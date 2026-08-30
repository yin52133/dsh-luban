import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { LubanError } from 'dsh-luban-core'

const TERMINATION_GRACE_MS = 1_000
const FORCED_CLOSE_GRACE_MS = 1_000

type SpawnedProcess = ChildProcess & {
  readonly stdout: Readable
  readonly stderr: Readable
}

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
  readonly #spawnProcess: typeof spawn

  public constructor(spawnProcess: typeof spawn = spawn) {
    this.#spawnProcess = spawnProcess
  }

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
    if (
      options.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0)
    ) {
      throw new LubanError('E_INVALID_INPUT', 'process output limit must be positive')
    }
    if (options.signal?.aborted === true) {
      throw new LubanError('E_UNAVAILABLE', 'process was cancelled', { retriable: true })
    }
    const startedAt = Date.now()
    const maximum = options.maxOutputBytes ?? 128 * 1024
    return await new Promise<ProcessResult>((resolve, reject): void => {
      let stdout: Buffer = Buffer.alloc(0)
      let stderr: Buffer = Buffer.alloc(0)
      let settled = false
      let termination: 'cancelled' | 'failed' | 'timed-out' | undefined
      let processError: Error | undefined
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined
      let forcedCloseTimer: ReturnType<typeof setTimeout> | undefined
      let child: SpawnedProcess
      try {
        child = this.#spawnProcess(command, [...args], {
          cwd: options.cwd,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error: unknown) {
        reject(
          new LubanError('E_UNAVAILABLE', `Unable to start ${command}`, {
            retriable: true,
            cause: error,
          }),
        )
        return
      }

      function cleanup(): void {
        clearTimeout(timeoutTimer)
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
        if (forcedCloseTimer !== undefined) clearTimeout(forcedCloseTimer)
        options.signal?.removeEventListener('abort', onAbort)
        child.stdout.removeListener('data', onStdout)
        child.stderr.removeListener('data', onStderr)
        child.removeListener('error', onChildError)
        child.removeListener('close', onClose)
      }
      function details(
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ): Readonly<Record<string, unknown>> {
        return {
          exitCode: exitCode ?? -1,
          signal,
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          durationMs: Date.now() - startedAt,
        }
      }
      function settleTermination(exitCode: number | null, signal: NodeJS.Signals | null): void {
        if (settled || termination === undefined) return
        settled = true
        cleanup()
        reject(
          new LubanError(
            termination === 'timed-out' ? 'E_TIMEOUT' : 'E_UNAVAILABLE',
            termination === 'timed-out'
              ? `${command} timed out`
              : termination === 'cancelled'
                ? `${command} was cancelled`
                : `Unable to run ${command}`,
            {
              retriable: true,
              ...(processError === undefined ? {} : { cause: processError }),
              details: details(exitCode, signal),
            },
          ),
        )
      }
      function forceClose(): void {
        if (settled) return
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL')
          } catch (error: unknown) {
            processError = error instanceof Error ? error : new Error('Unable to kill process')
          }
        }
        forcedCloseTimer = setTimeout((): void => {
          if (settled) return
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          } catch (error: unknown) {
            processError = error instanceof Error ? error : new Error('Unable to kill process')
          }
          child.stdout.destroy()
          child.stderr.destroy()
          child.unref()
          settleTermination(child.exitCode, child.signalCode)
        }, FORCED_CLOSE_GRACE_MS)
        forcedCloseTimer.unref()
      }
      function terminate(reason: 'cancelled' | 'failed' | 'timed-out'): void {
        if (termination !== undefined) return
        termination = reason
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGTERM')
          } catch (error: unknown) {
            processError = error instanceof Error ? error : new Error('Unable to terminate process')
          }
        }
        if (forceKillTimer !== undefined) return
        forceKillTimer = setTimeout(forceClose, TERMINATION_GRACE_MS)
        forceKillTimer.unref()
      }
      function onAbort(): void {
        terminate('cancelled')
      }
      function onStdout(chunk: Buffer): void {
        stdout = tail(stdout, chunk, maximum)
      }
      function onStderr(chunk: Buffer): void {
        stderr = tail(stderr, chunk, maximum)
      }
      function onChildError(error: Error): void {
        processError = error
        if (termination !== undefined || settled) return
        if (child.pid !== undefined) {
          terminate('failed')
          return
        }
        settled = true
        cleanup()
        reject(
          new LubanError('E_UNAVAILABLE', `Unable to start ${command}`, {
            retriable: true,
            cause: error,
          }),
        )
      }
      function onClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
        if (settled) return
        if (termination !== undefined) {
          settleTermination(exitCode, signal)
          return
        }
        settled = true
        cleanup()
        if (processError !== undefined) {
          reject(
            new LubanError('E_UNAVAILABLE', `Unable to run ${command}`, {
              retriable: true,
              cause: processError,
              details: details(exitCode, signal),
            }),
          )
          return
        }
        resolve({
          exitCode: exitCode ?? -1,
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          durationMs: Date.now() - startedAt,
        })
      }

      child.stdout.on('data', onStdout)
      child.stderr.on('data', onStderr)
      child.once('error', onChildError)
      child.once('close', onClose)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const timeoutTimer = setTimeout((): void => terminate('timed-out'), options.timeoutMs)
      timeoutTimer.unref()
      if (options.signal?.aborted === true) onAbort()
    })
  }
}

export function assertProcessSuccess(result: ProcessResult, operation: string): void {
  if (result.exitCode === 0) return
  throw new LubanError('E_UNAVAILABLE', `${operation} failed`, {
    retriable: true,
    details: { exitCode: result.exitCode, stderr: result.stderr.slice(-2_000) },
  })
}
