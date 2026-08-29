import type { Actor, HostId, SessionId, TaskId, Unsubscribe } from './common.js'
import type { TelemetrySnapshot } from './models.js'

export interface LubanEventMap {
  readonly 'luban.task.changed': {
    readonly taskId: TaskId
    readonly from: string
    readonly to: string
    readonly actor: Actor
    readonly version: number
  }
  readonly 'luban.task.claimed': {
    readonly taskId: TaskId
    readonly actor: Actor
    readonly hostScope: 'win' | 'ubuntu' | 'any'
  }
  readonly 'luban.night.status': {
    readonly windowActive: boolean
    readonly quotaUsed: number
    readonly circuit: 'ok' | 'open'
  }
  readonly 'luban.keepalive.health': {
    readonly sessionId: string
    readonly alive: boolean
    readonly detail?: string
  }
  readonly 'luban.session.lock': {
    readonly sessionId: SessionId
    readonly holder: Actor | null
    readonly role: 'owner' | 'operator' | 'observer'
  }
  readonly 'luban.telemetry.snapshot': TelemetrySnapshot
  readonly 'luban.compaction.done': {
    readonly sessionId: SessionId
    readonly strategy: string
    readonly beforeTokens: number
    readonly afterTokens: number
  }
  readonly 'luban.channel.data': {
    readonly endpointId: string
    readonly kind: string
    readonly direction: 'in' | 'out'
  }
  readonly 'luban.build.job': {
    readonly jobId: string
    readonly from: string
    readonly to: string
  }
  readonly 'luban.browser.progress': {
    readonly runId: string
    readonly step: number
    readonly screenshot?: string
    readonly host?: HostId
  }
}

type Listener<Payload> = (payload: Payload) => void

/** In-process typed event bus; cross-process transports adapt this same event map. */
export class TypedEventBus<Events extends object> {
  readonly #listeners = new Map<keyof Events, Set<Listener<unknown>>>()

  public on<Key extends keyof Events>(key: Key, listener: Listener<Events[Key]>): Unsubscribe {
    let listeners = this.#listeners.get(key)
    if (listeners === undefined) {
      listeners = new Set<Listener<unknown>>()
      this.#listeners.set(key, listeners)
    }
    listeners.add(listener as Listener<unknown>)
    return (): void => {
      listeners.delete(listener as Listener<unknown>)
      if (listeners.size === 0) this.#listeners.delete(key)
    }
  }

  public emit<Key extends keyof Events>(key: Key, payload: Events[Key]): void {
    const listeners = this.#listeners.get(key)
    if (listeners === undefined) return
    for (const listener of [...listeners]) listener(payload)
  }

  public clear(): void {
    this.#listeners.clear()
  }
}

export type LubanEventBus = TypedEventBus<LubanEventMap>
