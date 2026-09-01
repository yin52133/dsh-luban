import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { LubanError } from '@yin52133/dsh-luban-core'
import { BoundedAsyncQueue } from './queue.js'
import type {
  CommandOptions,
  CommandRunner,
  ManagedProcess,
  ManagedProcessEvent,
  ManagedProcessOptions,
  ManagedProcessRunner,
} from './types.js'

const DEFAULT_SHUTDOWN_GRACE_MS = 2000

function ignoreLateProcessError(): void {
  // A detached child may report one last asynchronous kill error.
}

export interface ManagedProcessSpawnOptions {
  readonly cwd: string | undefined
  readonly shell: false
  readonly windowsHide: true
  readonly stdio: ['pipe', 'pipe', 'pipe']
}

export type ManagedProcessFactory = (
  command: string,
  args: readonly string[],
  options: ManagedProcessSpawnOptions,
) => ChildProcessWithoutNullStreams

const spawnManagedProcess: ManagedProcessFactory = (command, args, options) =>
  spawn(command, [...args], options)

function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve): void => {
    let settled = false
    const timer = setTimeout((): void => {
      if (settled) return
      settled = true
      resolve(false)
    }, timeoutMs)
    timer.unref()
    void promise.then(
      (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      },
      (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      },
    )
  })
}

function bestEffortKill(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // A bounded close wait and final handle release remain authoritative.
  }
}

function releaseChildHandles(child: ChildProcessWithoutNullStreams): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream.destroy()
    } catch {
      // Continue releasing the remaining process handles.
    }
  }
  try {
    child.unref()
  } catch {
    // A failed unref must not prevent deterministic lifecycle settlement.
  }
}

function childIsRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null
}

async function terminateStartingChild(
  child: ChildProcessWithoutNullStreams,
  shutdownGraceMs: number,
): Promise<void> {
  if (child.exitCode !== null) {
    releaseChildHandles(child)
    return
  }
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve): void => {
    resolveClosed = resolve
  })
  const observedClose = (): void => resolveClosed()
  child.once('close', observedClose)
  child.on('error', ignoreLateProcessError)
  let detachedWhileRunning = false
  try {
    bestEffortKill(child, 'SIGTERM')
    let exited = await waitFor(closed, shutdownGraceMs)
    if (!exited && childIsRunning(child)) {
      bestEffortKill(child, 'SIGKILL')
      exited = await waitFor(closed, shutdownGraceMs)
    }
    if (!exited && childIsRunning(child)) {
      bestEffortKill(child, 'SIGKILL')
      detachedWhileRunning = childIsRunning(child)
    }
  } finally {
    child.off('close', observedClose)
    if (!detachedWhileRunning) child.off('error', ignoreLateProcessError)
    releaseChildHandles(child)
  }
}

function assertInvocation(command: string, args: readonly string[], options: CommandOptions): void {
  if (command.trim() === '' || command.includes('\0')) throw new TypeError('command is invalid')
  for (const [index, argument] of args.entries()) {
    if (argument.includes('\0')) throw new TypeError(`args[${String(index)}] contains a NUL byte`)
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer')
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0) {
    throw new TypeError('maxOutputBytes must be a positive integer')
  }
  if (options.signal?.aborted === true) {
    throw new LubanError('E_UNAVAILABLE', 'Command was cancelled', { retriable: true })
  }
}

function appendTail(current: Buffer, chunk: Buffer, maximum: number): Buffer {
  const combined = Buffer.concat([current, chunk])
  return combined.byteLength <= maximum
    ? combined
    : combined.subarray(combined.byteLength - maximum)
}

