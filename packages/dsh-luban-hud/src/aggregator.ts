import type {
  AccountId,
  Clock,
  SessionId,
  TelemetryAggregator,
  TelemetryField,
  TelemetryProvider,
  TelemetrySnapshot,
  Unsubscribe,
} from 'dsh-luban-core'
import { systemClock } from 'dsh-luban-core'
import type { HudThresholds } from './config.js'
import { systemMonotonicClock, type MonotonicClock } from './rate-window.js'
import type {
  HudTelemetryEnvelope,
  ProviderFailure,
  TelemetryAdvisory,
  TelemetrySourceKey,
} from './types.js'

const FIELDS = new Set<TelemetryField>(['context', 'workspace', 'model', 'rates'])
const DIAGNOSTIC_CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu

interface RegisteredProvider {
  readonly provider: TelemetryProvider
  readonly capabilities: ReadonlySet<TelemetryField>
}

/** HUD-local extension until the shared telemetry contract grows account-aware sampling. */
export interface AccountTelemetryProvider extends TelemetryProvider {
  sampleForAccount(accountId: AccountId): Promise<Partial<TelemetrySnapshot>>
  sampleForOwnedSession?(
    accountId: AccountId,
    sessionId: SessionId,
  ): Promise<Partial<TelemetrySnapshot>>
}

interface HistoryEntry {
  readonly at: number
  readonly snapshot: TelemetrySnapshot
}

export interface TelemetryAggregatorOptions {
  readonly refreshMs?: number
  readonly providerTimeoutMs?: number
  readonly historyRetentionMs?: number
  readonly historyEnabled?: boolean
  readonly thresholds?: HudThresholds
  readonly clock?: Clock
  readonly monotonicClock?: MonotonicClock
  readonly accountScoped?: boolean
  readonly resolveSessionAccount?: (sessionId: SessionId) => Promise<AccountId | null>
  readonly onError?: (error: unknown) => void
}

const DEFAULT_THRESHOLDS: HudThresholds = Object.freeze({
  warn: 0.7,
  danger: 0.85,
  critical: 0.95,
})

function diagnosticOf(error: unknown): string {
  try {
    const value = error instanceof Error ? error.message : String(error)
    const diagnostic = value
      .replace(DIAGNOSTIC_CONTROL_CHARACTERS, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 512)
    return diagnostic === '' ? 'unknown error' : diagnostic
  } catch {
    return 'unknown error'
  }
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function unknownSnapshot(at: number, accountId?: AccountId): TelemetrySnapshot {
  return Object.freeze({
    ...(accountId === undefined ? {} : { accountId }),
    context: Object.freeze({ used: 'unknown', max: 'unknown', ratio: 'unknown' }),
    workspace: Object.freeze({ name: 'unknown' }),
    model: Object.freeze({ name: 'unknown', thinkingDepth: 'unknown' }),
    rates: Object.freeze({
      tpm1m: 'unknown',
      tpm5m: 'unknown',
      rpm1m: 'unknown',
      rpm5m: 'unknown',
    }),
    at,
  })
}

function freezeSnapshot(snapshot: TelemetrySnapshot): TelemetrySnapshot {
  return Object.freeze({
    ...(snapshot.accountId === undefined ? {} : { accountId: snapshot.accountId }),
    context: Object.freeze({ ...snapshot.context }),
    workspace: Object.freeze({ ...snapshot.workspace }),
    model: Object.freeze({ ...snapshot.model }),
    rates: Object.freeze({ ...snapshot.rates }),
    at: snapshot.at,
  })
}

function advisoryFor(snapshot: TelemetrySnapshot, thresholds: HudThresholds): TelemetryAdvisory {
  const ratio = snapshot.context.ratio
  if (ratio === 'unknown') {
    return Object.freeze({
      level: 'unknown',
      message: 'Context usage is unavailable',
      compactionSuggested: false,
    })
  }
  if (ratio >= thresholds.critical) {
    return Object.freeze({
      level: 'critical',
      message: 'Context is critically full; M08 compaction is recommended',
      compactionSuggested: true,
    })
  }
  if (ratio >= thresholds.danger) {
    return Object.freeze({
      level: 'danger',
      message: 'Context usage is in the danger range',
      compactionSuggested: false,
    })
  }
  if (ratio >= thresholds.warn) {
    return Object.freeze({
      level: 'warn',
      message: 'Context usage is elevated',
      compactionSuggested: false,
    })
  }
  return Object.freeze({
    level: 'normal',
    message: 'Context usage is normal',
    compactionSuggested: false,
  })
}

function timeout<T>(promise: Promise<T>, milliseconds: number, providerId: string): Promise<T> {
  return new Promise<T>((resolve, reject): void => {
    const timer = setTimeout(
      (): void => reject(new Error(`Telemetry provider ${providerId} timed out`)),
      milliseconds,
    )
    timer.unref()
    void promise.then(
      (value): void => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown): void => {
        clearTimeout(timer)
        reject(new Error(diagnosticOf(error)))
      },
    )
  })
}

