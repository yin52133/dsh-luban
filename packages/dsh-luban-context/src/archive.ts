import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type {
  AccountId,
  Clock,
  CompactionAuditRecord,
  CompactionPlan,
  CompactionSurfaceSnapshotIndex,
  CompactionSurfaceSnapshotIndexEntry,
  CompactionSurfaceSnapshots,
  ContextSegment,
  JsonCodec,
  SessionId,
} from 'dsh-luban-core'
import { AtomicJsonStore, LubanError, asAccountId, asSessionId } from 'dsh-luban-core'

export interface ArchiveIndexEntry {
  readonly accountId: AccountId
  readonly startSeq: number
  readonly endSeq: number
  readonly estTokens: number
  readonly topic?: string
  readonly path: string
  readonly sha256: string
  readonly createdAt: number
}

interface StoredArchiveIndexEntry extends Omit<ArchiveIndexEntry, 'accountId'> {
  /** Missing only on legacy indexes that have not been assigned by an explicit migration. */
  readonly accountId?: AccountId
}

interface ArchiveState {
  readonly schemaVersion: 1
  readonly entries: readonly StoredArchiveIndexEntry[]
}

interface DirectoryIdentity {
  readonly device: number | bigint
  readonly inode: number | bigint
  readonly birthtimeMs: number | bigint
}

interface DirectoryBoundary {
  readonly path: string
  readonly identity: DirectoryIdentity
}

interface RepositoryRoot {
  readonly workspace: string
  readonly archive: DirectoryBoundary
  readonly account: DirectoryBoundary
  readonly session: DirectoryBoundary
  readonly index: AtomicJsonStore<ArchiveState>
  readonly audit: AtomicJsonStore<readonly CompactionAuditRecord[]>
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = (error as Readonly<{ code?: unknown }>).code
  return typeof value === 'string' ? value : undefined
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === ''
}

function directoryIdentity(info: Awaited<ReturnType<typeof lstat>>): DirectoryIdentity {
  return { device: info.dev, inode: info.ino, birthtimeMs: info.birthtimeMs }
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeMs === right.birthtimeMs
  )
}

async function ownedDirectory(
  path: string,
  workspace: string,
  label: string,
): Promise<DirectoryBoundary> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error: unknown) {
    if (errorCode(error) !== 'EEXIST') {
      throw new LubanError('E_IO', `Unable to create ${label}`, { cause: error })
    }
  }
  const [info, canonical] = await Promise.all([lstat(path), realpath(path)])
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !samePath(path, canonical) ||
    (!samePath(workspace, canonical) && !isInside(workspace, canonical))
  ) {
    throw new LubanError(
      'E_INVALID_INPUT',
      `${label} must be a real directory inside the canonical workspace`,
    )
  }
  return { path, identity: directoryIdentity(info) }
}

async function ownedDirectoryTree(
  workspace: string,
  requested: string,
  label: string,
): Promise<DirectoryBoundary> {
  const relativePath = relative(workspace, requested)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new LubanError('E_INVALID_INPUT', `${label} must stay inside the workspace`)
  }
  let current = workspace
  let boundary: DirectoryBoundary | undefined
  for (const component of relativePath.split(/[\\/]+/u)) {
    if (component === '' || component === '.') continue
    current = resolve(current, component)
    boundary = await ownedDirectory(current, workspace, label)
  }
  if (boundary === undefined) {
    throw new LubanError('E_INVALID_INPUT', `${label} must stay inside the workspace`)
  }
  return boundary
}

async function assertDirectory(boundary: DirectoryBoundary, label: string): Promise<void> {
  const [info, canonical] = await Promise.all([lstat(boundary.path), realpath(boundary.path)])
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !samePath(boundary.path, canonical) ||
    !sameDirectoryIdentity(boundary.identity, directoryIdentity(info))
  ) {
    throw new Error(`${label} identity changed`)
  }
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

function optionalAccountId(value: unknown, label: string): AccountId | undefined {
  if (value === undefined) return undefined
  const candidate = text(value, label)
  if (candidate.trim() === '') throw new LubanError('E_IO', `${label} must not be blank`)
  return asAccountId(candidate)
}

