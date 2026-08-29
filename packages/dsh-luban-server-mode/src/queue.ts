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
  readonly #retainRuns: number
  readonly #alerts: BuildAlertSink | undefined
  readonly #now: () => number
  readonly #publish: ((event: BuildQueueEvent) => void) | undefined
  readonly #onError: (error: unknown) => void
  readonly #listeners = new Set<(event: BuildQueueEvent) => void>()
  readonly #running = new Map<
    string,
    { readonly controller: AbortController; readonly task: Promise<void> }
  >()
  #timer: ReturnType<typeof setInterval> | undefined
  #draining = false
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
    this.#retainRuns = options.retainRuns
    this.#alerts = options.alerts
    this.#now = options.now ?? Date.now
    this.#publish = options.publish
    this.#onError = options.onError ?? ((): void => undefined)
  }

  public async start(): Promise<void> {
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
      const sample = await this.#probe.sample()
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
          return
        }
        if (jobs.some((job): boolean => job.status === 'running')) {
          await new Promise<void>((resolve): void => {
            setImmediate(resolve)
          })
          continue
        }
        if ((await this.resourceReport()).paused) return
        continue
      }
      await Promise.all(tasks)
    }
  }

  public async dispose(): Promise<void> {
    this.#stopping = true
    this.#started = false
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    for (const entry of this.#running.values()) entry.controller.abort()
    await Promise.allSettled([...this.#running.values()].map((entry) => entry.task))
    this.#listeners.clear()
  }

  #schedule(): void {
    if (this.#stopping || !this.#started) return
    void this.#drain().catch(this.#onError)
  }

  async #drain(): Promise<void> {
    if (this.#draining || this.#stopping) return
    this.#draining = true
    try {
      const report = await this.resourceReport()
      const changedToPaused = report.paused && !this.#paused
      this.#paused = report.paused
      this.#emit({ type: 'resource', report })
      if (changedToPaused && this.#alerts !== undefined) {
        void this.#alerts.guardExceeded(report).catch(this.#onError)
      }
      if (report.paused) return
      const available = this.#maxConcurrent - this.#running.size
      if (available <= 0) return
      const records = Object.values((await this.#store.read()).records)
        .filter((record): boolean => record.job.status === 'queued')
        .sort((left, right): number => left.createdAt - right.createdAt)
        .slice(0, available)
      for (const record of records) await this.#launch(record.job.id)
    } finally {
      this.#draining = false
    }
  }

  async #launch(jobId: string): Promise<void> {
    let runningJob: BuildJob | undefined
    await this.#store.update((ledger): BuildLedger => {
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
    if (runningJob === undefined) return
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
      void this.#alerts.jobFailed(finished).catch(this.#onError)
    }
    await this.#enforceRetention()
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