/** Execute one allowlisted executable with an argument array; a shell is never involved. */
export class NodeCommandRunner implements CommandRunner {
  public async run(
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<Readonly<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>> {
    assertInvocation(command, args, options)
    const startedAt = Date.now()
    const controller = new AbortController()
    let timedOut = false
    const abort = (): void => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout((): void => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
    timer.unref()

    try {
      return await new Promise((resolve, reject): void => {
        let stdout: Buffer = Buffer.alloc(0)
        let stderr: Buffer = Buffer.alloc(0)
        let settled = false
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          signal: controller.signal,
        })
        child.stdout.on('data', (chunk: Buffer): void => {
          stdout = appendTail(stdout, chunk, options.maxOutputBytes)
        })
        child.stderr.on('data', (chunk: Buffer): void => {
          stderr = appendTail(stderr, chunk, options.maxOutputBytes)
        })
        child.once('error', (error: Error): void => {
          if (settled) return
          settled = true
          reject(
            new LubanError(
              timedOut ? 'E_TIMEOUT' : 'E_CHANNEL_UNAVAILABLE',
              timedOut ? `${command} timed out` : `Unable to run ${command}`,
              { retriable: true, cause: error },
            ),
          )
        })
        child.once('close', (exitCode: number | null): void => {
          if (settled) return
          settled = true
          resolve({
            exitCode: exitCode ?? -1,
            stdout: stdout.toString('utf8'),
            stderr: stderr.toString('utf8'),
            durationMs: Date.now() - startedAt,
          })
        })
      })
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }
}

class NodeManagedProcess implements ManagedProcess {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #queue = new BoundedAsyncQueue<ManagedProcessEvent>(1024)
  readonly #startedAt: number
  readonly #maximum: number
  readonly #timer: ReturnType<typeof setTimeout>
  readonly #externalSignal: AbortSignal | undefined
  readonly #externalAbort: () => void
  readonly #shutdownGraceMs: number
  readonly #onStdout: (chunk: Buffer) => void
  readonly #onStderr: (chunk: Buffer) => void
  readonly #onClose: (code: number | null) => void
  readonly #onError: (error: Error) => void
  #stdout: Buffer = Buffer.alloc(0)
  #stderr: Buffer = Buffer.alloc(0)
  #eventBytes = 0
  #exitCode: number | undefined
  #cleaned = false
  #listenersAttached = true
  #stopping:
    | Promise<Readonly<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>>
    | undefined

