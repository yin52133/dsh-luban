import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  BrowserAdapter,
  BrowserEvent,
  BrowserProfile,
  BrowserResult,
  BrowserSession,
  BrowserTaskSpec,
  BrowserTemplate,
} from '@luban/core'
import { AsyncQueue } from './async-queue.js'
import type { ResolvedConfig } from './config.js'
import { isUnrestrictedDomainPattern } from './domain-policy.js'
import { BrowserError, asBrowserError } from './errors.js'
import { renderTemplate, TemplateRepository } from './templates.js'
import type {
  BrowserBridge,
  BrowserJobEvent,
  BrowserJobRequest,
  BrowserJobSnapshot,
  BrowserJobStatus,
  BrowserQueue,
  ResolvedBrowserTask,
} from './types.js'

interface MutableJob {
  readonly id: string
  readonly task: BrowserTaskSpec
  readonly params: Readonly<Record<string, string>>
  readonly automatic: boolean
  readonly createdAt: number
  status: BrowserJobStatus
  startedAt: number | undefined
  finishedAt: number | undefined
  progressStep: number
  screenshots: string[]
  result: BrowserResult | undefined
  error: BrowserError | undefined
  controller: AbortController | undefined
  readonly events: AsyncQueue<BrowserEvent>
  readonly waiters: ((job: BrowserJobSnapshot) => void)[]
}

export interface BrowserServiceOptions {
  readonly config: ResolvedConfig
  readonly bridge: BrowserBridge
  readonly templates?: TemplateRepository
  readonly now?: () => number
}

export class BrowserService implements BrowserAdapter, BrowserQueue {
  readonly #config: ResolvedConfig
  readonly #bridge: BrowserBridge
  readonly #templates: TemplateRepository
  readonly #now: () => number
  readonly #jobs = new Map<string, MutableJob>()
  readonly #pending: MutableJob[] = []
  readonly #listeners = new Set<(event: BrowserJobEvent) => void>()
  #sequence = 0
  #draining: Promise<void> | null = null
  #closing = false

  public constructor(options: BrowserServiceOptions) {
    this.#config = options.config
    this.#bridge = options.bridge
    this.#templates =
      options.templates ?? new TemplateRepository(options.config.templateDirectories)
    this.#now = options.now ?? Date.now
  }

  public async start(profile: BrowserProfile = this.#config.profile): Promise<BrowserSession> {
    this.#assertOpen()
    await this.#ensureDirectories()
    return this.#bridge.start(profile)
  }

  public async *run(task: BrowserTaskSpec): AsyncIterable<BrowserEvent> {
    const snapshot = this.enqueue({ task })
    const job = this.#jobs.get(snapshot.id)
    if (job === undefined)
      throw new BrowserError('E_BROWSER_NOT_FOUND', 'Browser job was not found')
    for await (const event of job.events) yield event
  }

