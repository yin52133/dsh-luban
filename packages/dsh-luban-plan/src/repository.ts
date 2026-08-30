import { randomBytes, randomUUID } from 'node:crypto'
import {
  link,
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
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type {
  AccountId,
  Actor,
  Clock,
  JsonCodec,
  Plan,
  PlanDecisionRecord,
  PlanId,
  PlanSections,
  PlanStatus,
  SessionId,
  TaskId,
} from 'dsh-luban-core'
import {
  AtomicJsonStore,
  LubanError,
  asAccountId,
  asActorId,
  asPlanId,
  asSessionId,
  asTaskId,
} from 'dsh-luban-core'
import { renderPlanDocument } from './template.js'

export interface StoredPlan extends Plan {
  readonly workspace: string
  readonly slug: string
  readonly createdAt: number
  readonly updatedAt: number
}

interface PlanState {
  readonly schemaVersion: 1
  readonly plans: readonly StoredPlan[]
}

interface DirectoryIdentity {
  readonly device: number | bigint
  readonly inode: number | bigint
  readonly birthtimeMs: number | bigint
}

interface DirectoryFence {
  readonly path: string
  readonly identity: DirectoryIdentity
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

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LubanError('E_IO', `${label} must be a non-negative integer`)
  }
  return value
}

function actor(value: unknown, label: string): Actor {
  const row = record(value, label)
  if (row.kind !== 'user' && row.kind !== 'agent') {
    throw new LubanError('E_IO', `${label}.kind is invalid`)
  }
  return {
    kind: row.kind,
    id: asActorId(text(row.id, `${label}.id`)),
    ...(typeof row.accountId === 'string' ? { accountId: asAccountId(row.accountId) } : {}),
    ...(typeof row.displayName === 'string' ? { displayName: row.displayName } : {}),
  }
}

const PLAN_STATUSES = new Set<PlanStatus>([
  'draft',
  'in-review',
  'approved',
  'executing',
  'completed',
  'rejected',
  'revising',
])

function sections(value: unknown, label: string): PlanSections {
  const row = record(value, label)
  return {
    background: text(row.background, `${label}.background`),
    impact: text(row.impact, `${label}.impact`),
    changes: text(row.changes, `${label}.changes`),
    verification: text(row.verification, `${label}.verification`),
  }
}

function decision(value: unknown, label: string): PlanDecisionRecord {
  const row = record(value, label)
  if (row.decision !== 'approve' && row.decision !== 'reject') {
    throw new LubanError('E_IO', `${label}.decision is invalid`)
  }
  return {
    by: actor(row.by, `${label}.by`),
    decision: row.decision,
    ...(typeof row.comment === 'string' ? { comment: row.comment } : {}),
    at: safeInteger(row.at, `${label}.at`),
  }
}

function storedPlan(value: unknown, label: string): StoredPlan {
  const row = record(value, label)
  const status = text(row.status, `${label}.status`) as PlanStatus
  if (!PLAN_STATUSES.has(status)) throw new LubanError('E_IO', `${label}.status is invalid`)
  if (!Array.isArray(row.decisions))
    throw new LubanError('E_IO', `${label}.decisions must be an array`)
  return {
    ...(typeof row.accountId === 'string' ? { accountId: asAccountId(row.accountId) } : {}),
    id: asPlanId(text(row.id, `${label}.id`)),
    ...(typeof row.taskId === 'string' ? { taskId: asTaskId(row.taskId) } : {}),
    ...(typeof row.sessionId === 'string' ? { sessionId: asSessionId(row.sessionId) } : {}),
    status,
    sections: sections(row.sections, `${label}.sections`),
    filePath: text(row.filePath, `${label}.filePath`),
    decisions: row.decisions.map((item, index): PlanDecisionRecord =>
      decision(item, `${label}.decisions[${String(index)}]`),
    ),
    version: safeInteger(row.version, `${label}.version`),
    workspace: text(row.workspace, `${label}.workspace`),
    slug: text(row.slug, `${label}.slug`),
    createdAt: safeInteger(row.createdAt, `${label}.createdAt`),
    updatedAt: safeInteger(row.updatedAt, `${label}.updatedAt`),
  }
}

