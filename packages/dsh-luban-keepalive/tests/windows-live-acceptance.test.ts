import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedKeepaliveService } from '../src/service.js'
import { startWindowsLiveAcceptance } from '../src/windows-live-acceptance.js'

const directories = new Set<string>()

async function temporaryDirectory(): Promise<string> {
  const directory = join(tmpdir(), `luban-windows-live-${randomUUID()}`)
  directories.add(directory)
  await mkdir(directory, { mode: 0o700 })
  return directory
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await access(path)
      return
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      await delay(25)
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function acceptanceFixture(): Promise<{
  readonly runDir: string
  readonly runId: string
  readonly taskId: string
  readonly sessionId: string
  readonly checkpoint: {
    readonly taskId: string
    readonly stepList: readonly string[]
    readonly currentStep: number
    readonly artifacts: readonly string[]
    readonly savedAt: number
  }
  readonly workerPath: string
  readonly specSha256: string
}> {
  const runDir = await temporaryDirectory()
  const runId = randomUUID()
  const taskId = `m03-windows-${runId}`
  const sessionId = `luban-m03-${runId}`
  const checkpoint = {
    taskId,
    stepList: ['prepare', 'verify-signout', 'arm-reboot', 'verify-reboot', 'cleanup'],
    currentStep: 1,
    artifacts: ['owner:test'],
    savedAt: 1_000_000,
  } as const
  const workerPath = resolve('packages/dsh-luban-keepalive/dist/windows-acceptance-worker.js')
  const spec = {
    schemaVersion: 'dsh-luban/m03-windows-acceptance-spec/v1',
    runId,
    sessionId,
    taskId,
    nodePath: process.execPath,
    workerPath,
    checkpoint,
  }
  const bytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`, 'utf8')
  const specSha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(runDir, 'acceptance-spec.json'), bytes, { flag: 'wx', mode: 0o600 })
  return { runDir, runId, taskId, sessionId, checkpoint, workerPath, specSha256 }
}

function acceptanceEnvironment(
  fixture: Awaited<ReturnType<typeof acceptanceFixture>>,
  options: { readonly bootStartedAt?: number } = {},
): void {
  vi.stubEnv('LUBAN_M03_ACCEPTANCE_RUN_DIR', fixture.runDir)
  vi.stubEnv('LUBAN_M03_ACCEPTANCE_RUN_ID', fixture.runId)
  vi.stubEnv('LUBAN_M03_ACCEPTANCE_SPEC_SHA256', fixture.specSha256)
  vi.stubEnv('LUBAN_M03_HOST_STARTED_AT', '1000000')
  vi.stubEnv('LUBAN_M03_BOOT_STARTED_AT', String(options.bootStartedAt ?? 500_000))
}

function acceptanceService(
  fixture: Awaited<ReturnType<typeof acceptanceFixture>>,
  load: () => Promise<unknown>,
): {
  readonly service: ManagedKeepaliveService
  readonly ensureAlive: ReturnType<typeof vi.fn>
  readonly saveCheckpoint: ReturnType<typeof vi.fn>
  readonly release: ReturnType<typeof vi.fn>
} {
  const ensureAlive = vi.fn(() =>
    Promise.resolve({
      id: fixture.sessionId,
      host: 'test-host',
      kind: 'service' as const,
      purpose: 'task' as const,
      ownerTaskId: fixture.taskId,
      createdAt: 1_000_000,
    }),
  )
  const saveCheckpoint = vi.fn(() => Promise.resolve())
  const release = vi.fn(() => Promise.resolve())
  return {
    ensureAlive,
    saveCheckpoint,
    release,
    service: {
      ensureAlive,
      loadCheckpoint: vi.fn(load),
      saveCheckpoint,
      release,
    } as unknown as ManagedKeepaliveService,
  }
}

afterEach(async (): Promise<void> => {
  vi.unstubAllEnvs()
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe.runIf(process.platform === 'win32')('Windows mounted live acceptance', (): void => {
  it('uses the real keepalive service for session/checkpoint restore and cleanup evidence', async (): Promise<void> => {
    const runDir = await temporaryDirectory()
    const runId = '11111111-1111-4111-8111-111111111111'
    const taskId = `m03-windows-${runId}`
    const sessionId = `luban-m03-${runId}`
    const checkpoint = {
      taskId,
      stepList: ['prepare', 'verify-signout', 'arm-reboot', 'verify-reboot', 'cleanup'],
      currentStep: 1,
      artifacts: ['owner:test'],
      savedAt: 1_000_000,
    }
    const spec = {
      schemaVersion: 'dsh-luban/m03-windows-acceptance-spec/v1',
      runId,
      sessionId,
      taskId,
      nodePath: process.execPath,
      workerPath: resolve('packages/dsh-luban-keepalive/dist/windows-acceptance-worker.js'),
      checkpoint,
    }
    const bytes = Buffer.from(`${JSON.stringify(spec, null, 2)}\n`, 'utf8')
    const specSha256 = createHash('sha256').update(bytes).digest('hex')
    await writeFile(join(runDir, 'acceptance-spec.json'), bytes, { flag: 'wx', mode: 0o600 })

    vi.stubEnv('LUBAN_M03_ACCEPTANCE_RUN_DIR', runDir)
    vi.stubEnv('LUBAN_M03_ACCEPTANCE_RUN_ID', runId)
    vi.stubEnv('LUBAN_M03_ACCEPTANCE_SPEC_SHA256', specSha256)
    vi.stubEnv('LUBAN_M03_HOST_STARTED_AT', '1000000')
    vi.stubEnv('LUBAN_M03_BOOT_STARTED_AT', '500000')

    const ensureAlive = vi.fn(() =>
      Promise.resolve({
        id: sessionId,
        host: 'test-host',
        kind: 'service' as const,
        purpose: 'task' as const,
        ownerTaskId: taskId,
        createdAt: 1_000_000,
      }),
    )
    const loadCheckpoint = vi.fn(() => Promise.resolve(null))
    const saveCheckpoint = vi.fn(() => Promise.resolve())
    const release = vi.fn(() => Promise.resolve())
    const service = {
      ensureAlive,
      loadCheckpoint,
      saveCheckpoint,
      release,
    } as unknown as ManagedKeepaliveService

    const handle = await startWindowsLiveAcceptance(service)
    expect(handle).not.toBeNull()
    await waitForFile(join(runDir, 'host-heartbeat.json'))
    expect(ensureAlive).toHaveBeenCalledWith({
      id: sessionId,
      purpose: 'task',
      command: process.execPath,
      args: [spec.workerPath, '--run-dir', runDir, '--run-id', runId, '--spec-sha256', specSha256],
      ownerTaskId: taskId,
    })
    expect(loadCheckpoint).toHaveBeenCalledWith(sessionId)
    expect(saveCheckpoint).toHaveBeenCalledWith(sessionId, checkpoint)
    const heartbeat = JSON.parse(
      await readFile(join(runDir, 'host-heartbeat.json'), 'utf8'),
    ) as Readonly<Record<string, unknown>>
    expect(heartbeat).toMatchObject({
      schemaVersion: 'dsh-luban/m03-windows-host-heartbeat/v1',
      runId,
      specSha256,
      managed: { sessionId, ownerTaskId: taskId, kind: 'service', checkpoint },
    })

    await writeFile(
      join(runDir, 'cleanup-request.json'),
      `${JSON.stringify({
        schemaVersion: 'dsh-luban/m03-windows-cleanup-request/v1',
        runId,
        specSha256,
        requestedAt: Date.now(),
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    )
    await waitForFile(join(runDir, 'cleanup-confirmed.json'))
    await handle?.dispose()
    expect(release).toHaveBeenCalledWith(sessionId, { destroy: true })
    const confirmation = JSON.parse(
      await readFile(join(runDir, 'cleanup-confirmed.json'), 'utf8'),
    ) as Readonly<Record<string, unknown>>
    expect(confirmation).toMatchObject({
      schemaVersion: 'dsh-luban/m03-windows-cleanup-confirmation/v1',
      runId,
      specSha256,
      sessionId,
      taskId,
    })
  })

  it.each([
    {
      label: 'deleted ledger checkpoint',
      load: (): Promise<unknown> => Promise.resolve(null),
      message: /durable checkpoint was not restored/u,
    },
    {
      label: 'corrupt ledger',
      load: (): Promise<unknown> => Promise.reject(new Error('corrupt ledger')),
      message: /corrupt ledger/u,
    },
  ])(
    'fails before reconstructing a confirmed session when the $label is observed',
    async ({ load, message }): Promise<void> => {
      const fixture = await acceptanceFixture()
      acceptanceEnvironment(fixture)
      const initial = acceptanceService(fixture, () => Promise.resolve(null))
      const initialHandle = await startWindowsLiveAcceptance(initial.service)
      expect(initialHandle).not.toBeNull()
      await waitForFile(join(fixture.runDir, 'checkpoint-seeded.json'))
      await initialHandle?.dispose()

      acceptanceEnvironment(fixture, {
        bootStartedAt: 700_000,
      })
      const restored = acceptanceService(fixture, load)
      await expect(startWindowsLiveAcceptance(restored.service)).rejects.toThrow(message)
      expect(restored.ensureAlive).not.toHaveBeenCalled()
      expect(restored.saveCheckpoint).not.toHaveBeenCalled()
    },
  )

  it('recovers the checkpoint-save crash window across a restart without saving again', async (): Promise<void> => {
    const fixture = await acceptanceFixture()
    acceptanceEnvironment(fixture)
    const initial = acceptanceService(fixture, () => Promise.resolve(null))
    const initialHandle = await startWindowsLiveAcceptance(initial.service)
    await waitForFile(join(fixture.runDir, 'checkpoint-seeded.json'))
    await initialHandle?.dispose()
    await rm(join(fixture.runDir, 'checkpoint-seeded.json'))

    acceptanceEnvironment(fixture, {
      bootStartedAt: 700_000,
    })
    const recovered = acceptanceService(fixture, () => Promise.resolve(fixture.checkpoint))
    const recoveredHandle = await startWindowsLiveAcceptance(recovered.service)
    expect(recoveredHandle).not.toBeNull()
    await waitForFile(join(fixture.runDir, 'checkpoint-seeded.json'))
    await recoveredHandle?.dispose()
    expect(recovered.ensureAlive).toHaveBeenCalledTimes(1)
    expect(recovered.saveCheckpoint).not.toHaveBeenCalled()
  })
})
