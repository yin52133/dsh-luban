import { randomBytes } from 'node:crypto'
import type {
  AccountId,
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
} from 'dsh-luban-core'
import { LubanError, asTaskId, systemClock } from 'dsh-luban-core'
import type { AtomicJsonStore } from 'dsh-luban-core'
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
  readonly accountId?: AccountId
  readonly actor: Actor
  readonly sessionId: SessionId
  readonly host: 'win' | 'ubuntu'
  readonly executionOwner?: 'night-scheduler'
  readonly statuses?: readonly TaskStatus[]
  readonly workspace?: string
  readonly tags?: readonly string[]
  readonly requireAcceptance: boolean
}

export interface AtomicNightClaimInput extends Omit<
  AtomicClaimInput,
  'accountId' | 'executionOwner'
> {
  readonly accountId: AccountId
  readonly dateKey: string
  readonly dailyQuota: number
}

export type AtomicNightClaimResult =
  | {
      readonly ok: true
      readonly task: Task
      readonly scheduler: SchedulerLedger
      readonly quotaAllocated: number
    }
  | {
      readonly ok: false
      readonly reason: 'circuit-open' | 'quota-exceeded' | 'no-match'
      readonly scheduler: SchedulerLedger
      readonly quotaAllocated: number
    }

export type NightRunSettlementInput =
  | {
      readonly kind: 'complete'
      readonly id: TaskId
      readonly expectedClaim: TaskClaim
      readonly output: Task['outputs'][number]
      readonly autoDone: boolean
      readonly dailyQuota: number
    }
  | {
      readonly kind: 'fail'
      readonly id: TaskId
      readonly expectedClaim: TaskClaim
      readonly reason: string
      readonly maxConsecutiveFailures: number
    }