/** Concurrent field-level aggregator with immutable caching and partial-failure diagnostics. */
export class DefaultTelemetryAggregator implements TelemetryAggregator {
  readonly #providers = new Map<string, RegisteredProvider>()
  readonly #listeners = new Set<(snapshot: TelemetrySnapshot) => void>()
  readonly #advisoryListeners = new Set<(advisory: TelemetryAdvisory) => void>()
  readonly #accountListeners = new Map<AccountId, Set<(snapshot: TelemetrySnapshot) => void>>()
  readonly #accountObservers = new Set<
    (accountId: AccountId, snapshot: TelemetrySnapshot) => void
  >()
  readonly #clock: Clock
  readonly #monotonicClock: MonotonicClock
  readonly #refreshMs: number
  readonly #providerTimeoutMs: number
  readonly #historyRetentionMs: number
  readonly #historyEnabled: boolean
  readonly #accountScoped: boolean
  readonly #resolveSessionAccount: ((sessionId: SessionId) => Promise<AccountId | null>) | undefined
  readonly #thresholds: HudThresholds
  readonly #onError: (error: unknown) => void
  readonly #history: HistoryEntry[] = []
  readonly #accountHistory = new Map<AccountId, HistoryEntry[]>()
  readonly #activeAccounts = new Set<AccountId>()
  readonly #accountEnvelopes = new Map<AccountId, HudTelemetryEnvelope>()
  readonly #accountSampleAt = new Map<AccountId, number>()
  readonly #accountInFlight = new Map<AccountId, Promise<HudTelemetryEnvelope>>()
  #lastEnvelope: HudTelemetryEnvelope | undefined
  #lastSampleAt = Number.NEGATIVE_INFINITY
  #inFlight: Promise<HudTelemetryEnvelope> | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #providerGeneration = 0

