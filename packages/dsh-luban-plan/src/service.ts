import type {
  AccountActor,
  AccountId,
  AccountPlanInput,
  AccountSessionRegistry,
  Actor,
  Plan,
  PlanDecision,
  PlanGuard,
  PlanId,
  PlanService,
  PlanSections,
  PlanStatus,
  SessionId,
  TaskStore,
  Unsubscribe,
} from 'dsh-luban-core'
import { LubanError } from 'dsh-luban-core'
import { ApprovalPlanGuard } from './guard.js'
import type { StoredPlan } from './repository.js'
import type { PlanRepository } from './repository.js'
import { validateSections } from './template.js'

export interface PlanFeedbackEvent {
  readonly type: 'luban.plan.feedback'
  readonly accountId: AccountId
  readonly planId: PlanId
  readonly taskId?: Plan['taskId']
  readonly sessionId?: SessionId
  readonly status: PlanStatus
  readonly decision?: 'approve' | 'reject'
  readonly comment?: string
  readonly reviewer?: Actor
  readonly filePath: string
  readonly version: number
  readonly at: number
}

export interface PlanFeedbackSink {
  deliver(event: PlanFeedbackEvent): void | Promise<void>
}

type PlanSideEffect =
  | 'account-feedback-listener'
  | 'system-feedback-listener'
  | 'feedback-sink'
  | 'feedback-publish'
  | 'linked-task-transition'

interface PlanFeedbackDetail {
  readonly decision?: 'approve' | 'reject'
  readonly comment?: string
  readonly reviewer?: Actor
}

type PlanFeedbackListener = (event: PlanFeedbackEvent) => void | Promise<void>

export type { AccountActor, AccountPlanInput } from 'dsh-luban-core'

export interface PlanServiceWithFeedback extends PlanService {
  initialize(): Promise<void>
  saveDraft(input: AccountPlanInput): Promise<Plan>
  revise(
    id: PlanId,
    sections: PlanSections,
    expectedVersion: number,
    accountId: AccountId,
  ): Promise<Plan>
  currentForSession(sessionId: SessionId): Plan | null
  subscribeFeedback(
    accountId: AccountId,
    sessionId: SessionId | undefined,
    listener: PlanFeedbackListener,
  ): Unsubscribe
  subscribeSystemFeedback(listener: PlanFeedbackListener): Unsubscribe
  getDocument(id: PlanId, accountId: AccountId): Promise<string>
}

const TRANSITIONS: Readonly<Record<PlanStatus, readonly PlanStatus[]>> = Object.freeze({
  draft: ['in-review'],
  'in-review': [],
  approved: ['executing'],
  executing: ['completed'],
  completed: [],
  rejected: ['revising'],
  revising: ['in-review'],
})

function publicPlan(plan: StoredPlan): Plan {
  return {
    ...(plan.accountId === undefined ? {} : { accountId: plan.accountId }),
    id: plan.id,
    ...(plan.taskId === undefined ? {} : { taskId: plan.taskId }),
    ...(plan.sessionId === undefined ? {} : { sessionId: plan.sessionId }),
    status: plan.status,
    sections: plan.sections,
    filePath: plan.filePath,
    decisions: plan.decisions,
    version: plan.version,
  }
}

/** State machine, feedback channel, and optional task-board coordination. */
export class FilePlanService implements PlanServiceWithFeedback {
  readonly #repository: PlanRepository
  readonly #guard: ApprovalPlanGuard
  readonly #accountSessions: AccountSessionRegistry
  readonly #taskStore: () => TaskStore | undefined
  readonly #sink: PlanFeedbackSink | undefined
  readonly #onError: (error: unknown) => void
  readonly #plans = new Map<PlanId, StoredPlan>()
  readonly #sessionPlans = new Map<SessionId, PlanId>()
  readonly #listeners = new Map<AccountId, Map<string, Set<PlanFeedbackListener>>>()
  readonly #systemListeners = new Set<PlanFeedbackListener>()

