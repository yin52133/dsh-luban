#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { uptime } from 'node:os'
import { basename, dirname, parse, resolve } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { parseArgs } from 'node:util'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OPERATOR_PATH = resolve(
  REPOSITORY_ROOT,
  'packages/dsh-luban-keepalive/dist/windows-operator-cli.js',
)
const DEFAULT_EVIDENCE = resolve(REPOSITORY_ROOT, '.luban/acceptance/m03-windows-keepalive.json')
const EVIDENCE_SCHEMA_VERSION = 2
const SCOPE = 'M03-F003/windows-boot-launcher'
const COVERED_FEATURES = Object.freeze(['M03-F002', 'M03-F003'])
const TASK_NAME = '\\dsh-luban-host'
const MAX_EVIDENCE_BYTES = 64 * 1024
const REBOOT_MARKER_TOLERANCE_MS = 5_000

const HELP = `M03 Windows keepalive staged acceptance

Usage:
  node scripts/acceptance/m03-windows-keepalive.mjs [plan]
  node scripts/acceptance/m03-windows-keepalive.mjs prepare --apply [--output FILE]
  node scripts/acceptance/m03-windows-keepalive.mjs verify [--output FILE]
  node scripts/acceptance/m03-windows-keepalive.mjs cleanup --apply [--output FILE]

prepare stops at a human reboot boundary. This runner never reboots or signs out Windows.
`

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCli(argv) {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      apply: { type: 'boolean' },
      output: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.positionals.length > 1) throw new Error('invalid stage')
  const stage = parsed.positionals[0] ?? 'plan'
  if (!['plan', 'prepare', 'verify', 'cleanup'].includes(stage)) {
    throw new Error('invalid stage')
  }
  const apply = parsed.values.apply === true
  if (apply && stage !== 'prepare' && stage !== 'cleanup') {
    throw new Error('--apply is limited to prepare or cleanup')
  }
  const output = resolve(parsed.values.output ?? DEFAULT_EVIDENCE)
  if (output.includes('\0') || output === parse(output).root || basename(output) === '') {
    throw new Error('invalid evidence path')
  }
  return { stage, apply, output, help: parsed.values.help === true }
}

function safeFailure(code, message) {
  return {
    exitCode: 1,
    output: JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message } }),
  }
}

function incompleteFeatureResults() {
  return {
    'M03-F002': {
      passed: false,
      reason: 'sign-out survival is outside this staged reboot runner',
    },
    'M03-F003': {
      passed: false,
      reason: 'boot launcher state does not prove ledger-owned session and checkpoint continuation',
    },
  }
}

function bootStartedAt(now, hostUptime) {
  const value = Math.round(now() - hostUptime() * 1_000)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid boot marker')
  return value
}

function sanitizedStatus(envelope) {
  if (!isRecord(envelope) || envelope.ok !== true || !isRecord(envelope.status)) {
    throw new Error('operator status failed')
  }
  const status = envelope.status
  if (
    !['missing', 'exact', 'conflict'].includes(status.state) ||
    (typeof status.running !== 'boolean' && status.running !== null) ||
    typeof status.user !== 'string' ||
    status.taskName !== TASK_NAME
  ) {
    throw new Error('operator returned invalid status')
  }
  return {
    taskName: TASK_NAME,
    user: status.user,
    state: status.state,
    running: status.running,
    trigger: 'boot',
    logon: 's4u',
  }
}

async function readEvidence(path) {
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_EVIDENCE_BYTES) {
    throw new Error('evidence file is unsafe')
  }
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (
    !isRecord(value) ||
    value.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    value.scope !== SCOPE ||
    JSON.stringify(value.coveredFeatures) !== JSON.stringify(COVERED_FEATURES) ||
    value.platform !== 'windows' ||
    !['operator-attested', 'simulated'].includes(value.evidenceKind) ||
    typeof value.runId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value.runId) ||
    !['prepared', 'verified', 'cleaned'].includes(value.stage) ||
    !Number.isSafeInteger(value.preparedAt) ||
    !Number.isSafeInteger(value.preparedBootStartedAt) ||
    typeof value.rebootObserved !== 'boolean' ||
    !['pending', 'pass'].includes(value.cleanup) ||
    value.acceptancePassed !== false ||
    !isRecord(value.featureResults) ||
    value.featureResults['M03-F002']?.passed !== false ||
    value.featureResults['M03-F003']?.passed !== false ||
    !isRecord(value.host) ||
    value.host.taskName !== TASK_NAME ||
    typeof value.host.user !== 'string' ||
    !['missing', 'exact'].includes(value.host.state) ||
    (typeof value.host.running !== 'boolean' && value.host.running !== null)
  ) {
    throw new Error('evidence file is invalid')
  }
  if (
    (value.stage === 'prepared' &&
      (value.rebootObserved || value.cleanup !== 'pending' || value.host.state !== 'exact')) ||
    (value.stage === 'verified' &&
      (!value.rebootObserved ||
        value.cleanup !== 'pending' ||
        !Number.isSafeInteger(value.verifiedAt) ||
        !Number.isSafeInteger(value.verifiedBootStartedAt) ||
        value.verifiedAt < value.preparedAt ||
        value.verifiedBootStartedAt <= value.preparedBootStartedAt ||
        value.host.state !== 'exact' ||
        value.host.running !== true)) ||
    (value.stage === 'cleaned' &&
      (value.cleanup !== 'pass' ||
        !Number.isSafeInteger(value.cleanedAt) ||
        value.cleanedAt < value.preparedAt ||
        value.host.state !== 'missing' ||
        value.host.running !== null))
  ) {
    throw new Error('evidence stage transition is invalid')
  }
  return value
}

