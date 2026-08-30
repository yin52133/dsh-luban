import { randomBytes } from 'node:crypto'
import type {
  Actor,
  ClaimMutationOptions,
  Clock,
  Task,
  TaskCreateInput,
  TaskEvent,
  TaskId,
  TaskPatch,
  TaskQuery,
  TaskClaim,
  SessionId,
  TaskStatus,
  Unsubscribe,
} from '@luban/core'
import { LubanError, asTaskId, systemClock } from '@luban/core'
import type { AtomicJsonStore } from '@luban/core'
import type { SchedulerLedger, TaskAuditEntry, TaskLedger } from './ledger.js'

const TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = Object.freeze({
  backlog: new Set<TaskStatus>(['todo', 'dropped']),
  todo: new Set<TaskStatus>(['doing', 'dropped']),
  doing: new Set<TaskStatus>(['review', 'todo']),
  review: new Set<TaskStatus>(['done', 'doing']),
  done: new Set<TaskStatus>(),
  dropped: new Set<TaskStatus>(),
})

const PRIORITY_ORDER = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 })
const SYSTEM_ACTOR: Actor = Object.freeze({ kind: 'agent', id: 'luban-taskboard' as Actor['id'] })

export interface ImportTask {
  readonly title: string
  readonly description?: string
  readonly status?: 'backlog' | 'todo'
  readonly hostScope?: 'win' | 'ubuntu' | 'any'
  readonly workspace?: string
  readonly priority?: 'P0' | 'P1' | 'P2' | 'P3'
  readonly acceptance?: string
  readonly tags?: readonly string[]
}

export interface ImportReport {
  readonly imported: number
  readonly skipped: number
  readonly failed: number
  readonly errors: readonly { readonly index: number; readonly message: string }[]
}

export interface AtomicClaimInput {
  readonly actor: Actor
  readonly sessionId: SessionId
  readonly host: 'win' | 'ubuntu'
  readonly executionOwner?: 'night-scheduler'
  readonly statuses?: readonly TaskStatus[]
  readonly workspace?: string
  readonly tags?: readonly string[]
  readonly requireAcceptance: boolean
}

interface AppendOutputOptions extends ClaimMutationOptions {
  readonly transitionToReview: boolean
  readonly autoDone: boolean
}

function trimmed(value: string, label: string, maximum: number, allowEmpty = false): string {
  const normalized = value.trim()
  if ((!allowEmpty && normalized === '') || normalized.length > maximum) {
    throw new LubanError(
      'E_INVALID_INPUT',
      `${label} must be ${allowEmpty ? 'at most' : '1 to'} ${String(maximum)} characters`,
    )
  }
  return normalized
}

function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  if (tags === undefined) return []
  if (tags.length > 32)
    throw new LubanError('E_INVALID_INPUT', 'tags cannot contain more than 32 values')
  return [...new Set(tags.map((tag): string => trimmed(tag, 'tag', 64)).filter(Boolean))]
}

function normalizeCreate(input: TaskCreateInput): TaskCreateInput {
  const title = trimmed(input.title, 'title', 200)
  const description =
    input.description === undefined ? '' : trimmed(input.description, 'description', 10_000, true)
  const acceptance =
    input.acceptance === undefined
      ? undefined
      : trimmed(input.acceptance, 'acceptance', 10_000, true)
  if (input.status === 'todo' && (acceptance === undefined || acceptance === '')) {
    throw new LubanError('E_ACCEPTANCE_REQUIRED', 'todo tasks require acceptance criteria')
  }
  return {
    title,
    description,
    status: input.status ?? 'backlog',
    hostScope: input.hostScope,
    ...(input.workspace === undefined
      ? {}
      : { workspace: trimmed(input.workspace, 'workspace', 2_048) }),
    priority: input.priority,
    ...(acceptance === undefined ? {} : { acceptance }),
    tags: normalizeTags(input.tags),
  }
}

function nextTaskId(now: number): TaskId {
  const date = new Date(now).toISOString().slice(0, 10).replaceAll('-', '')
  return asTaskId(`T-${date}-${randomBytes(4).toString('hex')}`)
}

