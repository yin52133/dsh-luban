import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ArtifactRef, BuildJob, ResourceReport } from 'dsh-luban-core'
import { afterEach, describe, expect, it } from 'vitest'
import type { BuildAlertSink } from '../src/alerts.js'
import { ArtifactManager } from '../src/artifacts.js'
import type { BuildTemplateConfig } from '../src/config.js'
import type { BuildExecutionRequest, BuildExecutor } from '../src/executor.js'
import type { BuildLedger } from '../src/ledger.js'
import { BuildLedgerStore } from '../src/ledger.js'
import { BuildQueue } from '../src/queue.js'
import type { ResourceProbe, ResourceSample } from '../src/resources.js'
import type { WorkerResult } from '../src/worker-protocol.js'

const directories = new Set<string>()

const TEMPLATE: BuildTemplateConfig = {
  id: 'fake-build',
  title: 'Fake build',
  command: 'fake-build',
  args: ['--workspace', '${workspace}', '--mode', '${mode}'],
  cwd: '${workspace}',
  collect: [],
}

class FakeProbe implements ResourceProbe {
  public value: ResourceSample = { diskFreeGb: 100, load1: 1 }
  public behavior: 'ok' | 'reject' | 'stall' = 'ok'
  public sample(): Promise<ResourceSample> {
    if (this.behavior === 'reject') return Promise.reject(new Error('resource probe unavailable'))
    if (this.behavior === 'stall') {
      return new Promise<ResourceSample>(() => undefined)
    }
    return Promise.resolve(this.value)
  }
}

class GatedProbe extends FakeProbe {
  readonly started: Promise<void>
  #markStarted: () => void = (): void => undefined
  #releaseSample: ((sample: ResourceSample) => void) | undefined

  public constructor() {
    super()
    this.started = new Promise<void>((resolve): void => {
      this.#markStarted = resolve
    })
  }

  public override sample(): Promise<ResourceSample> {
    return new Promise<ResourceSample>((resolve): void => {
      this.#releaseSample = resolve
      this.#markStarted()
    })
  }

  public release(): void {
    const release = this.#releaseSample
    if (release === undefined) throw new Error('resource probe has not started')
    this.#releaseSample = undefined
    release(this.value)
  }
}

class GatedUpdateBuildLedgerStore extends BuildLedgerStore {
  readonly started: Promise<void>
  readonly #released: Promise<void>
  #markStarted: () => void = (): void => undefined
  #releaseUpdate: () => void = (): void => undefined
  readonly #gateAt: number
  #updateCount = 0

  public constructor(filePath: string, gateAt = 1) {
    super(filePath)
    this.#gateAt = gateAt
    this.started = new Promise<void>((resolve): void => {
      this.#markStarted = resolve
    })
    this.#released = new Promise<void>((resolve): void => {
      this.#releaseUpdate = resolve
    })
  }

  public override async update(
    mutator: (ledger: BuildLedger) => BuildLedger,
  ): Promise<BuildLedger> {
    this.#updateCount += 1
    if (this.#updateCount === this.#gateAt) {
      this.#markStarted()
      await this.#released
    }
    return super.update(mutator)
  }

  public release(): void {
    this.#releaseUpdate()
  }
}

class FakeExecutor implements BuildExecutor {
  public current = 0
  public maximum = 0
  readonly #concurrencyBarrier: number | undefined
  readonly #barrierWaiters: (() => void)[] = []
  #barrierOpen = false

  public constructor(concurrencyBarrier?: number) {
    this.#concurrencyBarrier = concurrencyBarrier
  }

  public async execute(request: BuildExecutionRequest, signal: AbortSignal): Promise<WorkerResult> {
    this.current += 1
    this.maximum = Math.max(this.maximum, this.current)
    if (this.#concurrencyBarrier !== undefined && !this.#barrierOpen) {
      if (this.current >= this.#concurrencyBarrier) {
        this.#barrierOpen = true
        for (const resolve of this.#barrierWaiters.splice(0)) resolve()
      } else {
        await new Promise<void>((resolve): void => {
          this.#barrierWaiters.push(resolve)
        })
      }
    } else {
      await new Promise<void>((resolve): void => {
        setTimeout(resolve, 25)
      })
    }
    this.current -= 1
    if (signal.aborted) throw new Error('cancelled')
    if (request.job.params.mode === 'fail') {
      return {
        schemaVersion: 1,
        exitCode: 2,
        stdout: 'compiler context',
        stderr: 'fatal: fake compiler error',
        durationMs: 5,
      }
    }
    await mkdir(request.artifactDirectory, { recursive: true })
    await writeFile(join(request.artifactDirectory, 'firmware.bin'), request.job.id, 'utf8')
    return { schemaVersion: 1, exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5 }
  }
}

class FailingArtifactManager extends ArtifactManager {
  public override discover(_jobId: string): Promise<readonly ArtifactRef[]> {
    return Promise.reject(new Error('artifact directory is unreadable'))
  }
}

class CapturingAlerts implements BuildAlertSink {
  public readonly guards: ResourceReport[] = []
  public readonly failures: BuildJob[] = []
  public guardExceeded(report: ResourceReport): Promise<void> {
    this.guards.push(report)
    return Promise.resolve()
  }
  public jobFailed(job: BuildJob): Promise<void> {
    this.failures.push(job)
    return Promise.resolve()
  }
}

class GatedFailureAlerts extends CapturingAlerts {
  readonly started: Promise<void>
  readonly #released: Promise<void>
  #markStarted: () => void = (): void => undefined
  #releaseAlert: () => void = (): void => undefined