  public constructor(options: TelemetryAggregatorOptions = {}) {
    this.#clock = options.clock ?? systemClock
    this.#monotonicClock = options.monotonicClock ?? systemMonotonicClock
    this.#refreshMs = options.refreshMs ?? 1_000
    this.#providerTimeoutMs = options.providerTimeoutMs ?? 2_000
    this.#historyRetentionMs = options.historyRetentionMs ?? 3_600_000
    this.#historyEnabled = options.historyEnabled ?? true
    this.#accountScoped = options.accountScoped ?? false
    this.#resolveSessionAccount = options.resolveSessionAccount
    this.#thresholds = options.thresholds ?? DEFAULT_THRESHOLDS
    this.#onError = options.onError ?? ((): void => undefined)
    if (!Number.isFinite(this.#refreshMs) || this.#refreshMs < 1_000) {
      throw new TypeError('Telemetry refresh must be at least 1000 milliseconds')
    }
    if (
      !Number.isFinite(this.#providerTimeoutMs) ||
      !Number.isFinite(this.#historyRetentionMs) ||
      this.#providerTimeoutMs <= 0 ||
      this.#historyRetentionMs <= 0
    ) {
      throw new TypeError('Telemetry intervals must be positive')
    }
  }

  public register(provider: TelemetryProvider): Unsubscribe {
    if (provider.id.trim() === '') throw new TypeError('Telemetry provider id must not be empty')
    if (this.#providers.has(provider.id)) {
      throw new TypeError(`Telemetry provider ${provider.id} is already registered`)
    }
    const capabilities = provider.capabilities()
    if (!capabilities.every((field): field is TelemetryField => FIELDS.has(field))) {
      throw new TypeError(`Telemetry provider ${provider.id} declared an invalid capability`)
    }
    const record = { provider, capabilities: new Set(capabilities) }
    this.#providers.set(provider.id, record)
    this.#providersChanged()
    return (): void => {
      if (this.#providers.get(provider.id) !== record) return
      this.#providers.delete(provider.id)
      this.#providersChanged()
    }
  }

  public snapshot(): Promise<TelemetrySnapshot> {
    return this.envelope().then((envelope): TelemetrySnapshot => envelope.snapshot)
  }

  public snapshotFor(sessionId: SessionId): Promise<TelemetrySnapshot> {
    if (this.#resolveSessionAccount !== undefined) {
      return this.#resolveSessionAccount(sessionId).then(
        (accountId): Promise<TelemetrySnapshot> => {
          if (accountId === null) return Promise.resolve(unknownSnapshot(this.#clock.now()))
          return this.snapshotForAccount(accountId, sessionId)
        },
      )
    }
    return this.#sample(
      this.#monotonicClock.now(),
      this.#providerGeneration,
      sessionId,
      false,
    ).then((envelope): TelemetrySnapshot => envelope.snapshot)
  }

  public envelope(): Promise<HudTelemetryEnvelope> {
    if (this.#accountScoped) {
      const snapshot = unknownSnapshot(this.#clock.now())
      return Promise.resolve(
        Object.freeze({
          snapshot,
          advisory: advisoryFor(snapshot, this.#thresholds),
          sources: Object.freeze({}),
          failures: Object.freeze([]),
        }),
      )
    }
    const now = this.#monotonicClock.now()
    if (this.#lastEnvelope !== undefined && now - this.#lastSampleAt < this.#refreshMs) {
      return Promise.resolve(this.#lastEnvelope)
    }
    if (this.#inFlight !== undefined) return this.#inFlight
    const refresh = this.#sample(now, this.#providerGeneration).finally((): void => {
      if (this.#inFlight === refresh) this.#inFlight = undefined
    })
    this.#inFlight = refresh
    return refresh
  }

  /** Sample and cache only providers that explicitly support the authenticated account. */
  public envelopeForAccount(accountId: AccountId): Promise<HudTelemetryEnvelope> {
    this.#activeAccounts.add(accountId)
    const now = this.#monotonicClock.now()
    const cached = this.#accountEnvelopes.get(accountId)
    const sampledAt = this.#accountSampleAt.get(accountId) ?? Number.NEGATIVE_INFINITY
    if (cached !== undefined && now - sampledAt < this.#refreshMs) return Promise.resolve(cached)
    const inFlight = this.#accountInFlight.get(accountId)
    if (inFlight !== undefined) return inFlight
    const refresh = this.#sample(now, this.#providerGeneration, undefined, true, accountId).finally(
      (): void => {
        if (this.#accountInFlight.get(accountId) === refresh)
          this.#accountInFlight.delete(accountId)
      },
    )
    this.#accountInFlight.set(accountId, refresh)
    return refresh
  }

  /** Bypass account cache and verify the exact session through account-aware providers. */
  public snapshotForAccount(
    accountId: AccountId,
    sessionId: SessionId,
  ): Promise<TelemetrySnapshot> {
    this.#activeAccounts.add(accountId)
    return this.#sample(
      this.#monotonicClock.now(),
      this.#providerGeneration,
      sessionId,
      false,
      accountId,
    ).then((envelope): TelemetrySnapshot => envelope.snapshot)
  }

  public subscribe(listener: (snapshot: TelemetrySnapshot) => void): Unsubscribe {
    this.#listeners.add(listener)
    return (): void => void this.#listeners.delete(listener)
  }

  public subscribeForAccount(
    accountId: AccountId,
    listener: (snapshot: TelemetrySnapshot) => void,
  ): Unsubscribe {
    this.#activeAccounts.add(accountId)
    const listeners = this.#accountListeners.get(accountId) ?? new Set()
    listeners.add(listener)
    this.#accountListeners.set(accountId, listeners)
    return (): void => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#accountListeners.delete(accountId)
    }
  }

  public subscribeAccounts(
    listener: (accountId: AccountId, snapshot: TelemetrySnapshot) => void,
  ): Unsubscribe {
    this.#accountObservers.add(listener)
    return (): void => void this.#accountObservers.delete(listener)
  }

  public subscribeAdvisory(listener: (advisory: TelemetryAdvisory) => void): Unsubscribe {
    this.#advisoryListeners.add(listener)
    return (): void => void this.#advisoryListeners.delete(listener)
  }

  public history(): readonly TelemetrySnapshot[] {
    this.#pruneHistory(this.#history, this.#monotonicClock.now())
    return Object.freeze(this.#history.map((entry): TelemetrySnapshot => entry.snapshot))
  }

  public historyForAccount(accountId: AccountId): readonly TelemetrySnapshot[] {
    const history = this.#accountHistory.get(accountId)
    if (history === undefined) return Object.freeze([])
    this.#pruneHistory(history, this.#monotonicClock.now())
    return Object.freeze(history.map((entry): TelemetrySnapshot => entry.snapshot))
  }

  public advisory(snapshot: TelemetrySnapshot): TelemetryAdvisory {
    return advisoryFor(snapshot, this.#thresholds)
  }

  public start(): void {
    if (this.#timer !== undefined) return
    if (!this.#accountScoped) {
      void this.envelope().catch((error: unknown): void => this.#reportError(error))
    }
    this.#timer = setInterval((): void => {
      this.#invalidate()
      if (!this.#accountScoped) {
        void this.envelope().catch((error: unknown): void => this.#reportError(error))
      }
      for (const accountId of this.#activeAccounts) {
        void this.envelopeForAccount(accountId).catch((error: unknown): void =>
          this.#reportError(error),
        )
      }
    }, this.#refreshMs)
    this.#timer.unref()
  }

  public dispose(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    this.#listeners.clear()
    this.#advisoryListeners.clear()
    this.#accountListeners.clear()
    this.#accountObservers.clear()
    this.#activeAccounts.clear()
    this.#accountInFlight.clear()
    if (this.#providers.size > 0) {
      this.#providers.clear()
      this.#providersChanged()
    }
  }

  async #sample(
    monotonicAt: number,
    providerGeneration: number,
    sessionId?: SessionId,
    publish = true,
    accountId?: AccountId,
  ): Promise<HudTelemetryEnvelope> {
    const providers = [...this.#providers.values()]
    const results = await Promise.allSettled(
      providers.map(async ({ provider }): Promise<Partial<TelemetrySnapshot>> =>
        timeout(
          Promise.resolve().then(() => {
            if (accountId !== undefined) {
              const scoped = provider as Partial<AccountTelemetryProvider>
              if (sessionId !== undefined) {
                return scoped.sampleForOwnedSession?.(accountId, sessionId) ?? Promise.resolve({})
              }
              return scoped.sampleForAccount?.(accountId) ?? Promise.resolve({})
            }
            return sessionId === undefined || provider.sampleForSession === undefined
              ? provider.sample()
              : provider.sampleForSession(sessionId)
          }),
          this.#providerTimeoutMs,
          provider.id,
        ),
      ),
    )
    if (providerGeneration !== this.#providerGeneration) {
      return this.#sample(
        this.#monotonicClock.now(),
        this.#providerGeneration,
        sessionId,
        publish,
        accountId,
      )
    }
    const at = this.#clock.now()
    const snapshot = unknownSnapshot(at, accountId)
    const mutable = {
      ...(accountId === undefined ? {} : { accountId }),
      context: { ...snapshot.context },
      workspace: { ...snapshot.workspace },
      model: { ...snapshot.model },
      rates: { ...snapshot.rates },
      at,
    }
    const sources: Partial<Record<TelemetrySourceKey, string>> = {}
    const failures: ProviderFailure[] = []

    for (const [index, result] of results.entries()) {
      const registered = providers.at(index)
      if (registered === undefined) throw new Error('Telemetry provider/result mismatch')
      const providerId = registered.provider.id
      if (result.status === 'rejected') {
        this.#recordProviderFailure(failures, providerId, result.reason)
        continue
      }
      try {
        const sample = result.value
        if (registered.capabilities.has('context') && sample.context !== undefined) {
          this.#mergeNumber(
            mutable.context,
            'used',
            sample.context.used,
            sources,
            'context.used',
            providerId,
          )
          this.#mergeNumber(
            mutable.context,
            'max',
            sample.context.max,
            sources,
            'context.max',
            providerId,
          )
          this.#mergeNumber(
            mutable.context,
            'ratio',
            sample.context.ratio,
            sources,
            'context.ratio',
            providerId,
          )
        }
        if (registered.capabilities.has('workspace') && sample.workspace !== undefined) {
          this.#mergeString(
            mutable.workspace,
            'name',
            sample.workspace.name,
            sources,
            'workspace.name',
            providerId,
          )
        }
        if (registered.capabilities.has('model') && sample.model !== undefined) {
          this.#mergeString(
            mutable.model,
            'name',
            sample.model.name,
            sources,
            'model.name',
            providerId,
          )
          this.#mergeString(
            mutable.model,
            'thinkingDepth',
            sample.model.thinkingDepth,
            sources,
            'model.thinkingDepth',
            providerId,
          )
        }
        if (registered.capabilities.has('rates') && sample.rates !== undefined) {
          this.#mergeNumber(
            mutable.rates,
            'tpm1m',
            sample.rates.tpm1m,
            sources,
            'rates.tpm1m',
            providerId,
          )
          this.#mergeNumber(
            mutable.rates,
            'tpm5m',
            sample.rates.tpm5m,
            sources,
            'rates.tpm5m',
            providerId,
          )
          this.#mergeNumber(
            mutable.rates,
            'rpm1m',
            sample.rates.rpm1m,
            sources,
            'rates.rpm1m',
            providerId,
          )
          this.#mergeNumber(
            mutable.rates,
            'rpm5m',
            sample.rates.rpm5m,
            sources,
            'rates.rpm5m',
            providerId,
          )
        }
      } catch (error: unknown) {
        this.#recordProviderFailure(failures, providerId, error)
      }
    }

