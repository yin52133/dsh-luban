import { createHash } from 'node:crypto'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { AccountId, Clock, ProviderRequestIdentityAdapter } from 'dsh-luban-core'
import { LubanError, systemClock } from 'dsh-luban-core'
import {
  attestHudProviderRequest,
  type HudProviderRequestIdentityEvidence,
  type ResolvedHudProviderRequestIdentity,
} from './provider-request-identity.js'
import {
  HUD_RATE_EXPORT_SCHEMA,
  type HudRateExport,
  type RateLedgerRecord,
  type RateWindowUtc,
  type ReconciledTokenUsage,
} from './rate-reconcile.js'
import { systemMonotonicClock, type MonotonicClock } from './rate-window.js'
import {
  parseHudRuntimeArtifactIdentity,
  type HudRuntimeArtifactIdentity,
} from './runtime-artifact.js'
import { parseHudBuildProvenance, type HudBuildProvenance } from './build-provenance.js'

export const HUD_RATE_CAPTURE_SCHEMA = 'dsh-luban/m07-hud-rate-capture/v4' as const

const DEFAULT_MAX_CAPTURE_RECORDS = 10_000
const FIVE_MINUTES_MS = 300_000
const CAPTURE_RETENTION_MS = 15 * 60_000
const MAX_CLOCK_DRIFT_MS = 1_000
const PROVIDER_IDENTITY_TIMEOUT_MS = 10_000
const PROVIDER_IDENTITY_CONCURRENCY = 8
const CHALLENGE = /^[A-Za-z0-9][A-Za-z0-9_-]{31,127}$/u
const RATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export interface HudRateCaptureMetadata {
  readonly id: string
  readonly sessionId: string
  readonly eventSeq: number
  readonly turn: number
  readonly step: number
  readonly messageId: string
  readonly provider: string
  readonly model: string
  readonly providerRequest: HudProviderRequestIdentityEvidence
}

export interface HudRateCapture {
  readonly schemaVersion: typeof HUD_RATE_CAPTURE_SCHEMA
  readonly source: {
    readonly kind: 'mounted-hud-capture'
    readonly exportedAt: string
    readonly coverageStartUtc: string
    readonly processId: number
    readonly nodeVersion: string
    readonly challengeSha256: string
    readonly runtimeArtifact: HudRuntimeArtifactIdentity
    readonly build: HudBuildProvenance
  }
  readonly export: HudRateExport
  readonly captures: readonly HudRateCaptureMetadata[]
}

export interface HudRateLedgerOptions {
  readonly runtimeArtifact: HudRuntimeArtifactIdentity
  readonly build: HudBuildProvenance
  readonly clock?: Clock
  readonly monotonicClock?: MonotonicClock
  readonly maxRecords?: number
  readonly resolveProviderRequestIdentity?: () => ProviderRequestIdentityAdapter | undefined
}

type HudRateEventMetadata = Omit<HudRateCaptureMetadata, 'providerRequest'>

interface CapturedRecord {
  readonly accountId?: AccountId
  readonly record: RateLedgerRecord
  readonly metadata: HudRateEventMetadata
}

interface RateScopeState {
  coverageStart: number | null
  coverageInvalid: boolean
  revision: number
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function validEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && !Number.isNaN(new Date(value).valueOf())
}

function validElapsed(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function canonicalUtc(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.endsWith('Z')) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be a canonical UTC timestamp`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be a canonical UTC timestamp`)
  }
  return value
}

function captureWindow(value: RateWindowUtc): RateWindowUtc {
  const startUtc = canonicalUtc(value.startUtc, 'rate window start')
  const endUtc = canonicalUtc(value.endUtc, 'rate window end')
  const duration = Date.parse(endUtc) - Date.parse(startUtc)
  if (duration !== 60_000 && duration !== FIVE_MINUTES_MS) {
    throw new LubanError(
      'E_INVALID_INPUT',
      'Rate capture window must be exactly one or five minutes',
    )
  }
  return Object.freeze({ startUtc, endUtc })
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function capturedUsage(value: TokenUsage | undefined): ReconciledTokenUsage {
  if (
    value === undefined ||
    !tokenCount(value.inputTokens) ||
    !tokenCount(value.outputTokens) ||
    (value.cacheReadTokens !== undefined && !tokenCount(value.cacheReadTokens)) ||
    (value.cacheWriteTokens !== undefined && !tokenCount(value.cacheWriteTokens))
  ) {
    return Object.freeze({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      unknownTokens: 1,
    })
  }
  return Object.freeze({
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens ?? 0,
    cacheWriteTokens: value.cacheWriteTokens ?? 0,
    unknownTokens: 0,
  })
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

function exactRoute(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value ||
    containsControlCharacter(value)
  ) {
    return undefined
  }
  return value
}

function exactIdentity(value: unknown): string | undefined {
  const raw = String(value)
  return RATE_ID.test(raw) ? raw : undefined
}

function sameUsage(left: ReconciledTokenUsage, right: ReconciledTokenUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.unknownTokens === right.unknownTokens
  )
}

