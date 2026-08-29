import type { TaskStore, TelemetrySnapshot } from '@luban/core'
import type { TelemetryAdvisory } from './types.js'

const ACTIVE_STATUSES = ['backlog', 'todo', 'doing', 'review'] as const
const ALERT_TAG = 'hud:context-critical'

function ratioDescription(snapshot: TelemetrySnapshot): string {
  const ratio = snapshot.context.ratio
  if (ratio === 'unknown' || !Number.isFinite(ratio) || ratio < 0) {
    return 'HUD context usage crossed the configured critical threshold.'
  }
  return `HUD context usage reached ${(ratio * 100).toFixed(1)}%, crossing the configured critical threshold.`
}

/** Creates at most one active Taskboard card per continuous critical HUD episode. */
export class TaskboardHudAlertSink {
  readonly #store: TaskStore
  #pending: Promise<void> = Promise.resolve()
  #critical = false
  #episode = 0
  #reportedEpisode = 0
  #disposed = false

  public constructor(store: TaskStore) {
    this.#store = store
  }

  public observe(snapshot: TelemetrySnapshot, advisory: TelemetryAdvisory): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    if (advisory.level !== 'critical') {
      this.#critical = false
      return Promise.resolve()
    }
    if (!this.#critical) {
      this.#critical = true
      this.#episode += 1
    }
    const episode = this.#episode
    const operation = this.#pending.then(async (): Promise<void> => {
      if (!this.#isCurrent(episode) || this.#reportedEpisode === episode) return
      const existing = await this.#store.query({ statuses: ACTIVE_STATUSES, tags: [ALERT_TAG] })
      if (!this.#isCurrent(episode)) return
      if (existing.length === 0) {
        await this.#store.create({
          title: 'HUD context usage is critical',
          description: ratioDescription(snapshot),
          status: 'todo',
          hostScope: 'any',
          priority: 'P1',
          acceptance: 'Reduce context pressure and confirm the HUD exits the critical state',
          tags: ['hud', 'telemetry', ALERT_TAG],
        })
      }
      if (this.#isCurrent(episode)) this.#reportedEpisode = episode
    })
    this.#pending = operation.catch((): void => undefined)
    return operation
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#critical = false
    await this.#pending
  }

  #isCurrent(episode: number): boolean {
    return !this.#disposed && this.#critical && this.#episode === episode
  }
}