    if (
      mutable.context.ratio === 'unknown' &&
      mutable.context.used !== 'unknown' &&
      mutable.context.max !== 'unknown' &&
      mutable.context.max > 0
    ) {
      mutable.context.ratio = mutable.context.used / mutable.context.max
      sources['context.ratio'] = [sources['context.used'], sources['context.max']]
        .filter(nonEmptyString)
        .join('+')
    }
    if (providerGeneration !== this.#providerGeneration) {
      return this.#sample(
        this.#monotonicClock.now(),
        this.#providerGeneration,
        sessionId,
        publish,
        accountId,
      )
    }

    const finalSnapshot = freezeSnapshot(mutable)
    const advisory = advisoryFor(finalSnapshot, this.#thresholds)
    const envelope: HudTelemetryEnvelope = Object.freeze({
      snapshot: finalSnapshot,
      advisory,
      sources: Object.freeze({ ...sources }),
      failures: Object.freeze(failures),
    })
    if (!publish) return envelope
    if (accountId === undefined) {
      const previousLevel = this.#lastEnvelope?.advisory.level
      this.#lastEnvelope = envelope
      this.#lastSampleAt = monotonicAt
      if (this.#historyEnabled) {
        this.#history.push({ at: monotonicAt, snapshot: finalSnapshot })
        this.#pruneHistory(this.#history, monotonicAt)
      }
      for (const listener of [...this.#listeners]) this.#notify((): void => listener(finalSnapshot))
      if (previousLevel !== advisory.level) {
        for (const listener of [...this.#advisoryListeners]) {
          this.#notify((): void => listener(advisory))
        }
      }
    } else {
      this.#accountEnvelopes.set(accountId, envelope)
      this.#accountSampleAt.set(accountId, monotonicAt)
      if (this.#historyEnabled) {
        const history = this.#accountHistory.get(accountId) ?? []
        history.push({ at: monotonicAt, snapshot: finalSnapshot })
        this.#accountHistory.set(accountId, history)
        this.#pruneHistory(history, monotonicAt)
      }
      for (const listener of this.#accountListeners.get(accountId) ?? []) {
        this.#notify((): void => listener(finalSnapshot))
      }
      for (const listener of [...this.#accountObservers]) {
        this.#notify((): void => listener(accountId, finalSnapshot))
      }
    }
    return envelope
  }

  #mergeNumber<Shape extends Record<Key, number | 'unknown'>, Key extends keyof Shape>(
    target: Shape,
    key: Key,
    value: unknown,
    sources: Partial<Record<TelemetrySourceKey, string>>,
    sourceKey: TelemetrySourceKey,
    providerId: string,
  ): void {
    if (target[key] !== 'unknown' || !finiteNonNegative(value)) return
    target[key] = value as Shape[Key]
    sources[sourceKey] = providerId
  }

  #mergeString<Shape extends Record<Key, string>, Key extends keyof Shape>(
    target: Shape,
    key: Key,
    value: unknown,
    sources: Partial<Record<TelemetrySourceKey, string>>,
    sourceKey: TelemetrySourceKey,
    providerId: string,
  ): void {
    if (target[key] !== 'unknown' || !nonEmptyString(value)) return
    target[key] = value as Shape[Key]
    sources[sourceKey] = providerId
  }

  #pruneHistory(history: HistoryEntry[], now: number): void {
    let stale = 0
    while (stale < history.length) {
      const entry = history.at(stale)
      if (entry === undefined || now - entry.at <= this.#historyRetentionMs) break
      stale += 1
    }
    if (stale > 0) history.splice(0, stale)
  }

  #invalidate(): void {
    this.#lastSampleAt = Number.NEGATIVE_INFINITY
    this.#accountSampleAt.clear()
  }

  #providersChanged(): void {
    this.#providerGeneration += 1
    this.#invalidate()
  }

  #recordProviderFailure(failures: ProviderFailure[], providerId: string, error: unknown): void {
    const diagnostic = diagnosticOf(error)
    failures.push(Object.freeze({ providerId, message: diagnostic }))
    this.#reportError(
      new Error(`Telemetry provider ${diagnosticOf(providerId)} failed: ${diagnostic}`),
    )
  }

  #reportError(error: unknown): void {
    try {
      this.#onError(new Error(diagnosticOf(error)))
    } catch {
      // Diagnostics must never break telemetry delivery.
    }
  }

  #notify(operation: () => void): void {
    try {
      operation()
    } catch (error: unknown) {
      this.#reportError(error)
    }
  }
}
