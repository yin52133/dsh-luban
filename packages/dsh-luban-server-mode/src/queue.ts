import { randomUUID } from 'node:crypto'
import type { BuildJob, BuildJobInput, ResourceReport, Unsubscribe } from '@luban/core'
import { LubanError } from '@luban/core'
import type { BuildAlertSink } from './alerts.js'
import type { ArtifactManager } from './artifacts.js'
import type { BuildTemplateConfig } from './config.js'
import type { BuildExecutor } from './executor.js'
import type { BuildLedger, BuildLedgerStore, BuildRecord } from './ledger.js'
import type { ResourceProbe } from './resources.js'
import { compileTemplate } from './templates.js'

const DEFAULT_RESOURCE_PROBE_TIMEOUT_MS = 5_000

export type BuildQueueEvent =
  | {
      readonly type: 'job'
      readonly job: BuildJob
      readonly from: 'none' | BuildJob['status']
      readonly to: BuildJob['status']
    }
  | { readonly type: 'resource'; readonly report: ResourceReport }

export interface BuildQueueOptions {
  readonly store: BuildLedgerStore
  readonly executor: BuildExecutor
  readonly artifacts: ArtifactManager
  readonly probe: ResourceProbe
  readonly templates: readonly BuildTemplateConfig[]
  readonly workspaceRoots: readonly string[]
  readonly maxConcurrent: number
  readonly defaultTimeoutMs: number
  readonly diskMinGb: number
  readonly loadMax: number
  readonly checkIntervalMs: number
  readonly probeTimeoutMs?: number
  readonly retainRuns: number
  readonly alerts?: BuildAlertSink
  readonly now?: () => number
  readonly publish?: (event: BuildQueueEvent) => void
  readonly onError?: (error: unknown) => void
}

function excerpt(stdout: string, stderr: string): string {
  const lines = `${stderr}\n${stdout}`.trim().split(/\r?\n/u)
  return lines.slice(-120).join('\n').slice(-16_384)
}

