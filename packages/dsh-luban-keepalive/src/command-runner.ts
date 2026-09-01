import { spawn } from 'node:child_process'
import { LubanError } from '@yin52133/dsh-luban-core'

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

export interface CommandOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  readonly cwd?: string | undefined
  readonly stdio?: 'pipe' | 'inherit'
  readonly maxOutputBytes?: number
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>
}

function validToken(value: string, label: string, allowEmpty = false): void {
  if ((!allowEmpty && value === '') || value.includes('\0'))
    throw new TypeError(`${label} is invalid`)
}

function appendTail(current: Buffer, chunk: Buffer, maximum: number): Buffer {
  const combined = Buffer.concat([current, chunk])
  return combined.byteLength <= maximum
    ? combined
    : combined.subarray(combined.byteLength - maximum)
}

/** Spawn one executable without a shell, with bounded output, timeout, and cancellation. */
export class NodeCommandRunner implements CommandRunner {
  public async run(
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    validToken(command, 'command')
    for (const [index, argument] of args.entries()) {
      validToken(argument, `args[${String(index)}]`, true)
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new TypeError('timeoutMs must be a positive integer')
    }
    if (options.signal?.aborted === true) {
      throw new LubanError('E_UNAVAILABLE', 'Command was cancelled', { retriable: true })
    }

    const startedAt = Date.now()
    const maximum = options.maxOutputBytes ?? 64 * 1024
    const controller = new AbortController()
    let timedOut = false
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout((): void => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
    timer.unref()

    try {
      return await new Promise<CommandResult>((resolve, reject): void => {
        let stdout: Buffer = Buffer.alloc(0)
        let stderr: Buffer = Buffer.alloc(0)
        let settled = false
        const child = spawn(command, [...args], {
          cwd: options.cwd,
          shell: false,
          windowsHide: true,
          stdio: options.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
          signal: controller.signal,
        })
        child.stdout?.on('data', (chunk: Buffer): void => {
          stdout = appendTail(stdout, chunk, maximum)
        })
        child.stderr?.on('data', (chunk: Buffer): void => {
          stderr = appendTail(stderr, chunk, maximum)
        })
        child.once('error', (error: Error): void => {
          if (settled) return
          settled = true
          if (timedOut) {
            reject(
              new LubanError('E_TIMEOUT', `${command} timed out`, {
                retriable: true,
                cause: error,
              }),
            )
          } else if (controller.signal.aborted) {
            reject(
              new LubanError('E_UNAVAILABLE', `${command} was cancelled`, {
                retriable: true,
                cause: error,
              }),
            )
          } else {
            reject(
              new LubanError('E_UNAVAILABLE', `Unable to start ${command}`, {
                retriable: true,
                cause: error,
              }),
            )
          }
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
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

export function assertSuccess(result: CommandResult, operation: string): void {
  if (result.exitCode === 0) return
  throw new LubanError('E_UNAVAILABLE', `${operation} failed`, {
    retriable: true,
    details: {
      exitCode: result.exitCode,
      stderr: result.stderr.slice(-2_000),
    },
  })
}
