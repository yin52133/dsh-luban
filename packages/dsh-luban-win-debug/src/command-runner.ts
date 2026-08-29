import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { LubanError } from '@luban/core'
import { BoundedAsyncQueue } from './queue.js'
import type {
  CommandOptions,
  CommandRunner,
  ManagedProcess,
  ManagedProcessEvent,
  ManagedProcessOptions,
  ManagedProcessRunner,
} from './types.js'

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
  #stdout: Buffer = Buffer.alloc(0)
  #stderr: Buffer = Buffer.alloc(0)
  #eventBytes = 0
  #exitCode: number | undefined
  #stopping:
    | Promise<Readonly<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>>
    | undefined

  public constructor(
    child: ChildProcessWithoutNullStreams,
    options: ManagedProcessOptions,
    startedAt: number,
  ) {
    this.#child = child
    this.#startedAt = startedAt
    this.#maximum = options.maxOutputBytes
    this.#externalSignal = options.signal
    this.#externalAbort = (): void => {
      void this.stop()
    }
    options.signal?.addEventListener('abort', this.#externalAbort, { once: true })
    this.#timer = setTimeout((): void => {
      void this.stop()
    }, options.timeoutMs)
    this.#timer.unref()
    child.stdout.on('data', (chunk: Buffer): void => this.#output('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer): void => this.#output('stderr', chunk))
    child.once('close', (code: number | null): void => {
      this.#exitCode = code ?? -1
      this.#queue.push({ type: 'exit', exitCode: this.#exitCode, at: Date.now() })
      this.#queue.end()
      this.#cleanup()
    })
    child.once('error', (error: Error): void => {
      this.#queue.end(
        new LubanError('E_CHANNEL_UNAVAILABLE', 'Managed process failed', {
          retriable: true,
          cause: error,
        }),
      )
      this.#cleanup()
    })
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

  async #stop(): Promise<
    Readonly<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>
  > {
    if (this.#exitCode === undefined && this.#child.exitCode === null) {
      this.#child.kill('SIGTERM')
      const exited = await Promise.race([
        new Promise<boolean>((resolve): void => {
          this.#child.once('close', (): void => resolve(true))
        }),
        new Promise<boolean>((resolve): void => {
          const timer = setTimeout((): void => resolve(false), 2000)
          timer.unref()
        }),
      ])
      if (!exited) this.#child.kill('SIGKILL')
    }
    if (this.#exitCode === undefined && this.#child.exitCode === null) {
      await new Promise<void>((resolve): void => {
        this.#child.once('close', (): void => resolve())
      })
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
    clearTimeout(this.#timer)
    this.#externalSignal?.removeEventListener('abort', this.#externalAbort)
  }
}

/** Start one long-running executable with bounded lifetime, output and shutdown. */
export class NodeManagedProcessRunner implements ManagedProcessRunner {
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
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const managed = new NodeManagedProcess(child, options, startedAt)
    await new Promise<void>((resolve, reject): void => {
      let settled = false
      const timer = setTimeout((): void => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new LubanError('E_TIMEOUT', `${command} startup timed out`, { retriable: true }))
      }, options.startupTimeoutMs)
      timer.unref()
      child.once('spawn', (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      })
      child.once('error', (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(
          new LubanError('E_CHANNEL_UNAVAILABLE', `Unable to start ${command}`, {
            retriable: true,
            cause: error,
          }),
        )
      })
    })
    return managed
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
