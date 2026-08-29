import type {
  Actor,
  Plan,
  PlanDecision,
  PlanGuard,
  PlanId,
  PlanInput,
  PlanSections,
  PlanService,
  PlanStatus,
  SessionId,
  TaskStore,
  Unsubscribe,
} from '@luban/core'
import { LubanError } from '@luban/core'
import { ApprovalPlanGuard } from './guard.js'
import type { StoredPlan } from './repository.js'
import type { PlanRepository } from './repository.js'
import { validateSections } from './template.js'

export interface PlanFeedbackEvent {
  readonly type: 'luban.plan.feedback'
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

export interface PlanServiceWithFeedback extends PlanService {
  initialize(): Promise<void>
  saveDraft(input: PlanInput): Promise<Plan>
  revise(id: PlanId, sections: PlanSections, expectedVersion: number): Promise<Plan>
  currentForSession(sessionId: SessionId): Plan | null
  subscribeFeedback(
    sessionId: SessionId | undefined,
    listener: (event: PlanFeedbackEvent) => void,
  ): Unsubscribe
  getDocument(id: PlanId): Promise<string>
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
  readonly #taskStore: () => TaskStore | undefined
  readonly #sink: PlanFeedbackSink | undefined
  readonly #plans = new Map<PlanId, StoredPlan>()
  readonly #sessionPlans = new Map<SessionId, PlanId>()
  readonly #listeners = new Map<string, Set<(event: PlanFeedbackEvent) => void>>()

  public constructor(options: {
    readonly repository: PlanRepository
    readonly protectedTools: readonly string[]
    readonly exemptTools: readonly string[]
    readonly taskStore?: TaskStore
    readonly taskStoreProvider?: () => TaskStore | undefined
    readonly sink?: PlanFeedbackSink
  }) {
    this.#repository = options.repository
    this.#guard = new ApprovalPlanGuard(options.protectedTools, options.exemptTools)
    this.#taskStore = options.taskStoreProvider ?? ((): TaskStore | undefined => options.taskStore)
    this.#sink = options.sink
  }

  public async initialize(): Promise<void> {
    this.#plans.clear()
    this.#sessionPlans.clear()
    for (const plan of await this.#repository.all()) this.#remember(plan)
  }

  public async submit(input: PlanInput): Promise<Plan> {
    validateSections(input.sections)
    const stored = await this.#repository.create(input)
    this.#remember(stored)
    await this.#publish(stored)
    return publicPlan(stored)
  }

  public async saveDraft(input: PlanInput): Promise<Plan> {
    const stored = await this.#repository.create({ ...input, status: 'draft' })
    this.#remember(stored)
    await this.#publish(stored)
    return publicPlan(stored)
  }

  public async decide(id: PlanId, decision: PlanDecision, reviewer: Actor): Promise<Plan> {
    if (decision.decision === 'reject' && decision.comment?.trim() === '') {
      throw new LubanError('E_INVALID_INPUT', 'A rejection comment cannot be blank')
    }
    if (decision.decision === 'reject' && decision.comment === undefined) {
      throw new LubanError('E_INVALID_INPUT', 'A rejection comment is required')
    }
    const stored = await this.#repository.update(
      id,
      decision.expectedVersion,
      (current): StoredPlan => {
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
    await this.#publish(stored, {
      decision: decision.decision,
      ...(decision.comment === undefined ? {} : { comment: decision.comment.trim() }),
      reviewer,
    })
    if (decision.decision === 'approve') await this.#advanceLinkedTask(stored, reviewer)
    return publicPlan(stored)
  }

  public async transition(id: PlanId, to: PlanStatus, expectedVersion: number): Promise<Plan> {
    const stored = await this.#repository.update(id, expectedVersion, (current): StoredPlan => {
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
    await this.#publish(stored)
    return publicPlan(stored)
  }

  public async revise(id: PlanId, sections: PlanSections, expectedVersion: number): Promise<Plan> {
    validateSections(sections)
    const stored = await this.#repository.update(id, expectedVersion, (current): StoredPlan => {
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
    await this.#publish(stored)
    return publicPlan(stored)
  }

  public get(id: PlanId): Promise<Plan | null> {
    const plan = this.#plans.get(id)
    return Promise.resolve(plan === undefined ? null : publicPlan(plan))
  }

  public listFor(taskId?: Plan['taskId']): Promise<readonly Plan[]> {
    return Promise.resolve(
      [...this.#plans.values()]
        .filter((plan): boolean => taskId === undefined || plan.taskId === taskId)
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
    return plan === undefined ? null : publicPlan(plan)
  }

  public subscribeFeedback(
    sessionId: SessionId | undefined,
    listener: (event: PlanFeedbackEvent) => void,
  ): Unsubscribe {
    const key = sessionId ?? '*'
    let listeners = this.#listeners.get(key)
    if (listeners === undefined) {
      listeners = new Set()
      this.#listeners.set(key, listeners)
    }
    listeners.add(listener)
    return (): void => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#listeners.delete(key)
    }
  }

  public async getDocument(id: PlanId): Promise<string> {
    const plan = this.#plans.get(id)
    if (plan === undefined) throw new LubanError('E_NOT_FOUND', `Plan ${id} was not found`)
    return this.#repository.readDocument(plan)
  }

  #remember(plan: StoredPlan): void {
    this.#plans.set(plan.id, plan)
    if (plan.sessionId !== undefined) {
      const existingId = this.#sessionPlans.get(plan.sessionId)
      const existing = existingId === undefined ? undefined : this.#plans.get(existingId)
      if (existing === undefined || existing.updatedAt <= plan.updatedAt) {
        this.#sessionPlans.set(plan.sessionId, plan.id)
      }
    }
  }

  async #publish(
    plan: StoredPlan,
    detail: {
      readonly decision?: 'approve' | 'reject'
      readonly comment?: string
      readonly reviewer?: Actor
    } = {},
  ): Promise<void> {
    const event: PlanFeedbackEvent = {
      type: 'luban.plan.feedback',
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
    for (const key of ['*', plan.sessionId].filter(
      (value): value is string => value !== undefined,
    )) {
      for (const listener of [...(this.#listeners.get(key) ?? [])]) listener(event)
    }
    await this.#sink?.deliver(event)
  }

  async #advanceLinkedTask(plan: StoredPlan, reviewer: Actor): Promise<void> {
    const taskStore = this.#taskStore()
    if (plan.taskId === undefined || taskStore === undefined) return
    const task = await taskStore.get(plan.taskId)
    if (task?.status === 'todo') {
      await taskStore.transition(plan.taskId, 'doing', reviewer, `Approved plan ${plan.id}`)
    }
  }
}
