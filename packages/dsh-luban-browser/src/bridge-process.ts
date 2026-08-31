import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { BrowserEvent, BrowserProfile, BrowserResult, BrowserSession } from 'dsh-luban-core'
import { AsyncQueue } from './async-queue.js'
import type { ResolvedConfig } from './config.js'
import { BrowserError, type BrowserErrorCode } from './errors.js'
import type { BrowserModelGateway } from './dsh-model-gateway.js'
import { bridgeEnvironment, redactBrowserLog } from './security.js'
import type { BrowserBridge, ResolvedBrowserTask } from './types.js'

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly onEvent?: (event: BrowserEvent) => void
  readonly timer: NodeJS.Timeout
}

interface ChildState {
  readonly child: ChildProcessWithoutNullStreams
  readonly lines: ReadlineInterface
  readonly errorLines: ReadlineInterface
  readonly closed: Promise<void>
  readonly onLine: (line: string) => void
  readonly onErrorLine: (line: string) => void
  readonly onError: (error: Error) => void
  readonly onClose: (code: number | null, signal: NodeJS.Signals | null) => void
  protocolClosed: boolean
  disposed: boolean
}

type SpawnBridge = typeof spawn

const PROCESS_CLOSE_TIMEOUT_MS = 5_000
const PROCESS_HANDSHAKE_TIMEOUT_MS = 60_000

export interface BridgeProcessOptions {
  readonly config: ResolvedConfig['bridge']
  readonly environment?: NodeJS.ProcessEnv
  readonly spawnProcess?: SpawnBridge
  readonly log?: (line: string) => void
  readonly modelGateway?: BrowserModelGateway
}

export class BridgeProcess implements BrowserBridge {
  readonly #config: ResolvedConfig['bridge']
  readonly #environment: NodeJS.ProcessEnv
  readonly #spawn: SpawnBridge
  readonly #log: (line: string) => void
  readonly #modelGateway: BrowserModelGateway | undefined
  readonly #pending = new Map<string, PendingRequest>()
  #state: ChildState | null = null
  #starting: Promise<void> | null = null
  #terminating: Promise<void> | null = null
  #closeOperation: Promise<void> | null = null
  #closed = false

  public constructor(options: BridgeProcessOptions) {
    this.#config = options.config
    this.#environment = options.environment ?? process.env
    this.#spawn = options.spawnProcess ?? spawn
    this.#log = options.log ?? ((): void => undefined)
    this.#modelGateway = options.modelGateway
  }