async function readEvidenceIfPresent(path) {
  try {
    return await readEvidence(path)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null
    throw error
  }
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const existing = await readEvidenceIfPresent(path)
  if (existing !== null && existing.runId !== evidence.runId) {
    throw new Error('refusing to replace evidence from another run')
  }
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function boundedAppend(current, chunk) {
  const next = `${current}${chunk.toString('utf8')}`
  return next.length <= MAX_EVIDENCE_BYTES ? next : next.slice(-MAX_EVIDENCE_BYTES)
}

async function defaultExecuteOperator(command, apply) {
  const args = [OPERATOR_PATH, command, ...(apply ? ['--apply'] : [])]
  return await new Promise((resolveResult, reject) => {
    let stdout = ''
    let settled = false
    const child = spawn(process.execPath, args, {
      cwd: REPOSITORY_ROOT,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGTERM')
    }, 30_000)
    timer.unref()
    child.stdout.on('data', (chunk) => {
      stdout = boundedAppend(stdout, chunk)
    })
    child.once('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('unable to start the Windows host operator'))
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let envelope
      try {
        envelope = JSON.parse(stdout.trim())
      } catch {
        reject(new Error('Windows host operator returned invalid JSON'))
        return
      }
      if (exitCode !== 0 || !isRecord(envelope) || envelope.ok !== true) {
        reject(new Error('Windows host operator rejected the command'))
        return
      }
      resolveResult(envelope)
    })
  })
}

function planEnvelope(output) {
  return {
    exitCode: 0,
    output: JSON.stringify({
      schemaVersion: 1,
      ok: true,
      mode: 'plan',
      scope: SCOPE,
      coveredFeatures: COVERED_FEATURES,
      acceptancePassed: false,
      featureResults: incompleteFeatureResults(),
      acceptanceBoundary:
        'this runner observes only the Windows host boot launcher; sign-out and unfinished-session continuation require separate live evidence',
      evidencePath: output,
      stages: [
        { stage: 'prepare', mutation: 'install-host-task', requiresApply: true },
        { stage: 'human-reboot', mutation: 'external-human-action', automated: false },
        { stage: 'verify', mutation: 'none', readOnly: true },
        { stage: 'cleanup', mutation: 'uninstall-host-task', requiresApply: true },
      ],
      rebootOrSignOutCommandExecuted: false,
    }),
  }
}

