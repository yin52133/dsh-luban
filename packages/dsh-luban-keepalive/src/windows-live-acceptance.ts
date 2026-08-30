import { createHash, randomUUID } from 'node:crypto'
import { link, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { asTaskId } from 'dsh-luban-core'
import type { Checkpoint } from 'dsh-luban-core'
import type { ManagedKeepaliveService } from './service.js'

const SPEC_SCHEMA = 'dsh-luban/m03-windows-acceptance-spec/v1'
const HOST_HEARTBEAT_SCHEMA = 'dsh-luban/m03-windows-host-heartbeat/v1'
const CLEANUP_REQUEST_SCHEMA = 'dsh-luban/m03-windows-cleanup-request/v1'
const CLEANUP_CONFIRMATION_SCHEMA = 'dsh-luban/m03-windows-cleanup-confirmation/v1'
const CHECKPOINT_SEED_ATTEMPT_SCHEMA = 'dsh-luban/m03-windows-checkpoint-seed-attempt/v1'
const CHECKPOINT_SEEDED_SCHEMA = 'dsh-luban/m03-windows-checkpoint-seeded/v1'
const MAX_JSON_BYTES = 256 * 1024
interface AcceptanceSpec {
  readonly schemaVersion: typeof SPEC_SCHEMA
  readonly runId: string
  readonly sessionId: string
  readonly taskId: string
  readonly nodePath: string
  readonly workerPath: string
  readonly checkpoint: Checkpoint
}

export interface WindowsLiveAcceptanceHandle {
  dispose(): Promise<void>
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(
  path: string,
): Promise<{ readonly bytes: Buffer; readonly value: unknown }> {
  const stats = await stat(path)
  if (!stats.isFile() || stats.size > MAX_JSON_BYTES) {
    throw new Error('Windows acceptance JSON is invalid')
  }
  const bytes = await readFile(path)
  return { bytes, value: JSON.parse(bytes.toString('utf8')) }
}

async function writeAtomic(path: string, value: unknown, createOnce = false): Promise<string> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (createOnce) {
      await link(temporary, path)
      await rm(temporary)
    } else {
      await rename(temporary, path)
    }
  } catch (error: unknown) {
    await rm(temporary, { force: true })
    throw error
  }
  return digest(serialized)
}

async function readJsonIfPresent(
  path: string,
): Promise<{ readonly bytes: Buffer; readonly value: unknown } | null> {
  try {
    return await readJson(path)
  } catch (error: unknown) {
    if (record(error) && error.code === 'ENOENT') return null
    throw error
  }
}

function acceptanceEnvironment(): {
  readonly runDir: string
  readonly runId: string
  readonly specSha256: string
  readonly startedAt: number
  readonly bootStartedAt: number
} | null {
  const runDirValue = process.env.LUBAN_M03_ACCEPTANCE_RUN_DIR
  const runId = process.env.LUBAN_M03_ACCEPTANCE_RUN_ID
  const specSha256 = process.env.LUBAN_M03_ACCEPTANCE_SPEC_SHA256
  const startedAt = Number(process.env.LUBAN_M03_HOST_STARTED_AT)
  const bootStartedAt = Number(process.env.LUBAN_M03_BOOT_STARTED_AT)
  if (runDirValue === undefined && runId === undefined && specSha256 === undefined) {
    return null
  }
  if (
    runDirValue === undefined ||
    !isAbsolute(runDirValue) ||
    resolve(runDirValue) === parse(resolve(runDirValue)).root ||
    runId === undefined ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(runId) ||
    specSha256 === undefined ||
    !/^[a-f0-9]{64}$/u.test(specSha256) ||
    !Number.isSafeInteger(startedAt) ||
    startedAt <= 0 ||
    !Number.isSafeInteger(bootStartedAt) ||
    bootStartedAt <= 0
  ) {
    throw new Error('Windows acceptance environment is invalid')
  }
  return { runDir: resolve(runDirValue), runId, specSha256, startedAt, bootStartedAt }
}

async function loadSpec(
  runDir: string,
  runId: string,
  expectedSha256: string,
): Promise<AcceptanceSpec> {
  const { bytes, value } = await readJson(join(runDir, 'acceptance-spec.json'))
  if (digest(bytes) !== expectedSha256 || !record(value)) {
    throw new Error('Windows acceptance spec digest changed')
  }
  const checkpoint = value.checkpoint
  if (
    value.schemaVersion !== SPEC_SCHEMA ||
    value.runId !== runId ||
    typeof value.sessionId !== 'string' ||
    !/^luban-[a-z0-9][a-z0-9_.-]{0,57}$/u.test(value.sessionId) ||
    typeof value.taskId !== 'string' ||
    value.taskId === '' ||
    typeof value.nodePath !== 'string' ||
    !isAbsolute(value.nodePath) ||
    typeof value.workerPath !== 'string' ||
    !isAbsolute(value.workerPath) ||
    !record(checkpoint) ||
    checkpoint.taskId !== value.taskId ||
    !Array.isArray(checkpoint.stepList) ||
    checkpoint.stepList.some((step) => typeof step !== 'string') ||
    !Number.isSafeInteger(checkpoint.currentStep) ||
    !Array.isArray(checkpoint.artifacts) ||
    checkpoint.artifacts.some((artifact) => typeof artifact !== 'string') ||
    !Number.isSafeInteger(checkpoint.savedAt)
  ) {
    throw new Error('Windows acceptance spec is invalid')
  }
  return value as unknown as AcceptanceSpec
}

