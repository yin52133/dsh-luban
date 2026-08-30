import type { Checkpoint, KeepaliveService, TaskId } from 'dsh-luban-core'
import { asTaskId } from 'dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import type { CheckpointStep } from '../src/checkpoint-runner.js'
import { runCheckpointedTask } from '../src/checkpoint-runner.js'

class MemoryCheckpoints implements Pick<KeepaliveService, 'loadCheckpoint' | 'saveCheckpoint'> {
  public value: Checkpoint | null
  public readonly saved: Checkpoint[] = []

  public constructor(value: Checkpoint | null = null) {
    this.value = value
  }

  public loadCheckpoint(_id: string): Promise<Checkpoint | null> {
    return Promise.resolve(this.value)
  }

  public saveCheckpoint(_id: string, checkpoint: Checkpoint): Promise<void> {
    this.value = checkpoint
    this.saved.push(checkpoint)
    return Promise.resolve()
  }
}

function step(id: string, execute: CheckpointStep['run']): CheckpointStep {
  return { id, run: execute }
}

const TASK_ID: TaskId = asTaskId('TASK-42')

describe('runCheckpointedTask', (): void => {
  it('resumes at the first incomplete step and never reruns persisted milestones', async (): Promise<void> => {
    const checkpoints = new MemoryCheckpoints({
      taskId: TASK_ID,
      stepList: ['configure', 'compile', 'test'],
      currentStep: 1,
      artifacts: ['/workspace/configure.log'],
      savedAt: 100,
    })
    const configure = vi.fn<CheckpointStep['run']>()
    const compile = vi.fn<CheckpointStep['run']>().mockResolvedValue(['/workspace/build.log'])
    const test = vi.fn<CheckpointStep['run']>().mockResolvedValue(['/workspace/test.log'])
    let now = 200

    const completed = await runCheckpointedTask({
      keepalive: checkpoints,
      sessionId: 'firmware-build',
      taskId: TASK_ID,
      steps: [step('configure', configure), step('compile', compile), step('test', test)],
      now: (): number => now++,
    })

    expect(configure).not.toHaveBeenCalled()
    expect(compile).toHaveBeenCalledOnce()
    expect(test).toHaveBeenCalledOnce()
    expect(checkpoints.saved.map((checkpoint) => checkpoint.currentStep)).toEqual([2, 3])
    expect(completed).toMatchObject({
      currentStep: 3,
      artifacts: ['/workspace/configure.log', '/workspace/build.log', '/workspace/test.log'],
    })

    await runCheckpointedTask({
      keepalive: checkpoints,
      sessionId: 'firmware-build',
      taskId: TASK_ID,
      steps: [step('configure', configure), step('compile', compile), step('test', test)],
    })
    expect(compile).toHaveBeenCalledOnce()
    expect(test).toHaveBeenCalledOnce()
  })

  it('does not advance the checkpoint when a milestone fails', async (): Promise<void> => {
    const checkpoints = new MemoryCheckpoints()
    const failure = new Error('compiler failed')

    await expect(
      runCheckpointedTask({
        keepalive: checkpoints,
        sessionId: 'failed-build',
        taskId: TASK_ID,
        steps: [step('compile', () => Promise.reject(failure))],
      }),
    ).rejects.toBe(failure)

    expect(checkpoints.saved).toEqual([])
    expect(checkpoints.value).toBeNull()
  })

  it('fails closed when a saved task or plan no longer matches', async (): Promise<void> => {
    const execute = vi.fn<CheckpointStep['run']>()
    const checkpoints = new MemoryCheckpoints({
      taskId: asTaskId('OTHER'),
      stepList: ['compile'],
      currentStep: 0,
      artifacts: [],
      savedAt: 100,
    })

    await expect(
      runCheckpointedTask({
        keepalive: checkpoints,
        sessionId: 'firmware-build',
        taskId: TASK_ID,
        steps: [step('compile', execute)],
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('honors cancellation before starting the next milestone', async (): Promise<void> => {
    const checkpoints = new MemoryCheckpoints()
    const controller = new AbortController()
    controller.abort()
    const execute = vi.fn<CheckpointStep['run']>()

    await expect(
      runCheckpointedTask({
        keepalive: checkpoints,
        sessionId: 'cancelled-build',
        taskId: TASK_ID,
        steps: [step('compile', execute)],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE', retriable: true })
    expect(execute).not.toHaveBeenCalled()
  })
})
