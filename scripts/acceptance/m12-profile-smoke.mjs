#!/usr/bin/env node

import { Buffer } from 'node:buffer'
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
export const M12_PROFILE_PLAN_SCHEMA = 'dsh-luban/m12-profile-smoke-plan/v1'
export const M12_PROFILE_EVIDENCE_SCHEMA = 'dsh-luban/m12-profile-smoke/v2'
export const M12_PROFILE_DUAL_SCHEMA = 'dsh-luban/m12-profile-smoke-dual/v1'
export const M12_PROFILE_DSH_VERSION = '0.1.1-rc.2'
const PACKAGE_NAME = 'dsh-luban-acceptance'
const PLUGIN_ID = 'luban-acceptance'
const CLIENT_MARKER = '__LUBAN_M12_CLIENT_LIFECYCLE__'
const CANONICAL_RUN_ID = 'canonical-run-id'
const COMMAND_TIMEOUT_MS = 120_000
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 10_000
const OUTPUT_LIMIT = 64 * 1024
const EVIDENCE_INPUT_LIMIT = 1024 * 1024
const OS_RELEASE_LIMIT = 64 * 1024
const TEMPORARY_OWNER_SEGMENTS = ['node_modules', '.cache', 'dsh-luban-acceptance']
const TEMPORARY_PREFIX = 'm12-profile-'
const SHA_PATTERN = /^[a-f0-9]{64}$/u
const GIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u

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

function osReleaseId(value) {
  for (const line of value.split(/\r?\n/u)) {
    const match = /^ID=(.*)$/u.exec(line.trim())
    if (match === null) continue
    const raw = match[1]?.trim()
    if (raw === undefined) return undefined
    return raw.replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2').toLowerCase()
  }
  return undefined
}

export async function inspectM12RuntimePlatform(
  runtimePlatform = process.platform,
  arch = process.arch,
  node = process.version,
  readOsRelease = () => readFile('/etc/os-release', 'utf8'),
) {
  if (runtimePlatform === 'win32') {
    return Object.freeze({ target: 'windows', runtimePlatform, arch, node })
  }
  if (runtimePlatform !== 'linux') {
    throw new SmokeBlockedError(`M12 profile smoke is unsupported on ${runtimePlatform}`)
  }
  let release
  try {
    release = await readOsRelease()
  } catch {
    throw new SmokeBlockedError('M12 profile smoke requires readable /etc/os-release')
  }
  if (typeof release !== 'string' || Buffer.byteLength(release, 'utf8') > OS_RELEASE_LIMIT) {
    throw new SmokeBlockedError('M12 profile smoke received invalid /etc/os-release data')
  }
  if (osReleaseId(release) !== 'ubuntu') {
    throw new SmokeBlockedError('M12 Linux profile smoke requires /etc/os-release ID=ubuntu')
  }
  return Object.freeze({
    target: 'ubuntu',
    runtimePlatform,
    arch,
    node,
    osReleaseId: 'ubuntu',
  })
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

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    )
  }
  return value
}

export function m12CanonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
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

export function inspectM12GitState(root) {
  let shaResult
  let statusResult
  try {
    shaResult = runCapture('git', ['rev-parse', 'HEAD'], { cwd: root })
    statusResult = runCapture('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: root,
    })
  } catch {
    throw new SmokeBlockedError('Unable to inspect the Git source state')
  }
  if (shaResult.exitCode !== 0 || statusResult.exitCode !== 0) {
    throw new SmokeBlockedError('Unable to inspect the Git source state')
  }
  const sha = shaResult.stdout.trim().toLowerCase()
  if (!GIT_SHA_PATTERN.test(sha)) {
    throw new SmokeBlockedError('Git returned an invalid commit identity')
  }
  return Object.freeze({ sha, clean: statusResult.stdout.trim() === '' })
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

export const M12_PROFILE_CANONICAL_TASK = Object.freeze({
  id: 'M12-F001-profile-smoke-v1',
  packageName: PACKAGE_NAME,
  pluginId: PLUGIN_ID,
  dshVersion: M12_PROFILE_DSH_VERSION,
  profiles: Object.freeze({ windows: 'win-debug', ubuntu: 'ubuntu-server' }),
  operations: Object.freeze([
    'generate-client-plugin',
    'build-and-typecheck',
    'install-offline-into-isolated-profile',
    'verify-single-bundle-and-config-row',
    'mount-host-and-load-lazy-cjs-client',
    'hot-disable-and-re-enable',
    'restart-and-verify-disposal',
  ]),
})