function sameCapturedRequest(left: CapturedRecord, right: CapturedRecord): boolean {
  return (
    left.accountId === right.accountId &&
    left.record.occurredAt === right.record.occurredAt &&
    sameUsage(left.record.usage, right.record.usage) &&
    left.metadata.eventSeq === right.metadata.eventSeq &&
    left.metadata.turn === right.metadata.turn &&
    left.metadata.step === right.metadata.step &&
    left.metadata.messageId === right.metadata.messageId &&
    left.metadata.provider === right.metadata.provider &&
    left.metadata.model === right.metadata.model
  )
}

function coverageError(message: string): LubanError {
  return new LubanError('E_UNAVAILABLE', message, { retriable: true })
}

function sameAdapterIdentity(
  left: ResolvedHudProviderRequestIdentity,
  right: ResolvedHudProviderRequestIdentity,
): boolean {
  return (
    left.attestation.adapter.id === right.attestation.adapter.id &&
    left.attestation.adapter.version === right.attestation.adapter.version &&
    left.attestation.adapter.runtimeSha256 === right.attestation.adapter.runtimeSha256
  )
}

function raceProviderIdentityWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(coverageError('Provider request identity timed out'))
  return new Promise<T>((resolve, reject): void => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => {
      finish((): void => reject(coverageError('Provider request identity timed out')))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value): void => finish((): void => resolve(value)),
      (error: unknown): void =>
        finish((): void =>
          reject(
            error instanceof Error
              ? error
              : coverageError('Provider request identity adapter rejected without an error'),
          ),
        ),
    )
  })
}

async function attestCapturedRecords(
  selected: readonly CapturedRecord[],
  adapter: ProviderRequestIdentityAdapter,
  challenge: string,
  signal: AbortSignal,
): Promise<readonly ResolvedHudProviderRequestIdentity[]> {
  const results: (ResolvedHudProviderRequestIdentity | undefined)[] = Array.from({
    length: selected.length,
  })
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < selected.length) {
      const index = cursor
      cursor += 1
      const captured = selected[index]
      if (captured === undefined) throw coverageError('Rate capture snapshot is incomplete')
      results[index] = await raceProviderIdentityWithSignal(
        attestHudProviderRequest(
          adapter,
          {
            sessionId: captured.metadata.sessionId,
            assistantEventSeq: captured.metadata.eventSeq,
            turn: captured.metadata.turn,
            step: captured.metadata.step,
            assistantMessageId: captured.metadata.messageId,
            provider: captured.metadata.provider,
            model: captured.metadata.model,
            challenge,
          },
          signal,
        ),
        signal,
      )
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(PROVIDER_IDENTITY_CONCURRENCY, selected.length) },
      async (): Promise<void> => worker(),
    ),
  )
  return Object.freeze(
    results.map((result): ResolvedHudProviderRequestIdentity => {
      if (result === undefined) throw coverageError('Provider request identity is incomplete')
      return result
    }),
  )
}

/** Bounded, metadata-only ledger produced from mounted durable assistant events. */
export class HudRateLedger {
  readonly #runtimeArtifact: HudRuntimeArtifactIdentity
  readonly #build: HudBuildProvenance
  readonly #clock: Clock
  readonly #monotonicClock: MonotonicClock
  readonly #maxRecords: number
  readonly #resolveProviderRequestIdentity:
    (() => ProviderRequestIdentityAdapter | undefined) | undefined
  readonly #records = new Map<string, CapturedRecord>()
  readonly #conflictTimes = new Map<string, Set<number>>()
  readonly #scopeStates = new Map<string, RateScopeState>()
  readonly #initialCoverageStart: number | null
  #lastWallClock: number | null
  #lastMonotonicClock: number | null
  #clockCoverageInvalid = false

