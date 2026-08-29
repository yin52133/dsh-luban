import type { Checkpoint, Clock, JsonCodec, ManagedSession, SessionSpec, TaskId } from '@luban/core'
import { asHostId, asTaskId, AtomicJsonStore, LubanError, systemClock } from '@luban/core'

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

function decodeSpec(value: unknown, name: string): SessionSpec {
  const row = objectValue(value, name)
  const purpose = row.purpose
  if (purpose !== 'dsh-main' && purpose !== 'task' && purpose !== 'build') {
    throw new TypeError(`${name}.purpose is invalid`)
  }
  return {
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
  const kind = row.kind
  const purpose = row.purpose
  if (kind !== 'tmux' && kind !== 'service') throw new TypeError(`${name}.kind is invalid`)
  if (purpose !== 'dsh-main' && purpose !== 'task' && purpose !== 'build') {
    throw new TypeError(`${name}.purpose is invalid`)
  }
  return {
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
  const stepList = textList(row.stepList, `${name}.stepList`)
  const currentStep = integer(row.currentStep, `${name}.currentStep`)
  if (currentStep > stepList.length) throw new TypeError(`${name}.currentStep exceeds stepList`)
  return {
    taskId: asTaskId(text(row.taskId, `${name}.taskId`)),
    stepList,
    currentStep,
    artifacts: textList(row.artifacts, `${name}.artifacts`),
    savedAt: integer(row.savedAt, `${name}.savedAt`),
  }
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
      if (id !== session.id)
        throw new TypeError(`ledger session key ${id} does not match session id`)
      sessions[id] = {
        spec,
        session,
        ...(row.checkpoint === undefined
          ? {}
          : { checkpoint: decodeCheckpoint(row.checkpoint, `ledger.sessions.${id}.checkpoint`) }),
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
    let saved: KeepaliveRecord | undefined
    await this.#store.update((current): KeepaliveLedger => {
      const prior = current.sessions[session.id]
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
      if (owner !== undefined && owner !== checkpoint.taskId) {
        throw new LubanError('E_INVALID_INPUT', 'checkpoint task does not own this session')
      }
      return {
        schemaVersion: 1,
        sessions: { ...current.sessions, [id]: { ...record, checkpoint } },
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