function withAudit(
  ledger: TaskLedger,
  taskId: TaskId,
  action: string,
  actor: Actor,
  at: number,
  detail?: string,
): TaskLedger {
  const sequence = ledger.sequence + 1
  const entry: TaskAuditEntry = {
    sequence,
    taskId,
    action,
    actor,
    at,
    ...(detail === undefined ? {} : { detail }),
  }
  return { ...ledger, sequence, audit: [...ledger.audit, entry].slice(-1_000) }
}

function taskIndex(ledger: TaskLedger, id: TaskId): number {
  const index = ledger.tasks.findIndex((task): boolean => task.id === id)
  if (index < 0) throw new LubanError('E_NOT_FOUND', `Task ${id} was not found`)
  return index
}

function replaceTask(ledger: TaskLedger, index: number, task: Task): TaskLedger {
  const tasks = [...ledger.tasks]
  tasks[index] = task
  return { ...ledger, tasks }
}

function requireVersion(task: Task, expectedVersion: number): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new LubanError('E_INVALID_INPUT', 'expectedVersion must be a positive integer')
  }
  if (task.version !== expectedVersion) {
    throw new LubanError('E_VERSION_CONFLICT', 'Task version has changed', {
      retriable: true,
      details: { expectedVersion, actualVersion: task.version },
    })
  }
}

function sameClaim(left: TaskClaim, right: TaskClaim): boolean {
  return (
    left.actor.kind === right.actor.kind &&
    left.actor.id === right.actor.id &&
    left.sessionId === right.sessionId &&
    left.claimedAt === right.claimedAt &&
    left.leaseId === right.leaseId &&
    left.executionOwner === right.executionOwner
  )
}

function requireExpectedClaim(task: Task, expectedClaim: TaskClaim | undefined): void {
  if (expectedClaim === undefined) return
  const actualClaim = task.claim
  if (
    task.status !== 'doing' ||
    actualClaim === undefined ||
    actualClaim === null ||
    !sameClaim(actualClaim, expectedClaim)
  ) {
    throw new LubanError('E_VERSION_CONFLICT', 'Task claim has changed', { retriable: true })
  }
}

function validateTransition(task: Task, to: TaskStatus): void {
  if (!TRANSITIONS[task.status].has(to)) {
    throw new LubanError('E_INVALID_TRANSITION', `Cannot move task from ${task.status} to ${to}`)
  }
  if (to === 'todo' && (task.acceptance === undefined || task.acceptance.trim() === '')) {
    throw new LubanError('E_ACCEPTANCE_REQUIRED', 'todo tasks require acceptance criteria')
  }
}

function matches(task: Task, filter: TaskQuery): boolean {
  if (filter.statuses !== undefined && !filter.statuses.includes(task.status)) return false
  if (
    filter.hostScope !== undefined &&
    task.hostScope !== 'any' &&
    task.hostScope !== filter.hostScope
  )
    return false
  if (filter.workspace !== undefined && task.workspace !== filter.workspace) return false
  if (filter.tags !== undefined && !filter.tags.every((tag): boolean => task.tags.includes(tag)))
    return false
  return true
}

/** Durable task store. Every mutation is one lock-protected ledger replacement. */
export class JsonTaskStore {
  readonly #store: AtomicJsonStore<TaskLedger>
  readonly #clock: Clock
  readonly #listeners = new Set<(event: TaskEvent) => void>()

  public constructor(store: AtomicJsonStore<TaskLedger>, clock: Clock = systemClock) {
    this.#store = store
    this.#clock = clock
  }

