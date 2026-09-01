import type { AccountId, TaskStore, TelemetrySnapshot } from '@yin52133/dsh-luban-core'
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
  readonly #states = new Map<
    AccountId,
    {
      pending: Promise<void>
      critical: boolean
      episode: number
      reportedEpisode: number
    }
  >()
  #disposed = false

  public constructor(store: TaskStore) {
    this.#store = store
  }

  public observe(snapshot: TelemetrySnapshot, advisory: TelemetryAdvisory): Promise<void> {
    const accountId = snapshot.accountId
    if (this.#disposed || accountId === undefined) return Promise.resolve()
    const state = this.#states.get(accountId) ?? {
      pending: Promise.resolve(),
      critical: false,
      episode: 0,
      reportedEpisode: 0,
    }
    this.#states.set(accountId, state)
    if (advisory.level !== 'critical') {
      state.critical = false
      return Promise.resolve()
    }
    if (!state.critical) {
      state.critical = true
      state.episode += 1
    }
    const episode = state.episode
    const operation = state.pending.then(async (): Promise<void> => {
      if (!this.#isCurrent(state, episode) || state.reportedEpisode === episode) return
      const existing = await this.#store.query({
        accountId,
        statuses: ACTIVE_STATUSES,
        tags: [ALERT_TAG],
      })
      if (!this.#isCurrent(state, episode)) return
      if (existing.length === 0) {
        await this.#store.create({
          accountId,
          title: 'HUD context usage is critical',
          description: ratioDescription(snapshot),
          status: 'todo',
          hostScope: 'any',
          priority: 'P1',
          acceptance: 'Reduce context pressure and confirm the HUD exits the critical state',
          tags: ['hud', 'telemetry', ALERT_TAG],
        })
      }
      if (this.#isCurrent(state, episode)) state.reportedEpisode = episode
    })
    state.pending = operation.catch((): void => undefined)
    return operation
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    for (const state of this.#states.values()) state.critical = false
    await Promise.all([...this.#states.values()].map(async (state): Promise<void> => state.pending))
    this.#states.clear()
  }

  #isCurrent(
    state: { readonly critical: boolean; readonly episode: number },
    episode: number,
  ): boolean {
    return !this.#disposed && state.critical && state.episode === episode
  }
}
