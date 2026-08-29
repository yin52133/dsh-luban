#!/usr/bin/env node
import { copyFile, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { NodeProcessRunner } from './process-runner.js'
import { decodeWorkerResult, decodeWorkerSpec, type WorkerResult } from './worker-protocol.js'

interface CopyBudget {
  files: number
}

async function writeResult(filePath: string, result: WorkerResult): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(filePath), `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, 'utf8')
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

async function copyTree(source: string, target: string, budget: CopyBudget): Promise<void> {
  const metadata = await lstat(source)
  if (metadata.isSymbolicLink()) return
  if (metadata.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 })
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      await copyTree(join(source, entry.name), join(target, entry.name), budget)
    }
    return
  }
  if (!metadata.isFile()) return
  budget.files += 1
  if (budget.files > 20_000) throw new Error('artifact collection exceeds 20,000 files')
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await copyFile(source, target)
}

async function collectArtifacts(sources: readonly string[], directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const budget: CopyBudget = { files: 0 }
  const names = new Set<string>()
  for (const source of sources) {
    const name = basename(source)
    if (names.has(name)) throw new Error(`duplicate artifact root ${name}`)
    names.add(name)
    try {
      await copyTree(source, join(directory, name), budget)
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
        continue
      }
      throw error
    }
  }
}

export async function runWorker(specFile: string): Promise<WorkerResult> {
  const spec = decodeWorkerSpec(JSON.parse(await readFile(specFile, 'utf8')) as unknown)
  try {
    return decodeWorkerResult(JSON.parse(await readFile(spec.resultFile, 'utf8')) as unknown)
  } catch (error: unknown) {
    if (typeof error !== 'object' || error === null || Reflect.get(error, 'code') !== 'ENOENT') {
      throw error
    }
  }
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  let result: WorkerResult
  try {
    const executed = await new NodeProcessRunner().run(spec.command, spec.args, {
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
      signal: controller.signal,
      maxOutputBytes: 256 * 1024,
    })
    let exitCode = executed.exitCode
    let stderr = executed.stderr
    if (exitCode === 0) {
      try {
        await collectArtifacts(spec.collect, spec.artifactDirectory)
      } catch (error: unknown) {
        exitCode = 1
        const message = error instanceof Error ? error.message : 'artifact collection failed'
        stderr = `${stderr}\nArtifact collection: ${message}`.trim()
      }
    }
    result = { schemaVersion: 1, ...executed, exitCode, stderr }
  } catch (error: unknown) {
    result = {
      schemaVersion: 1,
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : 'build worker failed',
      durationMs: 0,
    }
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
  await writeResult(spec.resultFile, result)
  return result
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const index = argv.indexOf('--spec')
  const specFile = index < 0 ? undefined : argv[index + 1]
  if (specFile === undefined || specFile === '') {
    process.stderr.write('Usage: luban-build-worker --spec <absolute-path>\n')
    return 2
  }
  const result = await runWorker(specFile)
  return result.exitCode === 0 ? 0 : 1
}

const invoked = process.argv[1] === undefined ? '' : pathToFileURL(process.argv[1]).href
if (invoked === import.meta.url) {
  void main()
    .then((exitCode): void => {
      process.exitCode = exitCode
    })
    .catch((error: unknown): void => {
      process.stderr.write(`${error instanceof Error ? error.message : 'build worker failed'}\n`)
      process.exitCode = 1
    })
}
