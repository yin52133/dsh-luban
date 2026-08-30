import type {
  AgentClaimService,
  ClaimCompletionOptions,
  ClaimFilter,
  ClaimMutationOptions,
  ClaimResult,
  ClaimSession,
  Task,
  TaskClaim,
  TaskId,
  TaskOutput,
  TaskProgress,
} from 'dsh-luban-core'
import { LubanError } from 'dsh-luban-core'
import type {
  AtomicNightClaimResult,
  JsonTaskStore,
  NightRunSettlementResult,
} from './task-store.js'

export interface NightClaimPolicy {
  readonly dateKey: string
  readonly dailyQuota: number
}

export interface NightCompletionOptions {
  readonly expectedClaim: TaskClaim
  readonly autoDone: boolean
  readonly dailyQuota: number
}

export interface NightFailureOptions {
  readonly expectedClaim: TaskClaim
  readonly maxConsecutiveFailures: number
}

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
      ...(session.executionOwner === undefined ? {} : { executionOwner: session.executionOwner }),
      ...(filter.statuses === undefined ? {} : { statuses: filter.statuses }),
      ...(filter.workspace === undefined ? {} : { workspace: filter.workspace }),
      ...(filter.tags === undefined ? {} : { tags: filter.tags }),
      requireAcceptance: filter.requireAcceptance ?? this.#requireAcceptance,
    })
    return task === null ? { ok: false, reason: 'no-match' } : { ok: true, task }
  }

  public async claimNight(
    filter: ClaimFilter,
    session: ClaimSession,
    policy: NightClaimPolicy,
  ): Promise<AtomicNightClaimResult> {
    if (session.executionOwner !== 'night-scheduler') {
      throw new LubanError('E_INVALID_INPUT', 'Night claims require the trusted scheduler owner')
    }
    return this.#store.atomicNightClaim({
      actor: session.actor,
      sessionId: session.sessionId,
      host: this.#hostScope,
      ...(filter.statuses === undefined ? {} : { statuses: filter.statuses }),
      ...(filter.workspace === undefined ? {} : { workspace: filter.workspace }),
      ...(filter.tags === undefined ? {} : { tags: filter.tags }),
      requireAcceptance: filter.requireAcceptance ?? this.#requireAcceptance,
      dateKey: policy.dateKey,
      dailyQuota: policy.dailyQuota,
    })
  }

  public async reportProgress(
    id: TaskId,
    progress: TaskProgress,
    options: ClaimMutationOptions = {},
  ): Promise<void> {
    const expectedClaim = await this.#expectedClaim(id, options.expectedClaim)
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
        by: expectedClaim.actor,
      },
      { transitionToReview: false, autoDone: false, expectedClaim },
    )
  }

  public async complete(
    id: TaskId,
    output: TaskOutput,
    options: ClaimCompletionOptions,
  ): Promise<Task> {
    const expectedClaim = await this.#expectedClaim(id, options.expectedClaim)
    if (expectedClaim.actor.id !== output.by.id || expectedClaim.actor.kind !== output.by.kind) {
      throw new LubanError('E_AUTH_REQUIRED', 'Only the claiming actor can complete the task')
    }
    return this.#store.appendOutput(id, output, {
      transitionToReview: true,
      autoDone: options.autoDone,
      expectedClaim,
    })
  }

  public async completeNight(
    id: TaskId,
    output: TaskOutput,
    options: NightCompletionOptions,
  ): Promise<NightRunSettlementResult> {
    if (
      options.expectedClaim.actor.id !== output.by.id ||
      options.expectedClaim.actor.kind !== output.by.kind
    ) {
      throw new LubanError('E_AUTH_REQUIRED', 'Only the claiming actor can complete the task')
    }
    return this.#store.settleNightRun({
      kind: 'complete',
      id,
      expectedClaim: options.expectedClaim,
      output,
      autoDone: options.autoDone,
      dailyQuota: options.dailyQuota,
    })
  }

  public async fail(id: TaskId, reason: string, options: ClaimMutationOptions = {}): Promise<void> {
    const expectedClaim = await this.#expectedClaim(id, options.expectedClaim)
    await this.#store.fail(id, reason, { expectedClaim })
  }

  public async failNight(
    id: TaskId,
    reason: string,
    options: NightFailureOptions,
  ): Promise<NightRunSettlementResult> {
    return this.#store.settleNightRun({
      kind: 'fail',
      id,
      expectedClaim: options.expectedClaim,
      reason,
      maxConsecutiveFailures: options.maxConsecutiveFailures,
    })
  }

  async #expectedClaim(id: TaskId, expectedClaim: TaskClaim | undefined): Promise<TaskClaim> {
    return expectedClaim ?? (await this.#claimedTask(id)).claim
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
