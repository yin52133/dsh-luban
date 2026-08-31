import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Actor, Clock, Task, TaskClaim, TaskOutput } from '../../packages/core/src/index.js'
import { asAccountId, asActorId, asHostId, asSessionId } from '../../packages/core/src/index.js'
import { BrowserTaskboardAutomation } from '../../packages/dsh-luban-browser/src/taskboard-automation.js'
import type {
  BrowserJobEvent,
  BrowserJobRequest,
  BrowserJobSnapshot,
  BrowserQueue,
} from '../../packages/dsh-luban-browser/src/types.js'
import { DefaultAgentClaimService } from '../../packages/dsh-luban-taskboard/src/claim-service.js'
import { createLedgerStore } from '../../packages/dsh-luban-taskboard/src/ledger.js'
import {
  DefaultNightScheduler,
  type NightTaskExecutor,
} from '../../packages/dsh-luban-taskboard/src/night-scheduler.js'
import { JsonTaskStore } from '../../packages/dsh-luban-taskboard/src/task-store.js'

// Keep the fixed clock inside the configured local-time scheduler window in every timezone.
const NOW = new Date(2026, 4, 3, 11, 11, 17, 777).getTime()
const CLOCK: Clock = { now: (): number => NOW }
const ACCOUNT = asAccountId('alice')
const AGENT: Actor = { kind: 'agent', id: asActorId('browser-agent'), accountId: ACCOUNT }
const SESSION = {
  actor: AGENT,
  sessionId: asSessionId('browser-session'),
  host: asHostId('ubuntu'),
} as const