function sameCheckpoint(left: Checkpoint, right: Checkpoint): boolean {
  return (
    left.taskId === right.taskId &&
    left.currentStep === right.currentStep &&
    left.savedAt === right.savedAt &&
    JSON.stringify(left.stepList) === JSON.stringify(right.stepList) &&
    JSON.stringify(left.artifacts) === JSON.stringify(right.artifacts)
  )
}

function checkpointSha256(checkpoint: Checkpoint): string {
  return digest(JSON.stringify(checkpoint))
}

interface CheckpointSeedEvidence {
  readonly attemptSha256: string
  readonly markerSha256: string
  readonly bootStartedAt: number
}

function validateSeedAttempt(
  value: unknown,
  spec: AcceptanceSpec,
  environment: NonNullable<ReturnType<typeof acceptanceEnvironment>>,
): Readonly<Record<string, unknown>> {
  if (
    !record(value) ||
    value.schemaVersion !== CHECKPOINT_SEED_ATTEMPT_SCHEMA ||
    value.runId !== environment.runId ||
    value.specSha256 !== environment.specSha256 ||
    value.sessionId !== spec.sessionId ||
    value.taskId !== spec.taskId ||
    value.checkpointSha256 !== checkpointSha256(spec.checkpoint) ||
    !Number.isSafeInteger(value.bootStartedAt) ||
    !Number.isSafeInteger(value.attemptedAt)
  ) {
    throw new Error('Windows acceptance checkpoint seed attempt is invalid')
  }
  return value
}

function validateSeedConfirmation(
  value: unknown,
  spec: AcceptanceSpec,
  environment: NonNullable<ReturnType<typeof acceptanceEnvironment>>,
  attemptSha256: string,
): Readonly<Record<string, unknown>> {
  if (
    !record(value) ||
    value.schemaVersion !== CHECKPOINT_SEEDED_SCHEMA ||
    value.runId !== environment.runId ||
    value.specSha256 !== environment.specSha256 ||
    value.sessionId !== spec.sessionId ||
    value.taskId !== spec.taskId ||
    value.checkpointSha256 !== checkpointSha256(spec.checkpoint) ||
    value.attemptSha256 !== attemptSha256 ||
    !Number.isSafeInteger(value.seededAt)
  ) {
    throw new Error('Windows acceptance checkpoint seed confirmation is invalid')
  }
  return value
}

async function ensureSeededSession(
  service: ManagedKeepaliveService,
  spec: AcceptanceSpec,
  environment: NonNullable<ReturnType<typeof acceptanceEnvironment>>,
): Promise<{
  readonly session: Awaited<ReturnType<ManagedKeepaliveService['ensureAlive']>>
  readonly evidence: CheckpointSeedEvidence
}> {
  const attemptPath = join(environment.runDir, 'checkpoint-seed-attempt.json')
  const confirmationPath = join(environment.runDir, 'checkpoint-seeded.json')
  let attemptRecord = await readJsonIfPresent(attemptPath)
  if (attemptRecord === null) {
    const attempt = {
      schemaVersion: CHECKPOINT_SEED_ATTEMPT_SCHEMA,
      runId: environment.runId,
      specSha256: environment.specSha256,
      sessionId: spec.sessionId,
      taskId: spec.taskId,
      checkpointSha256: checkpointSha256(spec.checkpoint),
      bootStartedAt: environment.bootStartedAt,
      attemptedAt: Date.now(),
    }
    await writeAtomic(attemptPath, attempt, true)
    attemptRecord = await readJson(attemptPath)
  }
  const attempt = validateSeedAttempt(attemptRecord.value, spec, environment)
  const attemptSha256 = digest(attemptRecord.bytes)
  const confirmationRecord = await readJsonIfPresent(confirmationPath)
  const stored = await service.loadCheckpoint(spec.sessionId)
  if (confirmationRecord !== null) {
    validateSeedConfirmation(confirmationRecord.value, spec, environment, attemptSha256)
    if (stored === null || !sameCheckpoint(stored, spec.checkpoint)) {
      throw new Error('Windows acceptance durable checkpoint was not restored')
    }
    const session = await service.ensureAlive({
      id: spec.sessionId,
      purpose: 'task',
      command: spec.nodePath,
      args: [
        spec.workerPath,
        '--run-dir',
        environment.runDir,
        '--run-id',
        environment.runId,
        '--spec-sha256',
        environment.specSha256,
      ],
      ownerTaskId: asTaskId(spec.taskId),
    })
    return {
      session,
      evidence: {
        attemptSha256,
        markerSha256: digest(confirmationRecord.bytes),
        bootStartedAt: attempt.bootStartedAt as number,
      },
    }
  }
  if (stored !== null && !sameCheckpoint(stored, spec.checkpoint)) {
    throw new Error('Windows acceptance checkpoint changed during seed recovery')
  }
  const session = await service.ensureAlive({
    id: spec.sessionId,
    purpose: 'task',
    command: spec.nodePath,
    args: [
      spec.workerPath,
      '--run-dir',
      environment.runDir,
      '--run-id',
      environment.runId,
      '--spec-sha256',
      environment.specSha256,
    ],
    ownerTaskId: asTaskId(spec.taskId),
  })
  if (stored === null) await service.saveCheckpoint(spec.sessionId, spec.checkpoint)
  const confirmation = {
    schemaVersion: CHECKPOINT_SEEDED_SCHEMA,
    runId: environment.runId,
    specSha256: environment.specSha256,
    sessionId: spec.sessionId,
    taskId: spec.taskId,
    checkpointSha256: checkpointSha256(spec.checkpoint),
    attemptSha256,
    seededAt: Date.now(),
  }
  await writeAtomic(confirmationPath, confirmation, true)
  const confirmed = await readJson(confirmationPath)
  validateSeedConfirmation(confirmed.value, spec, environment, attemptSha256)
  return {
    session,
    evidence: {
      attemptSha256,
      markerSha256: digest(confirmed.bytes),
      bootStartedAt: attempt.bootStartedAt as number,
    },
  }
}