  public constructor() {
    super()
    this.started = new Promise<void>((resolve): void => {
      this.#markStarted = resolve
    })
    this.#released = new Promise<void>((resolve): void => {
      this.#releaseAlert = resolve
    })
  }

  public override async jobFailed(job: BuildJob): Promise<void> {
    await super.jobFailed(job)
    this.#markStarted()
    await this.#released
  }

  public release(): void {
    this.#releaseAlert()
  }
}

interface QueueFixture {
  readonly directory: string
  readonly workspace: string
  readonly artifacts: ArtifactManager
  readonly probe: FakeProbe
  readonly executor: FakeExecutor
  readonly alerts: CapturingAlerts
  readonly errors: unknown[]
  readonly store: BuildLedgerStore
  readonly queue: BuildQueue
}

async function fixture(
  options: {
    readonly maxConcurrent?: number
    readonly retainRuns?: number
    readonly failArtifactDiscovery?: boolean
    readonly concurrencyBarrier?: number
    readonly probeTimeoutMs?: number
    readonly probe?: FakeProbe
    readonly alerts?: CapturingAlerts
    readonly storeFactory?: (filePath: string) => BuildLedgerStore
  } = {},
): Promise<QueueFixture> {
  const directory = join(tmpdir(), `luban-queue-${randomUUID()}`)
  const workspace = join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })
  directories.add(directory)
  const artifacts = options.failArtifactDiscovery
    ? new FailingArtifactManager(join(directory, 'artifacts'))
    : new ArtifactManager(join(directory, 'artifacts'))
  const probe = options.probe ?? new FakeProbe()
  const executor = new FakeExecutor(options.concurrencyBarrier)
  const alerts = options.alerts ?? new CapturingAlerts()
  const errors: unknown[] = []
  const ledgerPath = join(directory, 'ledger.json')
  const store = options.storeFactory?.(ledgerPath) ?? new BuildLedgerStore(ledgerPath)
  let timestamp = 1_788_048_000_000
  const queue = new BuildQueue({
    store,
    executor,
    artifacts,
    probe,
    templates: [TEMPLATE],
    workspaceRoots: [directory],
    maxConcurrent: options.maxConcurrent ?? 2,
    defaultTimeoutMs: 10_000,
    diskMinGb: 10,
    loadMax: 8,
    checkIntervalMs: 60_000,
    ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
    retainRuns: options.retainRuns ?? 10,
    alerts,
    now: (): number => ++timestamp,
    onError: (error: unknown): void => {
      errors.push(error)
    },
  })
  return { directory, workspace, artifacts, probe, executor, alerts, errors, store, queue }
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('BuildQueue', (): void => {
  it('persists jobs, honors concurrency, registers artifacts, and captures failed logs', async (): Promise<void> => {
    const { alerts, executor, queue, workspace } = await fixture({
      maxConcurrent: 2,
      concurrencyBarrier: 2,
    })
    await Promise.all([
      queue.enqueue({ templateId: TEMPLATE.id, params: { workspace, mode: 'ok' } }),
      queue.enqueue({ templateId: TEMPLATE.id, params: { workspace, mode: 'ok' } }),
      queue.enqueue({ templateId: TEMPLATE.id, params: { workspace, mode: 'fail' } }),
    ])
    await queue.start()
    await queue.waitForIdle()

    const jobs = await queue.queue()
    expect(jobs.map((job) => job.status).sort()).toEqual(['done', 'done', 'failed'])
    expect(executor.maximum).toBe(2)
    expect(
      jobs
        .filter((job) => job.status === 'done')
        .every((job) => job.artifacts.some((artifact) => artifact.name === 'firmware.bin')),
    ).toBe(true)
    const failed = jobs.find((job) => job.status === 'failed')
    expect(failed?.errorLogExcerpt).toContain('fatal: fake compiler error')
    await new Promise<void>((resolve): void => {
      setImmediate(resolve)
    })
    expect(alerts.failures).toHaveLength(1)
    await queue.dispose()
  })

  it('pauses starts on resource pressure, alerts once, and resumes after recovery', async (): Promise<void> => {
    const { alerts, probe, queue, workspace } = await fixture()
    probe.value = { diskFreeGb: 2, load1: 1 }
    await queue.start()
    const queued = await queue.enqueue({
      templateId: TEMPLATE.id,
      params: { workspace, mode: 'ok' },
    })
    await queue.waitForIdle()
    expect((await queue.get(queued.id)).status).toBe('queued')
    await new Promise<void>((resolve): void => {
      setImmediate(resolve)
    })
    expect(alerts.guards).toHaveLength(1)

    probe.value = { diskFreeGb: 100, load1: 1 }
    await queue.waitForIdle()
    expect((await queue.get(queued.id)).status).toBe('done')
    await queue.dispose()
  })

  it('fails closed when the resource probe rejects', async (): Promise<void> => {
    const { alerts, errors, executor, probe, queue, workspace } = await fixture()
    probe.behavior = 'reject'
    await queue.start()
    const queued = await queue.enqueue({
      templateId: TEMPLATE.id,
      params: { workspace, mode: 'ok' },
    })

    await queue.waitForIdle()
    await new Promise<void>((resolve): void => {
      setImmediate(resolve)
    })

    expect((await queue.get(queued.id)).status).toBe('queued')
    expect((await queue.resourceReport()).paused).toBe(true)
    expect(executor.maximum).toBe(0)
    expect(alerts.guards).toHaveLength(1)
    expect(errors.some((error): boolean => error instanceof Error)).toBe(true)
    await queue.dispose()
  })

  it('fails closed within a bound when the resource probe stalls', async (): Promise<void> => {
    const { alerts, errors, executor, probe, queue, workspace } = await fixture({
      probeTimeoutMs: 25,
    })
    probe.behavior = 'stall'
    await queue.start()
    const queued = await queue.enqueue({
      templateId: TEMPLATE.id,
      params: { workspace, mode: 'ok' },
    })
    const startedAt = Date.now()

    await queue.waitForIdle()
    await new Promise<void>((resolve): void => {
      setImmediate(resolve)
    })

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect((await queue.get(queued.id)).status).toBe('queued')
    expect(executor.maximum).toBe(0)
    expect(alerts.guards).toHaveLength(1)
    expect(
      errors.some(
        (error): boolean =>
          typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'E_TIMEOUT',
      ),
    ).toBe(true)
    await queue.dispose()
  })

  it('retains only the configured number of completed artifact runs', async (): Promise<void> => {
    const { artifacts, queue, workspace } = await fixture({ maxConcurrent: 1, retainRuns: 1 })
    await queue.start()
    const first = await queue.enqueue({
      templateId: TEMPLATE.id,
      params: { workspace, mode: 'ok' },
    })
    const second = await queue.enqueue({
      templateId: TEMPLATE.id,
      params: { workspace, mode: 'ok' },
    })
    await queue.waitForIdle()

    expect(await queue.artifacts(first.id)).toEqual([])
    expect(await artifacts.discover(first.id)).toEqual([])
    expect(await queue.artifacts(second.id)).toHaveLength(1)
    await queue.dispose()
  })

  it('marks a successful command failed when artifact discovery cannot complete', async (): Promise<void> => {
    const { queue, workspace } = await fixture({ failArtifactDiscovery: true })
    await queue.start()
    const job = await queue.enqueue({
      templateId: TEMPLATE.id,
      params: { workspace, mode: 'ok' },
    })
    await queue.waitForIdle()

    const failed = await queue.get(job.id)
    expect(failed.status).toBe('failed')
    expect(failed.errorLogExcerpt).toContain('Artifact discovery: artifact directory is unreadable')
    await queue.dispose()
  })

  it('requeues an interrupted running record on startup and consumes it once', async (): Promise<void> => {
    const { executor, queue, store, workspace } = await fixture({ maxConcurrent: 1 })
    const id = randomUUID()
    await store.update((ledger) => ({
      ...ledger,
      records: {
        [id]: {
          job: {
            id,
            templateId: TEMPLATE.id,
            params: { workspace, mode: 'ok' },
            status: 'running',
            sessionId: `luban-server-build-${id}`,
            artifacts: [],
            version: 2,
          },
          createdAt: Date.now(),
          startedAt: Date.now(),
        },
      },
    }))
    await queue.start()
    await queue.waitForIdle()
    expect((await queue.get(id)).status).toBe('done')
    expect(executor.maximum).toBe(1)
    await queue.dispose()
  })

  it('waits for an in-flight drain and does not launch queued work while disposing', async (): Promise<void> => {
    const probe = new GatedProbe()
    const { directory, executor, queue, workspace } = await fixture({ probe })
    await queue.enqueue({ templateId: TEMPLATE.id, params: { workspace, mode: 'ok' } })
    await queue.start()
    await probe.started

    let disposed = false
    const disposal = queue.dispose().then((): void => {
      disposed = true
    })
    await new Promise<void>((resolve): void => {
      setImmediate(resolve)
    })
    const resolvedBeforeProbeRelease = disposed
    probe.release()
    await disposal

    expect(resolvedBeforeProbeRelease).toBe(false)
    expect(executor.maximum).toBe(0)
    await rm(directory, { recursive: true, force: true })
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 25)
    })
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    directories.delete(directory)
  })

  it('waits for active failure alerts while disposing', async (): Promise<void> => {
    const alerts = new GatedFailureAlerts()
    const { queue, workspace } = await fixture({ alerts, maxConcurrent: 1 })
    await queue.start()
    await queue.enqueue({ templateId: TEMPLATE.id, params: { workspace, mode: 'fail' } })
    await alerts.started

    let disposed = false
    const disposal = queue.dispose().then((): void => {
      disposed = true
    })
    await new Promise<void>((resolve): void => {
      setImmediate(resolve)
    })
    const resolvedBeforeAlertRelease = disposed
    alerts.release()
    await disposal

    expect(resolvedBeforeAlertRelease).toBe(false)
    expect(alerts.failures).toHaveLength(1)
  })

  it('starts the next queued job from completion without waiting for the patrol interval', async (): Promise<void> => {
    const { queue, workspace } = await fixture({
      concurrencyBarrier: 1,
      maxConcurrent: 1,
    })
    await queue.enqueue({ templateId: TEMPLATE.id, params: { workspace, mode: 'ok' } })
    await queue.enqueue({ templateId: TEMPLATE.id, params: { workspace, mode: 'ok' } })
    await queue.start()

    await expect
      .poll(
        async (): Promise<number> =>
          (await queue.queue()).filter((job): boolean => job.status === 'done').length,
        { interval: 10, timeout: 2_000 },
      )
      .toBe(2)
    await queue.dispose()
  })

  it('does not launch a job when disposal starts during its ledger transition', async (): Promise<void> => {
    let gatedStore: GatedUpdateBuildLedgerStore | undefined
    const { executor, queue, workspace } = await fixture({
      maxConcurrent: 1,
      storeFactory: (filePath): BuildLedgerStore => {
        const store = new GatedUpdateBuildLedgerStore(filePath, 3)
        gatedStore = store
        return store
      },
    })
    if (gatedStore === undefined) throw new Error('gated ledger store was not created')
    const queued = await queue.enqueue({
      templateId: TEMPLATE.id,
      params: { workspace, mode: 'ok' },
    })
    await queue.start()
    await gatedStore.started

    const disposal = queue.dispose()
    await new Promise<void>((resolve): void => {
      setImmediate(resolve)
    })
    gatedStore.release()
    await disposal

    expect(executor.maximum).toBe(0)
    expect((await queue.get(queued.id)).status).toBe('queued')
  })

  it('serializes start and disposal while ledger recovery is in flight', async (): Promise<void> => {
    let gatedStore: GatedUpdateBuildLedgerStore | undefined
    const { directory, queue } = await fixture({
      storeFactory: (filePath): BuildLedgerStore => {
        const store = new GatedUpdateBuildLedgerStore(filePath)
        gatedStore = store
        return store
      },
    })
    if (gatedStore === undefined) throw new Error('gated ledger store was not created')

    const start = queue.start()
    await gatedStore.started
    let disposed = false
    const disposal = queue.dispose().then((): void => {
      disposed = true
    })
    await new Promise<void>((resolve): void => {
      setImmediate(resolve)
    })
    const resolvedBeforeRecoveryRelease = disposed
    gatedStore.release()
    await Promise.all([start, disposal])

    expect(resolvedBeforeRecoveryRelease).toBe(false)
    await rm(directory, { recursive: true, force: true })
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 25)
    })
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    directories.delete(directory)
  })
})
