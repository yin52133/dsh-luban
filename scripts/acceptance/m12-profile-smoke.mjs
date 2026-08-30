#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { generatePlugin } from '../create-plugin.mjs'
import { setupProfile } from '../deploy/setup-profile.mjs'
import { safeChildPath } from '../path-boundary.mjs'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..')
const SCHEMA_VERSION = 1
const DSH_VERSION = '0.1.1-rc.2'
const PACKAGE_NAME = 'dsh-luban-acceptance'
const PLUGIN_ID = 'luban-acceptance'
const CLIENT_MARKER = '__LUBAN_M12_CLIENT_LIFECYCLE__'
const COMMAND_TIMEOUT_MS = 120_000
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 10_000
const OUTPUT_LIMIT = 64 * 1024
const TEMPORARY_OWNER_SEGMENTS = ['node_modules', '.cache', 'dsh-luban-acceptance']
const TEMPORARY_PREFIX = 'm12-profile-'

class SmokeBlockedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SmokeBlockedError'
  }
}

class SmokeCheckError extends Error {
  constructor(checkId, message) {
    super(message)
    this.name = 'SmokeCheckError'
    this.checkId = checkId
  }
}

function temporaryOwner(root) {
  return resolve(root, ...TEMPORARY_OWNER_SEGMENTS)
}

function isDirectOwnedTemporaryChild(owner, candidate) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) return false
  const target = resolve(candidate)
  const rel = relative(resolve(owner), target)
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel) &&
    !rel.includes(sep) &&
    basename(target).startsWith(TEMPORARY_PREFIX) &&
    basename(target).length > TEMPORARY_PREFIX.length
  )
}

export function isOwnedTemporaryRoot(root, candidate) {
  return isDirectOwnedTemporaryChild(temporaryOwner(root), candidate)
}

function platformProfile(platform) {
  if (platform === 'win32') return 'win-debug'
  if (platform === 'linux') return 'ubuntu-server'
  throw new SmokeBlockedError(`M12 profile smoke is unsupported on ${platform}`)
}

function isoNow(now = Date.now()) {
  return new Date(now).toISOString()
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replaceAll(REPOSITORY_ROOT, '<repository>').slice(0, 4_000)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function tail(current, chunk) {
  const next = `${current}${String(chunk)}`
  return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT)
}

function recordCheck(checks, id, status, actual) {
  checks.push({ id, status, actual: String(actual).slice(0, 2_000) })
}

function requireCheck(checks, id, condition, actual) {
  recordCheck(checks, id, condition ? 'pass' : 'fail', actual)
  if (!condition) throw new SmokeCheckError(id, `${id} failed: ${String(actual)}`)
}

function executablePath(root, ...parts) {
  return resolve(root, 'node_modules', ...parts)
}

async function requireFile(path, label) {
  try {
    await access(path)
    if (!(await stat(path)).isFile()) throw new Error('not a file')
  } catch {
    throw new SmokeBlockedError(`${label} is unavailable at ${path}`)
  }
}

