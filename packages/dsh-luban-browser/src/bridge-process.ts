import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { BrowserEvent, BrowserProfile, BrowserResult, BrowserSession } from '@luban/core'
import { AsyncQueue } from './async-queue.js'
import type { ResolvedConfig } from './config.js'
import { BrowserError, type BrowserErrorCode } from './errors.js'
import { bridgeEnvironment, redactBrowserLog } from './security.js'
import type { BrowserBridge, ResolvedBrowserTask } from './types.js'

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly onEvent?: (event: BrowserEvent) => void
  readonly timer: NodeJS.Timeout
}

type SpawnBridge = typeof spawn

export interface BridgeProcessOptions {
  readonly config: ResolvedConfig['bridge']
  readonly environment?: NodeJS.ProcessEnv
  readonly spawnProcess?: SpawnBridge
  readonly log?: (line: string) => void
}

export class BridgeProcess implements BrowserBridge {
  readonly #config: ResolvedConfig['bridge']
  readonly #environment: NodeJS.ProcessEnv
  readonly #spawn: SpawnBridge
  readonly #log: (line: string) => void
  readonly #pending = new Map<string, PendingRequest>()
  #child: ChildProcessWithoutNullStreams | null = null
  #lines: ReadlineInterface | null = null
  #errorLines: ReadlineInterface | null = null
  #closed = false

  public constructor(options: BridgeProcessOptions) {
    this.#config = options.config
    this.#environment = options.environment ?? process.env
    this.#spawn = options.spawnProcess ?? spawn
    this.#log = options.log ?? ((): void => undefined)
  }

  public async start(profile: BrowserProfile): Promise<BrowserSession> {
    await this.#ensureProcess()
    const ping = asRecord(await this.#request('ping', {}, 10_000))
    if (
      ping.bridgeVersion !== '0.1.0' ||
      ping.browserUseVersion !== '0.13.8' ||
      ping.python !== '3.12'
    ) {
      throw new BrowserError('E_BROWSER_VERSION', 'Browser bridge version handshake failed')
    }
    await this.#request('start', { profile }, 30_000)
    return { id: randomUUID(), profile, startedAt: Date.now() }
  }

  public async *run(
    task: ResolvedBrowserTask,
    outputDir: string,
    signal: AbortSignal,
  ): AsyncIterable<BrowserEvent> {
    await this.#ensureProcess()
    if (signal.aborted)
      throw new BrowserError('E_BROWSER_CANCELLED', 'Browser task was cancelled', true)
    const events = new AsyncQueue<BrowserEvent>()
    const timeoutMs = (task.timeoutSec + this.#config.timeoutGraceSec) * 1000
    const operation = this.#request(
      'run',
      {
        runId: task.runId,
        goal: task.goal,
        ...(task.startUrl === undefined ? {} : { startUrl: task.startUrl }),
        maxSteps: task.maxSteps,
        timeoutSec: task.timeoutSec,
        allowDomains: task.allowDomains,
        outputDir,
        ...(task.outputSchema === undefined ? {} : { outputSchema: task.outputSchema }),
      },
      timeoutMs,
      (event): void => events.push(event),
    )
    const abort = (): void => {
      void this.cancel(task.runId)
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(
      (): void => events.close(),
      (error: unknown): void => events.fail(error),
    )
    try {
      for await (const event of events) yield event
      const result = decodeResult(await operation)
      yield { type: 'result', result }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  public async stop(): Promise<void> {
    if (this.#child === null) return
    await this.#request('stop', {}, 10_000)
  }

  public async close(): Promise<void> {
    if (this.#closed) return
    const child = this.#child
    if (child === null) {
      this.#closed = true
      return
    }
    try {
      await this.#request('shutdown', {}, 10_000)
    } catch {
      child.kill()
    } finally {
      this.#closed = true
      this.#lines?.close()
      this.#lines = null
      this.#errorLines?.close()
      this.#errorLines = null
      this.#child = null
      this.#rejectAll(new BrowserError('E_BROWSER_CLOSED', 'Browser bridge closed'))
    }
  }

  private async cancel(runId: string): Promise<void> {
    if (this.#child === null) return
    try {
      await this.#request('cancel', { runId }, 5_000)
    } catch {
      this.#child.kill()
    }
  }

  async #ensureProcess(): Promise<void> {
    if (this.#closed) throw new BrowserError('E_BROWSER_CLOSED', 'Browser bridge is closed')
    if (this.#child !== null) return
    await mkdir(this.#config.environmentDir, { recursive: true, mode: 0o700 })
    const environment = bridgeEnvironment(
      this.#environment,
      this.#config.passEnvironment,
      this.#config.environmentDir,
    )
    const child = this.#spawn(
      this.#config.runner,
      [
        'run',
        '--locked',
        '--no-dev',
        '--python',
        this.#config.python,
        '--project',
        this.#config.projectDir,
        'python',
        '-m',
        'luban_browser_bridge',
      ],
      {
        cwd: this.#config.projectDir,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.#child = child
    this.#lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.#lines.on('line', (line): void => this.#handleLine(line))
    this.#errorLines = createInterface({ input: child.stderr, crlfDelay: Infinity })
    this.#errorLines.on('line', (line): void => {
      if (line !== '') this.#log(redactBrowserLog(line))
    })
    child.once('error', (error): void => this.#processFailed(error))
    child.once('exit', (code, signal): void => {
      this.#processFailed(
        new BrowserError(
          'E_BROWSER_UNAVAILABLE',
          `Browser bridge exited (${code === null ? (signal ?? 'unknown') : String(code)})`,
          true,
        ),
      )
    })
  }

  #request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    onEvent?: (event: BrowserEvent) => void,
  ): Promise<unknown> {
    const child = this.#child
    if (child === null) {
      return Promise.reject(
        new BrowserError('E_BROWSER_UNAVAILABLE', 'Browser bridge is not running', true),
      )
    }
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject): void => {
      const timer = setTimeout((): void => {
        this.#processFailed(
          new BrowserError('E_BROWSER_TIMEOUT', `Browser bridge ${method} timed out`, true),
        )
      }, timeoutMs)
      this.#pending.set(id, {
        resolve,
        reject,
        ...(onEvent === undefined ? {} : { onEvent }),
        timer,
      })
      const frame = `${JSON.stringify({ v: 1, id, kind: 'request', method, params })}\n`
      child.stdin.write(frame, 'utf8', (error): void => {
        if (error === null || error === undefined) return
        const pending = this.#pending.get(id)
        if (pending === undefined) return
        clearTimeout(pending.timer)
        this.#pending.delete(id)
        pending.reject(
          new BrowserError('E_BROWSER_UNAVAILABLE', 'Unable to write to browser bridge', true),
        )
      })
    })
  }

  #handleLine(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line) as unknown
    } catch {
      this.#processFailed(
        new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge emitted invalid JSON'),
      )
      return
    }
    if (!isRecord(frame) || frame.v !== 1 || typeof frame.id !== 'string') {
      this.#processFailed(
        new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge emitted an invalid frame'),
      )
      return
    }
    const pending = this.#pending.get(frame.id)
    if (pending === undefined) return
    if (frame.kind === 'event') {
      try {
        pending.onEvent?.(decodeEvent(frame.event))
      } catch (error: unknown) {
        this.#processFailed(error)
      }
      return
    }
    if (frame.kind !== 'response' || typeof frame.ok !== 'boolean') {
      this.#processFailed(
        new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge response is invalid'),
      )
      return
    }
    clearTimeout(pending.timer)
    this.#pending.delete(frame.id)
    if (frame.ok) pending.resolve(frame.result)
    else pending.reject(decodeError(frame.error))
  }

  #processFailed(error: unknown): void {
    const failure =
      error instanceof BrowserError
        ? error
        : new BrowserError('E_BROWSER_UNAVAILABLE', 'Browser bridge process failed', true)
    this.#lines?.close()
    this.#lines = null
    this.#errorLines?.close()
    this.#errorLines = null
    const child = this.#child
    this.#child = null
    if (child !== null && child.exitCode === null && child.signalCode === null) child.kill()
    this.#rejectAll(failure)
  }

  #rejectAll(error: BrowserError): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.#pending.delete(id)
    }
  }
}