const planStateCodec: JsonCodec<PlanState> = Object.freeze({
  decode(value: unknown): PlanState {
    const root = record(value, 'plan state')
    if (root.schemaVersion !== 1 || !Array.isArray(root.plans)) {
      throw new LubanError('E_IO', 'Unsupported plan state schema')
    }
    const plans = root.plans.map((item, index): StoredPlan =>
      storedPlan(item, `plans[${String(index)}]`),
    )
    if (new Set(plans.map((plan): PlanId => plan.id)).size !== plans.length) {
      throw new LubanError('E_IO', 'Plan state contains duplicate ids')
    }
    return { schemaVersion: 1, plans }
  },
  encode(value: PlanState): unknown {
    return value
  },
})

function dateKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

export function normalizeSlug(value: string): string {
  const slug = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80)
  if (slug === '') throw new LubanError('E_INVALID_INPUT', 'slug must contain a letter or number')
  return slug
}

function workspaceRelative(workspace: string, absolutePath: string): string {
  const value = relative(workspace, absolutePath)
  if (value === '' || value === '..' || value.startsWith('../') || value.startsWith('..\\')) {
    throw new LubanError('E_INVALID_INPUT', 'Plan document must stay inside its workspace')
  }
  return value.replaceAll('\\', '/')
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === ''
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
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

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizedRelativeDirectory(value: string): string {
  const candidate = normalize(value)
  if (candidate === '.' || isAbsolute(candidate) || candidate.split(/[\\/]/u)[0] === '..') {
    throw new LubanError('E_INVALID_INPUT', 'plansDir must be a workspace-relative directory')
  }
  return candidate.replaceAll('\\', '/')
}

async function atomicTextWrite(
  filePath: string,
  content: string,
  exclusive: boolean,
  assertParent: () => Promise<void>,
): Promise<void> {
  await assertParent()
  const temporary = join(dirname(filePath), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const handle = await open(temporary, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await assertParent()
    if (exclusive) {
      try {
        await link(temporary, filePath)
        await rm(temporary, { force: true })
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          Reflect.get(error, 'code') === 'EEXIST'
        ) {
          throw new LubanError('E_VERSION_CONFLICT', `Plan document already exists: ${filePath}`)
        }
        throw error
      }
    } else {
      await rename(temporary, filePath)
    }
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch((): undefined => undefined)
    throw error instanceof LubanError
      ? error
      : new LubanError('E_IO', `Unable to write plan document ${filePath}`, { cause: error })
  }
}

/** Durable repository whose JSON index is the source of truth and Markdown is its review projection. */
export class PlanRepository {
  readonly #store: AtomicJsonStore<PlanState>
  readonly #stateFile: string
  readonly #plansDir: string
  readonly #clock: Clock
  readonly #workspaceFences = new Map<string, DirectoryFence>()
  readonly #documentFences = new Map<string, DirectoryFence>()

  public constructor(stateFile: string, plansDir: string, clock: Clock) {
    this.#stateFile = stateFile
    this.#plansDir = normalizedRelativeDirectory(plansDir)
    this.#clock = clock
    this.#store = new AtomicJsonStore({
      filePath: stateFile,
      codec: planStateCodec,
      initial: (): PlanState => ({ schemaVersion: 1, plans: [] }),
    })
  }

  public async all(): Promise<readonly StoredPlan[]> {
    return (await this.#store.read()).plans
  }

  public async create(input: {
    readonly accountId: AccountId
    readonly workspace: string
    readonly slug: string
    readonly sections: PlanSections
    readonly taskId?: TaskId
    readonly sessionId?: SessionId
    readonly status?: 'draft' | 'in-review'
  }): Promise<StoredPlan> {
    const requestedWorkspace = resolve(input.workspace)
    const workspaceStat = await stat(requestedWorkspace).catch((error: unknown): never => {
      throw new LubanError('E_INVALID_INPUT', `Workspace does not exist: ${requestedWorkspace}`, {
        cause: error,
      })
    })
    if (!workspaceStat.isDirectory())
      throw new LubanError('E_INVALID_INPUT', 'workspace must be a directory')
    const workspace = await realpath(requestedWorkspace)
    await this.#assertWorkspace(workspace)
    const now = this.#clock.now()
    const slug = normalizeSlug(input.slug)
    const id = asPlanId(`P-${dateKey(now).replaceAll('-', '')}-${randomBytes(4).toString('hex')}`)
    const filePath = `${this.#plansDir}/${dateKey(now)}-${slug}-${id.slice(-8)}.md`
    const absoluteFile = await this.#documentPathFor(workspace, filePath, true, false)
    const plan: StoredPlan = {
      accountId: input.accountId,
      id,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      status: input.status ?? 'in-review',
      sections: input.sections,
      filePath,
      decisions: [],
      version: 1,
      workspace,
      slug,
      createdAt: now,
      updatedAt: now,
    }
    await atomicTextWrite(absoluteFile, renderPlanDocument(plan), true, async (): Promise<void> => {
      await this.#assertDocumentRoot(workspace, true)
    })
    try {
      await this.#store.update((state): PlanState => ({
        ...state,
        plans: [...state.plans, plan],
      }))
    } catch (error: unknown) {
      await rm(absoluteFile, { force: true }).catch((): undefined => undefined)
      throw error
    }
    return plan
  }

  public async update(
    id: PlanId,
    expectedVersion: number,
    mutate: (current: StoredPlan) => StoredPlan,
  ): Promise<StoredPlan> {
    let result: StoredPlan | undefined
    let publishedDocument: { readonly path: string; readonly workspace: string } | undefined
    try {
      await this.#store.update(async (state): Promise<PlanState> => {
        const index = state.plans.findIndex((plan): boolean => plan.id === id)
        const current = state.plans[index]
        if (current === undefined) throw new LubanError('E_NOT_FOUND', `Plan ${id} was not found`)
        if (current.version !== expectedVersion) {
          throw new LubanError(
            'E_VERSION_CONFLICT',
            `Plan ${id} changed since version ${String(expectedVersion)}`,
          )
        }
        const next = mutate(current)
        if (
          next.id !== current.id ||
          next.accountId !== current.accountId ||
          next.filePath !== current.filePath ||
          next.workspace !== current.workspace
        ) {
          throw new LubanError(
            'E_INVALID_INPUT',
            'Plan identity and document location are immutable',
          )
        }
        const plans = [...state.plans]
        plans[index] = next
        const path = await this.#documentPath(next, true, true)
        await atomicTextWrite(path, renderPlanDocument(next), false, async (): Promise<void> => {
          await this.#assertDocumentRoot(next.workspace, false)
        })
        publishedDocument = { path, workspace: next.workspace }
        result = next
        return { ...state, plans }
      })
    } catch (persistenceError: unknown) {
      const document = publishedDocument
      if (document !== undefined) {
        try {
          const rawState = await readFile(this.#stateFile, 'utf8')
          const state = planStateCodec.decode(JSON.parse(rawState) as unknown)
          const authoritative = state.plans.find((plan): boolean => plan.id === id)
          if (authoritative === undefined) {
            throw new LubanError('E_IO', `Plan ${id} is missing from its authoritative state`)
          }
          await atomicTextWrite(
            document.path,
            renderPlanDocument(authoritative),
            false,
            async (): Promise<void> => {
              await this.#assertDocumentRoot(document.workspace, false)
            },
          )
        } catch (reconciliationError: unknown) {
          throw new LubanError(
            'E_IO',
            `Plan ${id} update failed and its document could not be reconciled`,
            {
              retriable: true,
              cause: new AggregateError(
                [persistenceError, reconciliationError],
                `Plan ${id} persistence reconciliation failed`,
              ),
              details: {
                persistenceError: errorMessage(persistenceError),
                reconciliationError: errorMessage(reconciliationError),
              },
            },
          )
        }
      }
      throw persistenceError
    }
    if (result === undefined) throw new LubanError('E_IO', 'Plan update did not produce a result')
    return result
  }

  public now(): number {
    return this.#clock.now()
  }

  public async readDocument(plan: StoredPlan): Promise<string> {
    const path = await this.#documentPath(plan, false, true)
    return readFile(path, 'utf8').catch((error: unknown): never => {
      throw new LubanError('E_IO', `Unable to read plan document ${plan.filePath}`, {
        cause: error,
      })
    })
  }

  async #documentPath(
    plan: StoredPlan,
    createDirectory: boolean,
    requireFile: boolean,
  ): Promise<string> {
    const normalized = normalize(plan.filePath).replaceAll('\\', '/')
    if (!normalized.startsWith(`${this.#plansDir}/`)) {
      throw new LubanError('E_IO', `Plan document is outside ${this.#plansDir}`)
    }
    return this.#documentPathFor(plan.workspace, normalized, createDirectory, requireFile)
  }

  async #documentPathFor(
    workspace: string,
    filePath: string,
    createDirectory: boolean,
    requireFile: boolean,
  ): Promise<string> {
    await this.#assertWorkspace(workspace)
    const absolute = resolve(workspace, filePath)
    workspaceRelative(workspace, absolute)
    const documentRoot = await this.#assertDocumentRoot(workspace, createDirectory)
    const expectedParent = resolve(workspace, dirname(filePath))
    if (!samePath(documentRoot, expectedParent)) {
      throw new LubanError('E_IO', 'Plan document parent is outside the canonical plans directory')
    }
    const result = join(documentRoot, basename(absolute))
    if (requireFile) await this.#assertRegularDocument(documentRoot, result)
    return result
  }

  async #assertWorkspace(workspace: string): Promise<void> {
    const [info, resolved] = await Promise.all([lstat(workspace), realpath(workspace)]).catch(
      (error: unknown): never => {
        throw new LubanError('E_IO', 'Plan workspace identity is unavailable', { cause: error })
      },
    )
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(workspace, resolved)) {
      throw new LubanError('E_IO', 'Plan workspace identity changed or is not canonical')
    }
    const current = directoryIdentity(info)
    const fence = this.#workspaceFences.get(workspace)
    if (fence !== undefined && !sameDirectoryIdentity(fence.identity, current)) {
      throw new LubanError('E_IO', 'Plan workspace identity changed or is unavailable')
    }
    if (fence === undefined) {
      this.#workspaceFences.set(workspace, { path: workspace, identity: current })
    }
  }

  async #assertDocumentRoot(workspace: string, create: boolean): Promise<string> {
    await this.#assertWorkspace(workspace)
    try {
      let current = workspace
      for (const segment of this.#plansDir.split('/')) {
        const candidate = join(current, segment)
        const info = await lstat(candidate).catch(async (error: unknown) => {
          if (!create || errorCode(error) !== 'ENOENT') throw error
          await mkdir(candidate, { mode: 0o700 })
          return lstat(candidate)
        })
        const resolved = await realpath(candidate)
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          !samePath(candidate, resolved) ||
          !isInside(workspace, resolved)
        ) {
          throw new LubanError(
            'E_IO',
            'Plan document directory resolves outside the workspace or changed identity',
          )
        }
        current = resolved
      }
      const identity = directoryIdentity(await lstat(current))
      const fence = this.#documentFences.get(workspace)
      if (
        fence !== undefined &&
        (!samePath(fence.path, current) || !sameDirectoryIdentity(fence.identity, identity))
      ) {
        throw new LubanError('E_IO', 'Plan document directory identity changed or is unavailable')
      }
      if (fence === undefined) this.#documentFences.set(workspace, { path: current, identity })
      return current
    } catch (error: unknown) {
      throw error instanceof LubanError
        ? error
        : new LubanError('E_IO', 'Plan document directory is unavailable', { cause: error })
    }
  }

  async #assertRegularDocument(root: string, filePath: string): Promise<void> {
    const [info, resolved] = await Promise.all([lstat(filePath), realpath(filePath)]).catch(
      (error: unknown): never => {
        throw new LubanError('E_IO', 'Plan document is unavailable', { cause: error })
      },
    )
    if (!info.isFile() || info.isSymbolicLink() || !isInside(root, resolved)) {
      throw new LubanError('E_IO', 'Plan document is not a canonical regular file')
    }
  }
}