function runCapture(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function requireCommand(checks, id, command, args, options) {
  const result = runCapture(command, args, options)
  const diagnostic = [result.stderr, result.stdout]
    .filter((value) => value.trim() !== '')
    .join('\n')
  requireCheck(
    checks,
    id,
    result.exitCode === 0,
    result.exitCode === 0
      ? 'exit 0'
      : `exit ${String(result.exitCode)}: ${sanitizeError(diagnostic)}`,
  )
  return result
}

function markerSource(runId) {
  return `/// <reference types="node" />
import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

export const name = '${PLUGIN_ID}'

function record(event: 'mounted' | 'disposed'): void {
  const file = process.env.LUBAN_M12_HOST_MARKER
  if (file === undefined || file === '') throw new Error('LUBAN_M12_HOST_MARKER is required')
  appendFileSync(file, JSON.stringify({ schemaVersion: 1, runId: '${runId}', event, pid: process.pid, at: Date.now() }) + '\\n', 'utf8')
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    record('mounted')
    return () => record('disposed')
  })
}
`
}

function clientSource(runId) {
  return `import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const inject: readonly string[] = []

export function apply(ctx: ClientContext): void {
  Reflect.set(globalThis, '${CLIENT_MARKER}', { runId: '${runId}', event: 'mounted' })
  ctx.effect(() => () => {
    Reflect.set(globalThis, '${CLIENT_MARKER}', { runId: '${runId}', event: 'disposed' })
  })
}
`
}

async function preparePlugin(plan, temporaryRoot, checks) {
  await copyFile(join(plan.root, 'tsconfig.base.json'), join(temporaryRoot, 'tsconfig.base.json'))
  const generated = await generatePlugin({
    name: 'acceptance',
    workspaceRoot: temporaryRoot,
    client: true,
    dryRun: false,
  })
  await writeFile(join(generated.target, 'src', 'index.ts'), markerSource(plan.runId), 'utf8')
  await writeFile(
    join(generated.target, 'src', 'client', 'index.ts'),
    clientSource(plan.runId),
    'utf8',
  )

  const tsdown = executablePath(plan.root, 'tsdown', 'dist', 'run.mjs')
  const tsc = executablePath(plan.root, 'typescript', 'bin', 'tsc')
  await requireFile(tsdown, 'project-local tsdown')
  await requireFile(tsc, 'project-local TypeScript')
  requireCommand(checks, 'generated-plugin-build', process.execPath, m12TsdownArgs(tsdown), {
    cwd: generated.target,
    env: process.env,
  })
  requireCommand(
    checks,
    'generated-plugin-types',
    process.execPath,
    [tsc, '--emitDeclarationOnly', '-p', 'tsconfig.json'],
    { cwd: generated.target, env: process.env },
  )
  return generated.target
}

export function m12TsdownArgs(tsdownEntry) {
  return [tsdownEntry, '--config-loader', 'tsx']
}

export function m12PluginInstallArgs(profile, pluginRoot, storeRoot) {
  const normalized = pluginRoot.replaceAll('\\', '/')
  const normalizedStore = storeRoot.replaceAll('\\', '/')
  return [
    'plugin',
    '--profile',
    profile,
    '--ignore-workspace',
    'add',
    '--offline',
    '--config.auto-install-peers=false',
    '--store-dir',
    normalizedStore,
    `file:${normalized}`,
  ]
}

async function readMarkers(path, runId) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry?.runId === runId)
}

async function delay(milliseconds) {
  await wait(milliseconds)
}

async function waitFor(label, predicate, processState, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() <= deadline) {
    if (processState?.closed === true) {
      throw new Error(
        `${label}: dsh exited early (${String(processState.exitCode)}): ${processState.stderr}`,
      )
    }
    try {
      const value = await predicate()
      if (value !== undefined && value !== false) return value
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error(
    `${label} timed out${lastError === undefined ? '' : `: ${sanitizeError(lastError)}`}`,
  )
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Unable to reserve a port')
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
  })
  return address.port
}