  public constructor(options: HudRateLedgerOptions) {
    this.#runtimeArtifact = parseHudRuntimeArtifactIdentity(options.runtimeArtifact)
    this.#build = parseHudBuildProvenance(options.build)
    if (this.#build.runtimeBundleSha256 !== this.#runtimeArtifact.bundleSha256) {
      throw new TypeError('HUD build provenance does not bind the runtime artifact')
    }
    this.#clock = options.clock ?? systemClock
    this.#monotonicClock = options.monotonicClock ?? systemMonotonicClock
    this.#maxRecords = options.maxRecords ?? DEFAULT_MAX_CAPTURE_RECORDS
    this.#resolveProviderRequestIdentity = options.resolveProviderRequestIdentity
    if (
      !Number.isSafeInteger(this.#maxRecords) ||
      this.#maxRecords < 1 ||
      this.#maxRecords > DEFAULT_MAX_CAPTURE_RECORDS
    ) {
      throw new TypeError('maxRecords must be a positive integer no greater than 10000')
    }
    const wallClock = this.#clock.now()
    const monotonicClock = this.#monotonicClock.now()
    const valid = validEpoch(wallClock) && validElapsed(monotonicClock)
    this.#initialCoverageStart = valid ? wallClock : null
    this.#lastWallClock = valid ? wallClock : null
    this.#lastMonotonicClock = valid ? monotonicClock : null
    this.#clockCoverageInvalid = !valid
  }

  public observe(session: Session, event: SessionEvent): void {
    this.#observe(session, event)
  }

  public observeForAccount(accountId: AccountId, session: Session, event: SessionEvent): void {
    this.#observe(session, event, accountId)
  }

  #observe(session: Session, event: SessionEvent, accountId?: AccountId): void {
    if (event.type !== 'assistant/message') return
    const state = this.#scopeState(accountId)
    const now = this.#sampleClock()
    if (now === null) return
    if (
      !Number.isSafeInteger(event.seq) ||
      event.seq < 0 ||
      !Number.isSafeInteger(event.time) ||
      event.time < 0 ||
      !Number.isSafeInteger(event.data.turn) ||
      event.data.turn < 0 ||
      !Number.isSafeInteger(event.data.step) ||
      event.data.step < 0
    ) {
      this.#markCoverageInvalid(accountId)
      return
    }
    if (event.time > now) {
      this.#markCoverageInvalid(accountId)
      return
    }
    if (state.coverageStart !== null && event.time < state.coverageStart) {
      this.#prune(now, accountId)
      return
    }
    const occurredAt = new Date(event.time)
    if (Number.isNaN(occurredAt.valueOf())) return
    const sessionId = exactIdentity(session.id)
    const messageId = exactIdentity(event.data.message.id)
    const provider = exactRoute(event.data.message.source.provider)
    const model = exactRoute(event.data.message.source.model)
    if (
      sessionId === undefined ||
      messageId === undefined ||
      provider === undefined ||
      model === undefined
    ) {
      this.#markCoverageInvalid(accountId)
      return
    }
    const id = messageId
    const captured: CapturedRecord = Object.freeze({
      ...(accountId === undefined ? {} : { accountId }),
      record: Object.freeze({
        id,
        occurredAt: occurredAt.toISOString(),
        requestCount: 1,
        usage: capturedUsage(event.data.usage),
      }),
      metadata: Object.freeze({
        id,
        sessionId,
        eventSeq: event.seq,
        turn: event.data.turn,
        step: event.data.step,
        messageId,
        provider,
        model,
      }),
    })
    const recordKey = this.#recordKey(id, accountId)
    const existing = this.#records.get(recordKey)
    if (existing !== undefined) {
      if (!sameCapturedRequest(existing, captured)) {
        this.#recordConflict(recordKey, existing, captured)
      }
      this.#prune(now, accountId)
      return
    }
    this.#records.set(recordKey, captured)
    state.revision += 1
    this.#prune(now, accountId)
  }

