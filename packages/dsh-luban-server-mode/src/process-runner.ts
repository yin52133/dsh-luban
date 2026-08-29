import { spawn } from 'node:child_process'
import { LubanError } from '@luban/core'

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

export interface ProcessOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  readonly cwd?: string | undefined
  readonly maxOutputBytes?: number
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult>
}

function tail(current: Buffer, chunk: Buffer, maximum: number): Buffer {
  const combined = Buffer.concat([current, chunk])
  return combined.byteLength <= maximum
    ? combined
    : combined.subarray(combined.byteLength - maximum)
}

/** Execute one argv vector without a shell and terminate it on timeout or cancellation. */
export class NodeProcessRunner implements ProcessRunner {
  public async run(
    command: string,
    args: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    if (command === '' || command.includes('\0') || args.some((value) => value.includes('\0'))) {
      throw new LubanError('E_INVALID_INPUT', 'process argv contains an invalid value')
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new LubanError('E_INVALID_INPUT', 'process timeout must be positive')
    }
    if (options.signal?.aborted === true) {
      throw new LubanError('E_UNAVAILABLE', 'process was cancelled', { retriable: true })
    }
    const startedAt = Date.now()
    const maximum = options.maxOutputBytes ?? 128 * 1024
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
      return await new Promise<ProcessResult>((resolve, reject): void => {
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
          stdout = tail(stdout, chunk, maximum)
        })
        child.stderr.on('data', (chunk: Buffer): void => {
          stderr = tail(stderr, chunk, maximum)
        })
        child.once('error', (error: Error): void => {
          if (settled) return
          settled = true
          const code = timedOut ? 'E_TIMEOUT' : 'E_UNAVAILABLE'
          const message = timedOut
            ? `${command} timed out`
            : controller.signal.aborted
              ? `${command} was cancelled`
              : `Unable to start ${command}`
          reject(new LubanError(code, message, { retriable: true, cause: error }))
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

export function assertProcessSuccess(result: ProcessResult, operation: string): void {
  if (result.exitCode === 0) return
  throw new LubanError('E_UNAVAILABLE', `${operation} failed`, {
    retriable: true,
    details: { exitCode: result.exitCode, stderr: result.stderr.slice(-2_000) },
  })
}
