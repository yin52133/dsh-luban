import type {
  Clock,
  SessionId,
  TelemetryAggregator,
  TelemetryField,
  TelemetryProvider,
  TelemetrySnapshot,
  Unsubscribe,
} from '@luban/core'
import { redactSecrets, systemClock } from '@luban/core'
import type { HudThresholds } from './config.js'
import { systemMonotonicClock, type MonotonicClock } from './rate-window.js'
import type {
  HudTelemetryEnvelope,
  ProviderFailure,
  TelemetryAdvisory,
  TelemetrySourceKey,
} from './types.js'

const FIELDS = new Set<TelemetryField>(['context', 'workspace', 'model', 'rates'])
const PUBLIC_PROVIDER_FAILURE = 'Telemetry provider unavailable'
const DIAGNOSTIC_CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu

interface RegisteredProvider {
  readonly provider: TelemetryProvider
  readonly capabilities: ReadonlySet<TelemetryField>
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
    const diagnostic = redactSecrets(value)
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

function unknownSnapshot(at: number): TelemetrySnapshot {
  return Object.freeze({
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
  readonly #clock: Clock
  readonly #monotonicClock: MonotonicClock
  readonly #refreshMs: number
  readonly #providerTimeoutMs: number
  readonly #historyRetentionMs: number
  readonly #historyEnabled: boolean
  readonly #thresholds: HudThresholds
  readonly #onError: (error: unknown) => void
  readonly #history: HistoryEntry[] = []
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
    return this.#sample(
      this.#monotonicClock.now(),
      this.#providerGeneration,
      sessionId,
      false,
    ).then((envelope): TelemetrySnapshot => envelope.snapshot)
  }

  public envelope(): Promise<HudTelemetryEnvelope> {
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

  public subscribe(listener: (snapshot: TelemetrySnapshot) => void): Unsubscribe {
    this.#listeners.add(listener)
    return (): void => void this.#listeners.delete(listener)
  }

  public subscribeAdvisory(listener: (advisory: TelemetryAdvisory) => void): Unsubscribe {
    this.#advisoryListeners.add(listener)
    return (): void => void this.#advisoryListeners.delete(listener)
  }

  public history(): readonly TelemetrySnapshot[] {
    this.#pruneHistory(this.#monotonicClock.now())
    return Object.freeze(this.#history.map((entry): TelemetrySnapshot => entry.snapshot))
  }

  public advisory(snapshot: TelemetrySnapshot): TelemetryAdvisory {
    return advisoryFor(snapshot, this.#thresholds)
  }

  public start(): void {
    if (this.#timer !== undefined) return
    void this.envelope().catch((error: unknown): void => this.#reportError(error))
    this.#timer = setInterval((): void => {
      this.#invalidate()
      void this.envelope().catch((error: unknown): void => this.#reportError(error))
    }, this.#refreshMs)
    this.#timer.unref()
  }

  public dispose(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    this.#listeners.clear()
    this.#advisoryListeners.clear()
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
  ): Promise<HudTelemetryEnvelope> {
    const providers = [...this.#providers.values()]
    const results = await Promise.allSettled(
      providers.map(async ({ provider }): Promise<Partial<TelemetrySnapshot>> =>
        timeout(
          Promise.resolve().then(() =>
            sessionId === undefined || provider.sampleForSession === undefined
              ? provider.sample()
              : provider.sampleForSession(sessionId),
          ),
          this.#providerTimeoutMs,
          provider.id,
        ),
      ),
    )
    if (providerGeneration !== this.#providerGeneration) {
      return this.#sample(this.#monotonicClock.now(), this.#providerGeneration, sessionId, publish)
    }
    const at = this.#clock.now()
    const snapshot = unknownSnapshot(at)
    const mutable = {
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
      return this.#sample(this.#monotonicClock.now(), this.#providerGeneration, sessionId, publish)
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
    const previousLevel = this.#lastEnvelope?.advisory.level
    this.#lastEnvelope = envelope
    this.#lastSampleAt = monotonicAt
    if (this.#historyEnabled) {
      this.#history.push({ at: monotonicAt, snapshot: finalSnapshot })
      this.#pruneHistory(monotonicAt)
    }
    for (const listener of [...this.#listeners]) this.#notify((): void => listener(finalSnapshot))
    if (previousLevel !== advisory.level) {
      for (const listener of [...this.#advisoryListeners]) {
        this.#notify((): void => listener(advisory))
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

  #pruneHistory(now: number): void {
    let stale = 0
    while (stale < this.#history.length) {
      const entry = this.#history.at(stale)
      if (entry === undefined || now - entry.at <= this.#historyRetentionMs) break
      stale += 1
    }
    if (stale > 0) this.#history.splice(0, stale)
  }

  #invalidate(): void {
    this.#lastSampleAt = Number.NEGATIVE_INFINITY
  }

  #providersChanged(): void {
    this.#providerGeneration += 1
    this.#invalidate()
  }

  #recordProviderFailure(failures: ProviderFailure[], providerId: string, error: unknown): void {
    failures.push(Object.freeze({ providerId, message: PUBLIC_PROVIDER_FAILURE }))
    this.#reportError(
      new Error(`Telemetry provider ${diagnosticOf(providerId)} failed: ${diagnosticOf(error)}`),
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
