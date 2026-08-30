import type {
  AccountId,
  AgentClaimService,
  ClaimCompletionOptions,
  ClaimFilter,
  ClaimMutationOptions,
  ClaimResult,
  ClaimSession,
  Task,
  TaskId,
  TaskOutput,
  TaskProgress,
  TaskStore,
} from 'dsh-luban-core'
import { asAccountId, asActorId, asSessionId, asTaskId } from 'dsh-luban-core'
import { LubanError } from 'dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import { BrowserTaskboardAutomation } from '../src/taskboard-automation.js'
import type { BrowserJobRequest, BrowserJobSnapshot, BrowserQueue } from '../src/types.js'

const ACCOUNT = asAccountId('alice')

describe('BrowserTaskboardAutomation', () => {
  it('recovers persisted browser claims per account and deduplicates a concurrent transition', async () => {
    const alice = task(['browser', 'auto-ok', 'browser-template:datasheet'])
    const bob = task(
      ['browser', 'auto-ok', 'browser-template:datasheet'],
      'lease-bob',
      1,
      asAccountId('bob'),
    )
    if (alice.claim === undefined || alice.claim === null) {
      throw new Error('Alice browser task claim is required')
    }
    const aliceActor = alice.claim.actor
    const { queue, enqueue, requests } = fakeQueueForAccounts()
    const claims = fakeClaims()
    let listener: ((event: Parameters<Parameters<TaskStore['subscribe']>[0]>[0]) => void) | undefined
    const query = vi.fn((): Promise<readonly Task[]> => {
      listener?.({
        type: 'transitioned',
        task: alice,
        from: 'todo',
        to: 'doing',
        actor: aliceActor,
      })
      return Promise.resolve([alice, bob])
    })
    const store = fakeStore(query, (value): (() => void) => {
      listener = value
      return (): void => {
        listener = undefined
      }
    })
    const onError = vi.fn()
    const automation = new BrowserTaskboardAutomation(queue, claims.service)

    const unbind = await automation.bind(store, onError)
    await vi.waitFor((): void => {
      expect(enqueue).toHaveBeenCalledTimes(2)
    })

    expect(query).toHaveBeenCalledWith({ statuses: ['doing'], tags: ['browser'] })
    expect(requests.map((request) => request.accountId)).toEqual([ACCOUNT, asAccountId('bob')])
    expect(onError).not.toHaveBeenCalled()
    unbind()
  })

  it('surfaces recovery query failures and removes the event listener', async () => {
    const failure = new Error('task ledger unavailable')
    const unsubscribe = vi.fn()
    const store = fakeStore(
      vi.fn(() => Promise.reject(failure)),
      (): (() => void) => unsubscribe,
    )
    const automation = new BrowserTaskboardAutomation(fakeQueue().queue, fakeClaims().service)

    await expect(automation.bind(store, vi.fn())).rejects.toBe(failure)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('requires all safety tags and writes a successful artifact through claims', async () => {
    const { queue, enqueue } = fakeQueue()
    const claims = fakeClaims()
    const automation = new BrowserTaskboardAutomation(queue, claims.service)
    const claimedTask = task([
      'browser',
      'auto-ok',
      'browser-template:datasheet',
      'browser-param:part=STM32',
    ])

    await automation.executeClaimedTask(claimedTask)

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ automatic: true }))
    expect(claims.progress).toHaveBeenCalledTimes(2)
    expect(claims.complete).toHaveBeenCalledWith(
      asTaskId('T-1'),
      expect.objectContaining({ kind: 'artifact', ref: '/artifact/result.png' }),
      { autoDone: true, expectedClaim: claimedTask.claim },
    )
    expect(claims.fail).not.toHaveBeenCalled()
  })

  it('returns scheduler-owned output without competing for terminal claim ownership', async () => {
    const { queue, enqueue } = fakeQueue()
    const claims = fakeClaims()
    const automation = new BrowserTaskboardAutomation(queue, claims.service)
    const claimedTask = nightTask([
      'browser',
      'auto-ok',
      'browser-template:datasheet',
      'browser-param:part=STM32',
    ])

    const output = await automation.executeNightTask(
      claimedTask,
      asSessionId('luban-night-session-1'),
    )
    await automation.executeClaimedTask(claimedTask)

    expect(output).toMatchObject({ kind: 'artifact', ref: '/artifact/result.png' })
    expect(enqueue).toHaveBeenCalledOnce()
    expect(claims.progress).toHaveBeenCalledTimes(2)
    expect(claims.complete).not.toHaveBeenCalled()
    expect(claims.fail).not.toHaveBeenCalled()
  })

  it('does not trust a forged scheduler display name and session prefix', async () => {
    const { queue, enqueue } = fakeQueue()
    const claims = fakeClaims()
    const automation = new BrowserTaskboardAutomation(queue, claims.service)
    const value = task(['browser', 'auto-ok', 'browser-template:datasheet'])
    const forged: Task = {
      ...value,
      claim: {
        actor: {
          kind: 'agent',
          id: asActorId('luban-night-forged'),
          displayName: 'Luban Night Scheduler',
        },
        sessionId: asSessionId('luban-night-forged'),
        claimedAt: 1,
        leaseId: 'forged-lease',
      },
    }

    await automation.executeClaimedTask(forged)

    expect(enqueue).toHaveBeenCalledOnce()
    expect(claims.complete).toHaveBeenCalledOnce()
  })

  it('rejects automatic execution without auto-ok', async () => {
    const { queue, enqueue } = fakeQueue()
    const claims = fakeClaims()
    const automation = new BrowserTaskboardAutomation(queue, claims.service)

    await expect(
      automation.executeClaimedTask(task(['browser', 'browser-template:datasheet'])),
    ).rejects.toThrow(/auto-ok/u)
    expect(enqueue).not.toHaveBeenCalled()
    expect(claims.fail).toHaveBeenCalledWith(asTaskId('T-1'), expect.stringMatching(/auto-ok/u), {
      expectedClaim: task([]).claim,
    })
  })

  it('fails closed when a succeeded job contains a non-ok browser result', async () => {
    const { queue } = fakeQueue('failed')
    const claims = fakeClaims()
    const automation = new BrowserTaskboardAutomation(queue, claims.service)
    const claimedTask = task(['browser', 'auto-ok', 'browser-template:datasheet'])

    await automation.executeClaimedTask(claimedTask)

    expect(claims.progress).toHaveBeenCalledTimes(1)
    expect(claims.complete).not.toHaveBeenCalled()
    expect(claims.fail).toHaveBeenCalledTimes(1)
    expect(claims.fail).toHaveBeenCalledWith(asTaskId('T-1'), 'Browser automation failed', {
      expectedClaim: claimedTask.claim,
    })
  })

  it('serializes claim generations and runs the replacement after a stale claim conflict', async () => {
    const first = task(['browser', 'auto-ok', 'browser-template:datasheet'], 'lease-a', 1)
    const replacement = task(['browser', 'auto-ok', 'browser-template:datasheet'], 'lease-b', 2)
    const firstWait = deferred<BrowserJobSnapshot>()
    const successful = completedJob('R-2')
    let enqueueCount = 0
    const enqueue = vi.fn((request: BrowserJobRequest): BrowserJobSnapshot => {
      enqueueCount += 1
      return {
        id: `R-${String(enqueueCount)}`,
        accountId: request.accountId,
        status: 'queued',
        task: request.task,
        automatic: true,
        createdAt: enqueueCount,
        progressStep: 0,
        screenshots: [],
      }
    })
    const queue: BrowserQueue = {
      enqueue,
      cancel: vi.fn(() => Promise.resolve(false)),
      get: vi.fn(() => null),
      list: vi.fn(() => []),
      wait: vi.fn((id: string) => (id === 'R-1' ? firstWait.promise : Promise.resolve(successful))),
      subscribe: vi.fn(() => (): void => undefined),
      subscribeAll: vi.fn(() => (): void => undefined),
    }
    const progress = vi.fn(
      (_id: TaskId, value: TaskProgress, options?: ClaimMutationOptions): Promise<void> =>
        options?.expectedClaim?.leaseId === 'lease-a' && value.percent === 100
          ? Promise.reject(
              new LubanError('E_VERSION_CONFLICT', 'Task claim has changed', { retriable: true }),
            )
          : Promise.resolve(),
    )
    const complete = vi.fn(
      (_id: TaskId, _output: TaskOutput, _options: ClaimCompletionOptions): Promise<Task> =>
        Promise.resolve(replacement),
    )
    const fail = vi.fn(
      (_id: TaskId, _reason: string, options?: ClaimMutationOptions): Promise<void> =>
        options?.expectedClaim?.leaseId === 'lease-a'
          ? Promise.reject(
              new LubanError('E_VERSION_CONFLICT', 'Task claim has changed', { retriable: true }),
            )
          : Promise.resolve(),
    )
    const claims: AgentClaimService = {
      claim: (_filter: ClaimFilter, _session: ClaimSession): Promise<ClaimResult> =>
        Promise.resolve({ ok: false, reason: 'no-match' }),
      reportProgress: progress,
      complete,
      fail,
    }
    const automation = new BrowserTaskboardAutomation(queue, claims)

    const staleRun = automation.executeClaimedTask(first)
    const duplicateStaleRun = automation.executeClaimedTask(first)
    await vi.waitFor((): void => {
      expect(enqueue).toHaveBeenCalledTimes(1)
    })
    const replacementRun = automation.executeClaimedTask(replacement)
    expect(enqueue).toHaveBeenCalledTimes(1)

    const staleExpectation = expect(staleRun).rejects.toMatchObject({
      code: 'E_VERSION_CONFLICT',
    })
    const duplicateExpectation = expect(duplicateStaleRun).rejects.toMatchObject({
      code: 'E_VERSION_CONFLICT',
    })
    firstWait.resolve(completedJob('R-1'))
    await staleExpectation
    await duplicateExpectation
    await replacementRun

    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(fail).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete).toHaveBeenCalledWith(
      asTaskId('T-1'),
      expect.objectContaining({ kind: 'artifact' }),
      { autoDone: true, expectedClaim: replacement.claim },
    )
  })
})

