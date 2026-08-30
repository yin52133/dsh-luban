import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Checkpoint,
  HealthReport,
  KeepaliveEvent,
  KeepaliveService,
  ManagedSession,
  SessionSpec,
} from 'dsh-luban-core'
import { afterEach, describe, expect, it } from 'vitest'
import { runWorker } from '../src/build-worker.js'
import { ManagedBuildExecutor } from '../src/executor.js'

const directories = new Set<string>()

class ReleasableKeepalive implements KeepaliveService {
  public readonly released: { readonly id: string; readonly destroy: boolean }[] = []
  public ensures = 0

  public ensureAlive(_spec: SessionSpec): Promise<ManagedSession> {
    this.ensures += 1
    throw new Error('pre-existing result must not launch a worker')
  }
  public patrol(): Promise<HealthReport> {
    return Promise.resolve({ healthy: true, checkedAt: 0, sessions: [] })
  }
  public onEvent(_listener: (event: KeepaliveEvent) => void): () => void {
    return (): void => undefined
  }
  public saveCheckpoint(_id: string, _checkpoint: Checkpoint): Promise<void> {
    return Promise.resolve()
  }
  public loadCheckpoint(_id: string): Promise<Checkpoint | null> {
    return Promise.resolve(null)
  }
  public release(id: string, options: { readonly destroy?: boolean } = {}): Promise<void> {
    this.released.push({ id, destroy: options.destroy === true })
    return Promise.resolve()
  }
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('ManagedBuildExecutor recovery', (): void => {
  it('reuses a durable worker result and releases its M03 ledger entry', async (): Promise<void> => {
    const directory = join(tmpdir(), `luban-executor-${randomUUID()}`)
    directories.add(directory)
    const id = randomUUID()
    const resultDirectory = join(directory, 'jobs', id)
    await mkdir(resultDirectory, { recursive: true })
    await writeFile(
      join(resultDirectory, 'result.json'),
      JSON.stringify({
        schemaVersion: 1,
        exitCode: 0,
        stdout: 'recovered',
        stderr: '',
        durationMs: 42,
      }),
      'utf8',
    )
    const keepalive = new ReleasableKeepalive()
    const executor = new ManagedBuildExecutor({ keepalive, stateDirectory: directory })
    const result = await executor.execute(
      {
        job: {
          id,
          templateId: 'fake',
          params: { workspace: directory },
          status: 'running',
          artifacts: [],
          version: 2,
        },
        template: {
          id: 'fake',
          title: 'Fake',
          command: 'fake',
          args: ['${workspace}'],
          cwd: '${workspace}',
          collect: [],
        },
        timeoutMs: 1_000,
        artifactDirectory: join(directory, 'artifacts'),
        workspaceRoots: [directory],
      },
      new AbortController().signal,
    )

    expect(result).toMatchObject({ exitCode: 0, stdout: 'recovered' })
    expect(keepalive.ensures).toBe(0)
    expect(keepalive.released).toEqual([{ id: `luban-server-build-${id}`, destroy: true }])
  })

  it('releases a stale managed session when its durable result is corrupt', async (): Promise<void> => {
    const directory = join(tmpdir(), `luban-executor-corrupt-${randomUUID()}`)
    directories.add(directory)
    const id = randomUUID()
    const resultDirectory = join(directory, 'jobs', id)
    await mkdir(resultDirectory, { recursive: true })
    await writeFile(join(resultDirectory, 'result.json'), '{not-json', 'utf8')
    const keepalive = new ReleasableKeepalive()
    const executor = new ManagedBuildExecutor({ keepalive, stateDirectory: directory })

    await expect(
      executor.execute(
        {
          job: {
            id,
            templateId: 'fake',
            params: { workspace: directory },
            status: 'running',
            artifacts: [],
            version: 2,
          },
          template: {
            id: 'fake',
            title: 'Fake',
            command: 'fake',
            args: ['${workspace}'],
            cwd: '${workspace}',
            collect: [],
          },
          timeoutMs: 1_000,
          artifactDirectory: join(directory, 'artifacts'),
          workspaceRoots: [directory],
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(SyntaxError)
    expect(keepalive.ensures).toBe(0)
    expect(keepalive.released).toEqual([{ id: `luban-server-build-${id}`, destroy: true }])
  })

  it('makes a restored M03 worker idempotent when its result already exists', async (): Promise<void> => {
    const directory = join(tmpdir(), `luban-worker-recovery-${randomUUID()}`)
    directories.add(directory)
    await mkdir(directory, { recursive: true })
    const resultFile = join(directory, 'result.json')
    const result = {
      schemaVersion: 1,
      exitCode: 0,
      stdout: 'already complete',
      stderr: '',
      durationMs: 7,
    }
    await writeFile(resultFile, JSON.stringify(result), 'utf8')
    const specFile = join(directory, 'worker.json')
    await writeFile(
      specFile,
      JSON.stringify({
        schemaVersion: 1,
        command: 'this-command-must-never-run',
        args: [],
        cwd: directory,
        timeoutMs: 1_000,
        artifactDirectory: join(directory, 'artifacts'),
        collect: [],
        resultFile,
      }),
      'utf8',
    )
    await expect(runWorker(specFile)).resolves.toEqual(result)
  })
})