function startDsh(plan, dshEntry, dshHome, markerFile, port) {
  const child = spawn(
    process.execPath,
    [
      dshEntry,
      '--profile',
      plan.profile,
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: plan.root,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        LUBAN_M12_HOST_MARKER: markerFile,
        LUBAN_M12_RUN_ID: plan.runId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const state = { child, stdout: '', stderr: '', closed: false, exitCode: undefined }
  child.stdout?.on('data', (chunk) => {
    state.stdout = tail(state.stdout, chunk)
  })
  child.stderr?.on('data', (chunk) => {
    state.stderr = tail(state.stderr, chunk)
  })
  state.completion = new Promise((resolveCompletion) => {
    child.once('close', (exitCode) => {
      state.closed = true
      state.exitCode = exitCode
      resolveCompletion(exitCode)
    })
  })
  return state
}

async function stopDsh(state) {
  if (state.closed) return { graceful: true, exitCode: state.exitCode }
  state.child.kill('SIGTERM')
  const graceful = await Promise.race([
    state.completion.then(() => true),
    delay(STOP_TIMEOUT_MS).then(() => false),
  ])
  if (!graceful && !state.closed) {
    state.child.kill('SIGKILL')
    await state.completion
  }
  return { graceful, exitCode: state.exitCode }
}

async function fetchClient(port) {
  const response = await globalThis.fetch(
    `http://127.0.0.1:${String(port)}/plugins/${PACKAGE_NAME}/client.js`,
    {
      signal: globalThis.AbortSignal.timeout(2_000),
    },
  )
  if (!response.ok) throw new Error(`client bundle returned HTTP ${String(response.status)}`)
  return response.text()
}

export function evaluateLazyClient(source, runId) {
  let handoff
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          handoff = value
        },
      },
    },
  }
  runInNewContext(source, sandbox, { timeout: 2_000 })
  if (handoff?.id !== PACKAGE_NAME || typeof handoff.factory !== 'function') {
    throw new Error('client bundle did not register the expected lazy-CJS module')
  }
  const exported = handoff.factory((specifier) => {
    throw new Error(`Unexpected client external: ${specifier}`)
  })
  if (typeof exported?.apply !== 'function') throw new Error('client bundle exports no apply()')
  let effect
  exported.apply({
    effect(callback) {
      effect = callback
    },
  })
  if (typeof effect !== 'function') throw new Error('client apply() registered no effect')
  const dispose = effect()
  const mounted = Reflect.get(sandbox, CLIENT_MARKER)
  if (mounted?.runId !== runId || mounted?.event !== 'mounted') {
    throw new Error('client effect did not mount in the lazy-CJS realm')
  }
  if (typeof dispose !== 'function') throw new Error('client effect returned no disposer')
  dispose()
  const disposed = Reflect.get(sandbox, CLIENT_MARKER)
  if (disposed?.runId !== runId || disposed?.event !== 'disposed') {
    throw new Error('client effect did not dispose in the lazy-CJS realm')
  }
  return { moduleId: handoff.id, lifecycle: ['mounted', 'disposed'] }
}

async function writeProfileToggle(path, disabled) {
  await writeFile(path, `- id: ${PLUGIN_ID}\n  disabled: ${disabled ? 'true' : 'false'}\n`, 'utf8')
}

