import type { AccountId, Checkpoint, KeepaliveService, TaskId } from 'dsh-luban-core'
import { LubanError } from 'dsh-luban-core'

const MAX_STEPS = 256
const MAX_ARTIFACTS = 4_096

export interface CheckpointStepContext {
  readonly taskId: TaskId
  readonly sessionId: string
  readonly stepIndex: number
  readonly artifacts: readonly string[]
  readonly signal?: AbortSignal
}

export interface CheckpointStep {
  readonly id: string
  /** Return new durable artifact paths produced by this milestone. */
  run(context: CheckpointStepContext): Promise<readonly string[] | undefined>
}

export interface CheckpointedTaskOptions {
  readonly keepalive: Pick<KeepaliveService, 'loadCheckpoint' | 'saveCheckpoint'>
  readonly sessionId: string
  readonly taskId: TaskId
  readonly accountId?: AccountId
  readonly steps: readonly CheckpointStep[]
  readonly signal?: AbortSignal
  readonly now?: () => number
}

function validatePlan(steps: readonly CheckpointStep[]): readonly string[] {
  if (steps.length === 0 || steps.length > MAX_STEPS) {
    throw new LubanError(
      'E_INVALID_INPUT',
      `checkpoint plan must contain 1-${String(MAX_STEPS)} steps`,
    )
  }
  const ids = steps.map((step): string => step.id.trim())
  if (ids.some((id): boolean => id === '' || id.length > 256 || id.includes('\0'))) {
    throw new LubanError('E_INVALID_INPUT', 'checkpoint step ids must be bounded non-empty text')
  }
  if (new Set(ids).size !== ids.length) {
    throw new LubanError('E_INVALID_INPUT', 'checkpoint step ids must be unique')
  }
  return ids
}

function assertCompatible(
  checkpoint: Checkpoint,
  taskId: TaskId,
  ids: readonly string[],
  accountId?: AccountId,
): void {
  if (
    (accountId !== undefined && checkpoint.accountId !== accountId) ||
    checkpoint.taskId !== taskId ||
    checkpoint.stepList.length !== ids.length ||
    checkpoint.stepList.some((id, index): boolean => id !== ids[index])
  ) {
    throw new LubanError(
      'E_INVALID_INPUT',
      'saved checkpoint belongs to a different task or step plan',
    )
  }
}

function mergeArtifacts(
  current: readonly string[],
  produced: readonly string[] | undefined,
): readonly string[] {
  if (produced === undefined) return current
  if (
    !Array.isArray(produced) ||
    !produced.every(
      (artifact): artifact is string =>
        typeof artifact === 'string' &&
        artifact !== '' &&
        artifact.length <= 4_096 &&
        !artifact.includes('\0'),
    )
  ) {
    throw new LubanError('E_INVALID_INPUT', 'checkpoint artifacts must be bounded non-empty paths')
  }
  const merged = [...new Set([...current, ...produced])]
  if (merged.length > MAX_ARTIFACTS) {
    throw new LubanError(
      'E_INVALID_INPUT',
      `checkpoint artifacts exceed ${String(MAX_ARTIFACTS)} entries`,
    )
  }
  return merged
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new LubanError('E_UNAVAILABLE', 'checkpointed task was cancelled', { retriable: true })
  }
}

/**
 * Execute milestone steps from the first incomplete checkpoint. A step is advanced only after its
 * output has completed and the next-step checkpoint is durably saved.
 */
export async function runCheckpointedTask(options: CheckpointedTaskOptions): Promise<Checkpoint> {
  const ids = validatePlan(options.steps)
  const existing = await options.keepalive.loadCheckpoint(options.sessionId)
  if (existing !== null) assertCompatible(existing, options.taskId, ids, options.accountId)
  let checkpoint: Checkpoint =
    existing ??
    Object.freeze({
      ...(options.accountId === undefined ? {} : { accountId: options.accountId }),
      taskId: options.taskId,
      stepList: ids,
      currentStep: 0,
      artifacts: [],
      savedAt: options.now?.() ?? Date.now(),
    })

  for (let index = checkpoint.currentStep; index < options.steps.length; index += 1) {
    throwIfAborted(options.signal)
    const step = options.steps[index]
    if (step === undefined) throw new LubanError('E_INVALID_INPUT', 'checkpoint step is missing')
    const produced = await step.run({
      taskId: options.taskId,
      sessionId: options.sessionId,
      stepIndex: index,
      artifacts: checkpoint.artifacts,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    checkpoint = Object.freeze({
      ...(checkpoint.accountId === undefined ? {} : { accountId: checkpoint.accountId }),
      taskId: options.taskId,
      stepList: ids,
      currentStep: index + 1,
      artifacts: mergeArtifacts(checkpoint.artifacts, produced),
      savedAt: options.now?.() ?? Date.now(),
    })
    await options.keepalive.saveCheckpoint(options.sessionId, checkpoint)
  }
  return checkpoint
}