export const M12_PROFILE_CANONICAL_FIXTURE = Object.freeze({
  generator: Object.freeze({
    name: 'acceptance',
    client: true,
    description: 'DSH Luban acceptance plugin',
    version: '0.1.0',
    dshEngine: '>=0.1.1-rc.1',
  }),
  hostSource: markerSource(CANONICAL_RUN_ID),
  clientSource: clientSource(CANONICAL_RUN_ID),
})

export const M12_PROFILE_TASK_SHA256 = sha256(m12CanonicalJson(M12_PROFILE_CANONICAL_TASK))
export const M12_PROFILE_FIXTURE_SHA256 = sha256(m12CanonicalJson(M12_PROFILE_CANONICAL_FIXTURE))

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
  const [writtenHostSource, writtenClientSource] = await Promise.all([
    readFile(join(generated.target, 'src', 'index.ts'), 'utf8'),
    readFile(join(generated.target, 'src', 'client', 'index.ts'), 'utf8'),
  ])
  const actualFixtureSha256 = sha256(
    m12CanonicalJson({
      generator: M12_PROFILE_CANONICAL_FIXTURE.generator,
      hostSource: writtenHostSource.replaceAll(plan.runId, CANONICAL_RUN_ID),
      clientSource: writtenClientSource.replaceAll(plan.runId, CANONICAL_RUN_ID),
    }),
  )
  requireCheck(
    checks,
    'canonical-fixture-hash',
    actualFixtureSha256 === M12_PROFILE_FIXTURE_SHA256,
    actualFixtureSha256,
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
  let actualDshVersion = null
  let failure

  try {
    await requireFile(dshEntry, `project-local @deepseek-ai/dsh@${M12_PROFILE_DSH_VERSION}`)
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
    actualDshVersion = version.slice(0, 128)
    requireCheck(
      checks,
      'local-dsh-version',
      actualDshVersion === M12_PROFILE_DSH_VERSION,
      actualDshVersion,
    )

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
    actualDshVersion,
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
    schemaVersion: M12_PROFILE_PLAN_SCHEMA,
    featureId: 'M12-F001',
    runId,
    root,
    platform,
    profile,
    requestedMode: options.live === true ? 'live' : 'plan',
    dshVersion: M12_PROFILE_DSH_VERSION,
    taskSha256: M12_PROFILE_TASK_SHA256,
    fixtureSha256: M12_PROFILE_FIXTURE_SHA256,
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

function assertPlatformMatchesPlan(plan, platform) {
  const expectedTarget = plan.platform === 'win32' ? 'windows' : 'ubuntu'
  if (
    platform?.target !== expectedTarget ||
    platform.runtimePlatform !== plan.platform ||
    (expectedTarget === 'windows' && platform.osReleaseId !== undefined) ||
    (expectedTarget === 'ubuntu' && platform.osReleaseId !== 'ubuntu')
  ) {
    throw new SmokeBlockedError('Runtime platform attestation does not match the smoke profile')
  }
}

function executionFailure(error) {
  return {
    status: error instanceof SmokeBlockedError ? 'blocked' : 'fail',
    checks: [],
    cleanup: 'not-applicable',
    actualDshVersion: null,
    error: sanitizeError(error),
  }
}

function normalizedCheck(id, status, actual) {
  return { id, status, actual: String(actual).slice(0, 2_000) }
}

async function runAttestedExecution(plan, dependencies, executionMode) {
  const attestationChecks = []
  let platform = null
  let before = null
  let after = null
  let execution
  let integrityFailure

  try {
    platform = await dependencies.inspectPlatform()
    assertPlatformMatchesPlan(plan, platform)
    attestationChecks.push(normalizedCheck('runtime-platform-attested', 'pass', platform.target))
    before = await dependencies.inspectGit(plan.root)
    attestationChecks.push(
      normalizedCheck('git-before-clean', before.clean ? 'pass' : 'blocked', before.clean),
    )
    if (!before.clean) {
      throw new SmokeBlockedError(
        'Live profile smoke requires a clean source tree before execution',
      )
    }
    execution = await dependencies.executeLive(plan)
    if (execution === null || typeof execution !== 'object' || Array.isArray(execution)) {
      throw new Error('Live profile smoke returned an invalid execution result')
    }
  } catch (error) {
    execution = executionFailure(error)
  }

  if (before !== null) {
    try {
      after = await dependencies.inspectGit(plan.root)
      const afterClean = after.clean === true
      const sameHead = after.sha === before.sha
      attestationChecks.push(
        normalizedCheck('git-after-clean', afterClean ? 'pass' : 'fail', afterClean),
        normalizedCheck('git-head-unchanged', sameHead ? 'pass' : 'fail', sameHead),
      )
      if (before.clean === true && !afterClean) {
        integrityFailure = new SmokeCheckError(
          'git-after-clean',
          'Source tree became dirty during live profile smoke',
        )
      } else if (before.clean === true && !sameHead) {
        integrityFailure = new SmokeCheckError(
          'git-head-unchanged',
          'Git HEAD changed during live profile smoke',
        )
      }
    } catch (error) {
      integrityFailure = error
      attestationChecks.push(
        normalizedCheck('git-after-inspected', 'fail', 'Git after-state unavailable'),
      )
    }
  }

  if (integrityFailure !== undefined) {
    execution = {
      ...execution,
      status: 'fail',
      error: sanitizeError(integrityFailure),
    }
  }
  const actualDshVersion =
    typeof execution.actualDshVersion === 'string' ? execution.actualDshVersion : null
  if (
    executionMode === 'production' &&
    execution.status === 'pass' &&
    actualDshVersion !== M12_PROFILE_DSH_VERSION
  ) {
    execution = {
      ...execution,
      status: 'fail',
      error: 'Successful live execution did not attest the required local DSH version',
    }
    attestationChecks.push(
      normalizedCheck('actual-dsh-version-attested', 'fail', actualDshVersion ?? 'missing'),
    )
  } else if (actualDshVersion !== null) {
    attestationChecks.push(
      normalizedCheck(
        'actual-dsh-version-attested',
        actualDshVersion === M12_PROFILE_DSH_VERSION ? 'pass' : 'fail',
        actualDshVersion,
      ),
    )
  }

  return normalizeExecution(
    plan,
    { ...execution, actualDshVersion },
    executionMode,
    platform,
    { before, after },
    attestationChecks,
  )
}

function normalizeExecution(plan, execution, executionMode, platform, git, attestationChecks) {
  const evidenceKind = executionMode === 'production' ? 'live' : 'simulated'
  const livePass =
    executionMode === 'production' &&
    execution.status === 'pass' &&
    git.before?.clean === true &&
    git.after?.clean === true &&
    git.before.sha === git.after.sha &&
    execution.cleanup === 'pass' &&
    execution.actualDshVersion === M12_PROFILE_DSH_VERSION
  return {
    schemaVersion: M12_PROFILE_EVIDENCE_SCHEMA,
    featureId: plan.featureId,
    runId: plan.runId,
    execution: executionMode,
    evidenceKind,
    platform,
    profile: plan.profile,
    git,
    taskSha256: M12_PROFILE_TASK_SHA256,
    fixtureSha256: M12_PROFILE_FIXTURE_SHA256,
    dsh: {
      expectedVersion: M12_PROFILE_DSH_VERSION,
      actualVersion: execution.actualDshVersion,
    },
    status:
      executionMode === 'test-double' && execution.status === 'pass'
        ? 'simulated'
        : execution.status,
    acceptancePassed: livePass,
    checks: [...attestationChecks, ...(Array.isArray(execution.checks) ? execution.checks : [])],
    cleanup: execution.cleanup ?? 'not-applicable',
    startedAt: plan.startedAt,
    ...(execution.error === undefined ? {} : { error: execution.error }),
    finishedAt: isoNow(),
  }
}

export async function runM12ProfileSmoke(options = {}, dependencies = {}) {
  const plan = Object.freeze({ ...createProfileSmokePlan(options), startedAt: isoNow() })
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
  const injected = Object.keys(dependencies).length > 0
  const runtime = {
    inspectPlatform: inspectM12RuntimePlatform,
    inspectGit: inspectM12GitState,
    executeLive: executeLiveProfileSmoke,
    ...dependencies,
  }
  return runAttestedExecution(plan, runtime, injected ? 'test-double' : 'production')
}

export async function writeM12ProfileResult(path, result) {
  const target = resolve(path)
  await mkdir(dirname(target), { recursive: true })
  const serialized = `${JSON.stringify(result, null, 2)}\n`
  await writeFile(target, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { target, sha256: sha256(serialized) }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value
}

function assertAggregatableGitState(value, label) {
  if (
    !hasExactKeys(value, ['clean', 'sha']) ||
    value.clean !== true ||
    typeof value.sha !== 'string' ||
    !GIT_SHA_PATTERN.test(value.sha)
  ) {
    throw new Error(`${label} Git attestation is invalid or dirty`)
  }
}

function assertAggregatablePlatform(value) {
  if (!isRecord(value)) throw new Error('Profile evidence platform attestation is invalid')
  const commonValid =
    typeof value.arch === 'string' &&
    value.arch.length > 0 &&
    value.arch.length <= 64 &&
    typeof value.node === 'string' &&
    value.node.length > 0 &&
    value.node.length <= 64
  if (!commonValid) throw new Error('Profile evidence platform attestation is invalid')
  if (
    value.target === 'windows' &&
    value.runtimePlatform === 'win32' &&
    hasExactKeys(value, ['arch', 'node', 'runtimePlatform', 'target'])
  ) {
    return
  }
  if (
    value.target === 'ubuntu' &&
    value.runtimePlatform === 'linux' &&
    value.osReleaseId === 'ubuntu' &&
    hasExactKeys(value, ['arch', 'node', 'osReleaseId', 'runtimePlatform', 'target'])
  ) {
    return
  }
  throw new Error('Profile evidence platform must attest Windows or Ubuntu')
}

function assertAggregatableEvidence(value) {
  const expectedKeys = [
    'acceptancePassed',
    'checks',
    'cleanup',
    'dsh',
    'evidenceKind',
    'execution',
    'featureId',
    'finishedAt',
    'fixtureSha256',
    'git',
    'platform',
    'profile',
    'runId',
    'schemaVersion',
    'startedAt',
    'status',
    'taskSha256',
  ]
  if (
    !hasExactKeys(value, expectedKeys) ||
    value.schemaVersion !== M12_PROFILE_EVIDENCE_SCHEMA ||
    value.featureId !== 'M12-F001' ||
    typeof value.runId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(value.runId) ||
    value.execution !== 'production' ||
    value.evidenceKind !== 'live' ||
    value.status !== 'pass' ||
    value.acceptancePassed !== true ||
    value.cleanup !== 'pass' ||
    !validTimestamp(value.startedAt) ||
    !validTimestamp(value.finishedAt) ||
    value.finishedAt < value.startedAt ||
    value.taskSha256 !== M12_PROFILE_TASK_SHA256 ||
    value.fixtureSha256 !== M12_PROFILE_FIXTURE_SHA256 ||
    !SHA_PATTERN.test(value.taskSha256) ||
    !SHA_PATTERN.test(value.fixtureSha256)
  ) {
    throw new Error('Profile evidence is not an aggregatable production live pass')
  }
  assertAggregatablePlatform(value.platform)
  if (
    (value.platform.target === 'windows' && value.profile !== 'win-debug') ||
    (value.platform.target === 'ubuntu' && value.profile !== 'ubuntu-server')
  ) {
    throw new Error('Profile evidence target and profile do not match')
  }
  if (!hasExactKeys(value.git, ['after', 'before'])) {
    throw new Error('Profile evidence Git attestation is invalid')
  }
  assertAggregatableGitState(value.git.before, 'Before-run')
  assertAggregatableGitState(value.git.after, 'After-run')
  if (value.git.before.sha !== value.git.after.sha) {
    throw new Error('Profile evidence Git HEAD changed during execution')
  }
  if (
    !hasExactKeys(value.dsh, ['actualVersion', 'expectedVersion']) ||
    value.dsh.expectedVersion !== M12_PROFILE_DSH_VERSION ||
    value.dsh.actualVersion !== M12_PROFILE_DSH_VERSION
  ) {
    throw new Error('Profile evidence does not attest the required local DSH version')
  }
  if (
    !Array.isArray(value.checks) ||
    value.checks.length === 0 ||
    value.checks.some(
      (check) =>
        !hasExactKeys(check, ['actual', 'id', 'status']) ||
        typeof check.id !== 'string' ||
        check.id.length === 0 ||
        check.id.length > 128 ||
        check.status !== 'pass' ||
        typeof check.actual !== 'string' ||
        check.actual.length > 2_000,
    )
  ) {
    throw new Error('Profile evidence contains invalid or failing checks')
  }
}

export function aggregateM12ProfileSmokeEvidence(evidence, now = () => new Date()) {
  if (!Array.isArray(evidence) || evidence.length !== 2) {
    throw new Error('Exactly one Windows and one Ubuntu profile evidence file are required')
  }
  for (const item of evidence) assertAggregatableEvidence(item)
  const windows = evidence.find((item) => item.platform.target === 'windows')
  const ubuntu = evidence.find((item) => item.platform.target === 'ubuntu')
  if (windows === undefined || ubuntu === undefined) {
    throw new Error('Profile evidence must contain one Windows run and one Ubuntu run')
  }
  if (
    windows.git.before.sha !== ubuntu.git.before.sha ||
    windows.taskSha256 !== ubuntu.taskSha256 ||
    windows.fixtureSha256 !== ubuntu.fixtureSha256 ||
    windows.dsh.actualVersion !== ubuntu.dsh.actualVersion
  ) {
    throw new Error(
      'Windows and Ubuntu evidence do not describe the same source, task, and fixture',
    )
  }
  return Object.freeze({
    schemaVersion: M12_PROFILE_DUAL_SCHEMA,
    featureId: 'M12-F001',
    status: 'pass',
    acceptancePassed: true,
    gitSha: windows.git.before.sha,
    taskSha256: windows.taskSha256,
    fixtureSha256: windows.fixtureSha256,
    dshVersion: windows.dsh.actualVersion,
    generatedAt: now().toISOString(),
    inputs: Object.freeze({
      windows: Object.freeze({
        runId: windows.runId,
        evidenceSha256: sha256(m12CanonicalJson(windows)),
      }),
      ubuntu: Object.freeze({
        runId: ubuntu.runId,
        evidenceSha256: sha256(m12CanonicalJson(ubuntu)),
      }),
    }),
  })
}

async function readEvidence(path) {
  let raw
  try {
    raw = await readFile(resolve(path), 'utf8')
  } catch {
    throw new Error('Unable to read profile smoke evidence')
  }
  if (Buffer.byteLength(raw, 'utf8') > EVIDENCE_INPUT_LIMIT) {
    throw new Error('Profile smoke evidence is too large')
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('Profile smoke evidence is not valid JSON')
  }
}

function nextArgument(argv, index, option) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a path`)
  return value
}

function parseArguments(argv) {
  const command = argv[0] !== undefined && !argv[0].startsWith('--') ? argv[0] : 'run'
  if (command !== 'run' && command !== 'aggregate') throw new Error(`Unknown command: ${command}`)
  const startIndex = command === 'run' && argv[0] !== 'run' ? 0 : 1
  const options = { command, live: false }
  for (let index = startIndex; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--live' && command === 'run') options.live = true
    else if (argument === '--output') {
      if (options.output !== undefined) throw new Error('--output may only be provided once')
      options.output = nextArgument(argv, index, '--output')
      index += 1
    } else if (argument === '--windows' && command === 'aggregate') {
      if (options.windows !== undefined) throw new Error('--windows may only be provided once')
      options.windows = nextArgument(argv, index, '--windows')
      index += 1
    } else if (argument === '--ubuntu' && command === 'aggregate') {
      if (options.ubuntu !== undefined) throw new Error('--ubuntu may only be provided once')
      options.ubuntu = nextArgument(argv, index, '--ubuntu')
      index += 1
    } else if (argument === '--help') options.help = true
    else throw new Error(`Unknown option: ${argument}`)
  }
  if (
    command === 'aggregate' &&
    options.help !== true &&
    (options.windows === undefined || options.ubuntu === undefined || options.output === undefined)
  ) {
    throw new Error('aggregate requires --windows, --ubuntu, and --output')
  }
  return options
}

export async function runM12ProfileSmokeCli(argv, log = (value) => console.log(value)) {
  const options = parseArguments(argv)
  if (options.help === true) {
    log('Usage: node scripts/acceptance/m12-profile-smoke.mjs [--live] [--output <new-json-path>]')
    log(
      '       node scripts/acceptance/m12-profile-smoke.mjs aggregate --windows <json> --ubuntu <json> --output <new-json-path>',
    )
    return 0
  }
  if (options.command === 'aggregate') {
    const evidence = await Promise.all([
      readEvidence(options.windows),
      readEvidence(options.ubuntu),
    ])
    const result = aggregateM12ProfileSmokeEvidence(evidence)
    const written = await writeM12ProfileResult(options.output, result)
    log(JSON.stringify({ ...result, artifact: written }, null, 2))
    return 0
  }
  const result = await runM12ProfileSmoke(options)
  if (options.output !== undefined) {
    const written = await writeM12ProfileResult(options.output, result)
    log(JSON.stringify({ ...result, artifact: written }, null, 2))
  } else {
    log(JSON.stringify(result, null, 2))
  }
  if (result.status === 'blocked') return 2
  if (result.status === 'fail') return 1
  return 0
}

async function main() {
  process.exitCode = await runM12ProfileSmokeCli(process.argv.slice(2))
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