  public async stop(): Promise<void> {
    for (const job of this.#pending.splice(0)) this.#cancelQueued(job)
    const running = [...this.#jobs.values()].find((job) => job.status === 'running')
    running?.controller?.abort()
    if (this.#draining !== null) await this.#draining
    await this.#bridge.stop()
  }

  public async templates(): Promise<readonly BrowserTemplate[]> {
    return this.#templates.list()
  }

  public enqueue(request: BrowserJobRequest): BrowserJobSnapshot {
    this.#assertOpen()
    const activeCount = [...this.#jobs.values()].filter(
      (job) => job.status === 'queued' || job.status === 'running',
    ).length
    if (activeCount >= this.#config.maxPending) {
      throw new BrowserError('E_BROWSER_QUEUE_FULL', 'Browser task queue is full', true)
    }
    const task = cloneTask(request.task)
    validateTask(task)
    const job: MutableJob = {
      id: randomUUID(),
      task,
      params: Object.freeze({ ...(request.params ?? {}) }),
      automatic: request.automatic ?? false,
      createdAt: this.#now(),
      status: 'queued',
      startedAt: undefined,
      finishedAt: undefined,
      progressStep: 0,
      screenshots: [],
      result: undefined,
      error: undefined,
      controller: undefined,
      events: new AsyncQueue<BrowserEvent>(),
      waiters: [],
    }
    this.#jobs.set(job.id, job)
    this.#pending.push(job)
    this.#publish(job)
    this.#scheduleDrain()
    return snapshotOf(job)
  }

  public cancel(id: string): Promise<boolean> {
    const job = this.#jobs.get(id)
    if (job === undefined || isTerminal(job.status)) return Promise.resolve(false)
    if (job.status === 'queued') {
      const index = this.#pending.indexOf(job)
      if (index >= 0) this.#pending.splice(index, 1)
      this.#cancelQueued(job)
      return Promise.resolve(true)
    }
    job.controller?.abort()
    return Promise.resolve(true)
  }

  public get(id: string): BrowserJobSnapshot | null {
    const job = this.#jobs.get(id)
    return job === undefined ? null : snapshotOf(job)
  }

  public list(): readonly BrowserJobSnapshot[] {
    return Object.freeze(
      [...this.#jobs.values()]
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(snapshotOf),
    )
  }

  public wait(id: string): Promise<BrowserJobSnapshot> {
    const job = this.#jobs.get(id)
    if (job === undefined) {
      return Promise.reject(new BrowserError('E_BROWSER_NOT_FOUND', 'Browser job was not found'))
    }
    if (isTerminal(job.status)) return Promise.resolve(snapshotOf(job))
    return new Promise<BrowserJobSnapshot>((resolve): void => {
      job.waiters.push(resolve)
    })
  }

  public subscribe(listener: (event: BrowserJobEvent) => void): () => void {
    this.#listeners.add(listener)
    return (): void => {
      this.#listeners.delete(listener)
    }
  }

  public async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    for (const job of this.#pending.splice(0)) this.#cancelQueued(job)
    const running = [...this.#jobs.values()].find((job) => job.status === 'running')
    running?.controller?.abort()
    if (this.#draining !== null) await this.#draining
    await this.#bridge.close()
    this.#listeners.clear()
  }

  #scheduleDrain(): void {
    if (this.#draining !== null) return
    this.#draining = this.#drain().finally((): void => {
      this.#draining = null
      if (this.#pending.length > 0 && !this.#closing) this.#scheduleDrain()
    })
  }

  async #drain(): Promise<void> {
    try {
      await this.#ensureDirectories()
    } catch {
      const failure = new BrowserError(
        'E_BROWSER_UNAVAILABLE',
        'Unable to prepare browser data directories',
        true,
      )
      for (const job of this.#pending.splice(0)) this.#failQueued(job, failure)
      return
    }
    while (!this.#closing) {
      const job = this.#pending.shift()
      if (job === undefined) return
      if (job.status !== 'queued') continue
      await this.#execute(job)
    }
  }

  async #execute(job: MutableJob): Promise<void> {
    job.status = 'running'
    job.startedAt = this.#now()
    job.controller = new AbortController()
    this.#publish(job)
    try {
      const task = await this.#resolveTask(job)
      await this.#bridge.start(task.profile)
      let result: BrowserResult | undefined
      for await (const event of this.#bridge.run(
        task,
        this.#config.artifactsDir,
        job.controller.signal,
      )) {
        if (event.type === 'progress') job.progressStep = Math.max(job.progressStep, event.step)
        if (event.type === 'screenshot' && !job.screenshots.includes(event.path)) {
          job.screenshots.push(event.path)
        }
        if (event.type === 'result') result = event.result
        job.events.push(event)
        this.#publish(job, event)
      }
      if (result === undefined) {
        throw new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge returned no result')
      }
      job.result = result
      job.screenshots = [...result.screenshots]
      job.status =
        result.status === 'ok' ? 'succeeded' : result.status === 'timeout' ? 'timeout' : 'failed'
      if (job.status === 'failed') {
        job.error = new BrowserError('E_BROWSER_RUN', 'Browser task reported failure')
      }
    } catch (error: unknown) {
      const failure = job.controller.signal.aborted
        ? new BrowserError('E_BROWSER_CANCELLED', 'Browser task was cancelled', true)
        : asBrowserError(error)
      job.error = failure
      job.status =
        failure.code === 'E_BROWSER_CANCELLED'
          ? 'cancelled'
          : failure.code === 'E_BROWSER_TIMEOUT'
            ? 'timeout'
            : 'failed'
      const event: BrowserEvent = { type: 'error', runId: job.id, message: failure.message }
      job.events.push(event)
      this.#publish(job, event)
    } finally {
      job.controller = undefined
      job.finishedAt = this.#now()
      job.events.close()
      this.#publish(job)
      const snapshot = snapshotOf(job)
      for (const resolve of job.waiters.splice(0)) resolve(snapshot)
    }
  }

  async #resolveTask(job: MutableJob): Promise<ResolvedBrowserTask> {
    const { task, params } = job
    const template =
      task.templateId === undefined ? null : await this.#templates.get(task.templateId)
    if (task.templateId !== undefined && template === null) {
      throw new BrowserError(
        'E_BROWSER_INVALID_TASK',
        `Unknown browser template: ${task.templateId}`,
      )
    }
    if (job.automatic && template === null) {
      throw new BrowserError('E_BROWSER_POLICY', 'Automatic browser tasks require a template')
    }

    const requestedGoal = task.goal.trim()
    const templateGoal = template === null ? '' : renderTemplate(template.goal, params)
    const goal =
      templateGoal === ''
        ? requestedGoal
        : requestedGoal === ''
          ? templateGoal
          : `${templateGoal}\n\nAdditional task context: ${requestedGoal}`
    if (goal === '')
      throw new BrowserError('E_BROWSER_INVALID_TASK', 'Browser task goal is required')

    const renderedStartUrl =
      template?.startUrl === undefined ? undefined : renderTemplate(template.startUrl, params)
    const startUrl = task.startUrl ?? renderedStartUrl
    const templateDomains = template?.allowDomains ?? this.#config.defaults.allowDomains
    const requestedDomains = task.constraints?.allowDomains
    if (
      template !== null &&
      requestedDomains?.some((domain) => !templateDomains.includes(domain)) === true
    ) {
      throw new BrowserError(
        'E_BROWSER_POLICY',
        'Task allowDomains cannot widen its template policy',
      )
    }
    const allowDomains = Object.freeze([...(requestedDomains ?? templateDomains)])
    if (allowDomains.some(isUnrestrictedDomainPattern)) {
      throw new BrowserError('E_BROWSER_POLICY', 'allowDomains cannot contain wildcard *')
    }
    if (job.automatic && allowDomains.length === 0) {
      throw new BrowserError('E_BROWSER_POLICY', 'Automatic browser tasks require allowDomains')
    }
    if (startUrl !== undefined) assertStartUrl(startUrl, allowDomains)

    const templateSteps = template?.maxSteps ?? this.#config.defaults.maxSteps
    const templateTimeout = template?.timeoutSec ?? this.#config.defaults.timeoutSec
    const maxSteps = boundedInteger(
      task.constraints?.maxSteps ?? templateSteps,
      'maxSteps',
      1,
      template === null ? 500 : templateSteps,
    )
    const timeoutSec = boundedInteger(
      task.constraints?.timeoutSec ?? templateTimeout,
      'timeoutSec',
      1,
      template === null ? 3600 : templateTimeout,
    )
    const profile = this.#resolveProfile(template?.profile)
    return {
      runId: job.id,
      goal,
      ...(startUrl === undefined ? {} : { startUrl }),
      maxSteps,
      timeoutSec,
      allowDomains,
      ...(template?.outputSchema === undefined ? {} : { outputSchema: template.outputSchema }),
      profile,
    }
  }

  #resolveProfile(
    templateProfile:
      { readonly mode: 'isolated' | 'persistent'; readonly name?: string } | undefined,
  ): BrowserProfile {
    if (templateProfile?.mode === 'persistent') {
      return {
        ...this.#config.profile,
        userDataDir: join(this.#config.profilesDir, templateProfile.name ?? 'default'),
      }
    }
    if (templateProfile?.mode === 'isolated') {
      return Object.fromEntries(
        Object.entries(this.#config.profile).filter(([key]) => key !== 'userDataDir'),
      )
    }
    return this.#config.profile
  }

  #cancelQueued(job: MutableJob): void {
    job.status = 'cancelled'
    job.error = new BrowserError('E_BROWSER_CANCELLED', 'Browser task was cancelled', true)
    job.finishedAt = this.#now()
    const event: BrowserEvent = { type: 'error', runId: job.id, message: job.error.message }
    job.events.push(event)
    job.events.close()
    this.#publish(job, event)
    const snapshot = snapshotOf(job)
    for (const resolve of job.waiters.splice(0)) resolve(snapshot)
  }

  #failQueued(job: MutableJob, failure: BrowserError): void {
    job.status = 'failed'
    job.error = failure
    job.finishedAt = this.#now()
    const event: BrowserEvent = { type: 'error', runId: job.id, message: failure.message }
    job.events.push(event)
    job.events.close()
    this.#publish(job, event)
    const snapshot = snapshotOf(job)
    for (const resolve of job.waiters.splice(0)) resolve(snapshot)
  }

  #publish(job: MutableJob, event?: BrowserEvent): void {
    const published: BrowserJobEvent = {
      sequence: ++this.#sequence,
      at: this.#now(),
      job: snapshotOf(job),
      ...(event === undefined ? {} : { event }),
    }
    for (const listener of [...this.#listeners]) listener(published)
  }

  async #ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.#config.artifactsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.#config.profilesDir, { recursive: true, mode: 0o700 }),
      ...this.#config.templateDirectories
        .slice(1)
        .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
    ])
  }

  #assertOpen(): void {
    if (this.#closing) throw new BrowserError('E_BROWSER_CLOSED', 'Browser service is closing')
  }
}