async function sampleWithTimeout(
  probe: ResourceProbe,
  timeoutMs: number,
): Promise<Awaited<ReturnType<ResourceProbe['sample']>>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      probe.sample(),
      new Promise<never>((_resolve, reject): void => {
        timer = setTimeout((): void => {
          reject(
            new LubanError('E_TIMEOUT', 'resource probe timed out', {
              retriable: true,
              details: { timeoutMs },
            }),
          )
        }, timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function copyRecord(
  record: BuildRecord,
  job: BuildJob,
  values: {
    readonly startedAt?: number
    readonly finishedAt?: number
  },
): BuildRecord {
  return {
    job,
    createdAt: record.createdAt,
    ...(values.startedAt === undefined ? {} : { startedAt: values.startedAt }),
    ...(values.finishedAt === undefined ? {} : { finishedAt: values.finishedAt }),
  }
}

/** Persistent, resource-guarded build scheduler with bounded concurrency. */
export class BuildQueue {
  readonly #store: BuildLedgerStore
  readonly #executor: BuildExecutor
  readonly #artifacts: ArtifactManager
  readonly #probe: ResourceProbe
  readonly #templates: ReadonlyMap<string, BuildTemplateConfig>
  readonly #workspaceRoots: readonly string[]
  readonly #maxConcurrent: number
  readonly #defaultTimeoutMs: number
  readonly #diskMinGb: number
  readonly #loadMax: number
  readonly #checkIntervalMs: number
  readonly #probeTimeoutMs: number
  readonly #retainRuns: number
  readonly #alerts: BuildAlertSink | undefined
  readonly #now: () => number
  readonly #publish: ((event: BuildQueueEvent) => void) | undefined
  readonly #onError: (error: unknown) => void
  readonly #listeners = new Set<(event: BuildQueueEvent) => void>()
  readonly #activeAlerts = new Set<Promise<void>>()
  readonly #running = new Map<
    string,
    { readonly controller: AbortController; readonly task: Promise<void> }
  >()
  #timer: ReturnType<typeof setInterval> | undefined
  #lifecycle: Promise<void> = Promise.resolve()
  #drainOperation: Promise<void> | undefined
  #drainRequested = false
  #paused = false
  #stopping = false
  #started = false

  public constructor(options: BuildQueueOptions) {
    this.#store = options.store
    this.#executor = options.executor
    this.#artifacts = options.artifacts
    this.#probe = options.probe
    this.#templates = new Map(options.templates.map((template) => [template.id, template]))
    this.#workspaceRoots = options.workspaceRoots
    this.#maxConcurrent = options.maxConcurrent
    this.#defaultTimeoutMs = options.defaultTimeoutMs
    this.#diskMinGb = options.diskMinGb
    this.#loadMax = options.loadMax
    this.#checkIntervalMs = options.checkIntervalMs
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_RESOURCE_PROBE_TIMEOUT_MS
    if (!Number.isSafeInteger(this.#probeTimeoutMs) || this.#probeTimeoutMs <= 0) {
      throw new LubanError('E_INVALID_INPUT', 'resource probe timeout must be positive')
    }
    this.#retainRuns = options.retainRuns
    this.#alerts = options.alerts
    this.#now = options.now ?? Date.now
    this.#publish = options.publish
    this.#onError = options.onError ?? ((): void => undefined)
  }

  public start(): Promise<void> {
    return this.#serializeLifecycle(async (): Promise<void> => this.#start())
  }

  async #start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    this.#stopping = false
    try {
      const recovered: BuildJob[] = []
      await this.#store.update((ledger): BuildLedger => ({
        ...ledger,
        records: Object.fromEntries(
          Object.entries(ledger.records).map(([id, record]) => {
            if (record.job.status !== 'running') return [id, record]
            const job: BuildJob = {
              ...record.job,
              status: 'queued',
              version: record.job.version + 1,
            }
            recovered.push(job)
            return [id, { job, createdAt: record.createdAt }]
          }),
        ),
      }))
      for (const job of recovered) this.#emit({ type: 'job', job, from: 'running', to: 'queued' })
      this.#timer = setInterval((): void => {
        this.#schedule()
      }, this.#checkIntervalMs)
      this.#timer.unref()
      this.#schedule()
    } catch (error: unknown) {
      this.#started = false
      throw error
    }
  }

  public async enqueue(input: BuildJobInput): Promise<BuildJob> {
    const template = this.#templates.get(input.templateId)
    if (template === undefined) {
      throw new LubanError('E_INVALID_INPUT', `unknown build template ${input.templateId}`)
    }
    const id = randomUUID()
    const job: BuildJob = {
      id,
      templateId: template.id,
      params: { ...input.params },
      status: 'queued',
      artifacts: [],
      version: 1,
    }
    compileTemplate({
      template,
      params: job.params,
      jobId: id,
      artifactDirectory: this.#artifacts.jobDirectory(id),
      resultFile: this.#artifacts.jobDirectory(id),
      timeoutMs: this.#defaultTimeoutMs,
      workspaceRoots: this.#workspaceRoots,
    })
    await this.#store.update((ledger): BuildLedger => ({
      ...ledger,
      records: {
        ...ledger.records,
        [id]: { job, createdAt: this.#now() },
      },
    }))
    this.#emit({ type: 'job', job, from: 'none', to: 'queued' })
    this.#schedule()
    return job
  }

  public async queue(): Promise<readonly BuildJob[]> {
    const records = Object.values((await this.#store.read()).records)
    return records
      .sort((left, right): number => left.createdAt - right.createdAt)
      .map((record): BuildJob => record.job)
  }

  public async get(jobId: string): Promise<BuildJob> {
    return (await this.#store.require(jobId)).job
  }

  public async artifacts(jobId: string): Promise<BuildJob['artifacts']> {
    return (await this.#store.require(jobId)).job.artifacts
  }

  public async errorExcerpt(jobId: string): Promise<string | null> {
    return (await this.#store.require(jobId)).job.errorLogExcerpt ?? null
  }

  public templates(): readonly BuildTemplateConfig[] {
    return [...this.#templates.values()]
  }

  public async resourceReport(): Promise<ResourceReport> {
    const depth = (await this.queue()).filter((job): boolean => job.status === 'queued').length
    try {
      const sample = await sampleWithTimeout(this.#probe, this.#probeTimeoutMs)
      const paused =
        (this.#diskMinGb > 0 && sample.diskFreeGb < this.#diskMinGb) ||
        (this.#loadMax > 0 && sample.load1 > this.#loadMax)
      return { ...sample, queueDepth: depth, paused }
    } catch (error: unknown) {
      this.#onError(error)
      return { diskFreeGb: 0, load1: 0, queueDepth: depth, paused: true }
    }
  }

  public subscribe(listener: (event: BuildQueueEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return (): void => {
      this.#listeners.delete(listener)
    }
  }

  public async waitForIdle(): Promise<void> {
    for (;;) {
      await this.#drain()
      const tasks = [...this.#running.values()].map((entry) => entry.task)
      if (tasks.length === 0) {
        const jobs = await this.queue()
        if (jobs.every((job): boolean => job.status !== 'queued' && job.status !== 'running')) {
          await this.#waitForAlerts()
          return
        }
        if (jobs.some((job): boolean => job.status === 'running')) {
          await new Promise<void>((resolve): void => {
            setImmediate(resolve)
          })
          continue
        }
        if ((await this.resourceReport()).paused) {
          await this.#waitForAlerts()
          return
        }
        continue
      }
      await Promise.all(tasks)
    }
  }

  public dispose(): Promise<void> {
    return this.#serializeLifecycle(async (): Promise<void> => this.#dispose())
  }

  async #dispose(): Promise<void> {
    this.#stopping = true
    this.#started = false
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    for (const entry of this.#running.values()) entry.controller.abort()
    const draining = this.#drainOperation
    if (draining !== undefined) await Promise.allSettled([draining])
    for (const entry of this.#running.values()) entry.controller.abort()
    await Promise.allSettled([...this.#running.values()].map((entry) => entry.task))
    await this.#waitForAlerts()
    this.#drainRequested = false
    this.#listeners.clear()
  }

  #serializeLifecycle(operation: () => Promise<void>): Promise<void> {
    const scheduled = this.#lifecycle.then(operation)
    this.#lifecycle = scheduled.catch((): void => undefined)
    return scheduled
  }

  #schedule(): void {
    if (this.#stopping || !this.#started) return
    if (this.#drainOperation !== undefined) {
      this.#drainRequested = true
      return
    }
    void this.#drain().catch(this.#onError)
  }

  #drain(): Promise<void> {
    if (this.#stopping) return Promise.resolve()
    if (this.#drainOperation !== undefined) return this.#drainOperation
    const operation = this.#drainUntilQuiescent().finally((): void => {
      if (this.#drainOperation !== operation) return
      const reschedule = this.#shouldDrainAgain()
      this.#drainOperation = undefined
      if (reschedule) {
        this.#drainRequested = false
        this.#schedule()
      }
    })
    this.#drainOperation = operation
    return operation
  }

  async #drainUntilQuiescent(): Promise<void> {
    do {
      this.#drainRequested = false
      await this.#performDrain()
    } while (this.#shouldDrainAgain())
  }

  async #performDrain(): Promise<void> {
    const report = await this.resourceReport()
    if (this.#isStopping()) return
    const changedToPaused = report.paused && !this.#paused
    this.#paused = report.paused
    this.#emit({ type: 'resource', report })
    if (changedToPaused && this.#alerts !== undefined) {
      this.#trackAlert(this.#alerts.guardExceeded(report))
    }
    if (report.paused) return
    const available = this.#maxConcurrent - this.#running.size
    if (available <= 0) return
    const records = Object.values((await this.#store.read()).records)
      .filter((record): boolean => record.job.status === 'queued')
      .sort((left, right): number => left.createdAt - right.createdAt)
      .slice(0, available)
    for (const record of records) {
      if (this.#isStopping()) return
      await this.#launch(record.job.id)
    }
  }

  #isStopping(): boolean {
    return this.#stopping
  }

  #shouldDrainAgain(): boolean {
    return this.#drainRequested && !this.#stopping
  }

  async #launch(jobId: string): Promise<void> {
    let runningJob: BuildJob | undefined
    await this.#store.update((ledger): BuildLedger => {
      if (this.#isStopping()) return ledger
      const record = ledger.records[jobId]
      if (record?.job.status !== 'queued') return ledger
      runningJob = {
        ...record.job,
        status: 'running',
        sessionId: `luban-server-build-${record.job.id}`,
        version: record.job.version + 1,
      }
      return {
        ...ledger,
        records: {
          ...ledger.records,
          [jobId]: copyRecord(record, runningJob, { startedAt: this.#now() }),
        },
      }
    })
    if (runningJob === undefined || this.#isStopping()) return
    this.#emit({ type: 'job', job: runningJob, from: 'queued', to: 'running' })
    const controller = new AbortController()
    const task = this.#run(runningJob, controller.signal)
      .catch(this.#onError)
      .finally((): void => {
        this.#running.delete(jobId)
        this.#schedule()
      })
    this.#running.set(jobId, { controller, task })
  }

  async #run(job: BuildJob, signal: AbortSignal): Promise<void> {
    const template = this.#templates.get(job.templateId)
    let result
    try {
      if (template === undefined)
        throw new LubanError('E_INVALID_INPUT', 'build template was removed')
      result = await this.#executor.execute(
        {
          job,
          template,
          timeoutMs: this.#defaultTimeoutMs,
          artifactDirectory: this.#artifacts.jobDirectory(job.id),
          workspaceRoots: this.#workspaceRoots,
        },
        signal,
      )
    } catch (error: unknown) {
      if (signal.aborted) return
      result = {
        schemaVersion: 1 as const,
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : 'build execution failed',
        durationMs: 0,
      }
    }
    if (signal.aborted) return
    let artifacts: BuildJob['artifacts'] = []
    if (result.exitCode === 0) {
      try {
        artifacts = await this.#artifacts.discover(job.id)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'artifact discovery failed'
        result = {
          ...result,
          exitCode: 1,
          stderr: `${result.stderr}\nArtifact discovery: ${message}`.trim(),
        }
      }
    }
    const to = result.exitCode === 0 ? ('done' as const) : ('failed' as const)
    let finished: BuildJob | undefined
    await this.#store.update((ledger): BuildLedger => {
      const record = ledger.records[job.id]
      if (record?.job.status !== 'running') return ledger
      finished = {
        ...record.job,
        status: to,
        artifacts,
        ...(to === 'failed' ? { errorLogExcerpt: excerpt(result.stdout, result.stderr) } : {}),
        version: record.job.version + 1,
      }
      return {
        ...ledger,
        records: {
          ...ledger.records,
          [job.id]: copyRecord(record, finished, {
            ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
            finishedAt: this.#now(),
          }),
        },
      }
    })
    if (finished === undefined) return
    this.#emit({ type: 'job', job: finished, from: 'running', to })
    if (to === 'failed' && this.#alerts !== undefined) {
      this.#trackAlert(this.#alerts.jobFailed(finished))
    }
    await this.#enforceRetention()
  }

  #trackAlert(operation: Promise<void>): void {
    const tracked = operation
      .catch(this.#onError)
      .finally((): void => void this.#activeAlerts.delete(tracked))
    this.#activeAlerts.add(tracked)
    void tracked.catch((): void => undefined)
  }

  async #waitForAlerts(): Promise<void> {
    while (this.#activeAlerts.size > 0) {
      await Promise.allSettled([...this.#activeAlerts])
    }
  }

  async #enforceRetention(): Promise<void> {
    const ledger = await this.#store.read()
    const completed = Object.entries(ledger.records)
      .filter(
        (entry): boolean => entry[1].job.status === 'done' || entry[1].job.status === 'failed',
      )
      .sort((left, right): number => (right[1].finishedAt ?? 0) - (left[1].finishedAt ?? 0))
    const expired = completed.slice(this.#retainRuns).map(([id]) => id)
    if (expired.length === 0) return
    await this.#artifacts.prune(expired)
    const expiredSet = new Set(expired)
    await this.#store.update((current): BuildLedger => ({
      ...current,
      records: Object.fromEntries(
        Object.entries(current.records).map(([id, record]) => [
          id,
          expiredSet.has(id)
            ? { ...record, job: { ...record.job, artifacts: [], version: record.job.version + 1 } }
            : record,
        ]),
      ),
    }))
  }

  #emit(event: BuildQueueEvent): void {
    this.#publish?.(event)
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error: unknown) {
        this.#onError(error)
      }
    }
  }
}
