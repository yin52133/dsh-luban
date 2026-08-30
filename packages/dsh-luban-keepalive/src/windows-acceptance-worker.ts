#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm, stat } from 'node:fs/promises'
import { uptime } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const SPEC_SCHEMA = 'dsh-luban/m03-windows-acceptance-spec/v1'
const HEARTBEAT_SCHEMA = 'dsh-luban/m03-windows-session-heartbeat/v1'
const MAX_SPEC_BYTES = 256 * 1024
async function readSpec(runDir: string, runId: string): Promise<Readonly<Record<string, unknown>>> {
  const path = join(runDir, 'acceptance-spec.json')
  const stats = await stat(path)
  if (!stats.isFile() || stats.size > MAX_SPEC_BYTES) throw new Error('acceptance spec is invalid')
  const bytes = await readFile(path)
  const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  if (
    value.schemaVersion !== SPEC_SCHEMA ||
    value.runId !== runId ||
    typeof value.sessionId !== 'string' ||
    typeof value.taskId !== 'string'
  ) {
    throw new Error('acceptance spec is invalid')
  }
  return value
}

async function writeHeartbeat(
  path: string,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, path)
  } catch (error: unknown) {
    await rm(temporary, { force: true })
    throw error
  }
}

export async function runWindowsAcceptanceWorker(argv: readonly string[]): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows acceptance worker is Windows-only')
  const parsed = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      'run-dir': { type: 'string' },
      'run-id': { type: 'string' },
      'spec-sha256': { type: 'string' },
    },
  })
  const runDirValue = parsed.values['run-dir']
  const runId = parsed.values['run-id']
  const specSha256 = parsed.values['spec-sha256']
  if (
    runDirValue === undefined ||
    !isAbsolute(runDirValue) ||
    resolve(runDirValue) === parse(resolve(runDirValue)).root ||
    runId === undefined ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(runId) ||
    specSha256 === undefined ||
    !/^[a-f0-9]{64}$/u.test(specSha256)
  ) {
    throw new Error('invalid Windows acceptance worker arguments')
  }
  const runDir = resolve(runDirValue)
  const directory = await stat(runDir)
  if (!directory.isDirectory()) throw new Error('acceptance run directory is invalid')
  const spec = await readSpec(runDir, runId)
  const startedAt = Date.now()
  const bootStartedAt = Math.round(startedAt - uptime() * 1_000)
  const heartbeatPath = join(runDir, 'session-heartbeat.json')
  let sequence = 0
  for (;;) {
    sequence += 1
    await writeHeartbeat(heartbeatPath, {
      schemaVersion: HEARTBEAT_SCHEMA,
      runId,
      specSha256,
      bootStartedAt,
      startedAt,
      sequence,
      observedAt: Date.now(),
      sessionId: spec.sessionId,
      taskId: spec.taskId,
    })
    await delay(2_000)
  }
}

function isMain(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isMain()) {
  try {
    await runWindowsAcceptanceWorker(process.argv.slice(2))
  } catch {
    process.exitCode = 1
  }
}