async function cleanupRequested(
  runDir: string,
  runId: string,
  specSha256: string,
): Promise<boolean> {
  try {
    const { value } = await readJson(join(runDir, 'cleanup-request.json'))
    if (
      !record(value) ||
      value.schemaVersion !== CLEANUP_REQUEST_SCHEMA ||
      value.runId !== runId ||
      value.specSha256 !== specSha256 ||
      !Number.isSafeInteger(value.requestedAt)
    ) {
      throw new Error('Windows acceptance cleanup request is invalid')
    }
    return true
  } catch (error: unknown) {
    if (record(error) && error.code === 'ENOENT') return false
    throw error
  }
}

/** Activate only inside the exact acceptance bootstrap environment. */
export async function startWindowsLiveAcceptance(
  service: ManagedKeepaliveService,
): Promise<WindowsLiveAcceptanceHandle | null> {
  if (process.platform !== 'win32') return null
  const environment = acceptanceEnvironment()
  if (environment === null) return null
  const directory = await stat(environment.runDir)
  if (!directory.isDirectory()) throw new Error('Windows acceptance run directory is invalid')
  const spec = await loadSpec(environment.runDir, environment.runId, environment.specSha256)
  const { session, evidence: checkpointSeed } = await ensureSeededSession(
    service,
    spec,
    environment,
  )
  const controller = new AbortController()
  const heartbeatPath = join(environment.runDir, 'host-heartbeat.json')
  let sequence = 0
  let loopError: unknown
  const loop = (async (): Promise<void> => {
    while (!controller.signal.aborted) {
      sequence += 1
      await writeAtomic(heartbeatPath, {
        schemaVersion: HOST_HEARTBEAT_SCHEMA,
        runId: environment.runId,
        specSha256: environment.specSha256,
        bootStartedAt: environment.bootStartedAt,
        startedAt: environment.startedAt,
        sequence,
        observedAt: Date.now(),
        managed: {
          sessionId: session.id,
          ownerTaskId: spec.taskId,
          kind: session.kind,
          checkpoint: spec.checkpoint,
          checkpointSeed,
        },
      })
      if (await cleanupRequested(environment.runDir, environment.runId, environment.specSha256)) {
        await service.release(spec.sessionId, { destroy: true })
        try {
          await writeAtomic(
            join(environment.runDir, 'cleanup-confirmed.json'),
            {
              schemaVersion: CLEANUP_CONFIRMATION_SCHEMA,
              runId: environment.runId,
              specSha256: environment.specSha256,
              sessionId: spec.sessionId,
              taskId: spec.taskId,
              confirmedAt: Date.now(),
            },
            true,
          )
        } catch (error: unknown) {
          if (!record(error) || error.code !== 'EEXIST') throw error
        }
        return
      }
      await delay(2_000, undefined, { signal: controller.signal }).catch(() => undefined)
    }
  })().catch((error: unknown): void => {
    loopError = error
  })
  return {
    async dispose(): Promise<void> {
      controller.abort()
      await loop
      if (loopError instanceof Error) throw loopError
      if (loopError !== undefined)
        throw new Error('Windows acceptance loop failed', { cause: loopError })
    },
  }
}