  public async create(input: TaskCreateInput): Promise<Task> {
    const normalized = normalizeCreate(input)
    const at = this.#clock.now()
    const task: Task = {
      id: nextTaskId(at),
      title: normalized.title,
      description: normalized.description ?? '',
      status: normalized.status ?? 'backlog',
      hostScope: normalized.hostScope,
      ...(normalized.workspace === undefined ? {} : { workspace: normalized.workspace }),
      priority: normalized.priority,
      ...(normalized.acceptance === undefined ? {} : { acceptance: normalized.acceptance }),
      tags: normalized.tags ?? [],
      version: 1,
      claim: null,
      outputs: [],
      failureCount: 0,
      createdAt: at,
      updatedAt: at,
    }
    await this.#store.update((ledger): TaskLedger =>
      withAudit(
        { ...ledger, tasks: [...ledger.tasks, task] },
        task.id,
        'created',
        SYSTEM_ACTOR,
        at,
      ),
    )
    this.#emit({ type: 'created', task })
    return task
  }

  public async update(id: TaskId, patch: TaskPatch, expectedVersion: number): Promise<Task> {
    let updated: Task | undefined
    await this.#store.update((ledger): TaskLedger => {
      const index = taskIndex(ledger, id)
      const current = ledger.tasks[index]
      if (current === undefined) throw new LubanError('E_IO', 'Task index became inconsistent')
      requireVersion(current, expectedVersion)
      const workspace =
        patch.workspace === null
          ? undefined
          : patch.workspace === undefined
            ? current.workspace
            : trimmed(patch.workspace, 'workspace', 2_048)
      const acceptance =
        patch.acceptance === null
          ? undefined
          : patch.acceptance === undefined
            ? current.acceptance
            : trimmed(patch.acceptance, 'acceptance', 10_000, true)
      if (current.status === 'todo' && (acceptance === undefined || acceptance === '')) {
        throw new LubanError('E_ACCEPTANCE_REQUIRED', 'todo tasks require acceptance criteria')
      }
      const at = this.#clock.now()
      const next: Task = {
        id: current.id,
        title: patch.title === undefined ? current.title : trimmed(patch.title, 'title', 200),
        description:
          patch.description === undefined
            ? current.description
            : trimmed(patch.description, 'description', 10_000, true),
        status: current.status,
        hostScope: current.hostScope,
        ...(workspace === undefined ? {} : { workspace }),
        priority: patch.priority ?? current.priority,
        ...(acceptance === undefined ? {} : { acceptance }),
        tags: patch.tags === undefined ? current.tags : normalizeTags(patch.tags),
        version: current.version + 1,
        ...(current.claim === undefined ? {} : { claim: current.claim }),
        outputs: current.outputs,
        ...(current.autoDone === undefined ? {} : { autoDone: current.autoDone }),
        ...(current.nightRunId === undefined ? {} : { nightRunId: current.nightRunId }),
        ...(current.failureCount === undefined ? {} : { failureCount: current.failureCount }),
        createdAt: current.createdAt,
        updatedAt: at,
      }
      updated = next
      return withAudit(replaceTask(ledger, index, next), id, 'updated', SYSTEM_ACTOR, at)
    })
    if (updated === undefined) throw new LubanError('E_IO', 'Task update did not commit')
    this.#emit({ type: 'updated', task: updated })
    return updated
  }

  public async transition(id: TaskId, to: TaskStatus, actor: Actor, note?: string): Promise<Task> {
    return this.transitionWithVersion(id, to, actor, undefined, note)
  }

  public async transitionWithVersion(
    id: TaskId,
    to: TaskStatus,
    actor: Actor,
    expectedVersion?: number,
    note?: string,
  ): Promise<Task> {
    let before: Task | undefined
    let updated: Task | undefined
    await this.#store.update((ledger): TaskLedger => {
      const index = taskIndex(ledger, id)
      const current = ledger.tasks[index]
      if (current === undefined) throw new LubanError('E_IO', 'Task index became inconsistent')
      if (expectedVersion !== undefined) requireVersion(current, expectedVersion)
      validateTransition(current, to)
      const at = this.#clock.now()
      before = current
      updated = {
        ...current,
        status: to,
        ...(to === 'doing' ? {} : { claim: null }),
        ...(to === 'done' ? { autoDone: false } : {}),
        version: current.version + 1,
        updatedAt: at,
      }
      return withAudit(
        replaceTask(ledger, index, updated),
        id,
        `transition:${current.status}->${to}`,
        actor,
        at,
        note,
      )
    })
    if (before === undefined || updated === undefined) {
      throw new LubanError('E_IO', 'Task transition did not commit')
    }
    this.#emit({
      type: 'transitioned',
      task: updated,
      from: before.status,
      to,
      actor,
      ...(note === undefined ? {} : { note }),
    })
    return updated
  }

  public async get(id: TaskId): Promise<Task | null> {
    return (await this.#store.read()).tasks.find((task): boolean => task.id === id) ?? null
  }

  public async query(filter: TaskQuery = {}): Promise<readonly Task[]> {
    return (await this.#store.read()).tasks
      .filter((task): boolean => matches(task, filter))
      .sort(
        (left, right): number =>
          PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
          left.createdAt - right.createdAt,
      )
  }

  public subscribe(listener: (event: TaskEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return (): void => {
      this.#listeners.delete(listener)
    }
  }

  public async atomicClaim(input: AtomicClaimInput): Promise<Task | null> {
    let claimed: Task | undefined
    await this.#store.update((ledger): TaskLedger => {
      const candidates = ledger.tasks
        .map((task, index): { readonly task: Task; readonly index: number } => ({ task, index }))
        .filter(
          ({ task }): boolean =>
            task.status === 'todo' &&
            (task.hostScope === 'any' || task.hostScope === input.host) &&
            (input.statuses === undefined || input.statuses.includes(task.status)) &&
            (input.workspace === undefined || task.workspace === input.workspace) &&
            (input.tags === undefined ||
              input.tags.every((tag): boolean => task.tags.includes(tag))) &&
            (!input.requireAcceptance ||
              (task.acceptance !== undefined && task.acceptance.trim() !== '')),
        )
        .sort(
          (left, right): number =>
            PRIORITY_ORDER[left.task.priority] - PRIORITY_ORDER[right.task.priority] ||
            left.task.createdAt - right.task.createdAt,
        )
      const selected = candidates[0]
      if (selected === undefined) return ledger
      const at = this.#clock.now()
      claimed = {
        ...selected.task,
        status: 'doing',
        claim: {
          actor: input.actor,
          sessionId: input.sessionId,
          claimedAt: at,
          leaseId: `lease-${String(ledger.sequence + 1)}-${randomBytes(8).toString('hex')}`,
          ...(input.executionOwner === undefined ? {} : { executionOwner: input.executionOwner }),
        },
        version: selected.task.version + 1,
        updatedAt: at,
      }
      return withAudit(
        replaceTask(ledger, selected.index, claimed),
        claimed.id,
        'claimed',
        input.actor,
        at,
      )
    })
    if (claimed !== undefined) {
      this.#emit({
        type: 'transitioned',
        task: claimed,
        from: 'todo',
        to: 'doing',
        actor: input.actor,
      })
    }
    return claimed ?? null
  }

  public async appendOutput(
    id: TaskId,
    output: Task['outputs'][number],
    options: AppendOutputOptions,
  ): Promise<Task> {
    let before: Task | undefined
    let updated: Task | undefined
    await this.#store.update((ledger): TaskLedger => {
      const index = taskIndex(ledger, id)
      const current = ledger.tasks[index]
      if (current === undefined) throw new LubanError('E_IO', 'Task index became inconsistent')
      requireExpectedClaim(current, options.expectedClaim)
      if (
        options.transitionToReview &&
        (current.status !== 'doing' || current.claim === undefined || current.claim === null)
      ) {
        throw new LubanError('E_INVALID_TRANSITION', 'Only claimed doing tasks can be completed')
      }
      if (
        options.transitionToReview &&
        current.claim !== undefined &&
        current.claim !== null &&
        (current.claim.actor.kind !== output.by.kind || current.claim.actor.id !== output.by.id)
      ) {
        throw new LubanError('E_AUTH_REQUIRED', 'Only the claiming actor can complete the task')
      }
      const at = this.#clock.now()
      before = current
      updated = {
        ...current,
        ...(options.transitionToReview ? { status: 'review' as const, claim: null } : {}),
        outputs: [...current.outputs, output],
        ...(options.autoDone ? { autoDone: true } : {}),
        version: current.version + 1,
        updatedAt: at,
      }
      return withAudit(
        replaceTask(ledger, index, updated),
        id,
        'output',
        output.by,
        at,
        output.summary,
      )
    })
    if (before === undefined || updated === undefined)
      throw new LubanError('E_IO', 'Task output did not commit')
    if (options.transitionToReview) {
      this.#emit({
        type: 'transitioned',
        task: updated,
        from: before.status,
        to: 'review',
        actor: output.by,
      })
    } else {
      this.#emit({ type: 'updated', task: updated })
    }
    return updated
  }

  public async fail(id: TaskId, reason: string, options: ClaimMutationOptions = {}): Promise<Task> {
    const summary = trimmed(reason, 'reason', 4_000)
    let actor: Actor | undefined
    let updated: Task | undefined
    await this.#store.update((ledger): TaskLedger => {
      const index = taskIndex(ledger, id)
      const current = ledger.tasks[index]
      if (current === undefined) throw new LubanError('E_IO', 'Task index became inconsistent')
      requireExpectedClaim(current, options.expectedClaim)
      if (current.status !== 'doing' || current.claim === undefined || current.claim === null) {
        throw new LubanError('E_INVALID_TRANSITION', 'Only claimed doing tasks can fail')
      }
      const at = this.#clock.now()
      actor = current.claim.actor
      const failureCount = (current.failureCount ?? 0) + 1
      const next: Task = {
        ...current,
        status: 'todo',
        claim: null,
        outputs: [
          ...current.outputs,
          {
            kind: 'note',
            ref: `failure:${String(failureCount)}`,
            summary,
            at,
            by: actor,
          },
        ],
        failureCount,
        version: current.version + 1,
        updatedAt: at,
      }
      updated = next
      return withAudit(replaceTask(ledger, index, next), id, 'failed', actor, at, summary)
    })
    if (updated === undefined || actor === undefined)
      throw new LubanError('E_IO', 'Task failure did not commit')
    this.#emit({
      type: 'transitioned',
      task: updated,
      from: 'doing',
      to: 'todo',
      actor,
      note: summary,
    })
    return updated
  }

  public async import(tasks: readonly ImportTask[]): Promise<ImportReport> {
    const errors: { index: number; message: string }[] = []
    let imported = 0
    let skipped = 0
    const emitted: Task[] = []
    await this.#store.update((ledger): TaskLedger => {
      let next = ledger
      const identities = new Set(
        ledger.tasks.map(
          (task): string => `${task.title.toLocaleLowerCase()}\0${task.workspace ?? ''}`,
        ),
      )
      tasks.forEach((item, index): void => {
        try {
          const normalized = normalizeCreate({
            title: item.title,
            description: item.description ?? '',
            status: item.status ?? 'backlog',
            hostScope: item.hostScope ?? 'any',
            priority: item.priority ?? 'P2',
            ...(item.workspace === undefined ? {} : { workspace: item.workspace }),
            ...(item.acceptance === undefined ? {} : { acceptance: item.acceptance }),
            tags: item.tags ?? [],
          })
          const identity = `${normalized.title.toLocaleLowerCase()}\0${normalized.workspace ?? ''}`
          if (identities.has(identity)) {
            skipped += 1
            return
          }
          const at = this.#clock.now()
          const task: Task = {
            id: nextTaskId(at),
            title: normalized.title,
            description: normalized.description ?? '',
            status: normalized.status ?? 'backlog',
            hostScope: normalized.hostScope,
            ...(normalized.workspace === undefined ? {} : { workspace: normalized.workspace }),
            priority: normalized.priority,
            ...(normalized.acceptance === undefined ? {} : { acceptance: normalized.acceptance }),
            tags: normalized.tags ?? [],
            version: 1,
            claim: null,
            outputs: [],
            failureCount: 0,
            createdAt: at,
            updatedAt: at,
          }
          next = withAudit(
            { ...next, tasks: [...next.tasks, task] },
            task.id,
            'imported',
            SYSTEM_ACTOR,
            at,
          )
          identities.add(identity)
          emitted.push(task)
          imported += 1
        } catch (error: unknown) {
          errors.push({ index, message: error instanceof Error ? error.message : 'invalid task' })
        }
      })
      return next
    })
    for (const task of emitted) this.#emit({ type: 'created', task })
    return { imported, skipped, failed: errors.length, errors }
  }

  public async schedulerLedger(): Promise<SchedulerLedger> {
    return (await this.#store.read()).scheduler
  }

  public async updateScheduler(
    updater: (current: SchedulerLedger) => SchedulerLedger,
  ): Promise<SchedulerLedger> {
    let updated: SchedulerLedger | undefined
    await this.#store.update((ledger): TaskLedger => {
      updated = updater(ledger.scheduler)
      return { ...ledger, scheduler: updated }
    })
    if (updated === undefined) throw new LubanError('E_IO', 'Scheduler state did not commit')
    return updated
  }

  #emit(event: TaskEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch {
        process.emitWarning('A task event listener failed after the ledger commit', {
          code: 'LUBAN_TASK_EVENT_LISTENER',
        })
      }
    }
  }
}