  public async capture(
    windowValue: RateWindowUtc,
    challenge: string,
    accountId?: AccountId,
  ): Promise<HudRateCapture> {
    if (!CHALLENGE.test(challenge)) {
      throw new LubanError('E_INVALID_INPUT', 'Rate capture challenge is invalid')
    }
    const window = captureWindow(windowValue)
    const state = this.#scopeState(accountId)
    const now = this.#sampleClock()
    if (now === null) throw coverageError('Rate capture clock coverage is unavailable')
    if (Date.parse(window.endUtc) > now) {
      throw new LubanError('E_INVALID_INPUT', 'Rate capture window cannot end in the future')
    }
    this.#prune(now, accountId)
    const start = Date.parse(window.startUtc)
    const end = Date.parse(window.endUtc)
    if (this.#clockCoverageInvalid || state.coverageInvalid) {
      throw coverageError('Rate capture coverage is unavailable')
    }
    if (state.coverageStart === null || start < state.coverageStart) {
      throw coverageError('Rate capture window is outside complete mounted coverage')
    }
    const scopePrefix = this.#scopePrefix(accountId)
    for (const [key, timestamps] of this.#conflictTimes) {
      if (!key.startsWith(scopePrefix)) continue
      for (const occurredAt of timestamps) {
        if (occurredAt >= start && occurredAt < end) {
          throw coverageError('Rate capture window contains a conflicting message identity')
        }
      }
    }
    const selected = [...this.#records.values()]
      .filter((captured): boolean => {
        if (captured.accountId !== accountId) return false
        const { record } = captured
        const occurredAt = Date.parse(record.occurredAt)
        return occurredAt >= start && occurredAt < end
      })
      .sort((left, right): number => {
        const time = Date.parse(left.record.occurredAt) - Date.parse(right.record.occurredAt)
        if (time !== 0) return time
        const sequence = left.metadata.eventSeq - right.metadata.eventSeq
        return sequence === 0 ? left.record.id.localeCompare(right.record.id) : sequence
      })
    if (selected.length === 0) {
      throw new LubanError('E_NOT_FOUND', 'Rate capture window contains no assistant requests')
    }
    const adapter = this.#resolveProviderRequestIdentity?.()
    if (adapter === undefined) {
      throw coverageError('Provider request identity adapter is unavailable')
    }
    const snapshotRevision = state.revision
    const identities = await attestCapturedRecords(
      selected,
      adapter,
      challenge,
      AbortSignal.timeout(PROVIDER_IDENTITY_TIMEOUT_MS),
    )
    if (state.revision !== snapshotRevision || this.#sampleClock() === null) {
      throw coverageError('Rate capture changed during provider request identity attestation')
    }
    const firstIdentity = identities.at(0)
    if (
      firstIdentity === undefined ||
      identities.some((identity): boolean => !sameAdapterIdentity(firstIdentity, identity))
    ) {
      throw coverageError('Provider request identity adapter changed within the rate window')
    }
    const providerRequestIds = new Set<string>()
    const records: RateLedgerRecord[] = []
    const captures: HudRateCaptureMetadata[] = []
    for (let index = 0; index < selected.length; index += 1) {
      const captured = selected[index]
      const identity = identities[index]
      if (captured === undefined || identity === undefined) {
        throw coverageError('Provider request identity is incomplete')
      }
      const providerRequestId = identity.attestation.providerRequestId
      if (providerRequestIds.has(providerRequestId)) {
        throw coverageError('Provider request identity is duplicated within the rate window')
      }
      providerRequestIds.add(providerRequestId)
      records.push(Object.freeze({ ...captured.record, id: providerRequestId }))
      captures.push(
        Object.freeze({
          ...captured.metadata,
          id: providerRequestId,
          providerRequest: identity.evidence,
        }),
      )
    }
    const exportedAt = new Date(now).toISOString()
    const coverageStartUtc = new Date(state.coverageStart).toISOString()
    return Object.freeze({
      schemaVersion: HUD_RATE_CAPTURE_SCHEMA,
      source: Object.freeze({
        kind: 'mounted-hud-capture',
        exportedAt,
        coverageStartUtc,
        processId: process.pid,
        nodeVersion: process.version,
        challengeSha256: sha256(challenge),
        runtimeArtifact: this.#runtimeArtifact,
        build: this.#build,
      }),
      export: Object.freeze({
        schemaVersion: HUD_RATE_EXPORT_SCHEMA,
        source: Object.freeze({ kind: 'hud-event-export', origin: 'live-hud-events', exportedAt }),
        window,
        records: Object.freeze(records),
      }),
      captures: Object.freeze(captures),
    })
  }

  #sampleClock(): number | null {
    const wallClock = this.#clock.now()
    const monotonicClock = this.#monotonicClock.now()
    if (!validEpoch(wallClock) || !validElapsed(monotonicClock)) {
      this.#markClockCoverageInvalid()
      return null
    }
    if (this.#lastWallClock !== null && this.#lastMonotonicClock !== null) {
      const wallDelta = wallClock - this.#lastWallClock
      const monotonicDelta = monotonicClock - this.#lastMonotonicClock
      if (
        wallDelta < 0 ||
        monotonicDelta < 0 ||
        Math.abs(wallDelta - monotonicDelta) > MAX_CLOCK_DRIFT_MS
      ) {
        this.#markClockCoverageInvalid()
        this.#lastWallClock = wallClock
        this.#lastMonotonicClock = monotonicClock
        return null
      }
    }
    this.#lastWallClock = wallClock
    this.#lastMonotonicClock = monotonicClock
    return wallClock
  }

