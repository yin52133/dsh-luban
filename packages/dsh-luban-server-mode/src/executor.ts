import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { BuildJob, KeepaliveService } from '@yin52133/dsh-luban-core'
import { LubanError } from '@yin52133/dsh-luban-core'
import type { BuildTemplateConfig } from './config.js'
import { compileTemplate } from './templates.js'
import { decodeWorkerResult, type WorkerResult, type WorkerSpec } from './worker-protocol.js'

export interface BuildExecutionRequest {
  readonly job: BuildJob
  readonly template: BuildTemplateConfig
  readonly timeoutMs: number
  readonly artifactDirectory: string
  readonly workspaceRoots: readonly string[]
}

export interface BuildExecutor {
  execute(request: BuildExecutionRequest, signal: AbortSignal): Promise<WorkerResult>
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(filePath), `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, filePath)
  } catch (error: unknown) {
    await rm(temporary, { force: true })
    throw error
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject): void => {
    if (signal.aborted) {
      reject(new LubanError('E_UNAVAILABLE', 'build wait was cancelled', { retriable: true }))
      return
    }
    const timer = setTimeout((): void => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    timer.unref()
    const abort = (): void => {
      clearTimeout(timer)
      reject(new LubanError('E_UNAVAILABLE', 'build wait was cancelled', { retriable: true }))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof Reflect.get(error, 'code') === 'string'
    ? (Reflect.get(error, 'code') as string)
    : undefined
}

export interface ManagedBuildExecutorOptions {
  readonly keepalive: KeepaliveService
  readonly stateDirectory: string
  readonly pollIntervalMs?: number
  readonly onError?: (error: unknown) => void
}

/** Launch the package worker through M03 and await its durable result file. */
export class ManagedBuildExecutor implements BuildExecutor {
  readonly #keepalive: KeepaliveService & {
    release?(id: string, options?: { readonly destroy?: boolean }): Promise<void>
  }
  readonly #stateDirectory: string
  readonly #pollIntervalMs: number
  readonly #onError: (error: unknown) => void

  public constructor(options: ManagedBuildExecutorOptions) {
    this.#keepalive = options.keepalive
    this.#stateDirectory = options.stateDirectory
    this.#pollIntervalMs = options.pollIntervalMs ?? 500
    this.#onError = options.onError ?? ((): void => undefined)
  }

  public async execute(request: BuildExecutionRequest, signal: AbortSignal): Promise<WorkerResult> {
    const directory = join(this.#stateDirectory, 'jobs', request.job.id)
    const specFile = join(directory, 'worker.json')
    const resultFile = join(directory, 'result.json')
    const sessionId = `luban-server-build-${request.job.id}`
    try {
      const result = decodeWorkerResult(JSON.parse(await readFile(resultFile, 'utf8')) as unknown)
      await this.#release(sessionId, true)
      return result
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') {
        await this.#release(sessionId, true)
        throw error
      }
    }
    const spec: WorkerSpec = compileTemplate({
      template: request.template,
      params: request.job.params,
      jobId: request.job.id,
      artifactDirectory: request.artifactDirectory,
      resultFile,
      timeoutMs: request.timeoutMs,
      workspaceRoots: request.workspaceRoots,
    })
    await atomicJson(specFile, spec)
    await this.#keepalive.ensureAlive({
      ...(request.job.accountId === undefined ? {} : { accountId: request.job.accountId }),
      id: `server-build-${request.job.id}`,
      purpose: 'build',
      command: process.execPath,
      args: [fileURLToPath(new URL('./build-worker.js', import.meta.url)), '--spec', specFile],
    })

    const deadline = Date.now() + request.timeoutMs + 15_000
    while (Date.now() <= deadline) {
      if (signal.aborted) {
        throw new LubanError('E_UNAVAILABLE', 'build execution was cancelled', { retriable: true })
      }
      try {
        const result = decodeWorkerResult(JSON.parse(await readFile(resultFile, 'utf8')) as unknown)
        await this.#release(sessionId, true)
        return result
      } catch (error: unknown) {
        if (errorCode(error) !== 'ENOENT') {
          await this.#release(sessionId, true)
          throw error
        }
      }
      await wait(this.#pollIntervalMs, signal)
    }
    await this.#release(sessionId, true)
    throw new LubanError('E_TIMEOUT', `build ${request.job.id} did not report completion`, {
      retriable: true,
    })
  }

  async #release(sessionId: string, destroy: boolean): Promise<void> {
    try {
      await this.#keepalive.release?.(sessionId, { destroy })
    } catch (error: unknown) {
      this.#onError(error)
    }
  }
}