function snapshotOf(job: MutableJob): BrowserJobSnapshot {
  return Object.freeze({
    id: job.id,
    status: job.status,
    task: job.task,
    automatic: job.automatic,
    createdAt: job.createdAt,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    progressStep: job.progressStep,
    screenshots: Object.freeze([...job.screenshots]),
    ...(job.result === undefined ? {} : { result: job.result }),
    ...(job.error === undefined ? {} : { error: job.error.toJSON() }),
  })
}

function cloneTask(task: BrowserTaskSpec): BrowserTaskSpec {
  return Object.freeze({
    ...(task.templateId === undefined ? {} : { templateId: task.templateId }),
    goal: task.goal,
    ...(task.startUrl === undefined ? {} : { startUrl: task.startUrl }),
    ...(task.constraints === undefined
      ? {}
      : {
          constraints: Object.freeze({
            ...(task.constraints.maxSteps === undefined
              ? {}
              : { maxSteps: task.constraints.maxSteps }),
            ...(task.constraints.timeoutSec === undefined
              ? {}
              : { timeoutSec: task.constraints.timeoutSec }),
            ...(task.constraints.allowDomains === undefined
              ? {}
              : { allowDomains: Object.freeze([...task.constraints.allowDomains]) }),
          }),
        }),
  })
}

