#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCOPE = 'M03-F002+M03-F003/windows-signout-reboot-continuation'
const COVERED_FEATURES = Object.freeze(['M03-F002', 'M03-F003'])
const OWNER_SCHEMA = 'dsh-luban/m03-windows-owner/v1'
const SPEC_SCHEMA = 'dsh-luban/m03-windows-acceptance-spec/v1'
const EVENT_SCHEMA = 'dsh-luban/m03-windows-event/v1'
const HOST_HEARTBEAT_SCHEMA = 'dsh-luban/m03-windows-host-heartbeat/v1'
const SESSION_HEARTBEAT_SCHEMA = 'dsh-luban/m03-windows-session-heartbeat/v1'
const CLEANUP_REQUEST_SCHEMA = 'dsh-luban/m03-windows-cleanup-request/v1'
const CLEANUP_CONFIRMATION_SCHEMA = 'dsh-luban/m03-windows-cleanup-confirmation/v1'
const CHECKPOINT_SEED_ATTEMPT_SCHEMA = 'dsh-luban/m03-windows-checkpoint-seed-attempt/v1'
const CHECKPOINT_SEEDED_SCHEMA = 'dsh-luban/m03-windows-checkpoint-seeded/v1'
const HOST_TASK_NAME = '\\dsh-luban-host'
const MAX_JSON_BYTES = 256 * 1024
const MAX_COMMAND_BYTES = 4 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 60_000
const OBSERVATION_TIMEOUT_MS = 45_000
const HEARTBEAT_MAX_AGE_MS = 15_000
const BOOT_MARKER_TOLERANCE_MS = 15_000
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu
const SHA256 = /^[a-f0-9]{64}$/u
const COMMANDS = Object.freeze([
  'plan',
  'prepare',
  'verify-signout',
  'arm-reboot',
  'verify-reboot',
  'cleanup',
])
const STAGE_ORDER = Object.freeze([
  'prepare',
  'verify-signout',
  'arm-reboot',
  'verify-reboot',
  'cleanup',
])
const CONFIRMED_STATES = Object.freeze({
  prepare: 'prepared',
  'verify-signout': 'signout-verified',
  'arm-reboot': 'reboot-armed',
  'verify-reboot': 'reboot-verified',
  cleanup: 'cleaned',
})
const HELP = `M03 Windows staged keepalive acceptance

Usage:
  node scripts/acceptance/m03-windows-keepalive.mjs [plan]
  node scripts/acceptance/m03-windows-keepalive.mjs prepare --apply --run-dir ABSOLUTE_EXTERNAL_DIR
  node scripts/acceptance/m03-windows-keepalive.mjs verify-signout --run-dir DIR
  node scripts/acceptance/m03-windows-keepalive.mjs arm-reboot --run-dir DIR
  node scripts/acceptance/m03-windows-keepalive.mjs verify-reboot --run-dir DIR
  node scripts/acceptance/m03-windows-keepalive.mjs cleanup --apply --run-dir DIR

The runner never signs out or reboots Windows. prepare installs and starts only the exact bound host
task. Verification is based on mounted keepalive heartbeats and a restored checkpoint, never merely
on Scheduled Task "Running" state. Stage state is written atomically outside the repository.
Any injected adapter is simulation and can never set acceptancePassed=true.
`

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownDependency(dependencies, key) {
  return isRecord(dependencies) && Object.hasOwn(dependencies, key) ? dependencies[key] : undefined
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} has unexpected fields`)
}

function hasControl(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0)
    return code !== undefined && (code <= 0x1f || code === 0x7f)
  })
}

function text(value, label, maximum = 8_192) {
  if (typeof value !== 'string' || value === '' || value.length > maximum || hasControl(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid`)
  return value
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function safeFailure(code, message, exitCode = 1) {
  return {
    exitCode,
    output: JSON.stringify({ schemaVersion: 1, ok: false, error: { code, message } }),
  }
}

