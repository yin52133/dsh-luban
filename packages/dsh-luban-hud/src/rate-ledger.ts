import { createHash } from 'node:crypto'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Clock } from 'dsh-luban-core'
import { LubanError, redactSecrets, systemClock } from 'dsh-luban-core'
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

export const HUD_RATE_CAPTURE_SCHEMA = 'dsh-luban/m07-hud-rate-capture/v2' as const

const DEFAULT_MAX_CAPTURE_RECORDS = 10_000
const FIVE_MINUTES_MS = 300_000
const CAPTURE_RETENTION_MS = 15 * 60_000
const MAX_CLOCK_DRIFT_MS = 1_000
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
  }
  readonly export: HudRateExport
  readonly captures: readonly HudRateCaptureMetadata[]
}

export interface HudRateLedgerOptions {
  readonly runtimeArtifact: HudRuntimeArtifactIdentity
  readonly clock?: Clock
  readonly monotonicClock?: MonotonicClock
  readonly maxRecords?: number
}

interface CapturedRecord {
  readonly record: RateLedgerRecord
  readonly metadata: HudRateCaptureMetadata
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

function boundedRoute(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    containsControlCharacter(value)
  ) {
    return 'unknown'
  }
  const redacted = redactSecrets(value)
  return redacted.length <= 128 ? redacted : 'unknown'
}

function boundedIdentity(value: unknown, prefix: string): string {
  const raw = String(value)
  return RATE_ID.test(raw) ? raw : `${prefix}-${sha256(raw).slice(0, 32)}`
}

