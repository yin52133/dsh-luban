import type { ArtifactRef, BuildJob, BuildJobStatus, JsonCodec } from '@yin52133/dsh-luban-core'
import { AtomicJsonStore, LubanError, asAccountId } from '@yin52133/dsh-luban-core'

export interface BuildRecord {
  readonly job: BuildJob
  readonly createdAt: number
  readonly startedAt?: number
  readonly finishedAt?: number
}

export interface BuildLedger {
  readonly schemaVersion: 1
  readonly records: Readonly<Record<string, BuildRecord>>
  readonly updatedAt: number
}

function objectValue(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function text(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value === ''))
    throw new TypeError(`${name} is invalid`)
  return value
}

function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`)
  }
  return value
}

function status(value: unknown, name: string): BuildJobStatus {
  if (value !== 'queued' && value !== 'running' && value !== 'failed' && value !== 'done') {
    throw new TypeError(`${name} is invalid`)
  }
  return value
}

function params(value: unknown, name: string): Readonly<Record<string, string>> {
  const row = objectValue(value, name)
  if (!Object.values(row).every((item): item is string => typeof item === 'string')) {
    throw new TypeError(`${name} values must be strings`)
  }
  return { ...row } as Readonly<Record<string, string>>
}

function artifact(value: unknown, name: string): ArtifactRef {
  const row = objectValue(value, name)
  return {
    name: text(row.name, `${name}.name`),
    path: text(row.path, `${name}.path`),
    sizeBytes: integer(row.sizeBytes, `${name}.sizeBytes`),
  }
}

function job(value: unknown, name: string): BuildJob {
  const row = objectValue(value, name)
  if (!Array.isArray(row.artifacts)) throw new TypeError(`${name}.artifacts must be an array`)
  return {
    id: text(row.id, `${name}.id`),
    ...(typeof row.accountId === 'string' ? { accountId: asAccountId(row.accountId) } : {}),
    templateId: text(row.templateId, `${name}.templateId`),
    params: params(row.params, `${name}.params`),
    status: status(row.status, `${name}.status`),
    ...(row.sessionId === undefined ? {} : { sessionId: text(row.sessionId, `${name}.sessionId`) }),
    artifacts: row.artifacts.map((item, index): ArtifactRef =>
      artifact(item, `${name}.artifacts[${String(index)}]`),
    ),
    ...(row.errorLogExcerpt === undefined
      ? {}
      : { errorLogExcerpt: text(row.errorLogExcerpt, `${name}.errorLogExcerpt`, true) }),
    version: integer(row.version, `${name}.version`),
  }
}

export function emptyBuildLedger(now = Date.now()): BuildLedger {
  return { schemaVersion: 1, records: {}, updatedAt: now }
}

export const buildLedgerCodec: JsonCodec<BuildLedger> = Object.freeze({
  decode(value: unknown): BuildLedger {
    const root = objectValue(value, 'build ledger')
    if (root.schemaVersion !== 1) throw new TypeError('build ledger schemaVersion must be 1')
    const rows = objectValue(root.records, 'build ledger records')
    const records: Record<string, BuildRecord> = {}
    for (const [id, value] of Object.entries(rows)) {
      const row = objectValue(value, `build ledger records.${id}`)
      const decodedJob = job(row.job, `build ledger records.${id}.job`)
      if (decodedJob.id !== id) throw new TypeError(`build ledger key ${id} does not match job id`)
      records[id] = {
        job: decodedJob,
        createdAt: integer(row.createdAt, `build ledger records.${id}.createdAt`),
        ...(row.startedAt === undefined
          ? {}
          : { startedAt: integer(row.startedAt, `build ledger records.${id}.startedAt`) }),
        ...(row.finishedAt === undefined
          ? {}
          : { finishedAt: integer(row.finishedAt, `build ledger records.${id}.finishedAt`) }),
      }
    }
    return {
      schemaVersion: 1,
      records,
      updatedAt: integer(root.updatedAt, 'build ledger updatedAt'),
    }
  },
  encode(value: BuildLedger): unknown {
    return value
  },
})

export class BuildLedgerStore {
  readonly #store: AtomicJsonStore<BuildLedger>
  readonly #now: () => number

  public constructor(filePath: string, now: () => number = Date.now) {
    this.#now = now
    this.#store = new AtomicJsonStore({
      filePath,
      codec: buildLedgerCodec,
      initial: (): BuildLedger => emptyBuildLedger(now()),
    })
  }

  public read(): Promise<BuildLedger> {
    return this.#store.read()
  }

  public update(mutator: (ledger: BuildLedger) => BuildLedger): Promise<BuildLedger> {
    return this.#store.update((current): BuildLedger => ({
      ...mutator(current),
      updatedAt: this.#now(),
    }))
  }

  public async require(jobId: string): Promise<BuildRecord> {
    const record = (await this.read()).records[jobId]
    if (record === undefined)
      throw new LubanError('E_NOT_FOUND', `build job ${jobId} was not found`)
    return record
  }
}