function indexEntry(value: unknown, label: string): StoredArchiveIndexEntry {
  const row = record(value, label)
  const accountId = optionalAccountId(row.accountId, `${label}.accountId`)
  return {
    ...(accountId === undefined ? {} : { accountId }),
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
      entries: root.entries.map((item, index): StoredArchiveIndexEntry =>
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

function surfaceSnapshotEntry(value: unknown, label: string): CompactionSurfaceSnapshotIndexEntry {
  const row = record(value, label)
  return {
    eventSeq: integer(row.eventSeq, `${label}.eventSeq`),
    segment: contextSegment(row.segment, `${label}.segment`),
  }
}

function surfaceSnapshot(value: unknown, label: string): CompactionSurfaceSnapshotIndex {
  const row = record(value, label)
  if (!Array.isArray(row.entries)) {
    throw new LubanError('E_IO', `${label}.entries must be an array`)
  }
  const entries = row.entries.map((item, index): CompactionSurfaceSnapshotIndexEntry =>
    surfaceSnapshotEntry(item, `${label}.entries[${String(index)}]`),
  )
  const totalTokens = integer(row.totalTokens, `${label}.totalTokens`)
  const indexedTokens = entries.reduce((total, entry): number => total + entry.segment.estTokens, 0)
  if (totalTokens !== indexedTokens) {
    throw new LubanError('E_IO', `${label}.totalTokens does not match its surface index`)
  }
  if (new Set(entries.map((entry): number => entry.eventSeq)).size !== entries.length) {
    throw new LubanError('E_IO', `${label}.entries contains duplicate event sequences`)
  }
  return { totalTokens, entries }
}

function surfaceSnapshots(value: unknown, label: string): CompactionSurfaceSnapshots {
  const row = record(value, label)
  if (row.kind === 'legacy') return { kind: 'legacy' }
  if (row.kind !== 'captured') {
    throw new LubanError('E_IO', `${label}.kind is unsupported`)
  }
  return {
    kind: 'captured',
    before: surfaceSnapshot(row.before, `${label}.before`),
    after: surfaceSnapshot(row.after, `${label}.after`),
  }
}

function auditRecord(value: unknown, label: string): CompactionAuditRecord {
  const row = record(value, label)
  if (!Array.isArray(row.archiveFiles))
    throw new LubanError('E_IO', `${label}.archiveFiles must be an array`)
  const accountId = optionalAccountId(row.accountId, `${label}.accountId`)
  return {
    ...(accountId === undefined ? {} : { accountId }),
    sessionId: asSessionId(text(row.sessionId, `${label}.sessionId`)),
    at: integer(row.at, `${label}.at`),
    strategyId: text(row.strategyId, `${label}.strategyId`),
    beforeTokens: integer(row.beforeTokens, `${label}.beforeTokens`),
    afterTokens: integer(row.afterTokens, `${label}.afterTokens`),
    archiveFiles: row.archiveFiles.map((item, index): string =>
      text(item, `${label}.archiveFiles[${String(index)}]`),
    ),
    plan: compactionPlan(row.plan, `${label}.plan`),
    surfaceSnapshots:
      row.surfaceSnapshots === undefined
        ? { kind: 'legacy' }
        : surfaceSnapshots(row.surfaceSnapshots, `${label}.surfaceSnapshots`),
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

function sameAuditRecord(left: CompactionAuditRecord, right: CompactionAuditRecord): boolean {
  return isDeepStrictEqual(left, right)
}

function safeIdentifierDirectory(raw: string, fallback: string): string {
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/gu, '_')
    .replace(/^\.+/u, '')
    .slice(0, 80)
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8)
  return safe === raw && safe !== '' ? safe : `${safe === '' ? fallback : safe}-${hash}`
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
  readonly #requestedWorkspace: string
  readonly #archiveDir: string
  readonly #accountId: AccountId
  readonly #sessionId: SessionId
  readonly #clock: Clock
  #rootPromise: Promise<RepositoryRoot> | undefined

  public constructor(options: {
    readonly workspace: string
    readonly archiveDir: string
    readonly accountId: AccountId
    readonly sessionId: SessionId
    readonly clock: Clock
  }) {
    this.#requestedWorkspace = resolve(options.workspace)
    this.#archiveDir = options.archiveDir
    this.#accountId = options.accountId
    this.#sessionId = options.sessionId
    this.#clock = options.clock
    relativeInside(this.#requestedWorkspace, resolve(this.#requestedWorkspace, options.archiveDir))
  }

  public async archive(segment: ContextSegment, rawContent: string): Promise<string> {
    const root = await this.#root()
    await this.#assertRoot(root)
    const document = [
      `# Context segment ${String(segment.startSeq)}–${String(segment.endSeq)}`,
      '',
      `- Session: \`${this.#sessionId}\``,
      `- Estimated tokens: ${String(segment.estTokens)}`,
      ...(segment.topic === undefined ? [] : [`- Topic: ${segment.topic}`]),
      '',
      rawContent,
      '',
    ].join('\n')
    const digest = createHash('sha256').update(document).digest('hex')
    const name = `seg-${String(segment.startSeq).padStart(8, '0')}-${String(segment.endSeq).padStart(8, '0')}-${digest.slice(0, 12)}.md`
    const absolutePath = resolve(root.session.path, name)
    relativeInside(root.session.path, absolutePath)
    await atomicTextWrite(absolutePath, document)
    await this.#assertRoot(root)
    const path = relativeInside(root.workspace, absolutePath)
    const entry: ArchiveIndexEntry = {
      accountId: this.#accountId,
      startSeq: segment.startSeq,
      endSeq: segment.endSeq,
      estTokens: segment.estTokens,
      ...(segment.topic === undefined ? {} : { topic: segment.topic }),
      path,
      sha256: digest,
      createdAt: this.#clock.now(),
    }
    await root.index.update((state): ArchiveState => ({
      ...state,
      entries: state.entries.some(
        (item): boolean => item.path === path && item.accountId === this.#accountId,
      )
        ? state.entries.map((item): StoredArchiveIndexEntry =>
            item.path === path && item.accountId === this.#accountId ? entry : item,
          )
        : [...state.entries, entry],
    }))
    await this.#assertRoot(root)
    return path
  }

  public async entries(): Promise<readonly ArchiveIndexEntry[]> {
    const root = await this.#root()
    await this.#assertRoot(root)
    const entries = (await root.index.read()).entries.filter(
      (entry): entry is ArchiveIndexEntry => entry.accountId === this.#accountId,
    )
    await this.#assertRoot(root)
    return entries
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
    const root = await this.#root()
    await this.#assertRoot(root)
    const absolutePath = resolve(root.workspace, entry.path)
    relativeInside(root.session.path, absolutePath)
    const [info, canonical] = await Promise.all([
      lstat(absolutePath),
      realpath(absolutePath),
    ]).catch((error: unknown): never => {
      throw new LubanError('E_IO', `Unable to replay ${entry.path}`, { cause: error })
    })
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !samePath(absolutePath, canonical) ||
      !isInside(root.session.path, canonical)
    ) {
      throw new LubanError('E_IO', `Archived path is outside its session directory`)
    }
    const content = await readFile(absolutePath, 'utf8').catch((error: unknown): never => {
      throw new LubanError('E_IO', `Unable to replay ${entry.path}`, { cause: error })
    })
    await this.#assertRoot(root)
    const digest = createHash('sha256').update(content).digest('hex')
    if (digest !== entry.sha256)
      throw new LubanError('E_IO', `Archive checksum mismatch for ${entry.path}`)
    return content
  }

  public async recordAudit(record: CompactionAuditRecord): Promise<void> {
    if (record.sessionId !== this.#sessionId) {
      throw new LubanError('E_INVALID_INPUT', 'Audit record session does not match the archive')
    }
    if (record.accountId !== this.#accountId) {
      throw new LubanError(
        'E_ACCOUNT_SCOPE_MISMATCH',
        'Audit record account does not match the archive',
      )
    }
    const root = await this.#root()
    await this.#assertRoot(root)
    // A prior atomic publish may have succeeded before its caller observed a later failure.
    const persisted = await root.audit.read()
    if (persisted.some((candidate): boolean => sameAuditRecord(candidate, record))) {
      await this.#assertRoot(root)
      return
    }
    await root.audit.update((records): readonly CompactionAuditRecord[] =>
      records.some((candidate): boolean => sameAuditRecord(candidate, record))
        ? records
        : [...records, record],
    )
    await this.#assertRoot(root)
  }

  public async audit(): Promise<readonly CompactionAuditRecord[]> {
    const root = await this.#root()
    await this.#assertRoot(root)
    const records = (await root.audit.read()).filter(
      (record): boolean => record.accountId === this.#accountId,
    )
    await this.#assertRoot(root)
    return records
  }

  async #root(): Promise<RepositoryRoot> {
    this.#rootPromise ??= this.#initializeRoot()
    return this.#rootPromise
  }

  async #initializeRoot(): Promise<RepositoryRoot> {
    const workspaceInfo = await stat(this.#requestedWorkspace).catch((error: unknown): never => {
      throw new LubanError('E_IO', 'Context workspace is unavailable', { cause: error })
    })
    if (!workspaceInfo.isDirectory()) {
      throw new LubanError('E_INVALID_INPUT', 'Context workspace must be a directory')
    }
    const workspace = await realpath(this.#requestedWorkspace).catch((error: unknown): never => {
      throw new LubanError('E_IO', 'Context workspace is unavailable', { cause: error })
    })
    const requestedArchive = resolve(workspace, this.#archiveDir)
    relativeInside(workspace, requestedArchive)
    const archive = await ownedDirectoryTree(workspace, requestedArchive, 'archiveDir')
    const account = await ownedDirectory(
      resolve(archive.path, safeIdentifierDirectory(String(this.#accountId), 'account')),
      workspace,
      'context account directory',
    )
    const session = await ownedDirectory(
      resolve(account.path, safeIdentifierDirectory(String(this.#sessionId), 'session')),
      workspace,
      'context session directory',
    )
    const root: RepositoryRoot = {
      workspace,
      archive,
      account,
      session,
      index: new AtomicJsonStore({
        filePath: resolve(session.path, 'index.json'),
        codec: archiveCodec,
        initial: (): ArchiveState => ({ schemaVersion: 1, entries: [] }),
      }),
      audit: new AtomicJsonStore({
        filePath: resolve(session.path, 'audit.json'),
        codec: auditCodec,
        initial: (): readonly CompactionAuditRecord[] => [],
      }),
    }
    await this.#assertRoot(root)
    return root
  }

  async #assertRoot(root: RepositoryRoot): Promise<void> {
    try {
      await Promise.all([
        assertDirectory(root.archive, 'context archive directory'),
        assertDirectory(root.account, 'context account directory'),
        assertDirectory(root.session, 'context session directory'),
      ])
    } catch (error: unknown) {
      if (error instanceof LubanError) throw error
      throw new LubanError('E_IO', 'Context archive directory identity changed or is unavailable', {
        cause: error,
      })
    }
  }
}