  public constructor(
    child: ChildProcessWithoutNullStreams,
    options: ManagedProcessOptions,
    startedAt: number,
    shutdownGraceMs: number,
  ) {
    this.#child = child
    this.#startedAt = startedAt
    this.#maximum = options.maxOutputBytes
    this.#shutdownGraceMs = shutdownGraceMs
    this.#externalSignal = options.signal
    this.#externalAbort = (): void => {
      this.#stopSilently()
    }
    this.#onStdout = (chunk: Buffer): void => this.#output('stdout', chunk)
    this.#onStderr = (chunk: Buffer): void => this.#output('stderr', chunk)
    this.#onClose = (code: number | null): void => this.#finish(code ?? -1)
    this.#onError = (error: Error): void => {
      this.#queue.end(
        new LubanError('E_CHANNEL_UNAVAILABLE', 'Managed process failed', {
          retriable: true,
          cause: error,
        }),
      )
      this.#cleanup()
      this.#stopSilently()
    }
    this.#timer = setTimeout((): void => {
      this.#stopSilently()
    }, options.timeoutMs)
    this.#timer.unref()
    child.stdout.on('data', this.#onStdout)
    child.stderr.on('data', this.#onStderr)
    child.once('close', this.#onClose)
    child.once('error', this.#onError)
    options.signal?.addEventListener('abort', this.#externalAbort, { once: true })
    if (options.signal?.aborted === true) this.#stopSilently()
  }

  public get pid(): number | undefined {
    return this.#child.pid
  }

  public events(): AsyncIterable<ManagedProcessEvent> {
    return this.#queue
  }

  public stop(): Promise<
    Readonly<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>
  > {
    this.#stopping ??= this.#stop()
    return this.#stopping
  }

  #stopSilently(): void {
    void this.stop().catch((): void => {
      // Forced-close timeout has already detached every owned process handle.
    })
  }

  async #stop(): Promise<
    Readonly<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>
  > {
    if (this.#exitCode === undefined && this.#child.exitCode !== null) {
      this.#finish(this.#child.exitCode)
    }
    if (this.#exitCode === undefined) {
      let resolveClosed!: () => void
      const closed = new Promise<void>((resolve): void => {
        resolveClosed = resolve
      })
      const observedClose = (): void => resolveClosed()
      this.#child.once('close', observedClose)
      this.#child.on('error', ignoreLateProcessError)
      let detachedWhileRunning = false
      try {
        bestEffortKill(this.#child, 'SIGTERM')
        let exited = await waitFor(closed, this.#shutdownGraceMs)
        if (!exited && !this.#finished() && childIsRunning(this.#child)) {
          bestEffortKill(this.#child, 'SIGKILL')
          exited = await waitFor(closed, this.#shutdownGraceMs)
        }
        const observedExitCode = this.#child.exitCode
        if (!exited && !this.#finished() && observedExitCode !== null) {
          this.#finish(observedExitCode)
        }
        if (!exited && !this.#finished()) {
          bestEffortKill(this.#child, 'SIGKILL')
          detachedWhileRunning = childIsRunning(this.#child)
          this.#finish(-1)
          releaseChildHandles(this.#child)
          throw new LubanError(
            'E_TIMEOUT',
            'Managed process did not close after forced termination',
            {
              retriable: true,
            },
          )
        }
      } finally {
        this.#child.off('close', observedClose)
        if (!detachedWhileRunning) this.#child.off('error', ignoreLateProcessError)
      }
    }
    return {
      exitCode: this.#exitCode ?? this.#child.exitCode ?? -1,
      stdout: this.#stdout.toString('utf8'),
      stderr: this.#stderr.toString('utf8'),
      durationMs: Date.now() - this.#startedAt,
    }
  }

  #output(type: 'stdout' | 'stderr', chunk: Buffer): void {
    if (type === 'stdout') this.#stdout = appendTail(this.#stdout, chunk, this.#maximum)
    else this.#stderr = appendTail(this.#stderr, chunk, this.#maximum)
    if (this.#eventBytes >= this.#maximum) return
    const allowed = Math.min(chunk.byteLength, this.#maximum - this.#eventBytes)
    if (allowed <= 0) return
    const text = chunk.subarray(0, allowed).toString('utf8')
    this.#eventBytes += allowed
    this.#queue.push({ type, text, at: Date.now() })
  }

  #cleanup(): void {
    if (this.#cleaned) return
    this.#cleaned = true
    clearTimeout(this.#timer)
    this.#externalSignal?.removeEventListener('abort', this.#externalAbort)
  }

  #finished(): boolean {
    return this.#exitCode !== undefined
  }

  #finish(exitCode: number): void {
    if (this.#exitCode !== undefined) return
    this.#exitCode = exitCode
    this.#queue.push({ type: 'exit', exitCode, at: Date.now() })
    this.#queue.end()
    this.#detachListeners()
    this.#cleanup()
  }

  #detachListeners(): void {
    if (!this.#listenersAttached) return
    this.#listenersAttached = false
    this.#child.stdout.off('data', this.#onStdout)
    this.#child.stderr.off('data', this.#onStderr)
    this.#child.off('close', this.#onClose)
    this.#child.off('error', this.#onError)
  }
}

/** Start one long-running executable with bounded lifetime, output and shutdown. */
export class NodeManagedProcessRunner implements ManagedProcessRunner {
  readonly #factory: ManagedProcessFactory
  readonly #shutdownGraceMs: number

  public constructor(
    factory: ManagedProcessFactory = spawnManagedProcess,
    shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  ) {
    if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs <= 0) {
      throw new TypeError('shutdownGraceMs must be a positive integer')
    }
    this.#factory = factory
    this.#shutdownGraceMs = shutdownGraceMs
  }

  public async start(
    command: string,
    args: readonly string[],
    options: ManagedProcessOptions,
  ): Promise<ManagedProcess> {
    assertInvocation(command, args, options)
    if (!Number.isSafeInteger(options.startupTimeoutMs) || options.startupTimeoutMs <= 0) {
      throw new TypeError('startupTimeoutMs must be a positive integer')
    }
    const startedAt = Date.now()
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.#factory(command, args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error: unknown) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', `Unable to start ${command}`, {
        retriable: true,
        cause: error,
      })
    }
    return await new Promise<ManagedProcess>((resolve, reject): void => {
      let settled = false
      const cleanup = (): void => {
        clearTimeout(timer)
        child.off('spawn', spawned)
        child.off('error', failed)
        child.off('close', closed)
        options.signal?.removeEventListener('abort', aborted)
      }
      const rejectAfterCleanup = (error: Error, terminate: boolean): void => {
        if (settled) return
        settled = true
        cleanup()
        if (!terminate) {
          releaseChildHandles(child)
          reject(error)
          return
        }
        void terminateStartingChild(child, this.#shutdownGraceMs).then(
          (): void => reject(error),
          (): void => reject(error),
        )
      }
      const spawned = (): void => {
        if (settled) return
        if (options.signal?.aborted === true) {
          rejectAfterCleanup(
            new LubanError('E_UNAVAILABLE', `${command} startup was cancelled`, {
              retriable: true,
            }),
            true,
          )
          return
        }
        settled = true
        cleanup()
        try {
          resolve(new NodeManagedProcess(child, options, startedAt, this.#shutdownGraceMs))
        } catch (error: unknown) {
          void terminateStartingChild(child, this.#shutdownGraceMs).then(
            (): void =>
              reject(
                new LubanError('E_CHANNEL_UNAVAILABLE', `Unable to start ${command}`, {
                  retriable: true,
                  cause: error,
                }),
              ),
            (): void =>
              reject(
                new LubanError('E_CHANNEL_UNAVAILABLE', `Unable to start ${command}`, {
                  retriable: true,
                  cause: error,
                }),
              ),
          )
        }
      }
      const failed = (error: Error): void => {
        rejectAfterCleanup(
          new LubanError('E_CHANNEL_UNAVAILABLE', `Unable to start ${command}`, {
            retriable: true,
            cause: error,
          }),
          child.pid !== undefined,
        )
      }
      const closed = (exitCode: number | null): void => {
        rejectAfterCleanup(
          new LubanError('E_CHANNEL_UNAVAILABLE', `${command} exited before startup completed`, {
            retriable: true,
            details: { exitCode: exitCode ?? -1 },
          }),
          false,
        )
      }
      const aborted = (): void => {
        rejectAfterCleanup(
          new LubanError('E_UNAVAILABLE', `${command} startup was cancelled`, { retriable: true }),
          true,
        )
      }
      const timer = setTimeout((): void => {
        rejectAfterCleanup(
          new LubanError('E_TIMEOUT', `${command} startup timed out`, { retriable: true }),
          true,
        )
      }, options.startupTimeoutMs)
      timer.unref()
      child.once('spawn', spawned)
      child.once('error', failed)
      child.once('close', closed)
      options.signal?.addEventListener('abort', aborted, { once: true })
      if (child.exitCode !== null) closed(child.exitCode)
      else if (options.signal?.aborted === true) aborted()
    })
  }
}

const OPERATOR_TOKENS = new Set([';', '&&', '||', '|', '>', '<', '2>', '&'])

/** Parse a small command grammar while rejecting shell operators and substitutions. */
export function parseCommandWords(input: string): readonly string[] {
  if (input.trim() === '' || input.length > 16_384 || input.includes('\0')) {
    throw new LubanError('E_INVALID_INPUT', 'Command is empty or too large')
  }
  const words: string[] = []
  let current = ''
  let quote: 'single' | 'double' | undefined
  let escaped = false
  const flush = (): void => {
    if (current !== '') {
      words.push(current)
      current = ''
    }
  }
  for (const character of input) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === '\\' && quote !== 'single') {
      escaped = true
      continue
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single'
      continue
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double'
      continue
    }
    if (/\s/u.test(character) && quote === undefined) flush()
    else current += character
  }
  if (escaped || quote !== undefined)
    throw new LubanError('E_INVALID_INPUT', 'Command quoting is incomplete')
  flush()
  if (
    words.length === 0 ||
    words.length > 128 ||
    words.some(
      (word): boolean =>
        OPERATOR_TOKENS.has(word) ||
        /[;&|<>]/u.test(word) ||
        word.includes('$(') ||
        word.includes('`') ||
        word.includes('\r') ||
        word.includes('\n'),
    )
  ) {
    throw new LubanError('E_INVALID_INPUT', 'Shell operators are not accepted')
  }
  return Object.freeze(words)
}
