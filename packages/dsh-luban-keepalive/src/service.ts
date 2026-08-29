import type {
  Checkpoint,
  Clock,
  HealthReport,
  KeepaliveAdapter,
  KeepaliveEvent,
  KeepaliveService,
  ManagedSession,
  SessionSpec,
  Unsubscribe,
} from '@luban/core'
import { LubanError, systemClock } from '@luban/core'
import type { KeepaliveAlertSink } from './alerts.js'
import type { KeepaliveLedgerStore } from './ledger.js'
import { managedSessionId } from './session-id.js'

export interface ManagedKeepaliveOptions {
  readonly adapter: KeepaliveAdapter
  readonly ledger: KeepaliveLedgerStore
  readonly patrolIntervalMs: number
  readonly clock?: Clock
  readonly alerts?: KeepaliveAlertSink
  readonly onError?: (error: unknown) => void
  readonly publish?: (event: KeepaliveEvent) => void
}

/** Durable L2 keepalive service with idempotent recovery and non-destructive corruption handling. */
export class ManagedKeepaliveService implements KeepaliveService {
  readonly #adapter: KeepaliveAdapter
  readonly #ledger: KeepaliveLedgerStore
  readonly #patrolIntervalMs: number
  readonly #clock: Clock
  readonly #alerts: KeepaliveAlertSink | undefined
  readonly #onError: (error: unknown) => void
  readonly #publish: ((event: KeepaliveEvent) => void) | undefined
  readonly #listeners = new Set<(event: KeepaliveEvent) => void>()
  #timer: ReturnType<typeof setInterval> | undefined
  #patrolling = false
  #mutation: Promise<void> = Promise.resolve()

  public constructor(options: ManagedKeepaliveOptions) {
    this.#adapter = options.adapter
    this.#ledger = options.ledger
    this.#patrolIntervalMs = options.patrolIntervalMs
    this.#clock = options.clock ?? systemClock
    this.#alerts = options.alerts
    this.#onError = options.onError ?? ((): void => undefined)
    this.#publish = options.publish
  }