function externalPath(value, label) {
  if (typeof value !== 'string' || value === '' || hasControl(value) || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`)
  }
  const path = resolve(value)
  if (path === parse(path).root || basename(path) === '') {
    throw new Error(`${label} must not be a filesystem root`)
  }
  const within = relative(REPOSITORY_ROOT, path)
  if (within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))) {
    throw new Error(`${label} must be outside the repository`)
  }
  return path
}

function parseCli(argv) {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      apply: { type: 'boolean' },
      'run-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (parsed.positionals.length > 1) throw new Error('invalid command')
  const command = parsed.positionals[0] ?? 'plan'
  if (!COMMANDS.includes(command)) throw new Error('invalid command')
  const apply = parsed.values.apply === true
  if (apply && command !== 'prepare' && command !== 'cleanup') {
    throw new Error('--apply is limited to prepare and cleanup')
  }
  const runDir =
    parsed.values['run-dir'] === undefined
      ? undefined
      : externalPath(parsed.values['run-dir'], 'run directory')
  if (command !== 'plan' && runDir === undefined) throw new Error('--run-dir is required')
  return { command, apply, runDir, help: parsed.values.help === true }
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false
    throw error
  }
}

function samePath(left, right) {
  return resolve(left).toLocaleLowerCase('en-US') === resolve(right).toLocaleLowerCase('en-US')
}

async function assertRunDirectory(runDir, platform) {
  void platform
  const stats = await stat(runDir)
  if (!stats.isDirectory()) throw new Error('run directory is invalid')
}

async function readBoundedFile(path, maximum = MAX_JSON_BYTES) {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile() || before.size > maximum) {
    throw new Error('evidence file is unsafe')
  }
  const handle = await open(path, 'r')
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.size > maximum ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw new Error('evidence file changed during inspection')
    }
    const bytes = await handle.readFile()
    if (bytes.byteLength > maximum) throw new Error('evidence file is too large')
    const after = await lstat(path)
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error('evidence file changed during inspection')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function readJson(path, maximum = MAX_JSON_BYTES) {
  const bytes = await readBoundedFile(path, maximum)
  return { bytes, value: JSON.parse(bytes.toString('utf8')), sha256: digest(bytes) }
}

async function readJsonIfPresent(path, maximum = MAX_JSON_BYTES) {
  try {
    return await readJson(path, maximum)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null
    throw error
  }
}

async function writeJsonNew(path, value) {
  const bytes = canonicalJson(value)
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error('evidence is too large')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await rm(temporary)
  return digest(bytes)
}

async function execute(command, args, options = {}) {
  return await new Promise((resolveResult, reject) => {
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let truncated = false
    let settled = false
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const append = (current, chunk) => {
      const next = Buffer.concat([current, Buffer.from(chunk)])
      if (next.byteLength > MAX_COMMAND_BYTES) truncated = true
      return next.byteLength <= MAX_COMMAND_BYTES
        ? next
        : next.subarray(next.byteLength - MAX_COMMAND_BYTES)
    }
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGTERM')
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS)
    timer.unref()
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult({ exitCode: exitCode ?? 1, stdout, stderr, truncated })
    })
  })
}

async function executeChecked(command, args, options = {}) {
  const result = await execute(command, args, options)
  if (result.exitCode !== 0 || result.truncated) throw new Error('bound command failed')
  return result.stdout
}

async function ensureAcceptanceFile(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  if (await pathExists(path)) {
    const existing = await readBoundedFile(path)
    if (!existing.equals(Buffer.from(bytes))) throw new Error('acceptance profile changed')
    return
  }
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
}

async function ensureAcceptanceJunction(path, target) {
  if (await pathExists(path)) {
    if (!samePath(await realpath(path), target)) throw new Error('acceptance profile link changed')
    return
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await symlink(target, path, 'junction')
}

async function prepareWorkspaceRuntime(runDir) {
  const require = createRequire(import.meta.url)
  const packageRoot = (name) => dirname(require.resolve(`${name}/package.json`))
  const keepaliveRoot = join(REPOSITORY_ROOT, 'packages', 'dsh-luban-keepalive')
  const keepaliveDist = join(keepaliveRoot, 'dist')
  const dshRoot = packageRoot('@deepseek-ai/dsh')
  const dshEntryPath = join(dshRoot, 'lib', 'bin.js')
  const operatorPath = join(keepaliveDist, 'windows-operator-cli.js')
  const bootstrapPath = join(keepaliveDist, 'windows-host-bootstrap.js')
  const workerPath = join(keepaliveDist, 'windows-acceptance-worker.js')
  await Promise.all(
    [dshEntryPath, operatorPath, bootstrapPath, workerPath].map(async (path) => await access(path)),
  )

  const dshHome = join(runDir, 'dsh-home')
  const profileRoot = join(dshHome, 'profiles', 'win-debug')
  const packageValue = {
    name: 'dsh-profile-win-debug',
    version: '0.1.0',
    private: true,
    dependencies: { 'dsh-luban-keepalive': '0.1.0' },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-luban-keepalive'],
      },
    },
  }
  const patchValue = `- insert:\n    - id: luban-keepalive\n      name: dsh-luban-keepalive\n      config:\n        strategy: service\n        patrolIntervalSec: 60\n        ledgerFile: ${JSON.stringify(join(runDir, 'keepalive-ledger.json'))}\n        bootRestore: true\n        alertToTaskboard: false\n`
  await ensureAcceptanceFile(join(profileRoot, 'package.json'), canonicalJson(packageValue))
  await ensureAcceptanceFile(join(profileRoot, 'cordis.patch.yml'), patchValue)
  await ensureAcceptanceJunction(
    join(profileRoot, 'node_modules', 'dsh-luban-keepalive'),
    keepaliveRoot,
  )
  return {
    nodePath: process.execPath,
    dshEntryPath,
    dshHome,
    operatorPath,
    bootstrapPath,
    workerPath,
  }
}

function createProductionRuntimeAdapter(environment) {
  return {
    async prepareRunDirectory(runDir) {
      await assertRunDirectory(runDir, 'win32')
      const stdout = await executeChecked('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
        env: environment,
      })
      const match = /,"(S-1-(?:\d+-)+\d+)"\s*$/iu.exec(stdout.toString('utf8').trim())
      if (match?.[1] === undefined) throw new Error('current Windows SID is unavailable')
      return match[1].toUpperCase()
    },
    async validateRunDirectory(runDir) {
      await assertRunDirectory(runDir, 'win32')
    },
    async prepare(runDir) {
      return await prepareWorkspaceRuntime(runDir)
    },
    async verify(runDir, _owner, _ownerSha256, expected) {
      const actual = await prepareWorkspaceRuntime(runDir)
      if (!isDeepStrictEqual(actual, expected)) throw new Error('runtime configuration changed')
      return actual
    },
  }
}

function expectedLaunch(runDir, spec, specSha256) {
  return {
    nodeExecutable: spec.runtime.nodePath,
    bootstrapPath: spec.runtime.bootstrapPath,
    dshEntry: spec.runtime.dshEntryPath,
    dshHome: spec.runtime.dshHome,
    profile: 'win-debug',
    acceptance: { runDir, runId: spec.runId, specSha256 },
  }
}

function validateHostTaskStatus(value, runDir, spec, specSha256) {
  if (!isRecord(value)) throw new Error('Windows host status is invalid')
  if (
    value.taskName !== HOST_TASK_NAME ||
    !['missing', 'exact', 'conflict'].includes(value.state) ||
    ![true, false, null].includes(value.running) ||
    value.trigger !== 'boot' ||
    value.logon !== 's4u' ||
    value.runLevel !== 'limited' ||
    value.operationallyVerified !== false ||
    !isRecord(value.environment) ||
    value.environment.LUBAN_BOOT_RESTORE !== '1' ||
    !isDeepStrictEqual(value.launch, expectedLaunch(runDir, spec, specSha256))
  ) {
    throw new Error('Windows host task is not exactly bound to this run')
  }
  return {
    taskName: value.taskName,
    user: text(value.user, 'Windows host user'),
    state: value.state,
    running: value.running,
    trigger: value.trigger,
    logon: value.logon,
    runLevel: value.runLevel,
    launch: value.launch,
    environment: { LUBAN_BOOT_RESTORE: '1' },
    elevated: value.elevated === true,
    operationallyVerified: false,
  }
}

function validateTaskStatus(value, runDir, spec, specSha256) {
  exactKeys(value, ['host', 'child'], 'Windows acceptance task status')
  const host = validateHostTaskStatus(value.host, runDir, spec, specSha256)
  const child = value.child
  exactKeys(child, ['taskName', 'state', 'running'], 'Windows acceptance child status')
  if (
    child.taskName !== `\\dsh-luban-session-${spec.sessionId}` ||
    !['missing', 'exact', 'conflict'].includes(child.state) ||
    ![true, false, null].includes(child.running) ||
    (child.state !== 'exact' && child.running !== null)
  ) {
    throw new Error('Windows child task is not exactly bound to this run')
  }
  return {
    host,
    child: { taskName: child.taskName, state: child.state, running: child.running },
  }
}

async function executeOperator(command, apply, context, environment) {
  const runtime = context.spec.runtime
  const args = [
    runtime.operatorPath,
    command,
    '--node',
    runtime.nodePath,
    '--bootstrap',
    runtime.bootstrapPath,
    '--dsh-entry',
    runtime.dshEntryPath,
    '--dsh-home',
    runtime.dshHome,
    '--profile',
    'win-debug',
    '--acceptance-run-dir',
    context.runDir,
    '--acceptance-run-id',
    context.spec.runId,
    '--acceptance-spec-sha256',
    context.specSha256,
    ...(command === 'acceptance-status'
      ? ['--session-id', context.spec.sessionId, '--worker', context.spec.workerPath]
      : []),
    ...(apply ? ['--apply'] : []),
  ]
  const result = await execute(runtime.nodePath, args, {
    cwd: context.runDir,
    env: {
      ...environment,
      TEMP: context.runDir,
      TMP: context.runDir,
    },
    timeoutMs: 30_000,
  })
  let envelope
  try {
    envelope = JSON.parse(result.stdout.toString('utf8').trim())
  } catch {
    throw new Error('Windows host operator returned invalid JSON')
  }
  if (result.exitCode !== 0 || !isRecord(envelope) || envelope.ok !== true) {
    throw new Error('Windows host operator rejected the command')
  }
  return envelope
}

async function readLiveObservation(context, environment) {
  void environment
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MS
  let lastError
  while (Date.now() <= deadline) {
    try {
      const [host, session, seedAttempt, seedConfirmation] = await Promise.all([
        readJson(join(context.runDir, 'host-heartbeat.json')),
        readJson(join(context.runDir, 'session-heartbeat.json')),
        readJson(join(context.runDir, 'checkpoint-seed-attempt.json')),
        readJson(join(context.runDir, 'checkpoint-seeded.json')),
      ])
      return {
        capturedAt: Date.now(),
        systemBootStartedAt: host.value.bootStartedAt,
        host: host.value,
        session: session.value,
        checkpointSeed: {
          attempt: seedAttempt.value,
          attemptSha256: seedAttempt.sha256,
          confirmation: seedConfirmation.value,
          markerSha256: seedConfirmation.sha256,
        },
      }
    } catch (error) {
      lastError = error
      await delay(1_000)
    }
  }
  throw lastError ?? new Error('mounted keepalive heartbeat was not observed')
}

async function waitCleanupConfirmation(context) {
  const deadline = Date.now() + OBSERVATION_TIMEOUT_MS
  let lastError
  while (Date.now() <= deadline) {
    try {
      return (await readJson(join(context.runDir, 'cleanup-confirmed.json'))).value
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') lastError = error
      await delay(1_000)
    }
  }
  throw lastError ?? new Error('mounted keepalive cleanup was not confirmed')
}

function createProductionOperatorAdapter(environment) {
  return {
    async status(context) {
      const envelope = await executeOperator('acceptance-status', false, context, environment)
      return envelope.status
    },
    async install(context) {
      await executeOperator('install', true, context, environment)
    },
    async start(context) {
      await executeOperator('start', true, context, environment)
    },
    async observe(context) {
      return await readLiveObservation(context, environment)
    },
    async cleanupConfirmation(context, wait) {
      if (wait) return await waitCleanupConfirmation(context)
      return (
        (await readJsonIfPresent(join(context.runDir, 'cleanup-confirmed.json')))?.value ?? null
      )
    },
    async uninstall(context) {
      await executeOperator('uninstall', true, context, environment)
    },
  }
}

function validateRuntimeConfiguration(value) {
  if (!isRecord(value)) throw new Error('runtime configuration is invalid')
  for (const key of ['nodePath', 'dshEntryPath', 'operatorPath', 'bootstrapPath', 'workerPath']) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key])) {
      throw new Error('runtime configuration path is invalid')
    }
  }
  if (!isAbsolute(value.dshHome)) throw new Error('runtime DSH home is invalid')
  return value
}

function validateOwner(value) {
  exactKeys(
    value,
    [
      'schemaVersion',
      'scope',
      'runId',
      'ownerNonce',
      'taskName',
      'principalSid',
      'evidenceKind',
      'createdAt',
    ],
    'owner marker',
  )
  if (
    value.schemaVersion !== OWNER_SCHEMA ||
    value.scope !== SCOPE ||
    !UUID.test(value.runId) ||
    !UUID.test(value.ownerNonce) ||
    value.taskName !== HOST_TASK_NAME ||
    typeof value.principalSid !== 'string' ||
    !/^S-1-(?:\d+-)+\d+$/iu.test(value.principalSid) ||
    !['production', 'simulated'].includes(value.evidenceKind)
  ) {
    throw new Error('owner marker is invalid')
  }
  positiveInteger(value.createdAt, 'owner creation time')
  return value
}

function validateCheckpoint(value, taskId) {
  exactKeys(value, ['taskId', 'stepList', 'currentStep', 'artifacts', 'savedAt'], 'checkpoint')
  if (
    value.taskId !== taskId ||
    !Array.isArray(value.stepList) ||
    !isDeepStrictEqual(value.stepList, STAGE_ORDER) ||
    value.currentStep !== 1 ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length !== 1 ||
    typeof value.artifacts[0] !== 'string'
  ) {
    throw new Error('checkpoint is invalid')
  }
  positiveInteger(value.savedAt, 'checkpoint saved time')
  return value
}

function validateSpec(value, owner, ownerSha256) {
  exactKeys(
    value,
    [
      'schemaVersion',
      'scope',
      'coveredFeatures',
      'runId',
      'ownerSha256',
      'sessionId',
      'taskId',
      'evidenceKind',
      'nodePath',
      'workerPath',
      'checkpoint',
      'runtime',
      'createdAt',
    ],
    'acceptance spec',
  )
  if (
    value.schemaVersion !== SPEC_SCHEMA ||
    value.scope !== SCOPE ||
    !isDeepStrictEqual(value.coveredFeatures, COVERED_FEATURES) ||
    value.runId !== owner.runId ||
    value.ownerSha256 !== ownerSha256 ||
    value.sessionId !== `luban-m03-${owner.runId}` ||
    value.taskId !== `m03-windows-${owner.runId}` ||
    value.evidenceKind !== owner.evidenceKind
  ) {
    throw new Error('acceptance spec binding is invalid')
  }
  const runtime = validateRuntimeConfiguration(value.runtime)
  if (value.nodePath !== runtime.nodePath || value.workerPath !== runtime.workerPath) {
    throw new Error('acceptance spec runtime binding is invalid')
  }
  validateCheckpoint(value.checkpoint, value.taskId)
  if (value.checkpoint.artifacts[0] !== `owner:${ownerSha256}`) {
    throw new Error('checkpoint owner binding is invalid')
  }
  positiveInteger(value.createdAt, 'acceptance spec creation time')
  return value
}

async function loadOwner(runDir) {
  const record = await readJson(join(runDir, 'owner.json'))
  return { owner: validateOwner(record.value), ownerSha256: record.sha256 }
}

function eventFileName(event) {
  return `${String(event.sequence).padStart(6, '0')}-${event.command}-${event.kind}.json`
}

function validateEvent(value, previousSha256, run) {
  exactKeys(
    value,
    [
      'schemaVersion',
      'runId',
      'ownerSha256',
      'specSha256',
      'sequence',
      'kind',
      'command',
      'previousSha256',
      'createdAt',
      'payload',
    ],
    'acceptance event',
  )
  if (
    value.schemaVersion !== EVENT_SCHEMA ||
    value.runId !== run.owner.runId ||
    value.ownerSha256 !== run.ownerSha256 ||
    value.specSha256 !== run.specSha256 ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence <= 0 ||
    !['attempt', 'confirmed'].includes(value.kind) ||
    !STAGE_ORDER.includes(value.command) ||
    value.previousSha256 !== previousSha256 ||
    !isRecord(value.payload)
  ) {
    throw new Error('acceptance event binding is invalid')
  }
  positiveInteger(value.createdAt, 'acceptance event time')
  validateEventPayload(value, run)
  return value
}

function validateEventPayload(event, run) {
  if (event.kind === 'attempt') {
    if (event.command === 'prepare') {
      exactKeys(event.payload, ['taskState'], 'prepare attempt')
      if (event.payload.taskState !== 'missing') throw new Error('prepare attempt is invalid')
      return
    }
    exactKeys(event.payload, ['priorState'], 'stage attempt')
    const index = STAGE_ORDER.indexOf(event.command)
    if (index <= 0 || event.payload.priorState !== CONFIRMED_STATES[STAGE_ORDER[index - 1]]) {
      throw new Error('stage attempt prior state is invalid')
    }
    return
  }
  if (event.command === 'cleanup') {
    exactKeys(event.payload, ['confirmation', 'taskState'], 'cleanup confirmation event')
    if (event.payload.taskState !== 'missing') throw new Error('cleanup task state is invalid')
    validateCleanupConfirmation(event.payload.confirmation, run)
    return
  }
  exactKeys(event.payload, ['status', 'observation'], 'stage confirmation event')
  validateTaskStatus(event.payload.status, run.runDir, run.spec, run.specSha256)
  validateObservation(event.payload.observation, run)
}

async function loadEventChain(run) {
  const directory = join(run.runDir, 'events')
  if (!(await pathExists(directory)))
    return { events: [], latestSha256: null, state: null, pending: null }
  const stats = await lstat(directory)
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('event directory is unsafe')
  const names = (await readdir(directory)).filter((name) => !name.startsWith('.')).sort()
  const events = []
  let previousSha256 = null
  let state = null
  let pending = null
  for (const [index, name] of names.entries()) {
    const record = await readJson(join(directory, name))
    const event = validateEvent(record.value, previousSha256, run)
    if (event.sequence !== index + 1 || name !== eventFileName(event)) {
      throw new Error('acceptance event sequence is invalid')
    }
    const expectedIndex =
      state === null
        ? 0
        : STAGE_ORDER.indexOf(STAGE_ORDER.find((stage) => CONFIRMED_STATES[stage] === state)) + 1
    if (event.kind === 'attempt') {
      if (pending !== null || event.command !== STAGE_ORDER[expectedIndex]) {
        throw new Error('acceptance event transition is invalid')
      }
      pending = event.command
    } else {
      if (pending !== event.command)
        throw new Error('acceptance confirmation has no matching attempt')
      state = CONFIRMED_STATES[event.command]
      pending = null
    }
    events.push({ value: event, sha256: record.sha256 })
    previousSha256 = record.sha256
  }
  return { events, latestSha256: previousSha256, state, pending }
}

function confirmedEvent(chain, command) {
  return chain.events.findLast(
    (entry) => entry.value.kind === 'confirmed' && entry.value.command === command,
  )?.value
}

async function appendEvent(run, chain, kind, command, payload, now) {
  const event = {
    schemaVersion: EVENT_SCHEMA,
    runId: run.owner.runId,
    ownerSha256: run.ownerSha256,
    specSha256: run.specSha256,
    sequence: chain.events.length + 1,
    kind,
    command,
    previousSha256: chain.latestSha256,
    createdAt: now(),
    payload,
  }
  const path = join(run.runDir, 'events', eventFileName(event))
  await writeJsonNew(path, event)
  return await loadEventChain(run)
}

function sameCheckpoint(left, right) {
  return isDeepStrictEqual(left, right)
}

function validateHostHeartbeat(value, run, capturedAt, systemBootStartedAt) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== HOST_HEARTBEAT_SCHEMA ||
    value.runId !== run.owner.runId ||
    value.specSha256 !== run.specSha256
  ) {
    throw new Error('host heartbeat binding is invalid')
  }
  for (const key of ['bootStartedAt', 'startedAt', 'sequence', 'observedAt']) {
    positiveInteger(value[key], `host heartbeat ${key}`)
  }
  if (
    Math.abs(value.bootStartedAt - systemBootStartedAt) > BOOT_MARKER_TOLERANCE_MS ||
    value.observedAt > capturedAt + 2_000 ||
    capturedAt - value.observedAt > HEARTBEAT_MAX_AGE_MS ||
    value.startedAt > value.observedAt
  ) {
    throw new Error('host heartbeat is stale or from another boot')
  }
  if (
    !isRecord(value.managed) ||
    value.managed.sessionId !== run.spec.sessionId ||
    value.managed.ownerTaskId !== run.spec.taskId ||
    value.managed.kind !== 'service' ||
    !sameCheckpoint(value.managed.checkpoint, run.spec.checkpoint)
  ) {
    throw new Error('mounted keepalive state is invalid')
  }
  return value
}

function validateCheckpointSeed(value, run) {
  if (
    !isRecord(value) ||
    !SHA256.test(value.attemptSha256) ||
    !SHA256.test(value.markerSha256) ||
    !isRecord(value.attempt) ||
    !isRecord(value.confirmation)
  ) {
    throw new Error('checkpoint seed evidence digest is invalid')
  }
  if (
    value.attempt.schemaVersion !== CHECKPOINT_SEED_ATTEMPT_SCHEMA ||
    value.attempt.runId !== run.owner.runId ||
    value.attempt.specSha256 !== run.specSha256 ||
    value.attempt.sessionId !== run.spec.sessionId ||
    value.attempt.taskId !== run.spec.taskId ||
    value.attempt.checkpointSha256 !== digest(JSON.stringify(run.spec.checkpoint))
  ) {
    throw new Error('checkpoint seed attempt binding is invalid')
  }
  positiveInteger(value.attempt.bootStartedAt, 'checkpoint seed boot time')
  positiveInteger(value.attempt.attemptedAt, 'checkpoint seed attempt time')
  if (
    value.confirmation.schemaVersion !== CHECKPOINT_SEEDED_SCHEMA ||
    value.confirmation.runId !== run.owner.runId ||
    value.confirmation.specSha256 !== run.specSha256 ||
    value.confirmation.sessionId !== run.spec.sessionId ||
    value.confirmation.taskId !== run.spec.taskId ||
    value.confirmation.checkpointSha256 !== digest(JSON.stringify(run.spec.checkpoint)) ||
    value.confirmation.attemptSha256 !== value.attemptSha256
  ) {
    throw new Error('checkpoint seed confirmation binding is invalid')
  }
  positiveInteger(value.confirmation.seededAt, 'checkpoint seed confirmation time')
  if (
    digest(canonicalJson(value.attempt)) !== value.attemptSha256 ||
    digest(canonicalJson(value.confirmation)) !== value.markerSha256
  ) {
    throw new Error('checkpoint seed create-once evidence changed')
  }
  return {
    attemptSha256: value.attemptSha256,
    markerSha256: value.markerSha256,
    bootStartedAt: value.attempt.bootStartedAt,
  }
}

function validateSessionHeartbeat(value, run, capturedAt, systemBootStartedAt) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SESSION_HEARTBEAT_SCHEMA ||
    value.runId !== run.owner.runId ||
    value.specSha256 !== run.specSha256 ||
    (value.sessionId !== undefined && value.sessionId !== run.spec.sessionId) ||
    (value.taskId !== undefined && value.taskId !== run.spec.taskId)
  ) {
    throw new Error('session heartbeat binding is invalid')
  }
  for (const key of ['bootStartedAt', 'startedAt', 'sequence', 'observedAt']) {
    positiveInteger(value[key], `session heartbeat ${key}`)
  }
  if (
    Math.abs(value.bootStartedAt - systemBootStartedAt) > BOOT_MARKER_TOLERANCE_MS ||
    value.observedAt > capturedAt + 2_000 ||
    capturedAt - value.observedAt > HEARTBEAT_MAX_AGE_MS ||
    value.startedAt > value.observedAt
  ) {
    throw new Error('session heartbeat is stale or from another boot')
  }
  return value
}

function validateObservation(value, run) {
  if (!isRecord(value)) throw new Error('Windows observation is invalid')
  positiveInteger(value.capturedAt, 'observation capture time')
  positiveInteger(value.systemBootStartedAt, 'system boot time')
  const checkpointSeed = validateCheckpointSeed(value.checkpointSeed, run)
  validateHostHeartbeat(value.host, run, value.capturedAt, value.systemBootStartedAt)
  validateSessionHeartbeat(value.session, run, value.capturedAt, value.systemBootStartedAt)
  if (Math.abs(value.host.bootStartedAt - value.session.bootStartedAt) > BOOT_MARKER_TOLERANCE_MS) {
    throw new Error('host and session heartbeat boots disagree')
  }
  if (!isDeepStrictEqual(value.host.managed.checkpointSeed, checkpointSeed)) {
    throw new Error('mounted checkpoint seed heartbeat binding is invalid')
  }
  return value
}

function sameBoot(left, right) {
  return Math.abs(left.systemBootStartedAt - right.systemBootStartedAt) <= BOOT_MARKER_TOLERANCE_MS
}

function assertSignoutContinuation(before, after) {
  if (!sameBoot(before, after)) throw new Error('sign-out verification crossed a reboot boundary')
  if (
    after.host.sequence <= before.host.sequence ||
    after.session.sequence <= before.session.sequence
  ) {
    throw new Error('heartbeats did not advance across sign-out')
  }
  if (!isDeepStrictEqual(after.checkpointSeed, before.checkpointSeed)) {
    throw new Error('checkpoint seed evidence changed across sign-out')
  }
}

function assertSameBootContinuation(before, after) {
  if (
    !sameBoot(before, after) ||
    after.host.sequence <= before.host.sequence ||
    after.session.sequence <= before.session.sequence
  ) {
    throw new Error('pre-reboot keepalive continuity changed')
  }
  if (!isDeepStrictEqual(after.checkpointSeed, before.checkpointSeed)) {
    throw new Error('checkpoint seed evidence changed before reboot')
  }
}

function assertRebootRestore(before, after) {
  if (sameBoot(before, after) || after.systemBootStartedAt <= before.systemBootStartedAt) {
    throw new Error('a new Windows boot was not observed')
  }
  if (!isDeepStrictEqual(after.checkpointSeed, before.checkpointSeed)) {
    throw new Error('checkpoint was re-seeded instead of restored after reboot')
  }
}

function validateCleanupConfirmation(value, run) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== CLEANUP_CONFIRMATION_SCHEMA ||
    value.runId !== run.owner.runId ||
    value.specSha256 !== run.specSha256 ||
    value.sessionId !== run.spec.sessionId ||
    value.taskId !== run.spec.taskId
  ) {
    throw new Error('cleanup confirmation is invalid')
  }
  positiveInteger(value.confirmedAt, 'cleanup confirmation time')
  return value
}

async function publishCleanupRequest(run, now) {
  const path = join(run.runDir, 'cleanup-request.json')
  const value = {
    schemaVersion: CLEANUP_REQUEST_SCHEMA,
    runId: run.owner.runId,
    specSha256: run.specSha256,
    requestedAt: now(),
  }
  const existing = await readJsonIfPresent(path)
  if (existing !== null) {
    exactKeys(
      existing.value,
      ['schemaVersion', 'runId', 'specSha256', 'requestedAt'],
      'cleanup request',
    )
    if (
      existing.value.schemaVersion !== CLEANUP_REQUEST_SCHEMA ||
      existing.value.runId !== run.owner.runId ||
      existing.value.specSha256 !== run.specSha256
    ) {
      throw new Error('cleanup request binding changed')
    }
    positiveInteger(existing.value.requestedAt, 'cleanup request time')
    return existing.value
  }
  await writeJsonNew(path, value)
  return value
}

function planResult() {
  return {
    exitCode: 0,
    output: JSON.stringify({
      schemaVersion: 1,
      ok: true,
      mode: 'plan',
      scope: SCOPE,
      coveredFeatures: COVERED_FEATURES,
      acceptancePassed: false,
      evidenceKind: 'none',
      stages: [
        { stage: 'prepare', requiresApply: true, mutation: 'exact owned host-task install/start' },
        { stage: 'verify-signout', readOnlySystem: true, externalAction: 'human sign-out/sign-in' },
        { stage: 'arm-reboot', readOnlySystem: true, externalAction: 'none' },
        { stage: 'verify-reboot', readOnlySystem: true, externalAction: 'human reboot' },
        {
          stage: 'cleanup',
          requiresApply: true,
          mutation: 'mounted session release + exact task uninstall',
        },
      ],
      signoutOrRebootCommandExecuted: false,
    }),
  }
}

function stageResult(command, state, run, resumed = false) {
  const evidenceKind = run.owner.evidenceKind
  const complete = state === 'cleaned' && evidenceKind === 'production'
  const next = {
    prepared: 'sign out and sign in manually, then run verify-signout',
    'signout-verified': 'run arm-reboot',
    'reboot-armed': 'reboot Windows manually, then run verify-reboot',
    'reboot-verified': 'run cleanup --apply',
    cleaned: 'complete',
  }[state]
  return {
    exitCode: 0,
    output: JSON.stringify({
      schemaVersion: 1,
      ok: true,
      scope: SCOPE,
      coveredFeatures: COVERED_FEATURES,
      command,
      stage: state,
      evidenceKind,
      acceptancePassed: complete,
      featureResults: Object.fromEntries(
        COVERED_FEATURES.map((feature) => [feature, { passed: complete }]),
      ),
      runDir: run.runDir,
      next,
      resumed,
      signoutOrRebootCommandExecuted: false,
    }),
  }
}

async function createOrLoadRun(parsed, adapters, now, nextUuid, platform, evidenceKind) {
  const runDir = parsed.runDir
  const exists = await pathExists(runDir)
  if (!exists) {
    if (parsed.command !== 'prepare') throw new Error('acceptance run does not exist')
    await mkdir(runDir, { recursive: false, mode: 0o700 })
    await assertRunDirectory(runDir, platform)
    const principalSid = await adapters.runtime.prepareRunDirectory(runDir)
    const owner = {
      schemaVersion: OWNER_SCHEMA,
      scope: SCOPE,
      runId: nextUuid(),
      ownerNonce: nextUuid(),
      taskName: HOST_TASK_NAME,
      principalSid,
      evidenceKind,
      createdAt: now(),
    }
    const ownerSha256 = await writeJsonNew(join(runDir, 'owner.json'), owner)
    return { runDir, owner: validateOwner(owner), ownerSha256, fresh: true }
  }
  await assertRunDirectory(runDir, platform)
  const loaded = await loadOwner(runDir)
  if (loaded.owner.evidenceKind !== evidenceKind) {
    throw new Error('acceptance evidence kind cannot change')
  }
  await adapters.runtime.validateRunDirectory(runDir, loaded.owner.principalSid)
  return { runDir, ...loaded, fresh: false }
}

async function completeRunConfiguration(base, adapters, now) {
  const existing = await readJsonIfPresent(join(base.runDir, 'acceptance-spec.json'))
  if (existing !== null) {
    const spec = validateSpec(existing.value, base.owner, base.ownerSha256)
    await adapters.runtime.verify(base.runDir, base.owner, base.ownerSha256, spec.runtime)
    return { ...base, spec, specSha256: existing.sha256 }
  }
  const runtime = validateRuntimeConfiguration(
    await adapters.runtime.prepare(base.runDir, base.owner, base.ownerSha256),
  )
  const spec = {
    schemaVersion: SPEC_SCHEMA,
    scope: SCOPE,
    coveredFeatures: COVERED_FEATURES,
    runId: base.owner.runId,
    ownerSha256: base.ownerSha256,
    sessionId: `luban-m03-${base.owner.runId}`,
    taskId: `m03-windows-${base.owner.runId}`,
    evidenceKind: base.owner.evidenceKind,
    nodePath: runtime.nodePath,
    workerPath: runtime.workerPath,
    checkpoint: {
      taskId: `m03-windows-${base.owner.runId}`,
      stepList: STAGE_ORDER,
      currentStep: 1,
      artifacts: [`owner:${base.ownerSha256}`],
      savedAt: now(),
    },
    runtime,
    createdAt: now(),
  }
  const specSha256 = await writeJsonNew(join(base.runDir, 'acceptance-spec.json'), spec)
  return { ...base, spec: validateSpec(spec, base.owner, base.ownerSha256), specSha256 }
}

function adaptersFor(dependencies) {
  const environment = ownDependency(dependencies, 'environment') ?? process.env
  return {
    runtime: ownDependency(dependencies, 'runtime') ?? createProductionRuntimeAdapter(environment),
    operator:
      ownDependency(dependencies, 'operator') ?? createProductionOperatorAdapter(environment),
  }
}

async function runPrepare(run, chain, adapters, now) {
  if (chain.state !== null && chain.state !== 'prepared') {
    return stageResult('prepare', chain.state, run, true)
  }
  if (chain.state === 'prepared' && chain.pending === null) {
    return stageResult('prepare', 'prepared', run, true)
  }
  const context = run
  if (chain.pending === null) {
    const before = validateTaskStatus(
      await adapters.operator.status(context),
      run.runDir,
      run.spec,
      run.specSha256,
    )
    if (before.host.state !== 'missing' || before.child.state !== 'missing') {
      throw new Error('foreign or pre-existing task blocks prepare')
    }
    chain = await appendEvent(run, chain, 'attempt', 'prepare', { taskState: 'missing' }, now)
  } else if (chain.pending !== 'prepare') {
    throw new Error('another acceptance stage is incomplete')
  }
  let status = validateTaskStatus(
    await adapters.operator.status(context),
    run.runDir,
    run.spec,
    run.specSha256,
  )
  if (status.host.state === 'missing') {
    await adapters.operator.install(context)
    status = validateTaskStatus(
      await adapters.operator.status(context),
      run.runDir,
      run.spec,
      run.specSha256,
    )
  }
  if (status.host.state !== 'exact' || status.child.state === 'conflict') {
    throw new Error('owned Windows host task was not installed exactly')
  }
  await adapters.operator.start(context)
  const observation = validateObservation(await adapters.operator.observe(context), run)
  status = validateTaskStatus(
    await adapters.operator.status(context),
    run.runDir,
    run.spec,
    run.specSha256,
  )
  if (
    status.host.state !== 'exact' ||
    status.host.running !== true ||
    status.child.state !== 'exact' ||
    status.child.running !== true
  ) {
    throw new Error('mounted Windows tasks are not both exact and running')
  }
  chain = await appendEvent(run, chain, 'confirmed', 'prepare', { status, observation }, now)
  return stageResult('prepare', chain.state, run)
}

async function runVerification(command, run, chain, adapters, now) {
  const targetState = CONFIRMED_STATES[command]
  if (chain.state === targetState && chain.pending === null) {
    return stageResult(command, targetState, run, true)
  }
  const targetIndex = STAGE_ORDER.indexOf(command)
  const priorCommand = STAGE_ORDER[targetIndex - 1]
  const priorState = CONFIRMED_STATES[priorCommand]
  if (chain.state !== priorState || (chain.pending !== null && chain.pending !== command)) {
    throw new Error('acceptance stage is out of order')
  }
  if (chain.pending === null) {
    chain = await appendEvent(run, chain, 'attempt', command, { priorState }, now)
  }
  const status = validateTaskStatus(
    await adapters.operator.status(run),
    run.runDir,
    run.spec,
    run.specSha256,
  )
  if (
    status.host.state !== 'exact' ||
    status.host.running !== true ||
    status.child.state !== 'exact' ||
    status.child.running !== true
  ) {
    throw new Error('mounted Windows tasks are not both exact and running')
  }
  const observation = validateObservation(await adapters.operator.observe(run), run)
  const prior = confirmedEvent(chain, priorCommand)?.payload.observation
  if (prior === undefined) throw new Error('prior mounted observation is missing')
  if (command === 'verify-signout') assertSignoutContinuation(prior, observation)
  else if (command === 'arm-reboot') assertSameBootContinuation(prior, observation)
  else assertRebootRestore(prior, observation)
  chain = await appendEvent(run, chain, 'confirmed', command, { status, observation }, now)
  return stageResult(command, chain.state, run)
}

async function runCleanup(run, chain, adapters, now) {
  if (chain.state === 'cleaned' && chain.pending === null) {
    return stageResult('cleanup', 'cleaned', run, true)
  }
  if (
    chain.state !== 'reboot-verified' ||
    (chain.pending !== null && chain.pending !== 'cleanup')
  ) {
    throw new Error('cleanup is out of order')
  }
  if (chain.pending === null) {
    chain = await appendEvent(run, chain, 'attempt', 'cleanup', { priorState: chain.state }, now)
  }
  let status = validateTaskStatus(
    await adapters.operator.status(run),
    run.runDir,
    run.spec,
    run.specSha256,
  )
  let confirmation = await adapters.operator.cleanupConfirmation(run, false)
  if (status.host.state === 'conflict' || status.child.state === 'conflict') {
    throw new Error('foreign task is never cleaned')
  }
  if (status.host.state === 'missing') {
    if (confirmation === null)
      throw new Error('owned host task disappeared before cleanup confirmation')
  } else {
    if (
      confirmation === null &&
      (status.host.running !== true ||
        status.child.state !== 'exact' ||
        status.child.running !== true)
    ) {
      throw new Error('mounted Windows tasks stopped before cleanup')
    }
    await publishCleanupRequest(run, now)
    confirmation = confirmation ?? (await adapters.operator.cleanupConfirmation(run, true))
  }
  validateCleanupConfirmation(confirmation, run)
  status = validateTaskStatus(
    await adapters.operator.status(run),
    run.runDir,
    run.spec,
    run.specSha256,
  )
  if (status.host.state === 'conflict' || status.child.state === 'conflict') {
    throw new Error('foreign task is never cleaned')
  }
  if (status.child.state !== 'missing') {
    throw new Error('mounted child task cleanup did not finish')
  }
  if (status.host.state === 'exact') {
    await adapters.operator.uninstall(run)
    status = validateTaskStatus(
      await adapters.operator.status(run),
      run.runDir,
      run.spec,
      run.specSha256,
    )
  }
  if (status.host.state !== 'missing' || status.child.state !== 'missing') {
    throw new Error('owned Windows task cleanup did not finish')
  }
  chain = await appendEvent(
    run,
    chain,
    'confirmed',
    'cleanup',
    { confirmation, taskState: 'missing' },
    now,
  )
  return stageResult('cleanup', chain.state, run)
}

/** Run one stage. This function never invokes a sign-out, shutdown, or reboot command. */
export async function runM03WindowsKeepaliveAcceptance(argv, injectedDependencies) {
  const dependencyArgumentProvided = arguments.length >= 2
  const dependencies = injectedDependencies ?? {}
  let parsed
  try {
    parsed = parseCli(argv)
  } catch {
    return safeFailure('E_INVALID_INPUT', 'Invalid M03 Windows acceptance arguments')
  }
  if (parsed.help) return { exitCode: 0, output: HELP.trimEnd() }
  if (
    parsed.command === 'plan' ||
    (!parsed.apply && ['prepare', 'cleanup'].includes(parsed.command))
  ) {
    return planResult()
  }
  const platform = ownDependency(dependencies, 'platform') ?? process.platform
  if (platform !== 'win32') {
    return safeFailure('E_PLATFORM_UNSUPPORTED', 'M03 Windows acceptance is Windows-only')
  }
  const evidenceKind = dependencyArgumentProvided ? 'simulated' : 'production'
  const now = ownDependency(dependencies, 'now') ?? Date.now
  const nextUuid = ownDependency(dependencies, 'randomUUID') ?? randomUUID
  const adapters = adaptersFor(dependencies)
  try {
    const base = await createOrLoadRun(parsed, adapters, now, nextUuid, platform, evidenceKind)
    const run = await completeRunConfiguration(base, adapters, now)
    let chain = await loadEventChain(run)
    if (parsed.command === 'prepare') {
      return await runPrepare(run, chain, adapters, now)
    }
    if (parsed.command === 'cleanup') {
      return await runCleanup(run, chain, adapters, now)
    }
    return await runVerification(parsed.command, run, chain, adapters, now)
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
