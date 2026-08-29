import type { Actor, Clock, Task, TaskId, TaskOutput, TaskStatus } from '@luban/core'
import { AtomicJsonStore, LubanError, asSessionId, asTaskId } from '@luban/core'

export interface SchedulerLedger {
  readonly dateKey: string
  readonly quotaUsed: number
  readonly consecutiveFailures: number
  readonly circuit: 'ok' | 'open'
}

export interface TaskAuditEntry {
  readonly sequence: number
  readonly taskId: TaskId
  readonly action: string
  readonly actor: Actor
  readonly at: number
  readonly detail?: string
}

export interface TaskLedger {
  readonly schemaVersion: 1
  readonly sequence: number
  readonly tasks: readonly Task[]
  readonly audit: readonly TaskAuditEntry[]
  readonly scheduler: SchedulerLedger
}

export function emptyLedger(dateKey = '1970-01-01'): TaskLedger {
  return {
    schemaVersion: 1,
    sequence: 0,
    tasks: [],
    audit: [],
    scheduler: { dateKey, quotaUsed: 0, consecutiveFailures: 0, circuit: 'ok' },
  }
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new LubanError('E_INVALID_INPUT', `${label} must be a string`)
  return value
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be a finite number`)
  }
  return value
}

function actorValue(value: unknown, label: string): Actor {
  const row = record(value, label)
  const kind = stringValue(row.kind, `${label}.kind`)
  if (kind !== 'user' && kind !== 'agent') {
    throw new LubanError('E_INVALID_INPUT', `${label}.kind is invalid`)
  }
  const id = stringValue(row.id, `${label}.id`) as Actor['id']
  return {
    kind,
    id,
    ...(typeof row.displayName === 'string' ? { displayName: row.displayName } : {}),
  }
}

const TASK_STATUSES = new Set<TaskStatus>(['backlog', 'todo', 'doing', 'review', 'done', 'dropped'])
const OUTPUT_KINDS = new Set<TaskOutput['kind']>(['note', 'commit', 'artifact', 'link'])

function taskValue(value: unknown, index: number): Task {
  const label = `tasks[${String(index)}]`
  const row = record(value, label)
  const status = stringValue(row.status, `${label}.status`) as TaskStatus
  if (!TASK_STATUSES.has(status))
    throw new LubanError('E_INVALID_INPUT', `${label}.status is invalid`)
  const hostScope = stringValue(row.hostScope, `${label}.hostScope`)
  if (hostScope !== 'win' && hostScope !== 'ubuntu' && hostScope !== 'any') {
    throw new LubanError('E_INVALID_INPUT', `${label}.hostScope is invalid`)
  }
  const priority = stringValue(row.priority, `${label}.priority`)
  if (priority !== 'P0' && priority !== 'P1' && priority !== 'P2' && priority !== 'P3') {
    throw new LubanError('E_INVALID_INPUT', `${label}.priority is invalid`)
  }
  if (
    !Array.isArray(row.tags) ||
    !row.tags.every((tag): tag is string => typeof tag === 'string')
  ) {
    throw new LubanError('E_INVALID_INPUT', `${label}.tags must be strings`)
  }
  if (!Array.isArray(row.outputs))
    throw new LubanError('E_INVALID_INPUT', `${label}.outputs must be an array`)
  const outputs = row.outputs.map((output, outputIndex) => {
    const outputLabel = `${label}.outputs[${String(outputIndex)}]`
    const item = record(output, outputLabel)
    const rawKind = stringValue(item.kind, `${outputLabel}.kind`)
    if (!OUTPUT_KINDS.has(rawKind as TaskOutput['kind'])) {
      throw new LubanError('E_INVALID_INPUT', `${outputLabel}.kind is invalid`)
    }
    const kind = rawKind as TaskOutput['kind']
    return {
      kind,
      ref: stringValue(item.ref, `${outputLabel}.ref`),
      summary: stringValue(item.summary, `${outputLabel}.summary`),
      at: numberValue(item.at, `${outputLabel}.at`),
      by: actorValue(item.by, `${outputLabel}.by`),
    }
  })
  const claim =
    row.claim === null || row.claim === undefined
      ? row.claim
      : (() => {
          const item = record(row.claim, `${label}.claim`)
          return {
            actor: actorValue(item.actor, `${label}.claim.actor`),
            sessionId: asSessionId(stringValue(item.sessionId, `${label}.claim.sessionId`)),
            claimedAt: numberValue(item.claimedAt, `${label}.claim.claimedAt`),
          }
        })()
  return {
    id: asTaskId(stringValue(row.id, `${label}.id`)),
    title: stringValue(row.title, `${label}.title`),
    description: stringValue(row.description, `${label}.description`),
    status,
    hostScope,
    ...(typeof row.workspace === 'string' ? { workspace: row.workspace } : {}),
    priority,
    ...(typeof row.acceptance === 'string' ? { acceptance: row.acceptance } : {}),
    tags: row.tags,
    version: numberValue(row.version, `${label}.version`),
    ...(claim === undefined ? {} : { claim }),
    outputs,
    ...(typeof row.autoDone === 'boolean' ? { autoDone: row.autoDone } : {}),
    ...(typeof row.nightRunId === 'string' ? { nightRunId: row.nightRunId } : {}),
    ...(typeof row.failureCount === 'number' ? { failureCount: row.failureCount } : {}),
    createdAt: numberValue(row.createdAt, `${label}.createdAt`),
    updatedAt: numberValue(row.updatedAt, `${label}.updatedAt`),
  }
}

export function decodeLedger(value: unknown): TaskLedger {
  const row = record(value, 'ledger')
  if (row.schemaVersion !== 1) throw new LubanError('E_INVALID_INPUT', 'unsupported ledger version')
  if (!Array.isArray(row.tasks) || !Array.isArray(row.audit)) {
    throw new LubanError('E_INVALID_INPUT', 'ledger tasks and audit must be arrays')
  }
  const scheduler = record(row.scheduler, 'ledger.scheduler')
  const circuit = stringValue(scheduler.circuit, 'ledger.scheduler.circuit')
  if (circuit !== 'ok' && circuit !== 'open') {
    throw new LubanError('E_INVALID_INPUT', 'ledger.scheduler.circuit is invalid')
  }
  return {
    schemaVersion: 1,
    sequence: numberValue(row.sequence, 'ledger.sequence'),
    tasks: row.tasks.map(taskValue),
    audit: row.audit.map((entry, index): TaskAuditEntry => {
      const label = `audit[${String(index)}]`
      const item = record(entry, label)
      return {
        sequence: numberValue(item.sequence, `${label}.sequence`),
        taskId: asTaskId(stringValue(item.taskId, `${label}.taskId`)),
        action: stringValue(item.action, `${label}.action`),
        actor: actorValue(item.actor, `${label}.actor`),
        at: numberValue(item.at, `${label}.at`),
        ...(typeof item.detail === 'string' ? { detail: item.detail } : {}),
      }
    }),
    scheduler: {
      dateKey: stringValue(scheduler.dateKey, 'ledger.scheduler.dateKey'),
      quotaUsed: numberValue(scheduler.quotaUsed, 'ledger.scheduler.quotaUsed'),
      consecutiveFailures: numberValue(
        scheduler.consecutiveFailures,
        'ledger.scheduler.consecutiveFailures',
      ),
      circuit,
    },
  }
}

export function createLedgerStore(filePath: string, clock: Clock): AtomicJsonStore<TaskLedger> {
  return new AtomicJsonStore({
    filePath,
    codec: { decode: decodeLedger, encode: (value): unknown => value },
    initial: (): TaskLedger => emptyLedger(new Date(clock.now()).toISOString().slice(0, 10)),
    backupCount: 7,
  })
}