export async function removeOwnedTemporaryRoot(root, temporaryRoot) {
  if (!isOwnedTemporaryRoot(root, temporaryRoot)) {
    throw new Error(`Refusing to clean an unowned temporary path: ${temporaryRoot}`)
  }
  const owner = temporaryOwner(root)
  const safeOwner = await safeChildPath(root, owner, 'M12 smoke temporary owner')
  const safeTemporaryRoot = await safeChildPath(
    safeOwner.target,
    resolve(temporaryRoot),
    'M12 smoke temporary root',
  )
  if (!isDirectOwnedTemporaryChild(safeOwner.target, safeTemporaryRoot.target)) {
    throw new Error(`Refusing to clean a canonically unowned temporary path: ${temporaryRoot}`)
  }
  await rm(safeTemporaryRoot.target, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}

function eventSequence(markers) {
  return markers.map((marker) => marker.event)
}

async function executeLiveProfileSmoke(plan) {
  const checks = []
  const dshEntry = executablePath(plan.root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  let temporaryRoot
  let activeProcess
  let cleanup = 'not-needed'
  let failure

  try {
    await requireFile(dshEntry, `project-local @deepseek-ai/dsh@${DSH_VERSION}`)
    const version = requireCommand(
      checks,
      'local-dsh-version-command',
      process.execPath,
      [dshEntry, '-V'],
      {
        cwd: plan.root,
        env: process.env,
      },
    ).stdout.trim()
    requireCheck(checks, 'local-dsh-version', version === DSH_VERSION, version)

    const temporaryParent = temporaryOwner(plan.root)
    await safeChildPath(plan.root, temporaryParent, 'M12 smoke temporary owner')
    await mkdir(temporaryParent, { recursive: true })
    const safeTemporaryParent = await safeChildPath(
      plan.root,
      temporaryParent,
      'M12 smoke temporary owner',
    )
    temporaryRoot = await mkdtemp(join(safeTemporaryParent.target, TEMPORARY_PREFIX))
    const safeTemporaryRoot = await safeChildPath(
      safeTemporaryParent.target,
      temporaryRoot,
      'M12 smoke temporary root',
    )
    if (!isDirectOwnedTemporaryChild(safeTemporaryParent.target, safeTemporaryRoot.target)) {
      throw new Error(`Temporary root has an unexpected canonical path: ${temporaryRoot}`)
    }
    temporaryRoot = safeTemporaryRoot.target
    const dshHome = join(temporaryRoot, 'dsh-home')
    const markerFile = join(temporaryRoot, 'host-lifecycle.jsonl')
    const pnpmStore = join(temporaryRoot, 'pnpm-store')
    const pluginRoot = await preparePlugin(plan, temporaryRoot, checks)
    await setupProfile({ profile: plan.profile, dshHome, apply: true })
    recordCheck(checks, 'isolated-profile-created', 'pass', plan.profile)

    const dshEnvironment = {
      ...process.env,
      DSH_HOME: dshHome,
      npm_config_cache: join(temporaryRoot, 'pnpm-cache'),
      npm_config_state_dir: join(temporaryRoot, 'pnpm-state'),
      npm_config_store_dir: pnpmStore,
      npm_config_update_notifier: 'false',
    }
    requireCommand(
      checks,
      'profile-plugin-install-offline',
      process.execPath,
      [dshEntry, ...m12PluginInstallArgs(plan.profile, pluginRoot, pnpmStore)],
      { cwd: plan.root, env: dshEnvironment },
    )
    const profileManifest = JSON.parse(
      await readFile(join(dshHome, 'profiles', plan.profile, 'package.json'), 'utf8'),
    )
    const bundles = profileManifest.dsh?.profile?.bundles ?? []
    requireCheck(
      checks,
      'profile-bundle-once',
      bundles.filter((value) => value === PACKAGE_NAME).length === 1,
      JSON.stringify(bundles),
    )

    const dump = requireCommand(
      checks,
      'profile-config-dump',
      process.execPath,
      [dshEntry, '--profile', plan.profile, '--dump-config'],
      { cwd: plan.root, env: dshEnvironment },
    ).stdout
    const rowCount = [...dump.matchAll(/^\s*-?\s*id:\s+luban-acceptance\s*$/gmu)].length
    requireCheck(checks, 'profile-config-row-once', rowCount === 1, `rows=${String(rowCount)}`)
    requireCheck(
      checks,
      'profile-config-package',
      dump.includes(`name: ${PACKAGE_NAME}`),
      PACKAGE_NAME,
    )

    const patchPath = join(dshHome, 'profiles', plan.profile, 'cordis.patch.yml')
    const firstPort = await freePort()
    activeProcess = startDsh(plan, dshEntry, dshHome, markerFile, firstPort)
    await waitFor(
      'first host mount',
      async () => {
        const markers = await readMarkers(markerFile, plan.runId)
        return markers.filter((marker) => marker.event === 'mounted').length >= 1
      },
      activeProcess,
    )
    recordCheck(checks, 'host-mounted', 'pass', 'mount marker 1')
    const firstClient = await waitFor(
      'first client bundle',
      () => fetchClient(firstPort),
      activeProcess,
    )
    const firstClientResult = evaluateLazyClient(firstClient, plan.runId)
    recordCheck(checks, 'client-http-and-lazy-cjs', 'pass', JSON.stringify(firstClientResult))

    await writeProfileToggle(patchPath, true)
    await waitFor(
      'hot disable disposer',
      async () => {
        const markers = await readMarkers(markerFile, plan.runId)
        return markers.filter((marker) => marker.event === 'disposed').length >= 1
      },
      activeProcess,
    )
    recordCheck(checks, 'host-hot-disabled', 'pass', 'dispose marker 1')

    await writeProfileToggle(patchPath, false)
    await waitFor(
      'hot enable mount',
      async () => {
        const markers = await readMarkers(markerFile, plan.runId)
        return markers.filter((marker) => marker.event === 'mounted').length >= 2
      },
      activeProcess,
    )
    recordCheck(checks, 'host-hot-reenabled', 'pass', 'mount marker 2')
    await waitFor('client bundle after hot enable', () => fetchClient(firstPort), activeProcess)

    await writeProfileToggle(patchPath, true)
    await waitFor(
      'pre-restart disposer',
      async () => {
        const markers = await readMarkers(markerFile, plan.runId)
        return markers.filter((marker) => marker.event === 'disposed').length >= 2
      },
      activeProcess,
    )
    recordCheck(checks, 'host-disposed-before-restart', 'pass', 'dispose marker 2')
    const firstStop = await stopDsh(activeProcess)
    activeProcess = undefined
    requireCheck(
      checks,
      'first-process-stopped-within-timeout',
      firstStop.graceful,
      JSON.stringify(firstStop),
    )

    await writeProfileToggle(patchPath, false)
    const secondPort = await freePort()
    activeProcess = startDsh(plan, dshEntry, dshHome, markerFile, secondPort)
    await waitFor(
      'restart host mount',
      async () => {
        const markers = await readMarkers(markerFile, plan.runId)
        return markers.filter((marker) => marker.event === 'mounted').length >= 3
      },
      activeProcess,
    )
    const restartedClient = await waitFor(
      'client bundle after restart',
      () => fetchClient(secondPort),
      activeProcess,
    )
    evaluateLazyClient(restartedClient, plan.runId)
    recordCheck(checks, 'host-client-restart', 'pass', 'mount marker 3 and client 200')

    await writeProfileToggle(patchPath, true)
    await waitFor(
      'pre-final-stop disposer',
      async () => {
        const markers = await readMarkers(markerFile, plan.runId)
        return markers.filter((marker) => marker.event === 'disposed').length >= 3
      },
      activeProcess,
    )
    recordCheck(checks, 'host-disposed-before-final-stop', 'pass', 'dispose marker 3')
    const secondStop = await stopDsh(activeProcess)
    activeProcess = undefined
    requireCheck(
      checks,
      'second-process-stopped-within-timeout',
      secondStop.graceful,
      JSON.stringify(secondStop),
    )
    const markers = await readMarkers(markerFile, plan.runId)
    const expected = ['mounted', 'disposed', 'mounted', 'disposed', 'mounted', 'disposed']
    requireCheck(
      checks,
      'host-lifecycle-sequence',
      JSON.stringify(eventSequence(markers)) === JSON.stringify(expected),
      JSON.stringify(eventSequence(markers)),
    )
  } catch (error) {
    failure = error
    if (error instanceof SmokeBlockedError) {
      recordCheck(checks, 'live-preflight', 'blocked', sanitizeError(error))
    } else if (!(error instanceof SmokeCheckError)) {
      recordCheck(checks, 'live-execution', 'fail', sanitizeError(error))
    }
  } finally {
    if (activeProcess !== undefined) {
      const stopped = await stopDsh(activeProcess).catch(() => ({ graceful: false }))
      if (!stopped.graceful) {
        failure ??= new SmokeCheckError('cleanup-process', 'dsh required forced termination')
        recordCheck(checks, 'cleanup-process', 'fail', 'forced termination')
      }
    }
    if (temporaryRoot !== undefined) {
      try {
        await removeOwnedTemporaryRoot(plan.root, temporaryRoot)
        cleanup = 'pass'
      } catch (error) {
        cleanup = 'fail'
        failure ??= error
        recordCheck(checks, 'cleanup-temporary-root', 'fail', sanitizeError(error))
      }
    }
  }

  return {
    status:
      failure === undefined ? 'pass' : failure instanceof SmokeBlockedError ? 'blocked' : 'fail',
    checks,
    cleanup,
    ...(failure === undefined ? {} : { error: sanitizeError(failure) }),
  }
}

export function createProfileSmokePlan(options = {}) {
  const root = resolve(options.root ?? REPOSITORY_ROOT)
  const platform = options.platform ?? process.platform
  const profile = platformProfile(platform)
  const runId = options.runId ?? randomUUID()
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(runId)) {
    throw new TypeError('runId must be a bounded identifier')
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    featureId: 'M12-F001',
    runId,
    root,
    platform,
    profile,
    requestedMode: options.live === true ? 'live' : 'plan',
    dshVersion: DSH_VERSION,
    isolation:
      'temporary DSH_HOME under ignored node_modules/.cache/dsh-luban-acceptance; owned path removed in finally',
    commands: [
      'generate and build dsh-luban-acceptance',
      `project-local dsh plugin --profile ${profile} --ignore-workspace add --offline --store-dir <isolated> file:<fixture>`,
      `project-local dsh --profile ${profile} --dump-config`,
      `project-local dsh --profile ${profile} --no-open --host 127.0.0.1 --port <ephemeral>`,
    ],
  })
}