function task(
  tags: readonly string[],
  leaseId = 'lease-1',
  version = 1,
  accountId = ACCOUNT,
): Task {
  return {
    id: asTaskId('T-1'),
    accountId,
    title: 'Research part',
    description: 'Find the datasheet',
    status: 'doing',
    hostScope: 'any',
    priority: 'P1',
    tags,
    version,
    claim: {
      actor: { kind: 'agent', id: asActorId('agent-1') },
      sessionId: asSessionId('session-1'),
      claimedAt: 1,
      leaseId,
    },
    outputs: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

function fakeStore(
  query: TaskStore['query'],
  subscribe: TaskStore['subscribe'],
): TaskStore {
  return {
    create: vi.fn(() => Promise.reject(new Error('not implemented'))),
    update: vi.fn(() => Promise.reject(new Error('not implemented'))),
    transition: vi.fn(() => Promise.reject(new Error('not implemented'))),
    get: vi.fn(() => Promise.resolve(null)),
    query,
    subscribe,
  }
}

function nightTask(tags: readonly string[]): Task {
  const value = task(tags)
  return {
    ...value,
    claim: {
      actor: {
        kind: 'agent',
        id: asActorId('luban-night-session-1'),
        displayName: 'Luban Night Scheduler',
      },
      sessionId: asSessionId('luban-night-session-1'),
      claimedAt: 1,
      leaseId: 'night-lease-1',
      executionOwner: 'night-scheduler',
    },
  }
}

function completedJob(id: string, resultStatus: 'ok' | 'failed' = 'ok'): BrowserJobSnapshot {
  return {
    id,
    accountId: ACCOUNT,
    status: 'succeeded',
    task: { goal: 'Find the datasheet' },
    automatic: true,
    createdAt: 1,
    finishedAt: 2,
    progressStep: 1,
    screenshots: ['/artifact/result.png'],
    result: {
      accountId: ACCOUNT,
      runId: id,
      status: resultStatus,
      screenshots: ['/artifact/result.png'],
      text: 'Found result',
      steps: 1,
      durationMs: 1,
    },
  }
}

function fakeQueue(resultStatus: 'ok' | 'failed' = 'ok'): {
  readonly queue: BrowserQueue
  readonly enqueue: ReturnType<typeof vi.fn>
} {
  const completed = completedJob('R-1', resultStatus)
  const enqueue = vi.fn((_request: BrowserJobRequest): BrowserJobSnapshot => ({
    id: completed.id,
    accountId: ACCOUNT,
    status: 'queued',
    task: completed.task,
    automatic: true,
    createdAt: completed.createdAt,
    progressStep: 0,
    screenshots: [],
  }))
  return {
    enqueue,
    queue: {
      enqueue,
      cancel: vi.fn(() => Promise.resolve(false)),
      get: vi.fn(() => completed),
      list: vi.fn(() => [completed]),
      wait: vi.fn(() => Promise.resolve(completed)),
      subscribe: vi.fn(() => (): void => undefined),
      subscribeAll: vi.fn(() => (): void => undefined),
    },
  }
}

function fakeQueueForAccounts(): {
  readonly queue: BrowserQueue
  readonly enqueue: ReturnType<typeof vi.fn>
  readonly requests: readonly BrowserJobRequest[]
} {
  const requests: BrowserJobRequest[] = []
  const enqueue = vi.fn((request: BrowserJobRequest): BrowserJobSnapshot => {
    requests.push(request)
    return {
      id: `R-${String(request.accountId)}`,
      accountId: request.accountId,
      status: 'queued',
      task: request.task,
      automatic: true,
      createdAt: 1,
      progressStep: 0,
      screenshots: [],
    }
  })
  return {
    enqueue,
    requests,
    queue: {
      enqueue,
      cancel: vi.fn(() => Promise.resolve(false)),
      get: vi.fn(() => null),
      list: vi.fn(() => []),
      wait: vi.fn((id: string, accountId: AccountId): Promise<BrowserJobSnapshot> =>
        Promise.resolve({ ...completedJob(id), id, accountId }),
      ),
      subscribe: vi.fn(() => (): void => undefined),
      subscribeAll: vi.fn(() => (): void => undefined),
    },
  }
}

function fakeClaims(): {
  service: AgentClaimService
  progress: ReturnType<typeof vi.fn>
  complete: ReturnType<typeof vi.fn>
  fail: ReturnType<typeof vi.fn>
} {
  const progress = vi.fn(
    (_id: TaskId, _progress: TaskProgress, _options?: ClaimMutationOptions): Promise<void> =>
      Promise.resolve(),
  )
  const complete = vi.fn(
    (_id: TaskId, _output: TaskOutput, _options: ClaimCompletionOptions): Promise<Task> =>
      Promise.resolve(task([])),
  )
  const fail = vi.fn(
    (_id: TaskId, _reason: string, _options?: ClaimMutationOptions): Promise<void> =>
      Promise.resolve(),
  )
  return {
    progress,
    complete,
    fail,
    service: {
      claim: (_filter: ClaimFilter, _session: ClaimSession): Promise<ClaimResult> =>
        Promise.resolve({
          ok: false,
          reason: 'no-match',
        }),
      reportProgress: progress,
      complete,
      fail,
    },
  }
}

function deferred<Value>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
} {
  let resolvePromise: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve): void => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value: Value): void {
      resolvePromise?.(value)
    },
  }
}