describe('M11 taskboard browser automation integration', (): void => {
  it('gives one routed browser executor exclusive ownership of a night claim', async (): Promise<void> => {
    const harness = await createHarness([
      (job): Promise<BrowserJobSnapshot> => Promise.resolve(succeeded(job, 'night-browser')),
    ])
    const browserPathCompleted = deferred<undefined>()
    let schedulerClaim: TaskClaim | null | undefined
    const stopCompletionWatch = harness.store.subscribe((event): void => {
      if (event.task.status === 'doing') schedulerClaim = event.task.claim
      if (event.task.status === 'review') browserPathCompleted.resolve(undefined)
    })
    const fallbackExecute = vi.fn<NightTaskExecutor['execute']>(async (): Promise<TaskOutput> => {
      await browserPathCompleted.promise
      return {
        kind: 'artifact',
        ref: '/artifacts/duplicate-night-executor.png',
        summary: 'The fallback executor must not own a routed browser task.',
        at: NOW,
        by: AGENT,
      }
    })
    const fallback: NightTaskExecutor = { execute: fallbackExecute }
    const scheduler = new DefaultNightScheduler({
      store: harness.store,
      claims: harness.claims,
      executor: fallback,
      config: {
        enabled: true,
        window: '10:00-12:00',
        dailyQuota: 1,
        hostScopeWhitelist: ['ubuntu'],
        tagWhitelist: ['auto-ok'],
        model: { provider: 'deterministic', id: 'browser-test' },
        toolAllowlist: [],
        circuitBreaker: { maxConsecutiveFailures: 2 },
      },
      hostScope: 'ubuntu',
      clock: CLOCK,
    })
    const unregisterRoute = scheduler.registerTaskExecutor({
      id: 'luban-browser',
      matches: (task): boolean => task.tags.includes('browser'),
      executor: {
        execute: (task, sessionId): Promise<TaskOutput> =>
          harness.automation.executeNightTask(task, sessionId),
      },
    })

    try {
      const task = await harness.create(['browser', 'auto-ok', 'browser-template:night-safe'])

      await expect(scheduler.triggerOnce(ACCOUNT)).resolves.toBeUndefined()

      const completed = await harness.waitForTask(
        task.id,
        (candidate): boolean => candidate.status === 'review',
      )
      expect(fallbackExecute).not.toHaveBeenCalled()
      expect(harness.queue.requests).toHaveLength(1)
      expect(schedulerClaim).toMatchObject({ executionOwner: 'night-scheduler' })
      expect(completed).toMatchObject({ status: 'review', claim: null, autoDone: true })
      expect(completed.outputs.map((output) => output.ref)).toEqual([
        'progress:0',
        'progress:100',
        '/artifacts/night-browser.png',
      ])
      expect(scheduler.status()).toMatchObject({ quotaUsed: 1, circuit: 'ok' })
    } finally {
      unregisterRoute()
      stopCompletionWatch()
      await scheduler.dispose()
      await harness.dispose()
    }
  })

  it('persists claim, queue progress, artifact, and autoDone exactly once', async (): Promise<void> => {
    const completion = deferred<undefined>()
    const harness = await createHarness([
      (job): Promise<BrowserJobSnapshot> => completion.promise.then(() => succeeded(job, 'first')),
    ])
    try {
      const claimed = await harness.createAndClaim([
        'browser',
        'auto-ok',
        'browser-template:datasheet',
        'browser-param:part=STM32',
      ])
      await waitFor((): boolean => harness.queue.requests.length === 1)
      const duplicate = harness.automation.executeClaimedTask(claimed)

      completion.resolve(undefined)
      await duplicate
      const completed = await harness.waitForTask(
        claimed.id,
        (task): boolean => task.status === 'review',
      )

      expect(harness.queue.requests).toEqual([
        {
          accountId: ACCOUNT,
          automatic: true,
          params: { part: 'STM32' },
          task: {
            accountId: ACCOUNT,
            templateId: 'datasheet',
            goal: 'Collect the requested browser artifact.',
          },
        },
      ])
      expect(completed).toMatchObject({ status: 'review', claim: null, autoDone: true })
      expect(completed.outputs.map((output) => output.ref)).toEqual([
        'progress:0',
        'progress:100',
        '/artifacts/first.png',
      ])

      const reloaded = new JsonTaskStore(createLedgerStore(harness.ledgerPath, CLOCK), CLOCK)
      await expect(reloaded.get(claimed.id)).resolves.toEqual(completed)
    } finally {
      await harness.dispose()
    }
  })

  it('fails closed once for queue rejection, terminal failure, and non-ok results', async (): Promise<void> => {
    const cases: readonly {
      readonly name: string
      readonly outcome: Outcome
    }[] = [
      {
        name: 'wait rejection',
        outcome: (): Promise<BrowserJobSnapshot> => Promise.reject(new Error('queue rejected')),
      },
      {
        name: 'failed job',
        outcome: (job): Promise<BrowserJobSnapshot> =>
          Promise.resolve(failed(job, 'bridge failed')),
      },
      {
        name: 'failed browser result',
        outcome: (job): Promise<BrowserJobSnapshot> =>
          Promise.resolve(succeeded(job, 'failed-result', 'failed')),
      },
      {
        name: 'timed out browser result',
        outcome: (job): Promise<BrowserJobSnapshot> =>
          Promise.resolve(succeeded(job, 'timed-out-result', 'timeout')),
      },
    ]

    for (const scenario of cases) {
      const harness = await createHarness([scenario.outcome])
      try {
        const claimed = await harness.createAndClaim([
          'browser',
          'auto-ok',
          'browser-template:safe',
        ])
        let failedTask: Task
        try {
          failedTask = await harness.waitForTask(
            claimed.id,
            (task): boolean => task.status === 'todo' && task.failureCount === 1,
          )
        } catch (error: unknown) {
          throw new Error(
            `${scenario.name}: ${JSON.stringify(await harness.store.get(claimed.id))}`,
            { cause: error },
          )
        }

        expect(
          harness.queue.requests,
          `${scenario.name}: ${JSON.stringify(failedTask.outputs)}`,
        ).toHaveLength(1)
        expect(
          failedTask.outputs.filter((output) => output.ref.startsWith('failure:')),
        ).toHaveLength(1)
        expect(failedTask.outputs.some((output) => output.kind === 'artifact')).toBe(false)
        expect(failedTask.autoDone).not.toBe(true)
      } finally {
        await harness.dispose()
      }
    }
  })

  it('rejects missing and illegal safety tags without enqueueing a browser job', async (): Promise<void> => {
    const invalidTags: readonly (readonly string[])[] = [
      ['browser', 'browser-template:safe'],
      ['browser', 'auto-ok'],
      ['browser', 'auto-ok', 'browser-template:first', 'browser-template:second'],
      ['browser', 'auto-ok', 'browser-template:'],
      ['browser', 'auto-ok', 'browser-template:Unsafe!'],
      ['browser', 'auto-ok', 'browser-template:safe', 'browser-param:missing-equals'],
      ['browser', 'auto-ok', 'browser-template:safe', 'browser-param:part='],
      ['browser', 'auto-ok', 'browser-template:safe', 'browser-param:bad-name=value'],
    ]

    for (const tags of invalidTags) {
      const harness = await createHarness([])
      try {
        const claimed = await harness.createAndClaim(tags)
        const failedTask = await harness.waitForTask(
          claimed.id,
          (task): boolean => task.status === 'todo' && task.failureCount === 1,
        )

        expect(harness.queue.requests, tags.join(',')).toHaveLength(0)
        expect(failedTask.outputs.filter((output) => output.ref === 'failure:1')).toHaveLength(1)
      } finally {
        await harness.dispose()
      }
    }
  })

  it('ignores claimed tasks without the browser tag', async (): Promise<void> => {
    const harness = await createHarness([])
    try {
      const claimed = await harness.createAndClaim(['auto-ok', 'browser-template:safe'])
      await delay(20)

      expect(await harness.store.get(claimed.id)).toMatchObject({
        status: 'doing',
        claim: claimed.claim,
        outputs: [],
        failureCount: 0,
      })
      expect(harness.queue.requests).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('blocks every stale A write and executes same-clock reclaim B after A settles', async (): Promise<void> => {
    const first = deferred<undefined>()
    const second = deferred<undefined>()
    const harness = await createHarness([
      (job): Promise<BrowserJobSnapshot> => first.promise.then(() => succeeded(job, 'stale-a')),
      (job): Promise<BrowserJobSnapshot> => second.promise.then(() => succeeded(job, 'active-b')),
    ])
    try {
      const tags = ['browser', 'auto-ok', 'browser-template:safe'] as const
      const claimA = await harness.createAndClaim(tags)
      await waitFor((): boolean => harness.queue.requests.length === 1)
      await harness.store.transition(claimA.id, 'todo', AGENT, 'reclaimed after worker loss')
      const claimB = await harness.claim()

      expect(activeClaim(claimA).claimedAt).toBe(activeClaim(claimB).claimedAt)
      expect(activeClaim(claimA).leaseId).not.toBe(activeClaim(claimB).leaseId)
      expect(harness.queue.requests).toHaveLength(1)

      first.resolve(undefined)
      await waitFor((): boolean => harness.queue.requests.length === 2)
      expect(await harness.store.get(claimB.id)).toMatchObject({
        status: 'doing',
        claim: claimB.claim,
        failureCount: 0,
      })

      second.resolve(undefined)
      const completed = await harness.waitForTask(
        claimB.id,
        (task): boolean => task.status === 'review',
      )

      expect(completed.failureCount).toBe(0)
      expect(completed.outputs.filter((output) => output.ref === 'progress:100')).toHaveLength(1)
      expect(completed.outputs.filter((output) => output.kind === 'artifact')).toEqual([
        expect.objectContaining({ ref: '/artifacts/active-b.png' }),
      ])
      expect(completed.outputs.some((output) => output.ref === '/artifacts/stale-a.png')).toBe(
        false,
      )
      expect(completed).toMatchObject({ status: 'review', claim: null, autoDone: true })
    } finally {
      await harness.dispose()
    }
  })
})

type Outcome = (job: BrowserJobSnapshot) => Promise<BrowserJobSnapshot>

class ControlledQueue implements BrowserQueue {
  public readonly requests: BrowserJobRequest[] = []
  readonly #outcomes: Outcome[]
  readonly #jobs = new Map<string, BrowserJobSnapshot>()
  readonly #waits = new Map<string, Promise<BrowserJobSnapshot>>()

  public constructor(outcomes: readonly Outcome[]) {
    this.#outcomes = [...outcomes]
  }

  public enqueue(request: BrowserJobRequest): BrowserJobSnapshot {
    const id = `browser-job-${String(this.requests.length + 1)}`
    const queued: BrowserJobSnapshot = {
      id,
      status: 'queued',
      task: request.task,
      automatic: request.automatic === true,
      createdAt: NOW,
      progressStep: 0,
      screenshots: [],
    }
    const outcome = this.#outcomes.shift()
    if (outcome === undefined) throw new Error('Unexpected browser queue execution')
    this.requests.push(request)
    this.#jobs.set(id, queued)
    const completion = Promise.resolve()
      .then((): Promise<BrowserJobSnapshot> => outcome(queued))
      .then((completed): BrowserJobSnapshot => {
        this.#jobs.set(id, completed)
        return completed
      })
    this.#waits.set(id, completion)
    return queued
  }

  public cancel(): Promise<boolean> {
    return Promise.resolve(false)
  }

  public get(id: string): BrowserJobSnapshot | null {
    return this.#jobs.get(id) ?? null
  }

  public list(): readonly BrowserJobSnapshot[] {
    return [...this.#jobs.values()]
  }

  public wait(id: string): Promise<BrowserJobSnapshot> {
    return this.#waits.get(id) ?? Promise.reject(new Error(`Unknown browser job ${id}`))
  }

  public subscribe(_listener: (event: BrowserJobEvent) => void): () => void {
    return (): void => undefined
  }
}

interface Harness {
  readonly store: JsonTaskStore
  readonly claims: DefaultAgentClaimService
  readonly automation: BrowserTaskboardAutomation
  readonly queue: ControlledQueue
  readonly errors: readonly unknown[]
  readonly ledgerPath: string
  readonly create: (tags: readonly string[]) => Promise<Task>
  readonly createAndClaim: (tags: readonly string[]) => Promise<Task>
  readonly claim: () => Promise<Task>
  readonly waitForTask: (id: Task['id'], predicate: (task: Task) => boolean) => Promise<Task>
  readonly dispose: () => Promise<void>
}

async function createHarness(outcomes: readonly Outcome[]): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'luban-browser-taskboard-integration-'))
  const ledgerPath = join(directory, 'ledger.json')
  const store = new JsonTaskStore(createLedgerStore(ledgerPath, CLOCK), CLOCK)
  const claims = new DefaultAgentClaimService(store, 'ubuntu', true)
  const queue = new ControlledQueue(outcomes)
  const automation = new BrowserTaskboardAutomation(queue, claims)
  const errors: unknown[] = []
  const taskListeners = new Set<(task: Task) => void>()
  const pendingReads = new Set<Promise<void>>()
  const stopCapture = store.subscribe((event): void => {
    for (const listener of taskListeners) listener(event.task)
  })
  const unbind = await automation.bind(store, (error: unknown): void => {
    errors.push(error)
  })
  const claim = async (): Promise<Task> => {
    const result = await claims.claim({ accountId: ACCOUNT }, SESSION)
    if (!result.ok) throw new Error(`Task claim failed: ${result.reason}`)
    return result.task
  }
  return {
    store,
    claims,
    automation,
    queue,
    errors,
    ledgerPath,
    create: async (tags): Promise<Task> =>
      store.create({
        accountId: ACCOUNT,
        title: 'Automate a browser task',
        description: 'Collect the requested browser artifact.',
        status: 'todo',
        hostScope: 'ubuntu',
        priority: 'P1',
        acceptance: 'The browser result is attached for review.',
        tags,
      }),
    createAndClaim: async (tags): Promise<Task> => {
      await store.create({
        accountId: ACCOUNT,
        title: 'Automate a browser task',
        description: 'Collect the requested browser artifact.',
        status: 'todo',
        hostScope: 'ubuntu',
        priority: 'P1',
        acceptance: 'The browser result is attached for review.',
        tags,
      })
      return await claim()
    },
    claim,
    waitForTask: (id, predicate): Promise<Task> => {
      return new Promise<Task>((resolveTask, rejectTask): void => {
        let settled = false
        let snapshotComplete = false
        let pendingTask: Task | undefined
        const fail = (error: unknown): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          taskListeners.delete(listener)
          rejectTask(
            error instanceof Error
              ? error
              : new Error('Failed to read task state', { cause: error }),
          )
        }
        const finish = (task: Task): void => {
          if (settled || task.id !== id || !predicate(task)) return
          if (!snapshotComplete) {
            pendingTask = task
            return
          }
          settled = true
          clearTimeout(timer)
          taskListeners.delete(listener)
          resolveTask(task)
        }
        const timer = setTimeout((): void => {
          fail(new Error(`Timed out waiting for task ${id}`))
        }, 5_000)
        const listener = (task: Task): void => {
          finish(task)
        }
        taskListeners.add(listener)
        const snapshotRead = store.get(id).then(
          (task): void => {
            snapshotComplete = true
            if (task !== null && predicate(task)) {
              finish(task)
              return
            }
            if (pendingTask !== undefined) finish(pendingTask)
          },
          (error: unknown): void => {
            snapshotComplete = true
            fail(error)
          },
        )
        pendingReads.add(snapshotRead)
        void snapshotRead.then((): void => {
          pendingReads.delete(snapshotRead)
        })
      })
    },
    dispose: async (): Promise<void> => {
      unbind()
      stopCapture()
      await Promise.all(pendingReads)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function succeeded(
  job: BrowserJobSnapshot,
  label: string,
  status: 'ok' | 'failed' | 'timeout' = 'ok',
): BrowserJobSnapshot {
  return {
    ...job,
    status: 'succeeded',
    startedAt: NOW,
    finishedAt: NOW,
    progressStep: 1,
    screenshots: [`/artifacts/${label}.png`],
    result: {
      runId: job.id,
      status,
      screenshots: [`/artifacts/${label}.png`],
      text: `${label} result`,
      steps: 1,
      durationMs: 1,
    },
  }
}

function failed(job: BrowserJobSnapshot, message: string): BrowserJobSnapshot {
  return {
    ...job,
    status: 'failed',
    finishedAt: NOW,
    error: { code: 'E_BROWSER_UNAVAILABLE', message, retriable: true },
  }
}

function activeClaim(task: Task): TaskClaim {
  if (task.claim === undefined || task.claim === null) throw new Error('Task is not claimed')
  return task.claim
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await predicate()) return
    await delay(5)
  }
  throw new Error('Timed out waiting for taskboard automation')
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, milliseconds)
  })
}

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve): void => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value): void => {
      if (resolvePromise === undefined) throw new Error('Deferred resolver was not initialized')
      resolvePromise(value)
    },
  }
}
