import type {
  AgentClaimService,
  SessionId,
  Task,
  TaskEvent,
  TaskOutput,
  TaskStore,
} from '@luban/core'
import { BrowserError } from './errors.js'
import type { BrowserQueue } from './types.js'

const TEMPLATE_TAG = 'browser-template:'
const PARAMETER_TAG = 'browser-param:'
const TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u

interface TaskExecutionState {
  tail: Promise<void>
  readonly generations: Map<string, Promise<void>>
}

interface BrowserExecutionFailure {
  readonly ok: false
  readonly message: string
  readonly retriable: boolean
}

interface BrowserExecutionSuccess {
  readonly ok: true
  readonly output: TaskOutput
}

type BrowserExecutionResult = BrowserExecutionFailure | BrowserExecutionSuccess

export class BrowserTaskboardAutomation {
  readonly #queue: BrowserQueue
  readonly #claims: AgentClaimService
  readonly #executions = new Map<string, TaskExecutionState>()

  public constructor(queue: BrowserQueue, claims: AgentClaimService) {
    this.#queue = queue
    this.#claims = claims
  }

  public bind(store: TaskStore): () => void {
    return store.subscribe((event): void => {
      if (event.type !== 'transitioned' || event.to !== 'doing') return
      void this.executeClaimedTask(event.task).catch((): undefined => undefined)
    })
  }

  public async executeClaimedTask(task: Task): Promise<void> {
    if (!task.tags.includes('browser')) return
    if (isNightSchedulerClaim(task)) return
    const generation = claimGeneration(task)
    const state = this.#executions.get(task.id) ?? {
      tail: Promise.resolve(),
      generations: new Map<string, Promise<void>>(),
    }
    this.#executions.set(task.id, state)
    const existing = state.generations.get(generation)
    if (existing !== undefined) return existing

    const execution = state.tail
      .catch((): undefined => undefined)
      .then(async (): Promise<void> => {
        await this.#runClaimedTask(task)
      })
    state.generations.set(generation, execution)
    state.tail = execution
    const cleanup = (): void => {
      if (state.generations.get(generation) === execution) {
        state.generations.delete(generation)
      }
      if (
        state.generations.size === 0 &&
        state.tail === execution &&
        this.#executions.get(task.id) === state
      ) {
        this.#executions.delete(task.id)
      }
    }
    void execution.then(cleanup, cleanup)
    return execution
  }

  /** Execute a scheduler-owned browser task without mutating its terminal claim state. */
  public async executeNightTask(task: Task, sessionId: SessionId): Promise<TaskOutput> {
    if (!isNightSchedulerClaim(task, sessionId)) {
      throw new BrowserError(
        'E_BROWSER_POLICY',
        'Night browser execution requires the owning Luban night scheduler claim',
      )
    }
    const result = await this.#executeBrowserTask(task)
    if (!result.ok) {
      throw new BrowserError('E_BROWSER_RUN', result.message, result.retriable)
    }
    return result.output
  }

  async #runClaimedTask(task: Task): Promise<void> {
    const expectedClaim = task.claim
    if (expectedClaim?.actor.kind !== 'agent') {
      throw new BrowserError('E_BROWSER_POLICY', 'Automatic browser tasks require an agent claim')
    }
    let failureReported = false
    let failureAttempted = false
    try {
      const result = await this.#executeBrowserTask(task)
      if (!result.ok) {
        failureAttempted = true
        await this.#claims.fail(task.id, result.message, {
          expectedClaim,
        })
        failureReported = true
        return
      }
      await this.#claims.complete(task.id, result.output, { autoDone: true, expectedClaim })
    } catch (error: unknown) {
      if (!failureReported && !failureAttempted) {
        failureAttempted = true
        await this.#claims.fail(
          task.id,
          error instanceof Error ? error.message : 'Browser automation failed',
          { expectedClaim },
        )
        failureReported = true
      }
      throw error
    }
  }

  async #executeBrowserTask(task: Task): Promise<BrowserExecutionResult> {
    const expectedClaim = task.claim
    if (expectedClaim?.actor.kind !== 'agent') {
      throw new BrowserError('E_BROWSER_POLICY', 'Automatic browser tasks require an agent claim')
    }
    if (!task.tags.includes('auto-ok')) {
      throw new BrowserError('E_BROWSER_POLICY', 'Automatic browser tasks require the auto-ok tag')
    }
    const templateTags = task.tags.filter((tag) => tag.startsWith(TEMPLATE_TAG))
    if (templateTags.length !== 1) {
      throw new BrowserError(
        'E_BROWSER_POLICY',
        'Automatic browser tasks require exactly one template tag',
      )
    }
    const templateId = templateTags[0]?.slice(TEMPLATE_TAG.length) ?? ''
    if (!TEMPLATE_ID.test(templateId)) {
      throw new BrowserError('E_BROWSER_POLICY', 'Invalid browser template tag')
    }
    const params = parseParameters(task.tags)
    await this.#claims.reportProgress(
      task.id,
      {
        summary: 'Browser automation queued',
        percent: 0,
      },
      { expectedClaim },
    )
    const queued = this.#queue.enqueue({
      task: {
        templateId,
        goal: task.description.trim() === '' ? task.title : task.description,
      },
      params,
      automatic: true,
    })
    const completed = await this.#queue.wait(queued.id)
    if (completed.status !== 'succeeded' || completed.result?.status !== 'ok') {
      return {
        ok: false,
        message: completed.error?.message ?? 'Browser automation failed',
        retriable: completed.error?.retriable ?? false,
      }
    }
    await this.#claims.reportProgress(
      task.id,
      {
        summary: 'Browser automation completed',
        percent: 100,
      },
      { expectedClaim },
    )
    return {
      ok: true,
      output: {
        kind: 'artifact',
        ref: completed.result.screenshots[0] ?? `browser-run:${completed.id}`,
        summary: summarize(completed.result.text),
        at: Date.now(),
        by: expectedClaim.actor,
      },
    }
  }
}

export function isBrowserTaskEvent(event: TaskEvent): boolean {
  return (
    event.type === 'transitioned' && event.to === 'doing' && event.task.tags.includes('browser')
  )
}

function parseParameters(tags: readonly string[]): Readonly<Record<string, string>> {
  const output: Record<string, string> = Object.create(null) as Record<string, string>
  for (const tag of tags) {
    if (!tag.startsWith(PARAMETER_TAG)) continue
    const assignment = tag.slice(PARAMETER_TAG.length)
    const separator = assignment.indexOf('=')
    const name = separator < 0 ? '' : assignment.slice(0, separator)
    const value = separator < 0 ? '' : assignment.slice(separator + 1)
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(name) || value === '') {
      throw new BrowserError('E_BROWSER_POLICY', 'Invalid browser-param tag')
    }
    output[name] = value
  }
  return Object.freeze(output)
}

function summarize(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized === '') return 'Browser automation completed'
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`
}

function claimGeneration(task: Task): string {
  const claim = task.claim
  if (claim === undefined || claim === null) return `unclaimed:${String(task.version)}`
  return JSON.stringify([
    claim.actor.kind,
    claim.actor.id,
    claim.sessionId,
    claim.claimedAt,
    claim.leaseId ?? null,
    claim.executionOwner ?? null,
  ])
}

function isNightSchedulerClaim(task: Task, sessionId?: SessionId): boolean {
  const claim = task.claim
  if (claim?.actor.kind !== 'agent') return false
  return (
    claim.executionOwner === 'night-scheduler' &&
    String(claim.actor.id) === String(claim.sessionId) &&
    (sessionId === undefined || claim.sessionId === sessionId)
  )
}
