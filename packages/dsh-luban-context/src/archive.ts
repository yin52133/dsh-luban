import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type {
  Clock,
  CompactionAuditRecord,
  CompactionPlan,
  ContextSegment,
  JsonCodec,
  SessionId,
} from '@luban/core'
import { AtomicJsonStore, LubanError, asSessionId, redactSecrets } from '@luban/core'

export interface ArchiveIndexEntry {
  readonly startSeq: number
  readonly endSeq: number
  readonly estTokens: number
  readonly topic?: string
  readonly path: string
  readonly sha256: string
  readonly createdAt: number
}

interface ArchiveState {
  readonly schemaVersion: 1
  readonly entries: readonly ArchiveIndexEntry[]
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LubanError('E_IO', `${label} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new LubanError('E_IO', `${label} must be a string`)
  return value
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LubanError('E_IO', `${label} must be a non-negative integer`)
  }
  return value
}

function indexEntry(value: unknown, label: string): ArchiveIndexEntry {
  const row = record(value, label)
  return {
    startSeq: integer(row.startSeq, `${label}.startSeq`),
    endSeq: integer(row.endSeq, `${label}.endSeq`),
    estTokens: integer(row.estTokens, `${label}.estTokens`),
    ...(typeof row.topic === 'string' ? { topic: row.topic } : {}),
    path: text(row.path, `${label}.path`),
    sha256: text(row.sha256, `${label}.sha256`),
    createdAt: integer(row.createdAt, `${label}.createdAt`),
  }
}

const archiveCodec: JsonCodec<ArchiveState> = Object.freeze({
  decode(value: unknown): ArchiveState {
    const root = record(value, 'archive index')
    if (root.schemaVersion !== 1 || !Array.isArray(root.entries)) {
      throw new LubanError('E_IO', 'Unsupported archive index schema')
    }
    return {
      schemaVersion: 1,
      entries: root.entries.map((item, index): ArchiveIndexEntry =>
        indexEntry(item, `entries[${String(index)}]`),
      ),
    }
  },
  encode(value: ArchiveState): unknown {
    return value
  },
})

function contextSegment(value: unknown, label: string): ContextSegment {
  const row = record(value, label)
  return {
    startSeq: integer(row.startSeq, `${label}.startSeq`),
    endSeq: integer(row.endSeq, `${label}.endSeq`),
    estTokens: integer(row.estTokens, `${label}.estTokens`),
    ...(typeof row.topic === 'string' ? { topic: row.topic } : {}),
  }
}

function segmentList(value: unknown, label: string): readonly ContextSegment[] {
  if (!Array.isArray(value)) throw new LubanError('E_IO', `${label} must be an array`)
  return value.map((item, index): ContextSegment =>
    contextSegment(item, `${label}[${String(index)}]`),
  )
}

function compactionPlan(value: unknown, label: string): CompactionPlan {
  const row = record(value, label)
  return {
    keep: segmentList(row.keep, `${label}.keep`),
    summarize: segmentList(row.summarize, `${label}.summarize`),
    archive: segmentList(row.archive, `${label}.archive`),
    budgetTokens: integer(row.budgetTokens, `${label}.budgetTokens`),
    strategyId: text(row.strategyId, `${label}.strategyId`),
  }
}

function auditRecord(value: unknown, label: string): CompactionAuditRecord {
  const row = record(value, label)
  if (!Array.isArray(row.archiveFiles))
    throw new LubanError('E_IO', `${label}.archiveFiles must be an array`)
  return {
    sessionId: asSessionId(text(row.sessionId, `${label}.sessionId`)),
    at: integer(row.at, `${label}.at`),
    strategyId: text(row.strategyId, `${label}.strategyId`),
    beforeTokens: integer(row.beforeTokens, `${label}.beforeTokens`),
    afterTokens: integer(row.afterTokens, `${label}.afterTokens`),
    archiveFiles: row.archiveFiles.map((item, index): string =>
      text(item, `${label}.archiveFiles[${String(index)}]`),
    ),
    plan: compactionPlan(row.plan, `${label}.plan`),
  }
}

const auditCodec: JsonCodec<readonly CompactionAuditRecord[]> = Object.freeze({
  decode(value: unknown): readonly CompactionAuditRecord[] {
    if (!Array.isArray(value)) throw new LubanError('E_IO', 'audit file must be an array')
    return value.map((item, index): CompactionAuditRecord =>
      auditRecord(item, `audit[${String(index)}]`),
    )
  },
  encode(value: readonly CompactionAuditRecord[]): unknown {
    return value
  },
})

function safeSessionDirectory(sessionId: SessionId): string {
  const raw = String(sessionId)
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/^\.+/u, '')
    .slice(0, 80)
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8)
  return safe === raw && safe !== '' ? safe : `${safe === '' ? 'session' : safe}-${hash}`
}

function relativeInside(workspace: string, filePath: string): string {
  const value = relative(workspace, filePath)
  if (value === '' || value === '..' || value.startsWith('../') || value.startsWith('..\\')) {
    throw new LubanError('E_INVALID_INPUT', 'Archive path must stay inside the workspace')
  }
  return value.replaceAll('\\', '/')
}

async function atomicTextWrite(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = resolve(dirname(filePath), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const handle = await open(temporary, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, filePath)
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch((): undefined => undefined)
    throw new LubanError('E_IO', `Unable to write archive file ${filePath}`, { cause: error })
  }
}

/** Workspace-local virtual file repository with a searchable index and audit log. */
export class ContextArchiveRepository {
  readonly #workspace: string
  readonly #sessionId: SessionId
  readonly #sessionDirectory: string
  readonly #clock: Clock
  readonly #index: AtomicJsonStore<ArchiveState>
  readonly #audit: AtomicJsonStore<readonly CompactionAuditRecord[]>

  public constructor(options: {
    readonly workspace: string
    readonly archiveDir: string
    readonly sessionId: SessionId
    readonly clock: Clock
  }) {
    this.#workspace = resolve(options.workspace)
    this.#sessionId = options.sessionId
    this.#clock = options.clock
    const archiveRoot = resolve(this.#workspace, options.archiveDir)
    relativeInside(this.#workspace, archiveRoot)
    this.#sessionDirectory = resolve(archiveRoot, safeSessionDirectory(options.sessionId))
    relativeInside(archiveRoot, this.#sessionDirectory)
    this.#index = new AtomicJsonStore({
      filePath: resolve(this.#sessionDirectory, 'index.json'),
      codec: archiveCodec,
      initial: (): ArchiveState => ({ schemaVersion: 1, entries: [] }),
    })
    this.#audit = new AtomicJsonStore({
      filePath: resolve(this.#sessionDirectory, 'audit.json'),
      codec: auditCodec,
      initial: (): readonly CompactionAuditRecord[] => [],
    })
  }

  public async archive(segment: ContextSegment, rawContent: string): Promise<string> {
    const content = redactSecrets(rawContent)
    const document = [
      `# Context segment ${String(segment.startSeq)}–${String(segment.endSeq)}`,
      '',
      `- Session: \`${this.#sessionId}\``,
      `- Estimated tokens: ${String(segment.estTokens)}`,
      ...(segment.topic === undefined ? [] : [`- Topic: ${redactSecrets(segment.topic)}`]),
      '',
      content,
      '',
    ].join('\n')
    const digest = createHash('sha256').update(document).digest('hex')
    const name = `seg-${String(segment.startSeq).padStart(8, '0')}-${String(segment.endSeq).padStart(8, '0')}-${digest.slice(0, 12)}.md`
    const absolutePath = resolve(this.#sessionDirectory, name)
    relativeInside(this.#sessionDirectory, absolutePath)
    await atomicTextWrite(absolutePath, document)
    const path = relativeInside(this.#workspace, absolutePath)
    const entry: ArchiveIndexEntry = {
      startSeq: segment.startSeq,
      endSeq: segment.endSeq,
      estTokens: segment.estTokens,
      ...(segment.topic === undefined ? {} : { topic: redactSecrets(segment.topic) }),
      path,
      sha256: digest,
      createdAt: this.#clock.now(),
    }
    await this.#index.update((state): ArchiveState => ({
      ...state,
      entries: state.entries.some((item): boolean => item.path === path)
        ? state.entries.map((item): ArchiveIndexEntry => (item.path === path ? entry : item))
        : [...state.entries, entry],
    }))
    return path
  }

  public async entries(): Promise<readonly ArchiveIndexEntry[]> {
    return (await this.#index.read()).entries
  }

  public async replay(startSeq: number, endSeq: number): Promise<string> {
    const entry = (await this.entries()).findLast(
      (item): boolean => item.startSeq === startSeq && item.endSeq === endSeq,
    )
    if (entry === undefined) {
      throw new LubanError(
        'E_NOT_FOUND',
        `Archived segment ${String(startSeq)}-${String(endSeq)} was not found`,
      )
    }
    return this.#readEntry(entry)
  }

  /** Replay one exact index entry, including older entries that reused a surface range. */
  public async replayPath(path: string): Promise<string> {
    const entry = (await this.entries()).find((item): boolean => item.path === path)
    if (entry === undefined) throw new LubanError('E_NOT_FOUND', 'Archived path was not found')
    return this.#readEntry(entry)
  }

  async #readEntry(entry: ArchiveIndexEntry): Promise<string> {
    const absolutePath = resolve(this.#workspace, entry.path)
    relativeInside(this.#sessionDirectory, absolutePath)
    const content = await readFile(absolutePath, 'utf8').catch((error: unknown): never => {
      throw new LubanError('E_IO', `Unable to replay ${entry.path}`, { cause: error })
    })
    const digest = createHash('sha256').update(content).digest('hex')
    if (digest !== entry.sha256)
      throw new LubanError('E_IO', `Archive checksum mismatch for ${entry.path}`)
    return content
  }

  public async recordAudit(record: CompactionAuditRecord): Promise<void> {
    if (record.sessionId !== this.#sessionId) {
      throw new LubanError('E_INVALID_INPUT', 'Audit record session does not match the archive')
    }
    await this.#audit.update((records): readonly CompactionAuditRecord[] => [...records, record])
  }

  public async audit(): Promise<readonly CompactionAuditRecord[]> {
    return this.#audit.read()
  }
}
