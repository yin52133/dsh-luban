import type {
  AgentClaimService,
  ClaimFilter,
  ClaimResult,
  ClaimSession,
  Task,
  TaskId,
  TaskOutput,
  TaskProgress,
} from '@luban/core'
import { LubanError } from '@luban/core'
import type { JsonTaskStore } from './task-store.js'

/** Agent-facing task operations kept separate from human transition APIs. */
export class DefaultAgentClaimService implements AgentClaimService {
  readonly #store: JsonTaskStore
  readonly #hostScope: 'win' | 'ubuntu'
  readonly #requireAcceptance: boolean

  public constructor(
    store: JsonTaskStore,
    hostScope: 'win' | 'ubuntu',
    requireAcceptance: boolean,
  ) {
    this.#store = store
    this.#hostScope = hostScope
    this.#requireAcceptance = requireAcceptance
  }

  public async claim(filter: ClaimFilter, session: ClaimSession): Promise<ClaimResult> {
    const candidates = await this.#store.query({
      ...filter,
      statuses: ['todo'],
      hostScope: this.#hostScope,
    })
    if (
      (filter.requireAcceptance ?? this.#requireAcceptance) &&
      candidates.length > 0 &&
      candidates.every(
        (task): boolean => task.acceptance === undefined || task.acceptance.trim() === '',
      )
    ) {
      return { ok: false, reason: 'acceptance-required' }
    }
    const task = await this.#store.atomicClaim({
      actor: session.actor,
      sessionId: session.sessionId,
      host: this.#hostScope,
      ...(filter.statuses === undefined ? {} : { statuses: filter.statuses }),
      ...(filter.workspace === undefined ? {} : { workspace: filter.workspace }),
      ...(filter.tags === undefined ? {} : { tags: filter.tags }),
      requireAcceptance: filter.requireAcceptance ?? this.#requireAcceptance,
    })
    return task === null ? { ok: false, reason: 'no-match' } : { ok: true, task }
  }

  public async reportProgress(id: TaskId, progress: TaskProgress): Promise<void> {
    const task = await this.#claimedTask(id)
    const claim = task.claim
    const percent = progress.percent
    if (percent !== undefined && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
      throw new LubanError('E_INVALID_INPUT', 'progress percent must be between 0 and 100')
    }
    await this.#store.appendOutput(
      id,
      {
        kind: 'note',
        ref: percent === undefined ? 'progress' : `progress:${String(percent)}`,
        summary: progress.summary,
        at: Date.now(),
        by: claim.actor,
      },
      { transitionToReview: false, autoDone: false },
    )
  }

  public async complete(
    id: TaskId,
    output: TaskOutput,
    options: { readonly autoDone: boolean },
  ): Promise<Task> {
    const task = await this.#claimedTask(id)
    if (task.claim.actor.id !== output.by.id || task.claim.actor.kind !== output.by.kind) {
      throw new LubanError('E_AUTH_REQUIRED', 'Only the claiming actor can complete the task')
    }
    return this.#store.appendOutput(id, output, {
      transitionToReview: true,
      autoDone: options.autoDone,
    })
  }

  public async fail(id: TaskId, reason: string): Promise<void> {
    await this.#claimedTask(id)
    await this.#store.fail(id, reason)
  }

  async #claimedTask(id: TaskId): Promise<Task & { readonly claim: NonNullable<Task['claim']> }> {
    const task = await this.#store.get(id)
    if (task === null) throw new LubanError('E_NOT_FOUND', `Task ${id} was not found`)
    if (task.status !== 'doing' || task.claim === undefined || task.claim === null) {
      throw new LubanError('E_INVALID_TRANSITION', 'Task is not actively claimed')
    }
    return { ...task, claim: task.claim }
  }
}
