import type {
  AgentClaimService,
  ClaimFilter,
  ClaimResult,
  ClaimSession,
  Task,
  TaskId,
  TaskOutput,
  TaskProgress,
} from '@luban/core'
import { asActorId, asSessionId, asTaskId } from '@luban/core'
import { describe, expect, it, vi } from 'vitest'
import { BrowserTaskboardAutomation } from '../src/taskboard-automation.js'
import type { BrowserJobRequest, BrowserJobSnapshot, BrowserQueue } from '../src/types.js'

describe('BrowserTaskboardAutomation', () => {
  it('requires all safety tags and writes a successful artifact through claims', async () => {
    const { queue, enqueue } = fakeQueue()
    const claims = fakeClaims()
    const automation = new BrowserTaskboardAutomation(queue, claims.service)

    await automation.executeClaimedTask(
      task(['browser', 'auto-ok', 'browser-template:datasheet', 'browser-param:part=STM32']),
    )

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ automatic: true }))
    expect(claims.progress).toHaveBeenCalledTimes(2)
    expect(claims.complete).toHaveBeenCalledWith(
      asTaskId('T-1'),
      expect.objectContaining({ kind: 'artifact', ref: '/artifact/result.png' }),
      { autoDone: true },
    )
    expect(claims.fail).not.toHaveBeenCalled()
  })

  it('rejects automatic execution without auto-ok', async () => {
    const { queue, enqueue } = fakeQueue()
    const claims = fakeClaims()
    const automation = new BrowserTaskboardAutomation(queue, claims.service)

    await expect(
      automation.executeClaimedTask(task(['browser', 'browser-template:datasheet'])),
    ).rejects.toThrow(/auto-ok/u)
    expect(enqueue).not.toHaveBeenCalled()
    expect(claims.fail).toHaveBeenCalledWith(asTaskId('T-1'), expect.stringMatching(/auto-ok/u))
  })
})

function task(tags: readonly string[]): Task {
  return {
    id: asTaskId('T-1'),
    title: 'Research part',
    description: 'Find the datasheet',
    status: 'doing',
    hostScope: 'any',
    priority: 'P1',
    tags,
    version: 1,
    claim: {
      actor: { kind: 'agent', id: asActorId('agent-1') },
      sessionId: asSessionId('session-1'),
      claimedAt: 1,
    },
    outputs: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

function fakeQueue(): { readonly queue: BrowserQueue; readonly enqueue: ReturnType<typeof vi.fn> } {
  const completed: BrowserJobSnapshot = {
    id: 'R-1',
    status: 'succeeded',
    task: { goal: 'Find the datasheet' },
    automatic: true,
    createdAt: 1,
    finishedAt: 2,
    progressStep: 1,
    screenshots: ['/artifact/result.png'],
    result: {
      runId: 'R-1',
      status: 'ok',
      screenshots: ['/artifact/result.png'],
      text: 'Found result',
      steps: 1,
      durationMs: 1,
    },
  }
  const enqueue = vi.fn((_request: BrowserJobRequest): BrowserJobSnapshot => ({
    id: completed.id,
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
    },
  }
}

function fakeClaims(): {
  service: AgentClaimService
  progress: ReturnType<typeof vi.fn>
  complete: ReturnType<typeof vi.fn>
  fail: ReturnType<typeof vi.fn>
} {
  const progress = vi.fn((_id: TaskId, _progress: TaskProgress): Promise<void> => Promise.resolve())
  const complete = vi.fn(
    (_id: TaskId, _output: TaskOutput, _options: { readonly autoDone: boolean }): Promise<Task> =>
      Promise.resolve(task([])),
  )
  const fail = vi.fn((_id: TaskId, _reason: string): Promise<void> => Promise.resolve())
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