/** Run one acceptance stage. Mutating stages require --apply and never cross the reboot boundary. */
export async function runM03WindowsKeepaliveAcceptance(argv, dependencies = {}) {
  let parsed
  try {
    parsed = parseCli(argv)
  } catch {
    return safeFailure('E_INVALID_INPUT', 'Invalid M03 Windows acceptance arguments')
  }
  if (parsed.help) return { exitCode: 0, output: HELP.trimEnd() }
  if (parsed.stage === 'plan' || (!parsed.apply && ['prepare', 'cleanup'].includes(parsed.stage))) {
    return planEnvelope(parsed.output)
  }

  const platform = dependencies.platform ?? process.platform
  if (platform !== 'win32') {
    return safeFailure('E_PLATFORM_UNSUPPORTED', 'M03 Windows acceptance is Windows-only')
  }
  const executeOperator = dependencies.executeOperator ?? defaultExecuteOperator
  const now = dependencies.now ?? Date.now
  const hostUptime = dependencies.uptime ?? uptime
  const evidenceKind =
    dependencies.executeOperator === undefined ? 'operator-attested' : 'simulated'

  try {
    if (parsed.stage === 'prepare') {
      const existing = await readEvidenceIfPresent(parsed.output)
      if (existing !== null) {
        if (existing.evidenceKind !== evidenceKind) {
          throw new Error('evidence execution kind does not match this runner')
        }
        return {
          exitCode: 0,
          output: JSON.stringify({
            schemaVersion: 1,
            ok: true,
            scope: SCOPE,
            acceptancePassed: false,
            stage: existing.stage,
            evidencePath: parsed.output,
            resumed: true,
            next:
              existing.stage === 'cleaned' ? 'complete' : 'restart-windows-manually-then-verify',
            rebootOrSignOutCommandExecuted: false,
          }),
        }
      }
      const before = sanitizedStatus(await executeOperator('status', false))
      if (before.state !== 'missing') throw new Error('host task already exists without evidence')
      let installed = false
      try {
        await executeOperator('install', true)
        installed = true
        const status = sanitizedStatus(await executeOperator('status', false))
        if (status.state !== 'exact') throw new Error('host task was not installed')
        const preparedAt = now()
        const evidence = {
          schemaVersion: EVIDENCE_SCHEMA_VERSION,
          scope: SCOPE,
          coveredFeatures: COVERED_FEATURES,
          platform: 'windows',
          evidenceKind,
          runId: randomUUID(),
          stage: 'prepared',
          preparedAt,
          preparedBootStartedAt: bootStartedAt(() => preparedAt, hostUptime),
          rebootObserved: false,
          cleanup: 'pending',
          host: status,
          acceptancePassed: false,
          featureResults: incompleteFeatureResults(),
        }
        await writeEvidence(parsed.output, evidence)
      } catch (error) {
        if (installed) {
          try {
            await executeOperator('uninstall', true)
          } catch {
            throw new Error('prepare failed and host task rollback did not complete')
          }
        }
        throw error
      }
      return {
        exitCode: 0,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: true,
          scope: SCOPE,
          acceptancePassed: false,
          stage: 'prepared',
          evidencePath: parsed.output,
          next: 'restart-windows-manually-then-verify',
          rebootOrSignOutCommandExecuted: false,
        }),
      }
    }

    const evidence = await readEvidence(parsed.output)
    if (evidence.evidenceKind !== evidenceKind) {
      throw new Error('evidence execution kind does not match this runner')
    }
    if (parsed.stage === 'verify') {
      if (evidence.stage === 'cleaned') throw new Error('acceptance run is already cleaned')
      const status = sanitizedStatus(await executeOperator('status', false))
      const verifiedAt = now()
      const verifiedBootStartedAt = bootStartedAt(() => verifiedAt, hostUptime)
      if (verifiedBootStartedAt <= evidence.preparedBootStartedAt + REBOOT_MARKER_TOLERANCE_MS) {
        throw new Error('manual reboot has not been observed')
      }
      if (status.state !== 'exact' || status.running !== true) {
        throw new Error('host task is not running after reboot')
      }
      const verified = {
        ...evidence,
        stage: 'verified',
        verifiedAt,
        verifiedBootStartedAt,
        rebootObserved: true,
        host: status,
      }
      await writeEvidence(parsed.output, verified)
      return {
        exitCode: 0,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: true,
          scope: SCOPE,
          acceptancePassed: false,
          stage: 'verified',
          evidencePath: parsed.output,
          next: 'cleanup --apply',
          rebootOrSignOutCommandExecuted: false,
        }),
      }
    }

    if (evidence.stage === 'cleaned') {
      return {
        exitCode: 0,
        output: JSON.stringify({
          schemaVersion: 1,
          ok: true,
          scope: SCOPE,
          acceptancePassed: false,
          stage: 'cleaned',
          evidencePath: parsed.output,
          resumed: true,
          rebootOrSignOutCommandExecuted: false,
        }),
      }
    }
    await executeOperator('uninstall', true)
    const status = sanitizedStatus(await executeOperator('status', false))
    if (status.state !== 'missing') throw new Error('host task remains after cleanup')
    await writeEvidence(parsed.output, {
      ...evidence,
      stage: 'cleaned',
      cleanedAt: now(),
      cleanup: 'pass',
      host: status,
    })
    return {
      exitCode: 0,
      output: JSON.stringify({
        schemaVersion: 1,
        ok: true,
        scope: SCOPE,
        acceptancePassed: false,
        stage: 'cleaned',
        evidencePath: parsed.output,
        rebootOrSignOutCommandExecuted: false,
      }),
    }
  } catch {
    return safeFailure('E_ACCEPTANCE_REQUIRED', 'M03 Windows acceptance stage did not pass')
  }
}

function isMain() {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isMain()) {
  const result = await runM03WindowsKeepaliveAcceptance(process.argv.slice(2))
  process.stdout.write(`${result.output}\n`)
  process.exitCode = result.exitCode
}
