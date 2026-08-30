import type { Unsubscribe } from 'dsh-luban-core'
import { redactSecrets } from 'dsh-luban-core'
import type { HudKeepaliveAlert, HudKeepaliveStatus, KeepaliveHealthPayload } from './types.js'

const CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu
const MAX_ALERTS = 256

function publicText(value: string, maximumLength: number): string {
  try {
    return redactSecrets(value)
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

/** In-memory, metadata-only projection of M03 health events for HUD responses. */
export class HudKeepaliveHealthStore {
  readonly #alerts = new Map<string, HudKeepaliveAlert>()
  readonly #listeners = new Set<() => void>()
  #disposed = false

  public record(input: unknown): void {
    const payload = input as Partial<KeepaliveHealthPayload> | null
    if (this.#disposed || typeof payload !== 'object' || payload === null) return
    if (typeof payload.sessionId !== 'string' || typeof payload.alive !== 'boolean') return
    const sessionId = publicText(payload.sessionId, 160)
    if (sessionId === '') return
    let changed = false
    if (payload.alive) {
      changed = this.#alerts.delete(sessionId)
    } else {
      const detail =
        typeof payload.detail === 'string' ? publicText(payload.detail, 256) : undefined
      const alert = Object.freeze({
        sessionId,
        ...(detail === undefined || detail === '' ? {} : { detail }),
      })
      if (!sameAlert(this.#alerts.get(sessionId), alert)) {
        if (!this.#alerts.has(sessionId) && this.#alerts.size >= MAX_ALERTS) {
          const oldest = this.#alerts.keys().next().value
          if (oldest !== undefined) this.#alerts.delete(oldest)
        }
        this.#alerts.set(sessionId, alert)
        changed = true
      }
    }
    if (!changed) return
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch {
        // A HUD observer cannot break the shared M03 event path.
      }
    }
  }

  public snapshot(): HudKeepaliveStatus {
    const alerts = [...this.#alerts.values()].sort((left, right): number =>
      left.sessionId.localeCompare(right.sessionId),
    )
    return Object.freeze({ healthy: alerts.length === 0, alerts: Object.freeze(alerts) })
  }

  public subscribe(listener: () => void): Unsubscribe {
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
}