  public async ensureAlive(spec: SessionSpec): Promise<ManagedSession> {
    return this.#serialize(async (): Promise<ManagedSession> => {
      const normalized = { ...spec, id: managedSessionId(spec.id) }
      const ledger = await this.#ledger.read()
      const existing = ledger.sessions[normalized.id]
      if (existing !== undefined && (await this.#adapter.isAlive(normalized.id))) {
        return existing.session
      }
      const session = await this.#adapter.create(normalized)
      await this.#ledger.upsert(normalized, session)
      this.#emit({ type: 'started', session })
      return session
    })
  }

  /** Restore every ledger-owned session. A corrupt ledger is never replaced or cleaned. */
  public async restore(): Promise<HealthReport> {
    return this.#serialize(async (): Promise<HealthReport> => {
      let ledger
      try {
        ledger = await this.#ledger.read()
      } catch (error: unknown) {
        this.#onError(error)
        return this.#orphanReport('ledger unreadable; orphan retained')
      }
      const health: { id: string; alive: boolean; detail?: string }[] = []
      for (const record of Object.values(ledger.sessions)) {
        try {
          let session = record.session
          if (!(await this.#adapter.isAlive(session.id))) {
            session = await this.#adapter.create(record.spec)
            await this.#ledger.upsert(record.spec, session)
            this.#emit({
              type: 'restored',
              session,
              ...(record.checkpoint === undefined ? {} : { checkpoint: record.checkpoint }),
            })
          }
          health.push({ id: session.id, alive: true })
        } catch (error: unknown) {
          this.#onError(error)
          health.push({
            id: record.session.id,
            alive: false,
            detail: error instanceof Error ? error.message : 'restore failed',
          })
        }
      }
      return this.#report(health)
    })
  }

  public async patrol(): Promise<HealthReport> {
    let ledger
    try {
      ledger = await this.#ledger.read()
    } catch (error: unknown) {
      this.#onError(error)
      return this.#orphanReport('ledger unreadable; orphan retained')
    }
    const sessions = await Promise.all(
      Object.values(ledger.sessions).map(async (record) => {
        try {
          const alive = await this.#adapter.isAlive(record.session.id)
          return {
            id: record.session.id,
            alive,
            ...(alive ? {} : { detail: 'managed process is not alive' }),
          }
        } catch (error: unknown) {
          this.#onError(error)
          return {
            id: record.session.id,
            alive: false,
            detail: error instanceof Error ? error.message : 'health probe failed',
          }
        }
      }),
    )
    return this.#report(sessions)
  }

  public onEvent(listener: (event: KeepaliveEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return (): void => {
      this.#listeners.delete(listener)
    }
  }

  public async saveCheckpoint(id: string, checkpoint: Checkpoint): Promise<void> {
    const sessionId = managedSessionId(id)
    if (
      !Number.isSafeInteger(checkpoint.currentStep) ||
      checkpoint.currentStep < 0 ||
      checkpoint.currentStep > checkpoint.stepList.length
    ) {
      throw new LubanError('E_INVALID_INPUT', 'checkpoint currentStep is outside stepList')
    }
    if (!Number.isSafeInteger(checkpoint.savedAt) || checkpoint.savedAt < 0) {
      throw new LubanError('E_INVALID_INPUT', 'checkpoint savedAt must be epoch milliseconds')
    }
    await this.#ledger.checkpoint(sessionId, {
      ...checkpoint,
      stepList: [...checkpoint.stepList],
      artifacts: [...checkpoint.artifacts],
    })
  }

  public async loadCheckpoint(id: string): Promise<Checkpoint | null> {
    const ledger = await this.#ledger.read()
    return ledger.sessions[managedSessionId(id)]?.checkpoint ?? null
  }

  /** Stop tracking a completed session; optionally terminate it first. */
  public async release(id: string, options: { readonly destroy?: boolean } = {}): Promise<void> {
    await this.#serialize(async (): Promise<void> => {
      const sessionId = managedSessionId(id)
      if (options.destroy === true) await this.#adapter.destroy(sessionId)
      await this.#ledger.remove(sessionId)
    })
  }

  public start(): void {
    if (this.#timer !== undefined) return
    this.#timer = setInterval((): void => {
      if (this.#patrolling) return
      this.#patrolling = true
      void this.patrol()
        .catch(this.#onError)
        .finally((): void => {
          this.#patrolling = false
        })
    }, this.#patrolIntervalMs)
    this.#timer.unref()
  }

  public stop(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  public async dispose(): Promise<void> {
    this.stop()
    await this.#mutation.catch((): undefined => undefined)
    this.#listeners.clear()
  }

  async #orphanReport(detail: string): Promise<HealthReport> {
    let sessions: readonly ManagedSession[]
    try {
      sessions = await this.#adapter.list()
    } catch (error: unknown) {
      this.#onError(error)
      sessions = []
    }
    const orphans = sessions.map((session) => ({ id: session.id, alive: false, detail }))
    return this.#report(orphans.length === 0 ? [{ id: 'ledger', alive: false, detail }] : orphans)
  }

  #report(
    sessions: readonly { readonly id: string; readonly alive: boolean; readonly detail?: string }[],
  ): HealthReport {
    const report: HealthReport = {
      healthy: sessions.every((session): boolean => session.alive),
      checkedAt: this.#clock.now(),
      sessions,
    }
    this.#emit({ type: 'health', report })
    if (this.#alerts !== undefined) void this.#alerts.report(report).catch(this.#onError)
    return report
  }

  #emit(event: KeepaliveEvent): void {
    this.#publish?.(event)
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error: unknown) {
        this.#onError(error)
      }
    }
  }

  async #serialize<Value>(operation: () => Promise<Value>): Promise<Value> {
    const previous = this.#mutation
    let release: (() => void) | undefined
    this.#mutation = new Promise<void>((resolve): void => {
      release = resolve
    })
    await previous.catch((): undefined => undefined)
    try {
      return await operation()
    } finally {
      release?.()
    }
  }
}
