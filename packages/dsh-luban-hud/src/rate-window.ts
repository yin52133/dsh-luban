import type { AccountId, TelemetryProvider, TelemetrySnapshot } from '@yin52133/dsh-luban-core'

export interface MonotonicClock {
  now(): number
}

export const systemMonotonicClock: MonotonicClock = Object.freeze({
  now: (): number => performance.now(),
})

interface RateSample {
  readonly at: number
  readonly tokens: number | 'unknown'
  readonly requests: number
}

const ONE_MINUTE_MS = 60_000
const FIVE_MINUTES_MS = 300_000

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be non-negative`)
  return value
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`)
  return value
}

/** Monotonic, rollback-safe 1m/5m token and request window. */
export class SlidingRateWindow {
  readonly #clock: MonotonicClock
  readonly #samples: RateSample[] = []
  #cursor = 0

  public constructor(clock: MonotonicClock = systemMonotonicClock) {
    this.#clock = clock
  }

  public record(tokens: number | 'unknown', requests = 1, at?: number): void {
    if (tokens !== 'unknown') nonNegative(tokens, 'tokens')
    nonNegative(requests, 'requests')
    const now = this.#advance(this.#clock.now())
    const sampleAt = at ?? now
    finite(sampleAt, 'historical monotonic timestamp')
    this.#samples.push({ at: Math.min(sampleAt, now), tokens, requests })
    this.#prune(now)
  }

  public snapshot(at = this.#clock.now()): TelemetrySnapshot['rates'] {
    nonNegative(at, 'monotonic timestamp')
    const safeAt = this.#advance(at)
    this.#prune(safeAt)
    let tokens1m = 0
    let tokens5m = 0
    let requests1m = 0
    let requests5m = 0
    let unknownTokens1m = false
    let unknownTokens5m = false
    for (const sample of this.#samples) {
      const age = Math.max(0, safeAt - sample.at)
      if (age < FIVE_MINUTES_MS) {
        if (sample.tokens === 'unknown') unknownTokens5m = true
        else tokens5m += sample.tokens
        requests5m += sample.requests
      }
      if (age < ONE_MINUTE_MS) {
        if (sample.tokens === 'unknown') unknownTokens1m = true
        else tokens1m += sample.tokens
        requests1m += sample.requests
      }
    }
    return Object.freeze({
      tpm1m: unknownTokens1m ? 'unknown' : tokens1m,
      tpm5m: unknownTokens5m ? 'unknown' : tokens5m / 5,
      rpm1m: requests1m,
      rpm5m: requests5m / 5,
    })
  }

  #prune(at: number): void {
    for (let index = this.#samples.length - 1; index >= 0; index -= 1) {
      const sample = this.#samples.at(index)
      if (sample !== undefined && at - sample.at >= FIVE_MINUTES_MS) {
        this.#samples.splice(index, 1)
      }
    }
  }

  #advance(at: number): number {
    this.#cursor = Math.max(this.#cursor, at)
    return this.#cursor
  }
}

export class RateTelemetryProvider implements TelemetryProvider {
  public readonly id = 'dsh-rates'
  readonly #window: SlidingRateWindow
  readonly #windowForAccount: ((accountId: AccountId) => SlidingRateWindow | undefined) | undefined

  public constructor(
    window: SlidingRateWindow,
    windowForAccount?: (accountId: AccountId) => SlidingRateWindow | undefined,
  ) {
    this.#window = window
    this.#windowForAccount = windowForAccount
  }

  public capabilities(): readonly ['rates'] {
    return ['rates']
  }

  public sample(): Promise<Partial<TelemetrySnapshot>> {
    return Promise.resolve({ rates: this.#window.snapshot() })
  }

  public sampleForAccount(accountId: AccountId): Promise<Partial<TelemetrySnapshot>> {
    const window = this.#windowForAccount?.(accountId)
    return Promise.resolve(window === undefined ? {} : { accountId, rates: window.snapshot() })
  }
}
