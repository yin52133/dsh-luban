import { randomBytes, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import type {
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
} from '@luban/core'
import {
  AtomicJsonStore,
  LubanError,
  asActorId,
  asPlanId,
  asSessionId,
  asTaskId,
} from '@luban/core'
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
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(filePath), `.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const handle = await open(temporary, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
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
  readonly #plansDir: string
  readonly #clock: Clock

  public constructor(stateFile: string, plansDir: string, clock: Clock) {
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
    readonly workspace: string
    readonly slug: string
    readonly sections: PlanSections
    readonly taskId?: TaskId
    readonly sessionId?: SessionId
    readonly status?: 'draft' | 'in-review'
  }): Promise<StoredPlan> {
    const workspace = resolve(input.workspace)
    const workspaceStat = await stat(workspace).catch((error: unknown): never => {
      throw new LubanError('E_INVALID_INPUT', `Workspace does not exist: ${workspace}`, {
        cause: error,
      })
    })
    if (!workspaceStat.isDirectory())
      throw new LubanError('E_INVALID_INPUT', 'workspace must be a directory')
    const now = this.#clock.now()
    const slug = normalizeSlug(input.slug)
    const filePath = `${this.#plansDir}/${dateKey(now)}-${slug}.md`
    const absoluteFile = resolve(workspace, filePath)
    workspaceRelative(workspace, absoluteFile)
    const plan: StoredPlan = {
      id: asPlanId(`P-${dateKey(now).replaceAll('-', '')}-${randomBytes(4).toString('hex')}`),
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
    await atomicTextWrite(absoluteFile, renderPlanDocument(plan), true)
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
        next.filePath !== current.filePath ||
        next.workspace !== current.workspace
      ) {
        throw new LubanError('E_INVALID_INPUT', 'Plan identity and document location are immutable')
      }
      const plans = [...state.plans]
      plans[index] = next
      await atomicTextWrite(this.#documentPath(next), renderPlanDocument(next), false)
      result = next
      return { ...state, plans }
    })
    if (result === undefined) throw new LubanError('E_IO', 'Plan update did not produce a result')
    return result
  }

  public now(): number {
    return this.#clock.now()
  }

  public async readDocument(plan: StoredPlan): Promise<string> {
    const path = this.#documentPath(plan)
    return readFile(path, 'utf8').catch((error: unknown): never => {
      throw new LubanError('E_IO', `Unable to read plan document ${plan.filePath}`, {
        cause: error,
      })
    })
  }

  #documentPath(plan: StoredPlan): string {
    const normalized = normalize(plan.filePath).replaceAll('\\', '/')
    if (!normalized.startsWith(`${this.#plansDir}/`)) {
      throw new LubanError('E_IO', `Plan document is outside ${this.#plansDir}`)
    }
    const absolute = resolve(plan.workspace, normalized)
    workspaceRelative(plan.workspace, absolute)
    return absolute
  }
}