  #markCoverageInvalid(accountId?: AccountId): void {
    const state = this.#scopeState(accountId)
    if (state.coverageInvalid) return
    state.coverageInvalid = true
    state.revision += 1
  }

  #markClockCoverageInvalid(): void {
    if (this.#clockCoverageInvalid) return
    this.#clockCoverageInvalid = true
    for (const state of this.#scopeStates.values()) state.revision += 1
  }

  #recordConflict(id: string, left: CapturedRecord, right: CapturedRecord): void {
    const timestamps = this.#conflictTimes.get(id) ?? new Set<number>()
    const previousSize = timestamps.size
    timestamps.add(Date.parse(left.record.occurredAt))
    timestamps.add(Date.parse(right.record.occurredAt))
    this.#conflictTimes.set(id, timestamps)
    if (timestamps.size !== previousSize) this.#scopeState(left.accountId).revision += 1
  }

  #prune(now: number, accountId?: AccountId): void {
    const cutoff = now - CAPTURE_RETENTION_MS
    const state = this.#scopeState(accountId)
    const scopePrefix = this.#scopePrefix(accountId)
    let changed = false
    if (state.coverageStart !== null) {
      const coverageStart = Math.max(state.coverageStart, cutoff)
      if (coverageStart !== state.coverageStart) changed = true
      state.coverageStart = coverageStart
    }
    for (const [id, captured] of this.#records) {
      if (captured.accountId === accountId && Date.parse(captured.record.occurredAt) < cutoff) {
        this.#records.delete(id)
        changed = true
      }
    }
    for (const [id, timestamps] of this.#conflictTimes) {
      if (!id.startsWith(scopePrefix)) continue
      for (const timestamp of timestamps) {
        if (timestamp < cutoff) {
          timestamps.delete(timestamp)
          changed = true
        }
      }
      if (timestamps.size === 0) {
        this.#conflictTimes.delete(id)
        changed = true
      }
    }
    const scopedRecords = [...this.#records.entries()].filter(
      ([, captured]): boolean => captured.accountId === accountId,
    )
    if (scopedRecords.length <= this.#maxRecords) {
      if (changed) state.revision += 1
      return
    }
    const oldest = scopedRecords.sort(
      (left, right): number =>
        Date.parse(left[1].record.occurredAt) - Date.parse(right[1].record.occurredAt),
    )
    const evicted = oldest.slice(0, scopedRecords.length - this.#maxRecords)
    let evictionWatermark = state.coverageStart ?? cutoff
    for (const [id, captured] of evicted) {
      this.#records.delete(id)
      changed = true
      evictionWatermark = Math.max(evictionWatermark, Date.parse(captured.record.occurredAt) + 1)
    }
    if (evictionWatermark !== state.coverageStart) changed = true
    state.coverageStart = evictionWatermark
    if (changed) state.revision += 1
  }

  #scopeState(accountId?: AccountId): RateScopeState {
    const key = this.#scopePrefix(accountId)
    const existing = this.#scopeStates.get(key)
    if (existing !== undefined) return existing
    const created: RateScopeState = {
      coverageStart: this.#initialCoverageStart,
      coverageInvalid: false,
      revision: 0,
    }
    this.#scopeStates.set(key, created)
    return created
  }

  #scopePrefix(accountId?: AccountId): string {
    return `${accountId === undefined ? 'legacy' : String(accountId)}\u0000`
  }

  #recordKey(id: string, accountId?: AccountId): string {
    return `${this.#scopePrefix(accountId)}${id}`
  }
}
