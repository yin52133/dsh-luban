import type {
  AccountId,
  Checkpoint,
  Clock,
  JsonCodec,
  ManagedSession,
  SessionSpec,
  TaskId,
} from 'dsh-luban-core'
import {
  asAccountId,
  asHostId,
  asTaskId,
  AtomicJsonStore,
  LubanError,
  systemClock,
} from 'dsh-luban-core'
import { managedSessionId } from './session-id.js'

export interface KeepaliveRecord {
  readonly spec: SessionSpec
  readonly session: ManagedSession
  readonly checkpoint?: Checkpoint
}

export interface KeepaliveLedger {
  readonly schemaVersion: 1
  readonly sessions: Readonly<Record<string, KeepaliveRecord>>
  readonly updatedAt: number
}

function objectValue(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '')
    throw new TypeError(`${name} must be a non-empty string`)
  return value
}

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`)
  }
  return value
}

function textList(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new TypeError(`${name} must be a string array`)
  }
  return [...value]
}

function optionalAccountId(value: unknown, name: string): AccountId | undefined {
  return value === undefined ? undefined : asAccountId(text(value, name))
}

function decodeSpec(value: unknown, name: string): SessionSpec {
  const row = objectValue(value, name)
  const accountId = optionalAccountId(row.accountId, `${name}.accountId`)
  const purpose = row.purpose
  if (purpose !== 'dsh-main' && purpose !== 'task' && purpose !== 'build') {
    throw new TypeError(`${name}.purpose is invalid`)
  }
  return {
    ...(accountId === undefined ? {} : { accountId }),
    id: text(row.id, `${name}.id`),
    purpose,
    command: text(row.command, `${name}.command`),
    ...(row.args === undefined ? {} : { args: textList(row.args, `${name}.args`) }),
    ...(row.ownerTaskId === undefined
      ? {}
      : { ownerTaskId: asTaskId(text(row.ownerTaskId, `${name}.ownerTaskId`)) }),
  }
}

function decodeSession(value: unknown, name: string): ManagedSession {
  const row = objectValue(value, name)
  const accountId = optionalAccountId(row.accountId, `${name}.accountId`)
  const kind = row.kind
  const purpose = row.purpose
  if (kind !== 'tmux' && kind !== 'service') throw new TypeError(`${name}.kind is invalid`)
  if (purpose !== 'dsh-main' && purpose !== 'task' && purpose !== 'build') {
    throw new TypeError(`${name}.purpose is invalid`)
  }
  return {
    ...(accountId === undefined ? {} : { accountId }),
    id: text(row.id, `${name}.id`),
    host: asHostId(text(row.host, `${name}.host`)),
    kind,
    purpose,
    ...(row.ownerTaskId === undefined
      ? {}
      : { ownerTaskId: asTaskId(text(row.ownerTaskId, `${name}.ownerTaskId`)) }),
    createdAt: integer(row.createdAt, `${name}.createdAt`),
  }
}

function decodeCheckpoint(value: unknown, name: string): Checkpoint {
  const row = objectValue(value, name)
  const accountId = optionalAccountId(row.accountId, `${name}.accountId`)
  const stepList = textList(row.stepList, `${name}.stepList`)
  const currentStep = integer(row.currentStep, `${name}.currentStep`)
  if (currentStep > stepList.length) throw new TypeError(`${name}.currentStep exceeds stepList`)
  return {
    ...(accountId === undefined ? {} : { accountId }),
    taskId: asTaskId(text(row.taskId, `${name}.taskId`)),
    stepList,
    currentStep,
    artifacts: textList(row.artifacts, `${name}.artifacts`),
    savedAt: integer(row.savedAt, `${name}.savedAt`),
  }
}

function consistencyIssue(
  key: string,
  spec: SessionSpec,
  session: ManagedSession,
  checkpoint?: Checkpoint,
): string | null {
  try {
    if (managedSessionId(key) !== key) return 'session key is outside the managed namespace'
  } catch {
    return 'session key is outside the managed namespace'
  }
  if (spec.id !== key) return 'spec id does not match the session key'
  if (session.id !== key) return 'session id does not match the session key'
  if (spec.purpose !== session.purpose) return 'spec and session purposes do not match'
  if (spec.accountId !== session.accountId) return 'spec and session accounts do not match'
  if (spec.ownerTaskId !== session.ownerTaskId) return 'spec and session owners do not match'
  if (checkpoint !== undefined) {
    if (spec.ownerTaskId === undefined) return 'checkpoint requires an owned session'
    if (checkpoint.taskId !== spec.ownerTaskId) return 'checkpoint task does not own the session'
    if (checkpoint.accountId !== spec.accountId)
      return 'checkpoint and session accounts do not match'
  }
  return null
}

function assertDecodedConsistency(
  key: string,
  spec: SessionSpec,
  session: ManagedSession,
  checkpoint?: Checkpoint,
): void {
  const issue = consistencyIssue(key, spec, session, checkpoint)
  if (issue !== null) throw new TypeError(`ledger session ${key} is invalid: ${issue}`)
}

function assertWritableConsistency(
  key: string,
  spec: SessionSpec,
  session: ManagedSession,
  checkpoint?: Checkpoint,
): void {
  const issue = consistencyIssue(key, spec, session, checkpoint)
  if (issue !== null)
    throw new LubanError('E_INVALID_INPUT', `Managed session is invalid: ${issue}`)
}

export function emptyLedger(clock: Clock = systemClock): KeepaliveLedger {
  return { schemaVersion: 1, sessions: {}, updatedAt: clock.now() }
}

export const keepaliveLedgerCodec: JsonCodec<KeepaliveLedger> = Object.freeze({
  decode(value: unknown): KeepaliveLedger {
    const root = objectValue(value, 'ledger')
    if (root.schemaVersion !== 1) throw new TypeError('ledger.schemaVersion must be 1')
    const rawSessions = objectValue(root.sessions, 'ledger.sessions')
    const sessions: Record<string, KeepaliveRecord> = {}
    for (const [id, raw] of Object.entries(rawSessions)) {
      const row = objectValue(raw, `ledger.sessions.${id}`)
      const spec = decodeSpec(row.spec, `ledger.sessions.${id}.spec`)
      const session = decodeSession(row.session, `ledger.sessions.${id}.session`)
      const checkpoint =
        row.checkpoint === undefined
          ? undefined
          : decodeCheckpoint(row.checkpoint, `ledger.sessions.${id}.checkpoint`)
      assertDecodedConsistency(id, spec, session, checkpoint)
      sessions[id] = {
        spec,
        session,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      }
    }
    return {
      schemaVersion: 1,
      sessions,
      updatedAt: integer(root.updatedAt, 'ledger.updatedAt'),
    }
  },
  encode(value: KeepaliveLedger): unknown {
    return value
  },
})

export class KeepaliveLedgerStore {
  readonly #store: AtomicJsonStore<KeepaliveLedger>
  readonly #clock: Clock

  public constructor(filePath: string, clock: Clock = systemClock) {
    this.#clock = clock
    this.#store = new AtomicJsonStore({
      filePath,
      codec: keepaliveLedgerCodec,
      initial: (): KeepaliveLedger => emptyLedger(clock),
    })
  }

  public read(): Promise<KeepaliveLedger> {
    return this.#store.read()
  }

  public async upsert(spec: SessionSpec, session: ManagedSession): Promise<KeepaliveRecord> {
    assertWritableConsistency(session.id, spec, session)
    let saved: KeepaliveRecord | undefined
    await this.#store.update((current): KeepaliveLedger => {
      const prior = current.sessions[session.id]
      assertWritableConsistency(session.id, spec, session, prior?.checkpoint)
      saved = {
        spec,
        session,
        ...(prior?.checkpoint === undefined ? {} : { checkpoint: prior.checkpoint }),
      }
      return {
        schemaVersion: 1,
        sessions: { ...current.sessions, [session.id]: saved },
        updatedAt: this.#clock.now(),
      }
    })
    if (saved === undefined) throw new LubanError('E_IO', 'Unable to persist managed session')
    return saved
  }

  public async checkpoint(id: string, checkpoint: Checkpoint): Promise<void> {
    await this.#store.update((current): KeepaliveLedger => {
      const record = current.sessions[id]
      if (record === undefined)
        throw new LubanError('E_NOT_FOUND', `Managed session ${id} was not found`)
      const owner: TaskId | undefined = record.spec.ownerTaskId
      if (owner === undefined || owner !== checkpoint.taskId) {
        throw new LubanError('E_INVALID_INPUT', 'checkpoint task does not own this session')
      }
      if (checkpoint.accountId !== undefined && checkpoint.accountId !== record.spec.accountId) {
        throw new LubanError(
          'E_ACCOUNT_SCOPE_MISMATCH',
          'checkpoint account does not own this session',
        )
      }
      const scopedCheckpoint: Checkpoint =
        record.spec.accountId === undefined
          ? checkpoint
          : { ...checkpoint, accountId: record.spec.accountId }
      assertWritableConsistency(id, record.spec, record.session, scopedCheckpoint)
      return {
        schemaVersion: 1,
        sessions: { ...current.sessions, [id]: { ...record, checkpoint: scopedCheckpoint } },
        updatedAt: this.#clock.now(),
      }
    })
  }

  public async remove(id: string): Promise<boolean> {
    let removed = false
    await this.#store.update((current): KeepaliveLedger => {
      if (current.sessions[id] === undefined) return current
      removed = true
      const sessions = Object.fromEntries(
        Object.entries(current.sessions).filter(([sessionId]) => sessionId !== id),
      )
      return {
        schemaVersion: 1,
        sessions,
        updatedAt: this.#clock.now(),
      }
    })
    return removed
  }
}