function decodeError(value: unknown): BrowserError {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    return new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge error response is invalid')
  }
  return new BrowserError(value.code as BrowserErrorCode, value.message, value.retriable === true)
}

function decodeEvent(value: unknown): BrowserEvent {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.runId !== 'string') {
    throw new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge event is invalid')
  }
  if (
    value.type === 'progress' &&
    typeof value.step === 'number' &&
    typeof value.detail === 'string'
  ) {
    return { type: 'progress', runId: value.runId, step: value.step, detail: value.detail }
  }
  if (value.type === 'screenshot' && typeof value.path === 'string') {
    return { type: 'screenshot', runId: value.runId, path: value.path }
  }
  if (value.type === 'error' && typeof value.message === 'string') {
    return { type: 'error', runId: value.runId, message: value.message }
  }
  throw new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge event type is invalid')
}

function decodeResult(value: unknown): BrowserResult {
  const source = asRecord(value)
  if (
    typeof source.runId !== 'string' ||
    !['ok', 'failed', 'timeout'].includes(String(source.status)) ||
    !Array.isArray(source.screenshots) ||
    source.screenshots.some((path) => typeof path !== 'string') ||
    typeof source.text !== 'string' ||
    typeof source.steps !== 'number' ||
    typeof source.durationMs !== 'number'
  ) {
    throw new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge result is invalid')
  }
  return {
    runId: source.runId,
    status: source.status as BrowserResult['status'],
    screenshots: source.screenshots as string[],
    text: source.text,
    ...(source.structured === undefined ? {} : { structured: source.structured }),
    steps: source.steps,
    durationMs: source.durationMs,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge payload is invalid')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