  public constructor(options: {
    readonly repository: PlanRepository
    readonly accountSessions: AccountSessionRegistry
    readonly protectedTools: readonly string[]
    readonly exemptTools: readonly string[]
    readonly taskStore?: TaskStore
    readonly taskStoreProvider?: () => TaskStore | undefined
    readonly sink?: PlanFeedbackSink
    readonly onError?: (error: unknown) => void
  }) {
    this.#repository = options.repository
    this.#guard = new ApprovalPlanGuard(options.protectedTools, options.exemptTools)
    this.#accountSessions = options.accountSessions
    this.#taskStore = options.taskStoreProvider ?? ((): TaskStore | undefined => options.taskStore)
    this.#sink = options.sink
    this.#onError =
      options.onError ??
      ((error: unknown): void => {
        process.emitWarning(error instanceof Error ? error : new Error(String(error)), {
          code: 'LUBAN_PLAN_SIDE_EFFECT',
        })
      })
  }

  public async initialize(): Promise<void> {
    this.#plans.clear()
    this.#sessionPlans.clear()
    for (const plan of await this.#repository.all()) {
      const sessionIsOwned =
        plan.accountId !== undefined &&
        plan.sessionId !== undefined &&
        (await this.#accountSessions.ownerOf(plan.sessionId)) === plan.accountId
      this.#remember(plan, sessionIsOwned)
    }
  }

  public async submit(input: AccountPlanInput): Promise<Plan> {
    validateSections(input.sections)
    await this.#validateReferences(input)
    const stored = await this.#repository.create(input)
    this.#remember(stored)
    await this.#publishCommitted(stored)
    return publicPlan(stored)
  }

  public async saveDraft(input: AccountPlanInput): Promise<Plan> {
    await this.#validateReferences(input)
    const stored = await this.#repository.create({ ...input, status: 'draft' })
    this.#remember(stored)
    await this.#publishCommitted(stored)
    return publicPlan(stored)
  }

  public async decide(id: PlanId, decision: PlanDecision, reviewer: AccountActor): Promise<Plan> {
    if (decision.decision === 'reject' && decision.comment?.trim() === '') {
      throw new LubanError('E_INVALID_INPUT', 'A rejection comment cannot be blank')
    }
    if (decision.decision === 'reject' && decision.comment === undefined) {
      throw new LubanError('E_INVALID_INPUT', 'A rejection comment is required')
    }
    await this.#assertSessionOwned(id, reviewer.accountId)
    const stored = await this.#repository.update(
      id,
      decision.expectedVersion,
      (current): StoredPlan => {
        this.#assertOwned(current, reviewer.accountId)
        if (current.status !== 'in-review') {
          throw new LubanError(
            'E_INVALID_TRANSITION',
            `Cannot decide plan ${id} while ${current.status}`,
          )
        }
        const now = this.#repository.now()
        return {
          ...current,
          status: decision.decision === 'approve' ? 'approved' : 'rejected',
          decisions: [
            ...current.decisions,
            {
              by: reviewer,
              decision: decision.decision,
              ...(decision.comment === undefined ? {} : { comment: decision.comment.trim() }),
              at: now,
            },
          ],
          version: current.version + 1,
          updatedAt: now,
        }
      },
    )
    this.#remember(stored)
    await this.#publishCommitted(stored, {
      decision: decision.decision,
      ...(decision.comment === undefined ? {} : { comment: decision.comment.trim() }),
      reviewer,
    })
    if (decision.decision === 'approve') {
      await this.#runSideEffect(stored, 'linked-task-transition', async (): Promise<void> => {
        await this.#advanceLinkedTask(stored, reviewer)
      })
    }
    return publicPlan(stored)
  }

  public async transition(
    id: PlanId,
    to: PlanStatus,
    expectedVersion: number,
    accountId: AccountId,
  ): Promise<Plan> {
    await this.#assertSessionOwned(id, accountId)
    const stored = await this.#repository.update(id, expectedVersion, (current): StoredPlan => {
      this.#assertOwned(current, accountId)
      if (!TRANSITIONS[current.status].includes(to)) {
        throw new LubanError(
          'E_INVALID_TRANSITION',
          `Cannot transition plan ${id} from ${current.status} to ${to}`,
        )
      }
      if (to === 'in-review') validateSections(current.sections)
      const now = this.#repository.now()
      return { ...current, status: to, version: current.version + 1, updatedAt: now }
    })
    this.#remember(stored)
    await this.#publishCommitted(stored)
    return publicPlan(stored)
  }

  public async revise(
    id: PlanId,
    sections: PlanSections,
    expectedVersion: number,
    accountId: AccountId,
  ): Promise<Plan> {
    validateSections(sections)
    await this.#assertSessionOwned(id, accountId)
    const stored = await this.#repository.update(id, expectedVersion, (current): StoredPlan => {
      this.#assertOwned(current, accountId)
      if (current.status !== 'rejected' && current.status !== 'revising') {
        throw new LubanError(
          'E_INVALID_TRANSITION',
          `Cannot revise plan ${id} while ${current.status}`,
        )
      }
      const now = this.#repository.now()
      return {
        ...current,
        sections,
        status: 'in-review',
        version: current.version + 1,
        updatedAt: now,
      }
    })
    this.#remember(stored)
    await this.#publishCommitted(stored)
    return publicPlan(stored)
  }

  public get(id: PlanId, accountId: AccountId): Promise<Plan | null> {
    const plan = this.#plans.get(id)
    return Promise.resolve(plan?.accountId === accountId ? publicPlan(plan) : null)
  }

  public listFor(
    taskId: Plan['taskId'] | undefined,
    accountId: AccountId,
  ): Promise<readonly Plan[]> {
    return Promise.resolve(
      [...this.#plans.values()]
        .filter(
          (plan): boolean =>
            plan.accountId === accountId && (taskId === undefined || plan.taskId === taskId),
        )
        .sort((left, right): number => right.updatedAt - left.updatedAt)
        .map(publicPlan),
    )
  }

  public guard(): PlanGuard {
    return this.#guard
  }

  public currentForSession(sessionId: SessionId): Plan | null {
    const id = this.#sessionPlans.get(sessionId)
    const plan = id === undefined ? undefined : this.#plans.get(id)
    return plan?.accountId === undefined ? null : publicPlan(plan)
  }

  public subscribeFeedback(
    accountId: AccountId,
    sessionId: SessionId | undefined,
    listener: PlanFeedbackListener,
  ): Unsubscribe {
    const key = sessionId ?? '*'
    let accountListeners = this.#listeners.get(accountId)
    if (accountListeners === undefined) {
      accountListeners = new Map()
      this.#listeners.set(accountId, accountListeners)
    }
    let listeners = accountListeners.get(key)
    if (listeners === undefined) {
      listeners = new Set()
      accountListeners.set(key, listeners)
    }
    listeners.add(listener)
    return (): void => {
      listeners.delete(listener)
      if (listeners.size === 0) accountListeners.delete(key)
      if (accountListeners.size === 0) this.#listeners.delete(accountId)
    }
  }

  public subscribeSystemFeedback(listener: PlanFeedbackListener): Unsubscribe {
    this.#systemListeners.add(listener)
    return (): void => {
      this.#systemListeners.delete(listener)
    }
  }

  public async getDocument(id: PlanId, accountId: AccountId): Promise<string> {
    const plan = this.#plans.get(id)
    if (plan?.accountId !== accountId) {
      throw new LubanError('E_NOT_FOUND', `Plan ${id} was not found`)
    }
    return this.#repository.readDocument(plan)
  }

  #remember(plan: StoredPlan, includeSession = true): void {
    this.#plans.set(plan.id, plan)
    if (includeSession && plan.accountId !== undefined && plan.sessionId !== undefined) {
      const existingId = this.#sessionPlans.get(plan.sessionId)
      const existing = existingId === undefined ? undefined : this.#plans.get(existingId)
      if (existing === undefined || existing.updatedAt <= plan.updatedAt) {
        this.#sessionPlans.set(plan.sessionId, plan.id)
      }
    }
  }

  async #publishCommitted(plan: StoredPlan, detail: PlanFeedbackDetail = {}): Promise<void> {
    await this.#runSideEffect(plan, 'feedback-publish', async (): Promise<void> => {
      await this.#publish(plan, detail)
    })
  }

  async #publish(plan: StoredPlan, detail: PlanFeedbackDetail): Promise<void> {
    if (plan.accountId === undefined) {
      this.#reportSideEffectFailure(
        plan,
        'feedback-publish',
        new LubanError('E_IO', `Plan ${plan.id} has no account ownership`),
      )
      return
    }
    const event: PlanFeedbackEvent = {
      type: 'luban.plan.feedback',
      accountId: plan.accountId,
      planId: plan.id,
      ...(plan.taskId === undefined ? {} : { taskId: plan.taskId }),
      ...(plan.sessionId === undefined ? {} : { sessionId: plan.sessionId }),
      status: plan.status,
      ...(detail.decision === undefined ? {} : { decision: detail.decision }),
      ...(detail.comment === undefined ? {} : { comment: detail.comment }),
      ...(detail.reviewer === undefined ? {} : { reviewer: detail.reviewer }),
      filePath: plan.filePath,
      version: plan.version,
      at: this.#repository.now(),
    }
    const accountListeners = this.#listeners.get(plan.accountId)
    for (const key of ['*', plan.sessionId].filter(
      (value): value is string => value !== undefined,
    )) {
      for (const listener of [...(accountListeners?.get(key) ?? [])]) {
        await this.#runSideEffect(plan, 'account-feedback-listener', async (): Promise<void> => {
          await listener(event)
        })
      }
    }
    for (const listener of [...this.#systemListeners]) {
      await this.#runSideEffect(plan, 'system-feedback-listener', async (): Promise<void> => {
        await listener(event)
      })
    }
    if (this.#sink !== undefined) {
      await this.#runSideEffect(plan, 'feedback-sink', async (): Promise<void> => {
        await this.#sink?.deliver(event)
      })
    }
  }

  async #runSideEffect(
    plan: StoredPlan,
    operation: PlanSideEffect,
    effect: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await effect()
    } catch (error: unknown) {
      this.#reportSideEffectFailure(plan, operation, error)
    }
  }

  #reportSideEffectFailure(plan: StoredPlan, operation: PlanSideEffect, error: unknown): void {
    const failure = new LubanError(
      'E_IO',
      `Plan ${plan.id} ${operation} failed after the plan state was committed`,
      {
        cause: error,
        details: { planId: plan.id, operation },
      },
    )
    try {
      this.#onError(failure)
    } catch (reportError: unknown) {
      process.emitWarning(
        new AggregateError(
          [failure, reportError],
          `Plan ${plan.id} side-effect failure could not be reported`,
        ),
        { code: 'LUBAN_PLAN_SIDE_EFFECT' },
      )
    }
  }

  async #advanceLinkedTask(plan: StoredPlan, reviewer: Actor): Promise<void> {
    const taskStore = this.#taskStore()
    if (plan.taskId === undefined || taskStore === undefined) return
    const task = await taskStore.get(plan.taskId)
    if (task !== null && task.accountId === plan.accountId && task.status === 'todo') {
      await taskStore.transition(plan.taskId, 'doing', reviewer, `Approved plan ${plan.id}`)
    }
  }

  async #validateReferences(input: AccountPlanInput): Promise<void> {
    if (input.sessionId !== undefined) {
      const owner = await this.#accountSessions.ownerOf(input.sessionId)
      if (owner !== input.accountId) {
        throw new LubanError('E_ACCOUNT_SCOPE_MISMATCH', 'Session belongs to another account')
      }
    }
    const taskStore = this.#taskStore()
    if (input.taskId !== undefined && taskStore === undefined) {
      throw new LubanError('E_UNAVAILABLE', 'Task store is unavailable')
    }
    if (input.taskId !== undefined && taskStore !== undefined) {
      const task = await taskStore.get(input.taskId)
      if (task?.accountId !== input.accountId) {
        throw new LubanError('E_NOT_FOUND', `Task ${input.taskId} was not found`)
      }
    }
  }

  #assertOwned(plan: StoredPlan, accountId: AccountId): void {
    if (plan.accountId !== accountId) {
      throw new LubanError('E_NOT_FOUND', `Plan ${plan.id} was not found`)
    }
  }

  async #assertSessionOwned(id: PlanId, accountId: AccountId): Promise<void> {
    const plan = this.#plans.get(id)
    if (plan === undefined) throw new LubanError('E_NOT_FOUND', `Plan ${id} was not found`)
    this.#assertOwned(plan, accountId)
    if (plan.sessionId === undefined) return
    if ((await this.#accountSessions.ownerOf(plan.sessionId)) !== accountId) {
      throw new LubanError('E_ACCOUNT_SCOPE_MISMATCH', 'Session belongs to another account')
    }
  }
}