  public async start(profile: BrowserProfile): Promise<BrowserSession> {
    await this.#ensureProcess()
    const ping = asRecord(await this.#request('ping', {}, PROCESS_HANDSHAKE_TIMEOUT_MS))
    if (
      ping.bridgeVersion !== '0.1.0' ||
      ping.browserUseVersion !== '0.13.8' ||
      ping.python !== '3.12'
    ) {
      throw new BrowserError('E_BROWSER_VERSION', 'Browser bridge version handshake failed')
    }
    const resolvedProfile = decodeStartedProfile(await this.#request('start', { profile }, 30_000))
    return { id: randomUUID(), profile: resolvedProfile, startedAt: Date.now() }
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
    if (this.#state === null) return
    await this.#request('stop', {}, 10_000)
  }

  public close(): Promise<void> {
    if (this.#closeOperation !== null) return this.#closeOperation
    this.#closed = true
    const operation = this.#closeProcess()
    this.#closeOperation = operation
    return operation
  }

  async #closeProcess(): Promise<void> {
    const state = this.#state
    if (state === null) {
      await this.#terminating
      this.#rejectAll(new BrowserError('E_BROWSER_CLOSED', 'Browser bridge closed'))
      await this.#modelGateway?.close()
      return
    }
    let childClosed = false
    try {
      await this.#request('shutdown', {}, 10_000)
    } catch {
      this.#kill(state.child)
    }
    try {
      childClosed = await settlesWithin(state.closed, PROCESS_CLOSE_TIMEOUT_MS)
      if (!childClosed) {
        this.#kill(state.child, 'SIGKILL')
        childClosed = await settlesWithin(state.closed, PROCESS_CLOSE_TIMEOUT_MS)
      }
    } finally {
      if (this.#state === state) this.#state = null
      this.#disposeState(state)
      this.#rejectAll(new BrowserError('E_BROWSER_CLOSED', 'Browser bridge closed'))
      await this.#modelGateway?.close()
    }
    if (!childClosed) {
      throw new BrowserError(
        'E_BROWSER_TIMEOUT',
        'Browser bridge did not exit after shutdown',
        true,
      )
    }
  }

  private async cancel(runId: string): Promise<void> {
    const state = this.#state
    if (state === null) return
    try {
      await this.#request('cancel', { runId }, 5_000)
    } catch {
      this.#kill(state.child)
    }
  }

  async #ensureProcess(): Promise<void> {
    if (this.#closed) throw new BrowserError('E_BROWSER_CLOSED', 'Browser bridge is closed')
    if (this.#state !== null) return
    if (this.#starting !== null) return this.#starting
    const starting = this.#startProcess()
    this.#starting = starting
    try {
      await starting
    } finally {
      if (this.#starting === starting) this.#starting = null
    }
  }

  async #startProcess(): Promise<void> {
    await this.#terminating
    this.#assertOpen()
    if (this.#state !== null) return
    await mkdir(this.#config.environmentDir, { recursive: true, mode: 0o700 })
    this.#assertOpen()
    const environment = bridgeEnvironment(
      this.#environment,
      this.#config.passEnvironment,
      this.#config.environmentDir,
    )
    const model = await this.#modelGateway?.start()
    if (model !== undefined) {
      environment.LUBAN_BROWSER_DSH_LLM_URL = model.url
      environment.LUBAN_BROWSER_DSH_LLM_TOKEN = model.token
    }
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
    this.#attach(child)
  }

  #request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    onEvent?: (event: BrowserEvent) => void,
  ): Promise<unknown> {
    const state = this.#state
    if (state === null) {
      return Promise.reject(
        new BrowserError('E_BROWSER_UNAVAILABLE', 'Browser bridge is not running', true),
      )
    }
    const id = randomUUID()
    return new Promise<unknown>((resolve, reject): void => {
      const timer = setTimeout((): void => {
        this.#processFailed(
          new BrowserError('E_BROWSER_TIMEOUT', `Browser bridge ${method} timed out`, true),
          state,
        )
      }, timeoutMs)
      this.#pending.set(id, {
        resolve,
        reject,
        ...(onEvent === undefined ? {} : { onEvent }),
        timer,
      })
      const frame = `${JSON.stringify({ v: 1, id, kind: 'request', method, params })}\n`
      state.child.stdin.write(frame, 'utf8', (error): void => {
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

  #handleLine(line: string, state: ChildState): void {
    if (this.#state !== state) return
    let frame: unknown
    try {
      frame = JSON.parse(line) as unknown
    } catch {
      this.#processFailed(
        new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge emitted invalid JSON'),
        state,
      )
      return
    }
    if (!isRecord(frame) || frame.v !== 1 || typeof frame.id !== 'string') {
      this.#processFailed(
        new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge emitted an invalid frame'),
        state,
      )
      return
    }
    const pending = this.#pending.get(frame.id)
    if (pending === undefined) return
    if (frame.kind === 'event') {
      try {
        pending.onEvent?.(decodeEvent(frame.event))
      } catch (error: unknown) {
        this.#processFailed(error, state)
      }
      return
    }
    if (frame.kind !== 'response' || typeof frame.ok !== 'boolean') {
      this.#processFailed(
        new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge response is invalid'),
        state,
      )
      return
    }
    clearTimeout(pending.timer)
    this.#pending.delete(frame.id)
    if (frame.ok) pending.resolve(frame.result)
    else pending.reject(decodeError(frame.error))
  }

  #processFailed(error: unknown, state: ChildState): void {
    if (this.#state !== state) return
    const failure =
      error instanceof BrowserError
        ? error
        : new BrowserError('E_BROWSER_UNAVAILABLE', 'Browser bridge process failed', true)
    this.#state = null
    this.#closeProtocol(state)
    this.#kill(state.child)
    this.#rejectAll(failure)
    const terminating = this.#finishTermination(state)
    this.#terminating = terminating
    const clearTermination = (): void => {
      if (this.#terminating === terminating) this.#terminating = null
    }
    void terminating.then(clearTermination, clearTermination)
  }

  #attach(child: ChildProcessWithoutNullStreams): void {
    let settleClose: (() => void) | undefined
    const closed = new Promise<void>((resolve): void => {
      let settled = false
      settleClose = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
    })
    if (settleClose === undefined) throw new Error('child close resolver was not initialized')
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    const errorLines = createInterface({ input: child.stderr, crlfDelay: Infinity })
    const state: ChildState = {
      child,
      lines,
      errorLines,
      closed,
      onLine: (line): void => this.#handleLine(line, state),
      onErrorLine: (line): void => {
        if (this.#state === state && line !== '') this.#log(redactBrowserLog(line))
      },
      onError: (error): void => {
        if (child.pid === undefined) settleClose?.()
        this.#processFailed(error, state)
      },
      onClose: (code, signal): void => {
        settleClose?.()
        this.#processFailed(
          new BrowserError(
            'E_BROWSER_UNAVAILABLE',
            `Browser bridge exited (${code === null ? (signal ?? 'unknown') : String(code)})`,
            true,
          ),
          state,
        )
      },
      protocolClosed: false,
      disposed: false,
    }
    this.#state = state
    lines.on('line', state.onLine)
    errorLines.on('line', state.onErrorLine)
    child.once('error', state.onError)
    child.once('close', state.onClose)
  }

  async #finishTermination(state: ChildState): Promise<void> {
    try {
      if (!(await settlesWithin(state.closed, PROCESS_CLOSE_TIMEOUT_MS))) {
        this.#kill(state.child, 'SIGKILL')
      }
      await settlesWithin(state.closed, PROCESS_CLOSE_TIMEOUT_MS)
    } finally {
      this.#disposeState(state)
    }
  }

  #closeProtocol(state: ChildState): void {
    if (state.protocolClosed) return
    state.protocolClosed = true
    state.lines.off('line', state.onLine)
    state.errorLines.off('line', state.onErrorLine)
    state.lines.close()
    state.errorLines.close()
  }

  #disposeState(state: ChildState): void {
    if (state.disposed) return
    state.disposed = true
    this.#closeProtocol(state)
    state.child.off('error', state.onError)
    state.child.off('close', state.onClose)
    state.child.stdin.destroy()
    state.child.stdout.destroy()
    state.child.stderr.destroy()
  }

  #kill(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }

  #assertOpen(): void {
    if (this.#closed) throw new BrowserError('E_BROWSER_CLOSED', 'Browser bridge is closed')
  }

  #rejectAll(error: BrowserError): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.#pending.delete(id)
    }
  }
}

async function settlesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve): void => {
    timer = setTimeout((): void => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([operation.then((): boolean => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
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

function decodeStartedProfile(value: unknown): BrowserProfile {
  const source = asRecord(value)
  const profile = asRecord(source.profile)
  const binary = asRecord(profile.binary)
  const kernel = profile.kernel
  const binaryKind = binary.kind
  if (
    !hasExactKeys(profile, ['kernel', 'headless', 'isolated', 'binary']) ||
    !hasExactKeys(binary, ['kind', 'version', 'sha256']) ||
    !isResolvedBrowserKernel(kernel) ||
    typeof profile.headless !== 'boolean' ||
    typeof profile.isolated !== 'boolean' ||
    !isBrowserBinaryKind(binaryKind) ||
    binaryKind !==
      ({ chrome: 'chrome', edge: 'edge', 'chromium-headless': 'chromium' } as const)[kernel] ||
    typeof binary.version !== 'string' ||
    binary.version.length > 128 ||
    !/^\d+(?:\.\d+){1,3}(?:[-+._A-Za-z0-9]*)?$/u.test(binary.version) ||
    typeof binary.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(binary.sha256)
  ) {
    throw new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge resolved profile is invalid')
  }
  return Object.freeze({
    kernel,
    headless: profile.headless,
    isolated: profile.isolated,
    binary: Object.freeze({
      kind: binaryKind,
      version: binary.version,
      sha256: binary.sha256,
    }),
  })
}

function isResolvedBrowserKernel(value: unknown): value is 'chrome' | 'edge' | 'chromium-headless' {
  return typeof value === 'string' && ['chrome', 'edge', 'chromium-headless'].includes(value)
}

function isBrowserBinaryKind(value: unknown): value is 'chrome' | 'edge' | 'chromium' {
  return typeof value === 'string' && ['chrome', 'edge', 'chromium'].includes(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length && expected.every((key): boolean => Object.hasOwn(value, key))
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw new BrowserError('E_BROWSER_PROTOCOL', 'Browser bridge payload is invalid')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
