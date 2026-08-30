import type { AccountId, Unsubscribe } from 'dsh-luban-core'
import type { HudKeepaliveAlert, HudKeepaliveStatus, KeepaliveHealthPayload } from './types.js'

const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu
const MAX_ALERTS = 256

function boundedText(value: string, maximumLength: number): string {
  try {
    return value
      .replace(CONTROL_CHARACTERS, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, maximumLength)
  } catch {
    return ''
  }
}

function sameAlert(left: HudKeepaliveAlert | undefined, right: HudKeepaliveAlert): boolean {
  return left?.sessionId === right.sessionId && left.detail === right.detail
}

interface AccountAlert extends HudKeepaliveAlert {
  readonly accountId?: AccountId
}

/** In-memory, metadata-only projection of M03 health events for HUD responses. */
export class HudKeepaliveHealthStore {
  readonly #alerts = new Map<string, AccountAlert>()
  readonly #listeners = new Set<(accountId?: AccountId) => void>()
  #disposed = false

  public record(input: unknown): void {
    this.#record(input)
  }

  public recordForAccount(accountId: AccountId, input: unknown): void {
    this.#record(input, accountId)
  }

  #record(input: unknown, accountId?: AccountId): void {
    const payload = input as Partial<KeepaliveHealthPayload> | null
    if (this.#disposed || typeof payload !== 'object' || payload === null) return
    if (typeof payload.sessionId !== 'string' || typeof payload.alive !== 'boolean') return
    const sessionId = boundedText(payload.sessionId, 160)
    if (sessionId === '') return
    const key = this.#key(sessionId, accountId)
    let changed = false
    if (payload.alive) {
      changed = this.#alerts.delete(key)
    } else {
      const detail =
        typeof payload.detail === 'string' ? boundedText(payload.detail, 256) : undefined
      const alert = Object.freeze({
        ...(accountId === undefined ? {} : { accountId }),
        sessionId,
        ...(detail === undefined || detail === '' ? {} : { detail }),
      })
      if (!sameAlert(this.#alerts.get(key), alert)) {
        const accountAlerts = [...this.#alerts].filter(
          ([, candidate]): boolean => candidate.accountId === accountId,
        )
        if (!this.#alerts.has(key) && accountAlerts.length >= MAX_ALERTS) {
          const oldest = accountAlerts.at(0)?.[0]
          if (oldest !== undefined) this.#alerts.delete(oldest)
        }
        this.#alerts.set(key, alert)
        changed = true
      }
    }
    if (!changed) return
    for (const listener of [...this.#listeners]) {
      try {
        listener(accountId)
      } catch {
        // A HUD observer cannot break the shared M03 event path.
      }
    }
  }

  public snapshot(accountId?: AccountId): HudKeepaliveStatus {
    const alerts = [...this.#alerts.values()]
      .filter((alert): boolean => alert.accountId === accountId)
      .map((alert): HudKeepaliveAlert =>
        Object.freeze({
          sessionId: alert.sessionId,
          ...(alert.detail === undefined ? {} : { detail: alert.detail }),
        }),
      )
      .sort((left, right): number => left.sessionId.localeCompare(right.sessionId))
    return Object.freeze({ healthy: alerts.length === 0, alerts: Object.freeze(alerts) })
  }

  public subscribe(listener: (accountId?: AccountId) => void): Unsubscribe {
    if (this.#disposed) return (): void => undefined
    this.#listeners.add(listener)
    return (): void => void this.#listeners.delete(listener)
  }

  public dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
    this.#alerts.clear()
  }

  #key(sessionId: string, accountId?: AccountId): string {
    return `${accountId === undefined ? 'legacy' : String(accountId)}\u0000${sessionId}`
  }
}