function normalizeExecution(plan, execution, evidenceKind) {
  const livePass = evidenceKind === 'live' && execution.status === 'pass'
  return {
    schemaVersion: SCHEMA_VERSION,
    featureId: plan.featureId,
    runId: plan.runId,
    platform: plan.platform,
    profile: plan.profile,
    dshVersion: plan.dshVersion,
    evidenceKind,
    status:
      evidenceKind === 'simulated' && execution.status === 'pass' ? 'simulated' : execution.status,
    acceptancePassed: livePass,
    checks: execution.checks ?? [],
    cleanup: execution.cleanup ?? 'not-applicable',
    ...(execution.error === undefined ? {} : { error: execution.error }),
    finishedAt: isoNow(),
  }
}

export async function runM12ProfileSmoke(options = {}, dependencies = {}) {
  const plan = createProfileSmokePlan(options)
  if (options.live !== true) {
    return {
      ...plan,
      evidenceKind: 'none',
      status: 'planned',
      acceptancePassed: false,
      checks: [],
      cleanup: 'not-applicable',
      finishedAt: isoNow(),
    }
  }
  if (dependencies.executeLive !== undefined) {
    const execution = await dependencies.executeLive(plan)
    return normalizeExecution(plan, execution, 'simulated')
  }
  return normalizeExecution(plan, await executeLiveProfileSmoke(plan), 'live')
}

async function writeResult(path, result) {
  const target = resolve(path)
  await mkdir(dirname(target), { recursive: true })
  const serialized = `${JSON.stringify(result, null, 2)}\n`
  await writeFile(target, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { target, sha256: sha256(serialized) }
}

function parseArguments(argv) {
  const options = { live: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--live') options.live = true
    else if (argument === '--output') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--output requires a path')
      options.output = value
      index += 1
    } else if (argument === '--help') options.help = true
    else throw new Error(`Unknown option: ${argument}`)
  }
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/acceptance/m12-profile-smoke.mjs [--live] [--output <new-json-path>]',
    )
    console.log(
      'Without --live, print a non-writing plan. Live mode requires project-local DSH rc2.',
    )
    return
  }
  const result = await runM12ProfileSmoke(options)
  if (options.output !== undefined) {
    const written = await writeResult(options.output, result)
    console.log(JSON.stringify({ ...result, artifact: written }, null, 2))
  } else {
    console.log(JSON.stringify(result, null, 2))
  }
  if (result.status === 'blocked') process.exitCode = 2
  else if (result.status === 'fail') process.exitCode = 1
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`m12-profile-smoke: ${sanitizeError(error)}`)
    process.exitCode = 1
  })
}