function validateTask(task: BrowserTaskSpec): void {
  if (typeof task.goal !== 'string' || (task.goal.trim() === '' && task.templateId === undefined)) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'Browser task goal or templateId is required')
  }
  if (task.templateId !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(task.templateId)) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'Browser templateId is invalid')
  }
  if (task.startUrl !== undefined)
    assertStartUrl(task.startUrl, task.constraints?.allowDomains ?? [])
  if (
    task.constraints?.allowDomains?.some(
      (domain) => typeof domain !== 'string' || domain.trim() === '',
    )
  ) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'allowDomains must contain non-empty strings')
  }
  if (task.constraints?.allowDomains?.some(isUnrestrictedDomainPattern)) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'allowDomains cannot contain wildcard *')
  }
}

function assertStartUrl(url: string, allowDomains: readonly string[]): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'startUrl must be an absolute URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'startUrl must use http or https')
  }
  if (
    allowDomains.length > 0 &&
    !allowDomains.some((pattern) => hostMatches(parsed.hostname, pattern))
  ) {
    throw new BrowserError('E_BROWSER_POLICY', 'startUrl is outside allowDomains')
  }
}

function hostMatches(host: string, pattern: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/u, '')
  const withoutScheme = pattern.toLowerCase().replace(/^[a-z]+:\/\//u, '')
  const normalizedPattern = withoutScheme.split('/')[0]?.split(':')[0]?.replace(/\.$/u, '') ?? ''
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2)
    return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`)
  }
  return normalizedHost === normalizedPattern
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BrowserError(
      'E_BROWSER_INVALID_TASK',
      `${name} must be between ${String(minimum)} and ${String(maximum)}`,
    )
  }
  return value
}

function isTerminal(status: BrowserJobStatus): boolean {
  return ['succeeded', 'failed', 'timeout', 'cancelled'].includes(status)
}