function rateRecordId(event: SessionEvent<'assistant/message'>): string {
  return boundedIdentity(event.data.message.id, 'message')
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

/** Bounded, metadata-only ledger produced from mounted durable assistant events. */
export class HudRateLedger {
  readonly #runtimeArtifact: HudRuntimeArtifactIdentity
  readonly #clock: Clock
  readonly #monotonicClock: MonotonicClock
  readonly #maxRecords: number
  readonly #records = new Map<string, CapturedRecord>()
  readonly #conflictTimes = new Map<string, Set<number>>()
  #coverageStart: number | null
  #lastWallClock: number | null
  #lastMonotonicClock: number | null
  #coverageInvalid = false

  public constructor(options: HudRateLedgerOptions) {
    this.#runtimeArtifact = parseHudRuntimeArtifactIdentity(options.runtimeArtifact)
    this.#clock = options.clock ?? systemClock
    this.#monotonicClock = options.monotonicClock ?? systemMonotonicClock
    this.#maxRecords = options.maxRecords ?? DEFAULT_MAX_CAPTURE_RECORDS
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
    this.#coverageStart = valid ? wallClock : null
    this.#lastWallClock = valid ? wallClock : null
    this.#lastMonotonicClock = valid ? monotonicClock : null
    this.#coverageInvalid = !valid
  }

  public observe(session: Session, event: SessionEvent): void {
    if (event.type !== 'assistant/message') return
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
      this.#coverageInvalid = true
      return
    }
    if (event.time > now) {
      this.#coverageInvalid = true
      return
    }
    if (this.#coverageStart !== null && event.time < this.#coverageStart) {
      this.#prune(now)
      return
    }
    const occurredAt = new Date(event.time)
    if (Number.isNaN(occurredAt.valueOf())) return
    const id = rateRecordId(event)
    const captured: CapturedRecord = Object.freeze({
      record: Object.freeze({
        id,
        occurredAt: occurredAt.toISOString(),
        requestCount: 1,
        usage: capturedUsage(event.data.usage),
      }),
      metadata: Object.freeze({
        id,
        sessionId: boundedIdentity(session.id, 'session'),
        eventSeq: event.seq,
        turn: event.data.turn,
        step: event.data.step,
        messageId: boundedIdentity(event.data.message.id, 'message'),
        provider: boundedRoute(event.data.message.source.provider),
        model: boundedRoute(event.data.message.source.model),
      }),
    })
    const existing = this.#records.get(id)
    if (existing !== undefined) {
      if (!sameCapturedRequest(existing, captured)) this.#recordConflict(id, existing, captured)
      this.#prune(now)
      return
    }
    this.#records.set(id, captured)
    this.#prune(now)
  }

  public capture(windowValue: RateWindowUtc, challenge: string): HudRateCapture {
    if (!CHALLENGE.test(challenge)) {
      throw new LubanError('E_INVALID_INPUT', 'Rate capture challenge is invalid')
    }
    const window = captureWindow(windowValue)
    const now = this.#sampleClock()
    if (now === null) throw coverageError('Rate capture clock coverage is unavailable')
    if (Date.parse(window.endUtc) > now) {
      throw new LubanError('E_INVALID_INPUT', 'Rate capture window cannot end in the future')
    }
    this.#prune(now)
    const start = Date.parse(window.startUtc)
    const end = Date.parse(window.endUtc)
    if (this.#coverageInvalid) {
      throw coverageError('Rate capture coverage is unavailable')
    }
    if (this.#coverageStart === null || start < this.#coverageStart) {
      throw coverageError('Rate capture window is outside complete mounted coverage')
    }
    for (const timestamps of this.#conflictTimes.values()) {
      for (const occurredAt of timestamps) {
        if (occurredAt >= start && occurredAt < end) {
          throw coverageError('Rate capture window contains a conflicting message identity')
        }
      }
    }
    const selected = [...this.#records.values()]
      .filter(({ record }): boolean => {
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
    const exportedAt = new Date(now).toISOString()
    const coverageStartUtc = new Date(this.#coverageStart).toISOString()
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
      }),
      export: Object.freeze({
        schemaVersion: HUD_RATE_EXPORT_SCHEMA,
        source: Object.freeze({ kind: 'hud-event-export', origin: 'live-hud-events', exportedAt }),
        window,
        records: Object.freeze(selected.map(({ record }) => record)),
      }),
      captures: Object.freeze(selected.map(({ metadata }) => metadata)),
    })
  }

  #sampleClock(): number | null {
    const wallClock = this.#clock.now()
    const monotonicClock = this.#monotonicClock.now()
    if (!validEpoch(wallClock) || !validElapsed(monotonicClock)) {
      this.#coverageInvalid = true
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
        this.#coverageInvalid = true
      }
    }
    this.#lastWallClock = wallClock
    this.#lastMonotonicClock = monotonicClock
    return wallClock
  }

  #recordConflict(id: string, left: CapturedRecord, right: CapturedRecord): void {
    const timestamps = this.#conflictTimes.get(id) ?? new Set<number>()
    timestamps.add(Date.parse(left.record.occurredAt))
    timestamps.add(Date.parse(right.record.occurredAt))
    this.#conflictTimes.set(id, timestamps)
  }

  #prune(now: number): void {
    const cutoff = now - CAPTURE_RETENTION_MS
    if (this.#coverageStart !== null) {
      this.#coverageStart = Math.max(this.#coverageStart, cutoff)
    }
    for (const [id, captured] of this.#records) {
      if (Date.parse(captured.record.occurredAt) < cutoff) this.#records.delete(id)
    }
    for (const [id, timestamps] of this.#conflictTimes) {
      for (const timestamp of timestamps) {
        if (timestamp < cutoff) timestamps.delete(timestamp)
      }
      if (timestamps.size === 0) this.#conflictTimes.delete(id)
    }
    if (this.#records.size <= this.#maxRecords) return
    const oldest = [...this.#records.entries()].sort(
      (left, right): number =>
        Date.parse(left[1].record.occurredAt) - Date.parse(right[1].record.occurredAt),
    )
    const evicted = oldest.slice(0, this.#records.size - this.#maxRecords)
    let evictionWatermark = this.#coverageStart ?? cutoff
    for (const [id, captured] of evicted) {
      this.#records.delete(id)
      evictionWatermark = Math.max(evictionWatermark, Date.parse(captured.record.occurredAt) + 1)
    }
    this.#coverageStart = evictionWatermark
  }
}