export interface NightRunSettlementResult {
  readonly task: Task
  readonly scheduler: SchedulerLedger
  readonly quotaAllocated: number
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
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
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

function newTask(input: TaskCreateInput, at: number): Task {
  return {
    id: nextTaskId(at),
    ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
    title: input.title,
    description: input.description ?? '',
    status: input.status ?? 'backlog',
    hostScope: input.hostScope,
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    priority: input.priority,
    ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
    tags: input.tags ?? [],
    version: 1,
    claim: null,
    outputs: [],
    failureCount: 0,
    createdAt: at,
    updatedAt: at,
  }
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
  if (filter.accountId !== undefined && task.accountId !== filter.accountId) return false
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

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be a positive safe integer`)
  }
  return value
}

function schedulerForDate(current: SchedulerLedger, dateKey: string): SchedulerLedger {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateKey)) {
    throw new LubanError('E_INVALID_INPUT', 'dateKey must use YYYY-MM-DD')
  }
  return current.dateKey === dateKey
    ? current
    : { dateKey, quotaUsed: 0, consecutiveFailures: 0, circuit: 'ok' }
}

function emptyScheduler(dateKey: string): SchedulerLedger {
  return schedulerForDate(
    { dateKey: '1970-01-01', quotaUsed: 0, consecutiveFailures: 0, circuit: 'ok' },
    dateKey,
  )
}

function accountScheduler(
  ledger: TaskLedger,
  accountId: AccountId,
  dateKey: string,
): SchedulerLedger {
  return schedulerForDate(ledger.schedulers[String(accountId)] ?? emptyScheduler(dateKey), dateKey)
}

function withAccountScheduler(
  ledger: TaskLedger,
  accountId: AccountId,
  scheduler: SchedulerLedger,
): TaskLedger {
  if (ledger.schedulers[String(accountId)] === scheduler) return ledger
  return {
    ...ledger,
    schedulers: { ...ledger.schedulers, [String(accountId)]: scheduler },
  }
}

function nightRunDateKey(task: Task): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}):/u.exec(task.nightRunId ?? '')
  return match?.[1]
}

function isActiveNightRun(task: Task): boolean {
  return task.status === 'doing' && task.claim?.executionOwner === 'night-scheduler'
}

function localDateKey(epochMs: number): string {
  const value = new Date(epochMs)
  const year = String(value.getFullYear()).padStart(4, '0')
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function allocatedNightQuota(ledger: TaskLedger, accountId: AccountId, dateKey: string): number {
  const scheduler = accountScheduler(ledger, accountId, dateKey)
  const activeRuns = ledger.tasks.filter(
    (task): boolean =>
      task.accountId === accountId &&
      task.status === 'doing' &&
      task.claim?.executionOwner === 'night-scheduler' &&
      (nightRunDateKey(task) ?? localDateKey(task.claim.claimedAt)) === dateKey,
  ).length
  return scheduler.quotaUsed + activeRuns
}

function claimCandidate(
  ledger: TaskLedger,
  input: AtomicClaimInput,
): { readonly task: Task; readonly index: number } | undefined {
  const accountId = input.accountId ?? input.actor.accountId
  return ledger.tasks
    .map((task, index): { readonly task: Task; readonly index: number } => ({ task, index }))
    .filter(
      ({ task }): boolean =>
        task.status === 'todo' &&
        (accountId === undefined || task.accountId === accountId) &&
        (task.hostScope === 'any' || task.hostScope === input.host) &&
        (input.statuses === undefined || input.statuses.includes(task.status)) &&
        (input.workspace === undefined || task.workspace === input.workspace) &&
        (input.tags === undefined || input.tags.every((tag): boolean => task.tags.includes(tag))) &&
        (!input.requireAcceptance ||
          (task.acceptance !== undefined && task.acceptance.trim() !== '')),
    )
    .sort(
      (left, right): number =>
        PRIORITY_ORDER[left.task.priority] - PRIORITY_ORDER[right.task.priority] ||
        left.task.createdAt - right.task.createdAt,
    )[0]
}

function claimTask(
  ledger: TaskLedger,
  selected: { readonly task: Task; readonly index: number },
  input: AtomicClaimInput,
  at: number,
  dateKey?: string,
): { readonly ledger: TaskLedger; readonly task: Task } {
  const leaseId = `lease-${String(ledger.sequence + 1)}-${randomBytes(8).toString('hex')}`
  const actor =
    input.actor.accountId === undefined && selected.task.accountId !== undefined
      ? { ...input.actor, accountId: selected.task.accountId }
      : input.actor
  const task: Task = {
    ...selected.task,
    status: 'doing',
    claim: {
      actor,
      sessionId: input.sessionId,
      claimedAt: at,
      leaseId,
      ...(input.executionOwner === undefined ? {} : { executionOwner: input.executionOwner }),
    },
    ...(dateKey === undefined ? {} : { nightRunId: `${dateKey}:${leaseId}` }),
    version: selected.task.version + 1,
    updatedAt: at,
  }
  return {
    task,
    ledger: withAudit(replaceTask(ledger, selected.index, task), task.id, 'claimed', actor, at),
  }
}

interface CommittedTaskMutation {
  readonly ledger: TaskLedger
  readonly before: Task
  readonly task: Task
  readonly actor: Actor
}

function appendOutputMutation(
  ledger: TaskLedger,
  id: TaskId,
  output: Task['outputs'][number],
  options: AppendOutputOptions,
  at: number,
): CommittedTaskMutation {
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
  const task: Task = {
    ...current,
    ...(options.transitionToReview ? { status: 'review' as const, claim: null } : {}),
    outputs: [...current.outputs, output],
    ...(options.autoDone ? { autoDone: true } : {}),
    version: current.version + 1,
    updatedAt: at,
  }
  return {
    before: current,
    task,
    actor: output.by,
    ledger: withAudit(
      replaceTask(ledger, index, task),
      id,
      'output',
      output.by,
      at,
      output.summary,
    ),
  }
}

function failTaskMutation(
  ledger: TaskLedger,
  id: TaskId,
  summary: string,
  options: ClaimMutationOptions,
  at: number,
): CommittedTaskMutation {
  const index = taskIndex(ledger, id)
  const current = ledger.tasks[index]
  if (current === undefined) throw new LubanError('E_IO', 'Task index became inconsistent')
  requireExpectedClaim(current, options.expectedClaim)
  if (current.status !== 'doing' || current.claim === undefined || current.claim === null) {
    throw new LubanError('E_INVALID_TRANSITION', 'Only claimed doing tasks can fail')
  }
  const actor = current.claim.actor
  const failureCount = (current.failureCount ?? 0) + 1
  const task: Task = {
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
  return {
    before: current,
    task,
    actor,
    ledger: withAudit(replaceTask(ledger, index, task), id, 'failed', actor, at, summary),
  }
}

function requireNightRun(task: Task, expectedClaim: TaskClaim): string {
  if (expectedClaim.executionOwner !== 'night-scheduler' || expectedClaim.leaseId === undefined) {
    throw new LubanError('E_INVALID_INPUT', 'A leased night-scheduler claim is required')
  }
  requireExpectedClaim(task, expectedClaim)
  const dateKey = nightRunDateKey(task)
  if (dateKey === undefined || task.nightRunId !== `${dateKey}:${expectedClaim.leaseId}`) {
    throw new LubanError('E_VERSION_CONFLICT', 'Night run identity has changed', {
      retriable: true,
    })
  }
  return dateKey
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
    const task = newTask(normalized, at)
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
        ...(current.accountId === undefined ? {} : { accountId: current.accountId }),
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
      const selected = claimCandidate(ledger, input)
      if (selected === undefined) return ledger
      const mutation = claimTask(ledger, selected, input, this.#clock.now())
      claimed = mutation.task
      return mutation.ledger
    })
    if (claimed !== undefined) {
      this.#emit({
        type: 'transitioned',
        task: claimed,
        from: 'todo',
        to: 'doing',
        actor: claimed.claim?.actor ?? input.actor,
      })
    }
    return claimed ?? null
  }

  /** Atomically reserves daily capacity and claims one night task across scheduler instances. */
  public async atomicNightClaim(input: AtomicNightClaimInput): Promise<AtomicNightClaimResult> {
    const dailyQuota = positiveSafeInteger(input.dailyQuota, 'dailyQuota')
    let result: AtomicNightClaimResult | undefined
    await this.#store.update((ledger): TaskLedger => {
      const scheduler = accountScheduler(ledger, input.accountId, input.dateKey)
      const normalized = withAccountScheduler(ledger, input.accountId, scheduler)
      const quotaAllocated = allocatedNightQuota(normalized, input.accountId, input.dateKey)
      if (scheduler.circuit === 'open') {
        result = { ok: false, reason: 'circuit-open', scheduler, quotaAllocated }
        return normalized
      }
      if (quotaAllocated >= dailyQuota) {
        result = { ok: false, reason: 'quota-exceeded', scheduler, quotaAllocated }
        return normalized
      }
      const selected = claimCandidate(normalized, input)
      if (selected === undefined) {
        result = { ok: false, reason: 'no-match', scheduler, quotaAllocated }
        return normalized
      }
      const mutation = claimTask(
        normalized,
        selected,
        { ...input, executionOwner: 'night-scheduler' },
        this.#clock.now(),
        input.dateKey,
      )
      result = {
        ok: true,
        task: mutation.task,
        scheduler,
        quotaAllocated: quotaAllocated + 1,
      }
      return mutation.ledger
    })
    if (result === undefined) throw new LubanError('E_IO', 'Night claim did not commit')
    if (result.ok) {
      this.#emit({
        type: 'transitioned',
        task: result.task,
        from: 'todo',
        to: 'doing',
        actor: result.task.claim?.actor ?? input.actor,
      })
    }
    return result
  }

  public async appendOutput(
    id: TaskId,
    output: Task['outputs'][number],
    options: AppendOutputOptions,
  ): Promise<Task> {
    let mutation: CommittedTaskMutation | undefined
    await this.#store.update((ledger): TaskLedger => {
      mutation = appendOutputMutation(ledger, id, output, options, this.#clock.now())
      return mutation.ledger
    })
    if (mutation === undefined) throw new LubanError('E_IO', 'Task output did not commit')
    if (options.transitionToReview) {
      this.#emit({
        type: 'transitioned',
        task: mutation.task,
        from: mutation.before.status,
        to: 'review',
        actor: output.by,
      })
    } else {
      this.#emit({ type: 'updated', task: mutation.task })
    }
    return mutation.task
  }

  public async fail(id: TaskId, reason: string, options: ClaimMutationOptions = {}): Promise<Task> {
    const summary = trimmed(reason, 'reason', 4_000)
    let mutation: CommittedTaskMutation | undefined
    await this.#store.update((ledger): TaskLedger => {
      mutation = failTaskMutation(ledger, id, summary, options, this.#clock.now())
      return mutation.ledger
    })
    if (mutation === undefined) throw new LubanError('E_IO', 'Task failure did not commit')
    this.#emit({
      type: 'transitioned',
      task: mutation.task,
      from: 'doing',
      to: 'todo',
      actor: mutation.actor,
      note: summary,
    })
    return mutation.task
  }

  /** Commits a night task terminal mutation and its scheduler accounting in one ledger publish. */
  public async settleNightRun(input: NightRunSettlementInput): Promise<NightRunSettlementResult> {
    const summary = input.kind === 'fail' ? trimmed(input.reason, 'reason', 4_000) : undefined
    if (input.kind === 'complete') positiveSafeInteger(input.dailyQuota, 'dailyQuota')
    if (input.kind === 'fail') {
      positiveSafeInteger(input.maxConsecutiveFailures, 'maxConsecutiveFailures')
    }
    let mutation: CommittedTaskMutation | undefined
    let scheduler: SchedulerLedger | undefined
    let quotaAllocated: number | undefined
    await this.#store.update((ledger): TaskLedger => {
      const index = taskIndex(ledger, input.id)
      const current = ledger.tasks[index]
      if (current === undefined) throw new LubanError('E_IO', 'Task index became inconsistent')
      if (current.accountId === undefined) {
        throw new LubanError('E_ACCOUNT_SCOPE_MISMATCH', 'Night task has no account ownership')
      }
      const accountId = current.accountId
      const runDateKey = requireNightRun(current, input.expectedClaim)
      const at = this.#clock.now()
      mutation =
        input.kind === 'complete'
          ? appendOutputMutation(
              ledger,
              input.id,
              input.output,
              {
                transitionToReview: true,
                autoDone: input.autoDone,
                expectedClaim: input.expectedClaim,
              },
              at,
            )
          : failTaskMutation(
              ledger,
              input.id,
              summary ?? 'Autonomous execution failed',
              { expectedClaim: input.expectedClaim },
              at,
            )
      const currentScheduler = ledger.schedulers[String(accountId)] ?? emptyScheduler(runDateKey)
      if (currentScheduler.dateKey !== runDateKey) {
        scheduler = currentScheduler
      } else if (input.kind === 'complete') {
        if (currentScheduler.quotaUsed >= input.dailyQuota) {
          throw new LubanError('E_QUOTA_EXCEEDED', 'Night scheduler quota is already exhausted', {
            retriable: true,
          })
        }
        scheduler = {
          ...currentScheduler,
          quotaUsed: currentScheduler.quotaUsed + 1,
          consecutiveFailures: 0,
          circuit: 'ok',
        }
      } else {
        const consecutiveFailures = currentScheduler.consecutiveFailures + 1
        scheduler = {
          ...currentScheduler,
          consecutiveFailures,
          circuit:
            consecutiveFailures >= input.maxConsecutiveFailures
              ? ('open' as const)
              : ('ok' as const),
        }
      }
      const settledLedger = withAccountScheduler(mutation.ledger, accountId, scheduler)
      quotaAllocated = allocatedNightQuota(settledLedger, accountId, scheduler.dateKey)
      return settledLedger
    })
    if (mutation === undefined || scheduler === undefined || quotaAllocated === undefined) {
      throw new LubanError('E_IO', 'Night run settlement did not commit')
    }
    this.#emit({
      type: 'transitioned',
      task: mutation.task,
      from: mutation.before.status,
      to: input.kind === 'complete' ? 'review' : 'todo',
      actor: mutation.actor,
      ...(summary === undefined ? {} : { note: summary }),
    })
    return { task: mutation.task, scheduler, quotaAllocated }
  }

  public async import(tasks: readonly ImportTask[], accountId?: AccountId): Promise<ImportReport> {
    const errors: { index: number; message: string }[] = []
    let imported = 0
    let skipped = 0
    const emitted: Task[] = []
    await this.#store.update((ledger): TaskLedger => {
      let next = ledger
      const identities = new Set(
        ledger.tasks
          .filter((task): boolean => accountId === undefined || task.accountId === accountId)
          .map((task): string => `${task.title.toLocaleLowerCase()}\0${task.workspace ?? ''}`),
      )
      tasks.forEach((item, index): void => {
        try {
          const normalized = normalizeCreate({
            ...(accountId === undefined ? {} : { accountId }),
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
          const task = newTask(normalized, at)
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

  public async schedulerLedger(accountId: AccountId): Promise<SchedulerLedger> {
    const ledger = await this.#store.read()
    return accountScheduler(
      ledger,
      accountId,
      ledger.schedulers[String(accountId)]?.dateKey ?? '1970-01-01',
    )
  }

  public async nightSchedulerSnapshot(
    accountId: AccountId,
    dateKey: string,
  ): Promise<{ readonly scheduler: SchedulerLedger; readonly quotaAllocated: number }> {
    const ledger = await this.#store.read()
    const scheduler = accountScheduler(ledger, accountId, dateKey)
    const normalized = withAccountScheduler(ledger, accountId, scheduler)
    return {
      scheduler,
      quotaAllocated: allocatedNightQuota(normalized, accountId, dateKey),
    }
  }

  public async updateScheduler(
    accountId: AccountId,
    updater: (current: SchedulerLedger) => SchedulerLedger,
  ): Promise<SchedulerLedger> {
    let updated: SchedulerLedger | undefined
    await this.#store.update((ledger): TaskLedger => {
      const current =
        ledger.schedulers[String(accountId)] ??
        emptyScheduler(new Date(this.#clock.now()).toISOString().slice(0, 10))
      updated = updater(current)
      return withAccountScheduler(ledger, accountId, updated)
    })
    if (updated === undefined) throw new LubanError('E_IO', 'Scheduler state did not commit')
    return updated
  }

  public async nightSchedulerAccounts(): Promise<readonly AccountId[]> {
    const ledger = await this.#store.read()
    return [
      ...new Set(
        ledger.tasks.flatMap((task): readonly AccountId[] =>
          (task.status !== 'todo' && !isActiveNightRun(task)) || task.accountId === undefined
            ? []
            : [task.accountId],
        ),
      ),
    ].sort((left, right): number => String(left).localeCompare(String(right)))
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
