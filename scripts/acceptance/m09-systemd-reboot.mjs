#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { hostname, tmpdir, userInfo } from 'node:os'
import { isBuiltin } from 'node:module'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { parseArgs } from 'node:util'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const RUNNER_PATH = fileURLToPath(import.meta.url)
const OPERATOR_CLI_PATH = fileURLToPath(
  new URL('../../packages/dsh-luban-server-mode/dist/operator-cli.js', import.meta.url),
)
const SERVER_PACKAGE_ROOT = fileURLToPath(
  new URL('../../packages/dsh-luban-server-mode/', import.meta.url),
)
const SERVER_DIST_ROOT = join(SERVER_PACKAGE_ROOT, 'dist')
const CORE_PACKAGE_ROOT = fileURLToPath(new URL('../../packages/core/', import.meta.url))
const CORE_DIST_ROOT = join(CORE_PACKAGE_ROOT, 'dist')
const CORE_ENTRY_PATH = join(CORE_DIST_ROOT, 'index.js')
const CORE_LINK_PATH = join(SERVER_PACKAGE_ROOT, 'node_modules', 'dsh-luban-core')
const RUNNER_REPOSITORY_PATH = 'scripts/acceptance/m09-systemd-reboot.mjs'
const PNPM_TRUST_REPOSITORY_PATH = 'scripts/acceptance/m09-pnpm-trust.json'
const REQUIRED_BUILD_INPUTS = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  PNPM_TRUST_REPOSITORY_PATH,
  'tsconfig.base.json',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'packages/core/tsdown.config.ts',
  'packages/dsh-luban-server-mode/package.json',
  'packages/dsh-luban-server-mode/tsconfig.json',
  'packages/dsh-luban-server-mode/tsdown.config.ts',
])
const PRODUCTION_TOOL_PATHS = Object.freeze({
  git: '/usr/bin/git',
  loginctl: '/usr/bin/loginctl',
  systemctl: '/usr/bin/systemctl',
})
const SERVICE = 'dsh-luban.service'
const SCOPE = 'M09-F001/systemd-reboot'
const MARKER_SCHEMA = 'dsh-luban/m09-systemd-reboot-owner/v1'
const EVIDENCE_SCHEMA = 'dsh-luban/m09-systemd-reboot-evidence/v1'
const MAX_JSON_BYTES = 128 * 1024
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_COMMAND_BYTES = 16 * 1024
const MAX_TOOL_FILE_BYTES = 32 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 20_000
const BUILD_TIMEOUT_MS = 120_000
const PACKAGE_MANAGER_TIMEOUT_MS = 120_000
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const ISOLATED_INSTALL_MODE = 'pnpm-frozen-offline-ignore-scripts-copy-v1'
const COMMANDS = Object.freeze([
  'plan',
  'preflight',
  'install',
  'arm-reboot',
  'verify-reboot',
  'cleanup',
])
const STAGES = Object.freeze([
  'preflight-verified',
  'install-attempted',
  'installed',
  'reboot-armed',
  'reboot-verified',
  'cleanup-attempted',
  'cleaned',
])
const EVIDENCE_FILES = Object.freeze([
  '0001-preflight-verified.json',
  '0002-install-attempted.json',
  '0003-installed.json',
  '0004-reboot-armed.json',
  '0005-reboot-verified.json',
  '0006-cleanup-attempted.json',
  '0007-cleaned.json',
])

const HELP = `M09 Ubuntu/systemd staged reboot acceptance

Usage:
  node scripts/acceptance/m09-systemd-reboot.mjs [plan]
  node scripts/acceptance/m09-systemd-reboot.mjs preflight --apply --run-dir ABSOLUTE_EXTERNAL_PRIVATE_DIR
  node scripts/acceptance/m09-systemd-reboot.mjs install --apply --run-dir DIR
  node scripts/acceptance/m09-systemd-reboot.mjs arm-reboot --apply --run-dir DIR
  node scripts/acceptance/m09-systemd-reboot.mjs verify-reboot --apply --run-dir DIR
  node scripts/acceptance/m09-systemd-reboot.mjs cleanup --apply --run-dir DIR

Without --apply every command is a zero-write plan. --apply authorizes evidence writes;
only install and cleanup invoke the production luban-server-mode operator CLI to mutate
the owned user unit. This runner never enables linger, reboots, logs out, or disconnects.
The operator must perform those human-boundary actions outside the runner.
Install and cleanup persist a durable attempt before mutation and reconcile it on retry.
Simulation dependencies can exercise the state machine but can never pass acceptance.
`

const FAILURE_MESSAGES = Object.freeze({
  E_EVIDENCE_INVALID: 'M09 evidence is invalid or has been tampered with',
  E_INVALID_INPUT: 'Invalid M09 systemd acceptance arguments',
  E_OWNERSHIP: 'The systemd unit is no longer the evidence-owned exact unit',
  E_PACKAGE_MANAGER_TRUST: 'The pnpm runtime does not match the tracked HEAD trust manifest',
  E_PLATFORM_UNSUPPORTED: 'M09 systemd acceptance requires a non-root Ubuntu user',
  E_PROVENANCE_MISMATCH: 'Current runtime does not match the isolated clean-HEAD build',
  E_ROLLBACK_FAILED: 'The failed installation could not be safely rolled back',
  E_STAGE_ORDER: 'M09 acceptance stages must run in the documented order',
  E_UNAVAILABLE: 'M09 systemd acceptance prerequisites or live checks failed',
})

class AcceptanceError extends Error {
  constructor(code) {
    super(FAILURE_MESSAGES[code] ?? FAILURE_MESSAGES.E_UNAVAILABLE)
    this.code = code
  }
}

function fail(code) {
  throw new AcceptanceError(code)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value, keys) {
  if (!isRecord(value)) fail('E_EVIDENCE_INVALID')
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (!isDeepStrictEqual(actual, expected)) fail('E_EVIDENCE_INVALID')
}

function containsControl(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0)
    return code !== undefined && (code <= 0x1f || code === 0x7f)
  })
}

function boundedText(value, maximum = 4_096) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.length > maximum ||
    containsControl(value)
  ) {
    fail('E_EVIDENCE_INVALID')
  }
  return value
}

function boundedOptionalText(value, maximum = 8_192) {
  if (typeof value !== 'string' || value.length > maximum || containsControl(value)) {
    fail('E_EVIDENCE_INVALID')
  }
  return value
}

function safeInteger(value, positive = false) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) fail('E_EVIDENCE_INVALID')
  return value
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function serializedJson(value) {
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (data.byteLength > MAX_JSON_BYTES) fail('E_EVIDENCE_INVALID')
  return data
}

function safeResult(exitCode, value) {
  return { exitCode, output: JSON.stringify(value) }
}

function safeFailure(error) {
  const code =
    error instanceof AcceptanceError && Object.hasOwn(FAILURE_MESSAGES, error.code)
      ? error.code
      : 'E_UNAVAILABLE'
  return safeResult(1, {
    schemaVersion: 1,
    ok: false,
    error: { code, message: FAILURE_MESSAGES[code] },
  })
}

function pathInput(value) {
  if (typeof value !== 'string' || value === '' || containsControl(value) || !isAbsolute(value)) {
    fail('E_INVALID_INPUT')
  }
  const path = resolve(value)
  if (path === parse(path).root || basename(path) === '') fail('E_INVALID_INPUT')
  return path
}

function parseCli(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        apply: { type: 'boolean' },
        'run-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch {
    fail('E_INVALID_INPUT')
  }
  if (parsed.positionals.length > 1) fail('E_INVALID_INPUT')
  const command = parsed.positionals[0] ?? 'plan'
  if (!COMMANDS.includes(command)) fail('E_INVALID_INPUT')
  const apply = parsed.values.apply === true
  if (command === 'plan' && apply) fail('E_INVALID_INPUT')
  const runDir =
    parsed.values['run-dir'] === undefined ? undefined : pathInput(parsed.values['run-dir'])
  if (command !== 'plan' && apply && runDir === undefined) fail('E_INVALID_INPUT')
  return { command, apply, runDir, help: parsed.values.help === true }
}

function outsideRepository(path) {
  const within = relative(REPOSITORY_ROOT, path)
  return !(
    within === '' ||
    (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))
  )
}

async function assertSafeDirectory(path, privateDirectory) {
  const initial = await lstat(path)
  if (initial.isSymbolicLink() || !initial.isDirectory()) fail('E_EVIDENCE_INVALID')
  if (privateDirectory && process.platform !== 'win32' && (initial.mode & 0o077) !== 0) {
    fail('E_EVIDENCE_INVALID')
  }
  const canonical = await realpath(path)
  if (resolve(canonical) !== resolve(path)) fail('E_EVIDENCE_INVALID')
}

async function assertRunLocation(runDir, existing) {
  if (!outsideRepository(runDir)) fail('E_INVALID_INPUT')
  if (existing) {
    await assertSafeDirectory(runDir, true)
    return
  }
  await assertSafeDirectory(dirname(runDir), false)
  try {
    await lstat(runDir)
    fail('E_INVALID_INPUT')
  } catch (error) {
    if (error instanceof AcceptanceError) throw error
    if (!isRecord(error) || error.code !== 'ENOENT') fail('E_UNAVAILABLE')
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

async function readBoundedFile(path, maximum) {
  const initial = await lstat(path)
  if (initial.isSymbolicLink() || !initial.isFile() || initial.size > maximum) {
    fail('E_EVIDENCE_INVALID')
  }
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > maximum || !sameIdentity(initial, opened)) {
      fail('E_EVIDENCE_INVALID')
    }
    const content = await handle.readFile()
    if (content.byteLength > maximum) fail('E_EVIDENCE_INVALID')
    const final = await lstat(path)
    if (final.isSymbolicLink() || !final.isFile() || !sameIdentity(opened, final)) {
      fail('E_EVIDENCE_INVALID')
    }
    return content
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeNew(path, value, stagingDirectory = dirname(path)) {
  const data = serializedJson(value)
  const temporary = join(stagingDirectory, `.m09-evidence-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(temporary, path)
    await syncDirectory(dirname(path))
    return digest(data)
  } finally {
    await unlink(temporary).catch(() => undefined)
    await syncDirectory(stagingDirectory).catch(() => undefined)
  }
}

function normalizeFileManifest(value, expectedKind) {
  exactKeys(value, ['files', 'kind', 'sha256'])
  if (value.kind !== expectedKind || !Array.isArray(value.files) || value.files.length === 0) {
    fail('E_EVIDENCE_INVALID')
  }
  const files = value.files.map((entry) => {
    exactKeys(entry, ['path', 'sha256'])
    const path = boundedText(entry.path, 256)
    const sha256 = boundedText(entry.sha256, 64)
    if (
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').includes('..') ||
      !/^[a-zA-Z0-9._/@-]+(?:\/[a-zA-Z0-9._@-]+)*$/u.test(path) ||
      !/^[a-f0-9]{64}$/u.test(sha256)
    ) {
      fail('E_EVIDENCE_INVALID')
    }
    return { path, sha256 }
  })
  const paths = files.map((entry) => entry.path)
  if (!isDeepStrictEqual(paths, [...paths].sort()) || new Set(paths).size !== paths.length) {
    fail('E_EVIDENCE_INVALID')
  }
  const sha256 = boundedText(value.sha256, 64)
  if (!/^[a-f0-9]{64}$/u.test(sha256) || sha256 !== digest(JSON.stringify(files))) {
    fail('E_EVIDENCE_INVALID')
  }
  return { kind: expectedKind, files, sha256 }
}

function normalizeToolchain(value) {
  exactKeys(value, [
    'gitPath',
    'installMode',
    'loginctlPath',
    'nodePath',
    'nodeVersion',
    'packageManager',
    'pnpmEntryPath',
    'pnpmEntrySha256',
    'pnpmRootPath',
    'pnpmRuntimeFiles',
    'pnpmRuntimeSha256',
    'pnpmRuntimeUnpackedSize',
    'pnpmTarballIntegrity',
    'pnpmTrustManifestSha256',
    'pnpmVersion',
    'storePath',
    'systemctlPath',
    'tsdownVersion',
  ])
  const toolchain = {
    gitPath: pathInput(value.gitPath),
    installMode: value.installMode,
    loginctlPath: pathInput(value.loginctlPath),
    nodePath: pathInput(value.nodePath),
    nodeVersion: boundedText(value.nodeVersion, 64),
    packageManager: boundedText(value.packageManager, 64),
    pnpmEntryPath: pathInput(value.pnpmEntryPath),
    pnpmEntrySha256: boundedText(value.pnpmEntrySha256, 64),
    pnpmRootPath: pathInput(value.pnpmRootPath),
    pnpmRuntimeFiles: safeInteger(value.pnpmRuntimeFiles, true),
    pnpmRuntimeSha256: boundedText(value.pnpmRuntimeSha256, 64),
    pnpmRuntimeUnpackedSize: safeInteger(value.pnpmRuntimeUnpackedSize, true),
    pnpmTarballIntegrity: boundedText(value.pnpmTarballIntegrity, 128),
    pnpmTrustManifestSha256: boundedText(value.pnpmTrustManifestSha256, 64),
    pnpmVersion: boundedText(value.pnpmVersion, 64),
    storePath: pathInput(value.storePath),
    systemctlPath: pathInput(value.systemctlPath),
    tsdownVersion: boundedText(value.tsdownVersion, 64),
  }
  if (
    toolchain.installMode !== ISOLATED_INSTALL_MODE ||
    !/^v(?:22|2[4-9]|[3-9][0-9])\.[0-9]+\.[0-9]+$/u.test(toolchain.nodeVersion) ||
    !/^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/u.test(toolchain.packageManager) ||
    !/^[a-f0-9]{64}$/u.test(toolchain.pnpmEntrySha256) ||
    !/^[a-f0-9]{64}$/u.test(toolchain.pnpmRuntimeSha256) ||
    !/^sha512-[a-zA-Z0-9+/]{86}==$/u.test(toolchain.pnpmTarballIntegrity) ||
    !/^[a-f0-9]{64}$/u.test(toolchain.pnpmTrustManifestSha256) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(toolchain.pnpmVersion) ||
    toolchain.packageManager !== `pnpm@${toolchain.pnpmVersion}` ||
    !outsideRepository(toolchain.pnpmEntryPath) ||
    !outsideRepository(toolchain.pnpmRootPath) ||
    !withinDirectory(toolchain.pnpmRootPath, toolchain.pnpmEntryPath) ||
    !outsideRepository(toolchain.storePath) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u.test(toolchain.tsdownVersion)
  ) {
    fail('E_EVIDENCE_INVALID')
  }
  return toolchain
}

function assertBuildInputManifest(manifest) {
  const paths = manifest.files.map((entry) => entry.path)
  if (
    REQUIRED_BUILD_INPUTS.some((path) => !paths.includes(path)) ||
    !paths.includes('packages/core/src/index.ts') ||
    !paths.includes('packages/dsh-luban-server-mode/src/operator-cli.ts') ||
    !paths.includes('packages/dsh-luban-server-mode/src/process-runner.ts') ||
    !paths.includes('packages/dsh-luban-server-mode/src/systemd.ts') ||
    paths.some(
      (path) =>
        !REQUIRED_BUILD_INPUTS.includes(path) &&
        !/^packages\/(?:core|dsh-luban-server-mode)\/src\/[a-zA-Z0-9._/-]+\.tsx?$/u.test(path),
    )
  ) {
    fail('E_EVIDENCE_INVALID')
  }
}

function normalizeSource(value) {
  exactKeys(value, [
    'buildInputs',
    'freshBuild',
    'gitHead',
    'operatorRuntime',
    'runnerSha256',
    'toolchain',
  ])
  const buildInputs = normalizeFileManifest(value.buildInputs, 'head-build-inputs')
  assertBuildInputManifest(buildInputs)
  const source = {
    buildInputs,
    freshBuild: normalizeFileManifest(value.freshBuild, 'fresh-head-build-javascript'),
    gitHead: boundedText(value.gitHead, 64),
    operatorRuntime: normalizeFileManifest(value.operatorRuntime, 'complete-runtime-closure'),
    runnerSha256: boundedText(value.runnerSha256, 64),
    toolchain: normalizeToolchain(value.toolchain),
  }
  if (!/^[a-f0-9]{40,64}$/u.test(source.gitHead) || !/^[a-f0-9]{64}$/u.test(source.runnerSha256)) {
    fail('E_EVIDENCE_INVALID')
  }
  const runtimePaths = source.operatorRuntime.files.map((entry) => entry.path)
  const trustManifest = source.buildInputs.files.find(
    (entry) => entry.path === PNPM_TRUST_REPOSITORY_PATH,
  )
  const fixedRuntimePaths = [
    'packages/core/dist/index.js',
    'packages/core/package.json',
    'packages/dsh-luban-server-mode/dist/operator-cli.js',
    'packages/dsh-luban-server-mode/package.json',
  ]
  if (
    runtimePaths.length !== 6 ||
    trustManifest === undefined ||
    trustManifest.sha256 !== source.toolchain.pnpmTrustManifestSha256 ||
    fixedRuntimePaths.some((path) => !runtimePaths.includes(path)) ||
    runtimePaths.filter((path) => /\/dist\/process-runner-[a-zA-Z0-9_-]+\.js$/u.test(path))
      .length !== 1 ||
    runtimePaths.filter((path) => /\/dist\/systemd-[a-zA-Z0-9_-]+\.js$/u.test(path)).length !== 1 ||
    !source.freshBuild.files.some(
      (entry) => entry.path === 'packages/dsh-luban-server-mode/dist/operator-cli.js',
    ) ||
    !source.freshBuild.files.some((entry) => entry.path === 'packages/core/dist/index.js')
  ) {
    fail('E_EVIDENCE_INVALID')
  }
  return source
}

function normalizeHost(value) {
  exactKeys(value, [
    'bootId',
    'hostnameSha256',
    'linger',
    'machineIdSha256',
    'source',
    'ubuntuVersion',
    'uid',
    'user',
  ])
  const host = {
    bootId: boundedText(value.bootId, 64),
    hostnameSha256: boundedText(value.hostnameSha256, 64),
    linger: value.linger,
    machineIdSha256: boundedText(value.machineIdSha256, 64),
    source: normalizeSource(value.source),
    ubuntuVersion: boundedText(value.ubuntuVersion, 64),
    uid: safeInteger(value.uid, true),
    user: boundedText(value.user, 64),
  }
  if (
    !/^[a-f0-9-]{16,64}$/u.test(host.bootId) ||
    !/^[a-f0-9]{64}$/u.test(host.machineIdSha256) ||
    !/^[a-f0-9]{64}$/u.test(host.hostnameSha256) ||
    host.linger !== 'yes' ||
    !/^[a-z_][a-z0-9_.-]{0,63}$/u.test(host.user)
  ) {
    fail('E_EVIDENCE_INVALID')
  }
  return host
}

function normalizePreflight(value) {
  exactKeys(value, ['linger', 'ready', 'schemaVersion', 'service', 'unit', 'unitPath', 'user'])
  const result = {
    schemaVersion: value.schemaVersion,
    service: value.service,
    user: boundedText(value.user, 64),
    unitPath: pathInput(value.unitPath),
    linger: value.linger,
    unit: value.unit,
    ready: value.ready,
  }
  if (
    result.schemaVersion !== 1 ||
    result.service !== SERVICE ||
    result.linger !== 'enabled' ||
    result.unit !== 'missing' ||
    result.ready !== true
  ) {
    fail('E_UNAVAILABLE')
  }
  return result
}

function normalizeStatus(value, expectedState) {
  exactKeys(value, [
    'active',
    'enabled',
    'linger',
    'schemaVersion',
    'service',
    'unit',
    'unitPath',
    'user',
  ])
  const status = {
    schemaVersion: value.schemaVersion,
    service: value.service,
    user: boundedText(value.user, 64),
    unitPath: pathInput(value.unitPath),
    linger: value.linger,
    unit: value.unit,
    enabled: value.enabled,
    active: value.active,
  }
  const ready =
    expectedState === 'absent'
      ? status.unit === 'missing' && status.enabled === 'not-found' && status.active === 'inactive'
      : expectedState === 'owned'
        ? status.unit === 'exact' &&
          ['enabled', 'disabled', 'not-found'].includes(status.enabled) &&
          ['active', 'inactive'].includes(status.active)
        : status.unit === 'exact' && status.enabled === 'enabled' && status.active === 'active'
  if (
    status.schemaVersion !== 1 ||
    status.service !== SERVICE ||
    status.linger !== 'enabled' ||
    !ready
  ) {
    fail('E_UNAVAILABLE')
  }
  return status
}

function normalizeProperties(value, expectedState, unitPath) {
  exactKeys(value, [
    'activeEnterTimestampMonotonic',
    'activeState',
    'dropInPaths',
    'environment',
    'fragmentPath',
    'id',
    'invocationId',
    'loadState',
    'mainPid',
    'needDaemonReload',
    'subState',
    'type',
    'unitFileState',
  ])
  const properties = {
    id: value.id,
    invocationId: boundedOptionalText(value.invocationId, 64),
    loadState: value.loadState,
    fragmentPath: boundedOptionalText(value.fragmentPath),
    dropInPaths: boundedOptionalText(value.dropInPaths),
    needDaemonReload: value.needDaemonReload,
    unitFileState: value.unitFileState,
    activeState: value.activeState,
    subState: value.subState,
    mainPid: safeInteger(value.mainPid),
    type: boundedOptionalText(value.type, 64),
    activeEnterTimestampMonotonic: safeInteger(value.activeEnterTimestampMonotonic),
    environment: boundedOptionalText(value.environment),
  }
  if (properties.id !== SERVICE || properties.needDaemonReload !== 'no') {
    fail('E_UNAVAILABLE')
  }
  if (expectedState === 'absent') {
    if (
      properties.loadState !== 'not-found' ||
      properties.fragmentPath !== '' ||
      properties.dropInPaths !== '' ||
      properties.unitFileState !== 'not-found' ||
      properties.activeState !== 'inactive' ||
      properties.subState !== 'dead' ||
      properties.mainPid !== 0 ||
      properties.invocationId !== '' ||
      properties.type !== '' ||
      properties.activeEnterTimestampMonotonic !== 0 ||
      properties.environment !== ''
    ) {
      fail('E_UNAVAILABLE')
    }
    return properties
  }
  const sentinelCount = properties.environment.split('LUBAN_BOOT_RESTORE=').length - 1
  const exactSentinel = /(?:^|\s|")LUBAN_BOOT_RESTORE=1(?=$|\s|")/u.test(properties.environment)
  if (
    properties.loadState !== 'loaded' ||
    resolve(properties.fragmentPath) !== resolve(unitPath) ||
    properties.dropInPaths !== '' ||
    properties.unitFileState !== 'enabled' ||
    properties.activeState !== 'active' ||
    properties.subState !== 'running' ||
    properties.mainPid <= 0 ||
    !/^[a-f0-9]{32}$/u.test(properties.invocationId) ||
    properties.type !== 'exec' ||
    properties.activeEnterTimestampMonotonic <= 0 ||
    sentinelCount !== 1 ||
    !exactSentinel
  ) {
    fail('E_UNAVAILABLE')
  }
  return properties
}

function normalizeOwnership(value, unitPath) {
  exactKeys(value, ['device', 'inode', 'sha256', 'size', 'unitPath'])
  const ownership = {
    unitPath: pathInput(value.unitPath),
    sha256: boundedText(value.sha256, 64),
    device: boundedText(value.device, 32),
    inode: boundedText(value.inode, 32),
    size: safeInteger(value.size, true),
  }
  if (
    resolve(ownership.unitPath) !== resolve(unitPath) ||
    !/^[a-f0-9]{64}$/u.test(ownership.sha256) ||
    !/^[0-9]+$/u.test(ownership.device) ||
    !/^[0-9]+$/u.test(ownership.inode)
  ) {
    fail('E_OWNERSHIP')
  }
  return ownership
}

function normalizeSession(value, host) {
  exactKeys(value, ['earliestTimestampMonotonic', 'id', 'timestampMonotonic', 'uid', 'user'])
  const session = {
    earliestTimestampMonotonic: safeInteger(value.earliestTimestampMonotonic, true),
    id: boundedText(value.id, 128),
    timestampMonotonic: safeInteger(value.timestampMonotonic, true),
    uid: safeInteger(value.uid, true),
    user: boundedText(value.user, 64),
  }
  if (
    !/^[a-zA-Z0-9_.:-]+$/u.test(session.id) ||
    session.user !== host.user ||
    session.uid !== host.uid ||
    session.earliestTimestampMonotonic > session.timestampMonotonic
  ) {
    fail('E_UNAVAILABLE')
  }
  return session
}

function normalizeCliEnvelope(result, command, expectedMode) {
  exactKeys(result, ['envelope', 'exitCode'])
  if (!Number.isSafeInteger(result.exitCode) || !isRecord(result.envelope)) fail('E_UNAVAILABLE')
  if (result.exitCode !== 0) fail('E_UNAVAILABLE')
  const envelope = result.envelope
  if (envelope.schemaVersion !== 1 || envelope.ok !== true || envelope.command !== command) {
    fail('E_UNAVAILABLE')
  }
  if (envelope.mode !== expectedMode) fail('E_UNAVAILABLE')
  return envelope
}

function preflightFromCli(result) {
  const envelope = normalizeCliEnvelope(result, 'preflight', 'read-only')
  exactKeys(envelope, ['command', 'mode', 'ok', 'preflight', 'schemaVersion'])
  return normalizePreflight(envelope.preflight)
}

function statusFromCli(result, expectedState) {
  const envelope = normalizeCliEnvelope(result, 'status', 'read-only')
  exactKeys(envelope, ['command', 'mode', 'ok', 'schemaVersion', 'status'])
  return normalizeStatus(envelope.status, expectedState)
}

function confirmedOperation(command, user, recovered) {
  return {
    command,
    phase: 'confirmed',
    recovered,
    service: SERVICE,
    user,
  }
}

function attemptedOperation(command, user) {
  return {
    command,
    phase: 'attempt',
    service: SERVICE,
    user,
  }
}

function operationFromCli(result, command, user) {
  const envelope = normalizeCliEnvelope(result, command, 'apply')
  exactKeys(envelope, ['applied', 'command', 'mode', 'ok', 'schemaVersion', 'service', 'user'])
  if (envelope.applied !== true || envelope.service !== SERVICE || envelope.user !== user) {
    fail('E_UNAVAILABLE')
  }
  return confirmedOperation(command, user, false)
}

function normalizeOperation(value, stage, user) {
  const attempt = stage === 'install-attempted' || stage === 'cleanup-attempted'
  const confirmed = stage === 'installed' || stage === 'cleaned'
  if (!attempt && !confirmed) {
    if (value !== null) fail('E_EVIDENCE_INVALID')
    return null
  }
  const command = stage.startsWith('install') ? 'install' : 'uninstall'
  exactKeys(
    value,
    attempt
      ? ['command', 'phase', 'service', 'user']
      : ['command', 'phase', 'recovered', 'service', 'user'],
  )
  if (
    value.command !== command ||
    value.phase !== (attempt ? 'attempt' : 'confirmed') ||
    value.service !== SERVICE ||
    value.user !== user ||
    (confirmed && typeof value.recovered !== 'boolean')
  ) {
    fail('E_EVIDENCE_INVALID')
  }
  return { ...value }
}

function normalizeSnapshot(value, expectedState, marker, stage) {
  exactKeys(value, ['host', 'ownership', 'preflight', 'properties', 'session', 'status'])
  const host = normalizeHost(value.host)
  assertBinding(marker, host)
  const preflight = value.preflight === null ? null : normalizePreflight(value.preflight)
  const status = normalizeStatus(value.status, expectedState)
  if (
    status.user !== marker.binding.user ||
    resolve(status.unitPath) !== resolve(marker.binding.unitPath) ||
    (stage === 'preflight-verified') !== (preflight !== null)
  ) {
    fail('E_EVIDENCE_INVALID')
  }
  if (
    preflight !== null &&
    (preflight.user !== marker.binding.user ||
      resolve(preflight.unitPath) !== resolve(marker.binding.unitPath))
  ) {
    fail('E_EVIDENCE_INVALID')
  }
  const properties = normalizeProperties(value.properties, expectedState, marker.binding.unitPath)
  const ownership =
    value.ownership === null ? null : normalizeOwnership(value.ownership, marker.binding.unitPath)
  const session = value.session === null ? null : normalizeSession(value.session, host)
  if (
    (stage === 'preflight-verified' || stage === 'install-attempted') &&
    (ownership !== null || session !== null)
  ) {
    fail('E_EVIDENCE_INVALID')
  }
  if (stage !== 'preflight-verified' && stage !== 'install-attempted' && ownership === null) {
    fail('E_EVIDENCE_INVALID')
  }
  if (['reboot-verified', 'cleanup-attempted', 'cleaned'].includes(stage) !== (session !== null)) {
    fail('E_EVIDENCE_INVALID')
  }
  return { host, preflight, status, properties, ownership, session }
}

function normalizeMarker(value, runDir) {
  exactKeys(value, ['binding', 'createdAt', 'evidenceKind', 'runDir', 'runId', 'schemaVersion'])
  if (
    value.schemaVersion !== MARKER_SCHEMA ||
    value.runDir !== runDir ||
    !['operator-attested', 'simulated'].includes(value.evidenceKind) ||
    !/^[a-f0-9-]{36}$/iu.test(value.runId)
  ) {
    fail('E_EVIDENCE_INVALID')
  }
  exactKeys(value.binding, [
    'hostnameSha256',
    'machineIdSha256',
    'service',
    'source',
    'ubuntuVersion',
    'uid',
    'unitPath',
    'user',
  ])
  const binding = {
    hostnameSha256: boundedText(value.binding.hostnameSha256, 64),
    machineIdSha256: boundedText(value.binding.machineIdSha256, 64),
    service: value.binding.service,
    source: normalizeSource(value.binding.source),
    ubuntuVersion: boundedText(value.binding.ubuntuVersion, 64),
    uid: safeInteger(value.binding.uid, true),
    unitPath: pathInput(value.binding.unitPath),
    user: boundedText(value.binding.user, 64),
  }
  if (
    binding.service !== SERVICE ||
    !/^[a-f0-9]{64}$/u.test(binding.machineIdSha256) ||
    !/^[a-f0-9]{64}$/u.test(binding.hostnameSha256)
  ) {
    fail('E_EVIDENCE_INVALID')
  }
  return {
    schemaVersion: MARKER_SCHEMA,
    evidenceKind: value.evidenceKind,
    runId: value.runId,
    createdAt: safeInteger(value.createdAt),
    runDir,
    binding,
  }
}

function assertBinding(marker, host) {
  if (
    marker.binding.machineIdSha256 !== host.machineIdSha256 ||
    marker.binding.hostnameSha256 !== host.hostnameSha256 ||
    marker.binding.ubuntuVersion !== host.ubuntuVersion ||
    marker.binding.user !== host.user ||
    marker.binding.uid !== host.uid ||
    !isDeepStrictEqual(marker.binding.source, host.source)
  ) {
    fail('E_UNAVAILABLE')
  }
}

function normalizeEvidence(value, marker, markerSha256, expectedSequence, previousSha256) {
  exactKeys(value, [
    'acceptancePassed',
    'evidenceKind',
    'markerSha256',
    'operation',
    'previousSha256',
    'recordedAt',
    'runId',
    'safety',
    'schemaVersion',
    'scope',
    'sequence',
    'snapshot',
    'stage',
  ])
  const stage = STAGES[expectedSequence - 1]
  if (
    value.schemaVersion !== EVIDENCE_SCHEMA ||
    value.scope !== SCOPE ||
    value.sequence !== expectedSequence ||
    value.stage !== stage ||
    value.runId !== marker.runId ||
    value.evidenceKind !== marker.evidenceKind ||
    value.markerSha256 !== markerSha256 ||
    value.previousSha256 !== previousSha256
  ) {
    fail('E_EVIDENCE_INVALID')
  }
  exactKeys(value.safety, [
    'disconnectCommandExecuted',
    'lingerChanged',
    'logoutCommandExecuted',
    'rebootCommandExecuted',
  ])
  if (Object.values(value.safety).some((item) => item !== false)) fail('E_EVIDENCE_INVALID')
  const expectedPass = marker.evidenceKind === 'operator-attested' && stage === 'cleaned'
  if (value.acceptancePassed !== expectedPass) fail('E_EVIDENCE_INVALID')
  const expectedState =
    stage === 'preflight-verified' || stage === 'install-attempted' || stage === 'cleaned'
      ? 'absent'
      : 'ready'
  const snapshot = normalizeSnapshot(value.snapshot, expectedState, marker, stage)
  return {
    ...value,
    recordedAt: safeInteger(value.recordedAt),
    operation: normalizeOperation(value.operation, stage, marker.binding.user),
    snapshot,
  }
}

function assertTransitions(records) {
  for (let index = 1; index < records.length; index += 1) {
    if (records[index].recordedAt < records[index - 1].recordedAt) fail('E_EVIDENCE_INVALID')
  }
  const preflight = records[0]?.snapshot
  const installAttempt = records[1]?.snapshot
  const installed = records[2]?.snapshot
  const armed = records[3]?.snapshot
  const rebooted = records[4]?.snapshot
  const cleanupAttempt = records[5]?.snapshot
  const cleaned = records[6]?.snapshot
  if (installAttempt !== undefined && installAttempt.host.bootId !== preflight.host.bootId) {
    fail('E_EVIDENCE_INVALID')
  }
  if (installed !== undefined) {
    if (installed.host.bootId !== installAttempt.host.bootId) fail('E_EVIDENCE_INVALID')
  }
  if (armed !== undefined) {
    if (
      armed.host.bootId !== installed.host.bootId ||
      armed.properties.mainPid !== installed.properties.mainPid ||
      armed.properties.invocationId !== installed.properties.invocationId ||
      !isDeepStrictEqual(armed.ownership, installed.ownership)
    ) {
      fail('E_EVIDENCE_INVALID')
    }
  }
  if (rebooted !== undefined) {
    if (
      rebooted.host.bootId === installed.host.bootId ||
      rebooted.properties.invocationId === installed.properties.invocationId ||
      !isDeepStrictEqual(rebooted.ownership, installed.ownership) ||
      rebooted.properties.activeEnterTimestampMonotonic >=
        rebooted.session.earliestTimestampMonotonic
    ) {
      fail('E_EVIDENCE_INVALID')
    }
  }
  if (cleanupAttempt !== undefined) {
    if (
      cleanupAttempt.host.bootId !== rebooted.host.bootId ||
      cleanupAttempt.properties.mainPid !== rebooted.properties.mainPid ||
      cleanupAttempt.properties.invocationId !== rebooted.properties.invocationId ||
      !isDeepStrictEqual(cleanupAttempt.ownership, rebooted.ownership) ||
      !isDeepStrictEqual(cleanupAttempt.session, rebooted.session)
    ) {
      fail('E_EVIDENCE_INVALID')
    }
  }
  if (cleaned !== undefined) {
    if (
      cleaned.host.bootId !== cleanupAttempt.host.bootId ||
      !isDeepStrictEqual(cleaned.ownership, cleanupAttempt.ownership) ||
      !isDeepStrictEqual(cleaned.session, cleanupAttempt.session)
    ) {
      fail('E_EVIDENCE_INVALID')
    }
  }
}

async function loadRun(runDir) {
  await assertRunLocation(runDir, true)
  const rootEntries = (await readdir(runDir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  if (
    rootEntries.length !== 2 ||
    rootEntries[0].name !== 'evidence' ||
    !rootEntries[0].isDirectory() ||
    rootEntries[1].name !== 'owner.json' ||
    !rootEntries[1].isFile()
  ) {
    fail('E_EVIDENCE_INVALID')
  }
  await assertSafeDirectory(join(runDir, 'evidence'), true)
  const markerData = await readBoundedFile(join(runDir, 'owner.json'), MAX_JSON_BYTES)
  let markerValue
  try {
    markerValue = JSON.parse(markerData.toString('utf8'))
  } catch {
    fail('E_EVIDENCE_INVALID')
  }
  const marker = normalizeMarker(markerValue, runDir)
  const markerSha256 = digest(markerData)
  const entries = await readdir(join(runDir, 'evidence'), { withFileTypes: true })
  if (entries.length < 1 || entries.length > EVIDENCE_FILES.length) fail('E_EVIDENCE_INVALID')
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const records = []
  let previousSha256 = null
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry.isFile() || entry.name !== EVIDENCE_FILES[index]) fail('E_EVIDENCE_INVALID')
    const data = await readBoundedFile(join(runDir, 'evidence', entry.name), MAX_JSON_BYTES)
    let value
    try {
      value = JSON.parse(data.toString('utf8'))
    } catch {
      fail('E_EVIDENCE_INVALID')
    }
    records.push(normalizeEvidence(value, marker, markerSha256, index + 1, previousSha256))
    previousSha256 = digest(data)
  }
  assertTransitions(records)
  return { marker, markerSha256, records, previousSha256 }
}

function markerFor(runDir, evidenceKind, snapshot, now) {
  return {
    schemaVersion: MARKER_SCHEMA,
    evidenceKind,
    runId: randomUUID(),
    createdAt: now,
    runDir,
    binding: {
      hostnameSha256: snapshot.host.hostnameSha256,
      machineIdSha256: snapshot.host.machineIdSha256,
      service: SERVICE,
      source: snapshot.host.source,
      ubuntuVersion: snapshot.host.ubuntuVersion,
      uid: snapshot.host.uid,
      unitPath: snapshot.status.unitPath,
      user: snapshot.host.user,
    },
  }
}

function recordFor(run, stage, snapshot, operation, now) {
  const sequence = STAGES.indexOf(stage) + 1
  return {
    schemaVersion: EVIDENCE_SCHEMA,
    scope: SCOPE,
    sequence,
    stage,
    runId: run.marker.runId,
    evidenceKind: run.marker.evidenceKind,
    markerSha256: run.markerSha256,
    previousSha256: run.previousSha256,
    recordedAt: now,
    acceptancePassed: run.marker.evidenceKind === 'operator-attested' && stage === 'cleaned',
    operation,
    snapshot,
    safety: {
      disconnectCommandExecuted: false,
      lingerChanged: false,
      logoutCommandExecuted: false,
      rebootCommandExecuted: false,
    },
  }
}

async function createRun(runDir, evidenceKind, snapshot, now) {
  await assertRunLocation(runDir, false)
  const marker = markerFor(runDir, evidenceKind, snapshot, now)
  const temporary = join(dirname(runDir), `.${basename(runDir)}.${randomUUID()}.tmp`)
  await mkdir(temporary, { mode: 0o700 })
  try {
    await mkdir(join(temporary, 'evidence'), { mode: 0o700 })
    const markerSha256 = await writeNew(join(temporary, 'owner.json'), marker, dirname(runDir))
    const run = { marker, markerSha256, records: [], previousSha256: null }
    await writeNew(
      join(temporary, 'evidence', EVIDENCE_FILES[0]),
      recordFor(run, 'preflight-verified', snapshot, null, now),
      dirname(runDir),
    )
    await rename(temporary, runDir)
    await syncDirectory(dirname(runDir))
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  return await loadRun(runDir)
}

async function appendRecord(runDir, run, stage, snapshot, operation, now, beforeCommit) {
  const expectedSequence = run.records.length + 1
  if (STAGES[expectedSequence - 1] !== stage) fail('E_STAGE_ORDER')
  if (beforeCommit !== undefined) await beforeCommit(stage)
  await writeNew(
    join(runDir, 'evidence', EVIDENCE_FILES[expectedSequence - 1]),
    recordFor(run, stage, snapshot, operation, now),
    dirname(runDir),
  )
  return await loadRun(runDir)
}

function assertStage(run, stage) {
  if (run.records.at(-1)?.stage !== stage) fail('E_STAGE_ORDER')
}

async function captureAbsent(operator, expectedMarker) {
  const source = normalizeSource(await operator.source())
  const rawHost = await operator.host()
  const host = normalizeHost({ ...rawHost, source })
  if (expectedMarker !== undefined) assertBinding(expectedMarker, host)
  const preflight = preflightFromCli(
    await operator.cli({ command: 'preflight', apply: false, user: host.user }),
  )
  const status = statusFromCli(
    await operator.cli({ command: 'status', apply: false, user: host.user }),
    'absent',
  )
  if (
    preflight.user !== host.user ||
    status.user !== host.user ||
    resolve(preflight.unitPath) !== resolve(status.unitPath)
  ) {
    fail('E_UNAVAILABLE')
  }
  if (
    expectedMarker !== undefined &&
    resolve(status.unitPath) !== resolve(expectedMarker.binding.unitPath)
  ) {
    fail('E_UNAVAILABLE')
  }
  const properties = normalizeProperties(
    await operator.serviceProperties(),
    'absent',
    status.unitPath,
  )
  return { host, preflight, status, properties, ownership: null, session: null }
}

async function captureReady(operator, marker, includeSession) {
  const source = normalizeSource(await operator.source())
  const host = normalizeHost({ ...(await operator.host()), source })
  assertBinding(marker, host)
  const status = statusFromCli(
    await operator.cli({ command: 'status', apply: false, user: host.user }),
    'ready',
  )
  if (
    status.user !== marker.binding.user ||
    resolve(status.unitPath) !== resolve(marker.binding.unitPath)
  ) {
    fail('E_UNAVAILABLE')
  }
  const properties = normalizeProperties(
    await operator.serviceProperties(),
    'ready',
    marker.binding.unitPath,
  )
  const ownership = normalizeOwnership(
    await operator.unitOwnership(marker.binding.unitPath),
    marker.binding.unitPath,
  )
  const session = includeSession ? normalizeSession(await operator.currentSession(), host) : null
  return { host, preflight: null, status, properties, ownership, session }
}

async function captureOwned(operator, marker) {
  const source = normalizeSource(await operator.source())
  const host = normalizeHost({ ...(await operator.host()), source })
  assertBinding(marker, host)
  const status = statusFromCli(
    await operator.cli({ command: 'status', apply: false, user: host.user }),
    'owned',
  )
  if (
    status.user !== marker.binding.user ||
    resolve(status.unitPath) !== resolve(marker.binding.unitPath)
  ) {
    fail('E_UNAVAILABLE')
  }
  const ownership = normalizeOwnership(
    await operator.unitOwnership(marker.binding.unitPath),
    marker.binding.unitPath,
  )
  return { host, status, ownership }
}

function assertCurrentOwnership(snapshot, expected) {
  if (!isDeepStrictEqual(snapshot.ownership, expected)) fail('E_OWNERSHIP')
}

function plan(command, runDir) {
  return safeResult(0, {
    schemaVersion: 1,
    ok: true,
    scope: SCOPE,
    mode: 'plan',
    requestedStage: command,
    acceptancePassed: false,
    ...(runDir === undefined ? {} : { runDir }),
    stages: [
      { stage: 'preflight', writesEvidence: true, mutatesSystem: false },
      { stage: 'install', writesEvidence: true, mutatesSystem: true, requiresApply: true },
      { stage: 'arm-reboot', writesEvidence: true, mutatesSystem: false },
      { stage: 'human-reboot', automated: false, mutatesSystem: true },
      { stage: 'verify-reboot', writesEvidence: true, mutatesSystem: false },
      { stage: 'cleanup', writesEvidence: true, mutatesSystem: true, requiresApply: true },
    ],
    evidenceProtocol: [
      'preflight-verified',
      'install-attempted',
      'installed',
      'reboot-armed',
      'reboot-verified',
      'cleanup-attempted',
      'cleaned',
    ],
    prerequisites: [
      'Ubuntu host and current non-root user',
      'loginctl Linger=yes (enabled externally by an authorized operator)',
      'clean tracked Git HEAD and freshly built luban-server-mode operator CLI',
      'absolute evidence run directory outside the repository',
    ],
    humanBoundary: {
      enableLinger: 'external authorization required; never executed by this runner',
      reboot: 'run only after arm-reboot; never executed by this runner',
      logoutOrDisconnect: 'optional external action; never executed by this runner',
    },
    safety: {
      disconnectCommandExecuted: false,
      lingerChanged: false,
      logoutCommandExecuted: false,
      rebootCommandExecuted: false,
      systemdMutationExecuted: false,
      evidenceWritten: false,
    },
  })
}

function stageOutput(run, idempotent = false) {
  const latest = run.records.at(-1)
  return safeResult(0, {
    schemaVersion: 1,
    ok: true,
    scope: SCOPE,
    mode:
      latest.operation === null
        ? 'record'
        : latest.operation.phase === 'attempt'
          ? 'attempt'
          : 'apply',
    runId: run.marker.runId,
    evidenceKind: run.marker.evidenceKind,
    stage: latest.stage,
    sequence: latest.sequence,
    acceptancePassed: latest.acceptancePassed,
    idempotent,
    nextAction:
      latest.stage === 'reboot-armed'
        ? 'An authorized operator must reboot this same host, then run verify-reboot.'
        : latest.stage === 'reboot-verified'
          ? 'Run cleanup --apply to remove only the evidence-owned exact unit.'
          : latest.stage === 'cleaned'
            ? 'Acceptance evidence is complete and retained in the private run directory.'
            : null,
    safety: latest.safety,
  })
}

async function rollbackInstall(operator, marker) {
  try {
    operationFromCli(
      await operator.cli({ command: 'uninstall', apply: true, user: marker.binding.user }),
      'uninstall',
      marker.binding.user,
    )
    await captureAbsent(operator, marker)
  } catch {
    fail('E_ROLLBACK_FAILED')
  }
}

async function captureCurrentState(operator, marker, includeSession) {
  try {
    return { kind: 'ready', snapshot: await captureReady(operator, marker, includeSession) }
  } catch {
    try {
      return { kind: 'absent', snapshot: await captureAbsent(operator, marker) }
    } catch {
      try {
        return { kind: 'owned', snapshot: await captureOwned(operator, marker) }
      } catch {
        fail('E_UNAVAILABLE')
      }
    }
  }
}

function snapshotWithoutPreflight(snapshot) {
  return { ...snapshot, preflight: null }
}

function assertSameReadyInstance(snapshot, expected, includeSession) {
  if (
    snapshot.host.bootId !== expected.host.bootId ||
    snapshot.properties.mainPid !== expected.properties.mainPid ||
    snapshot.properties.invocationId !== expected.properties.invocationId ||
    !isDeepStrictEqual(snapshot.ownership, expected.ownership) ||
    (includeSession && !isDeepStrictEqual(snapshot.session, expected.session))
  ) {
    fail('E_OWNERSHIP')
  }
}

async function executeStage(parsed, dependencies, evidenceKind) {
  const platform = dependencies.platform ?? process.platform
  if (platform !== 'linux') fail('E_PLATFORM_UNSUPPORTED')
  const now = dependencies.now ?? Date.now
  const operator = dependencies.operator ?? defaultOperator()
  const beforeEvidenceCommit = dependencies.beforeEvidenceCommit
  const timestamp = () => safeInteger(now())
  const runDir = parsed.runDir
  if (runDir === undefined) fail('E_INVALID_INPUT')

  if (parsed.command === 'preflight') {
    const snapshot = await captureAbsent(operator)
    const run = await createRun(runDir, evidenceKind, snapshot, timestamp())
    return stageOutput(run)
  }

  let run = await loadRun(runDir)
  if (parsed.command === 'cleanup' && run.records.at(-1)?.stage === 'cleaned') {
    return stageOutput(run, true)
  }

  if (parsed.command === 'install') {
    if (run.records.at(-1)?.stage === 'installed') return stageOutput(run, true)
    if (run.records.at(-1)?.stage === 'preflight-verified') {
      const absent = snapshotWithoutPreflight(await captureAbsent(operator, run.marker))
      run = await appendRecord(
        runDir,
        run,
        'install-attempted',
        absent,
        attemptedOperation('install', run.marker.binding.user),
        timestamp(),
        beforeEvidenceCommit,
      )
    }
    assertStage(run, 'install-attempted')
    const current = await captureCurrentState(operator, run.marker, false)
    if (current.kind === 'ready') {
      run = await appendRecord(
        runDir,
        run,
        'installed',
        current.snapshot,
        confirmedOperation('install', run.marker.binding.user, true),
        timestamp(),
        beforeEvidenceCommit,
      )
      return stageOutput(run)
    }
    let operation
    try {
      operation = operationFromCli(
        await operator.cli({
          command: 'install',
          apply: true,
          user: run.marker.binding.user,
        }),
        'install',
        run.marker.binding.user,
      )
    } catch {
      await rollbackInstall(operator, run.marker)
      fail('E_UNAVAILABLE')
    }
    let snapshot
    try {
      snapshot = await captureReady(operator, run.marker, false)
    } catch {
      await rollbackInstall(operator, run.marker)
      fail('E_UNAVAILABLE')
    }
    run = await appendRecord(
      runDir,
      run,
      'installed',
      snapshot,
      operation,
      timestamp(),
      beforeEvidenceCommit,
    )
    return stageOutput(run)
  }

  if (parsed.command === 'arm-reboot') {
    if (run.records.at(-1)?.stage === 'reboot-armed') return stageOutput(run, true)
    assertStage(run, 'installed')
    const snapshot = await captureReady(operator, run.marker, false)
    assertCurrentOwnership(snapshot, run.records[2].snapshot.ownership)
    if (
      snapshot.host.bootId !== run.records[2].snapshot.host.bootId ||
      snapshot.properties.mainPid !== run.records[2].snapshot.properties.mainPid ||
      snapshot.properties.invocationId !== run.records[2].snapshot.properties.invocationId
    ) {
      fail('E_UNAVAILABLE')
    }
    run = await appendRecord(
      runDir,
      run,
      'reboot-armed',
      snapshot,
      null,
      timestamp(),
      beforeEvidenceCommit,
    )
    return stageOutput(run)
  }

  if (parsed.command === 'verify-reboot') {
    if (run.records.at(-1)?.stage === 'reboot-verified') return stageOutput(run, true)
    assertStage(run, 'reboot-armed')
    const installed = run.records[2].snapshot
    const snapshot = await captureReady(operator, run.marker, true)
    assertCurrentOwnership(snapshot, installed.ownership)
    if (
      snapshot.host.bootId === installed.host.bootId ||
      snapshot.properties.invocationId === installed.properties.invocationId ||
      snapshot.properties.activeEnterTimestampMonotonic >=
        snapshot.session.earliestTimestampMonotonic
    ) {
      fail('E_UNAVAILABLE')
    }
    run = await appendRecord(
      runDir,
      run,
      'reboot-verified',
      snapshot,
      null,
      timestamp(),
      beforeEvidenceCommit,
    )
    return stageOutput(run)
  }

  if (parsed.command === 'cleanup') {
    if (run.records.at(-1)?.stage === 'reboot-verified') {
      const verified = run.records[4].snapshot
      const before = await captureReady(operator, run.marker, true)
      assertSameReadyInstance(before, verified, true)
      run = await appendRecord(
        runDir,
        run,
        'cleanup-attempted',
        before,
        attemptedOperation('uninstall', run.marker.binding.user),
        timestamp(),
        beforeEvidenceCommit,
      )
    }
    assertStage(run, 'cleanup-attempted')
    const attempt = run.records[5].snapshot
    const current = await captureCurrentState(operator, run.marker, true)
    let operation
    let after
    if (current.kind === 'absent') {
      operation = confirmedOperation('uninstall', run.marker.binding.user, true)
      after = current.snapshot
    } else {
      if (current.kind === 'ready') {
        assertSameReadyInstance(current.snapshot, attempt, true)
      } else if (
        current.snapshot.host.bootId !== attempt.host.bootId ||
        !isDeepStrictEqual(current.snapshot.ownership, attempt.ownership)
      ) {
        fail('E_OWNERSHIP')
      }
      operation = operationFromCli(
        await operator.cli({ command: 'uninstall', apply: true, user: run.marker.binding.user }),
        'uninstall',
        run.marker.binding.user,
      )
      after = await captureAbsent(operator, run.marker)
    }
    const snapshot = {
      ...snapshotWithoutPreflight(after),
      ownership: attempt.ownership,
      session: attempt.session,
    }
    run = await appendRecord(
      runDir,
      run,
      'cleaned',
      snapshot,
      operation,
      timestamp(),
      beforeEvidenceCommit,
    )
    return stageOutput(run)
  }

  fail('E_INVALID_INPUT')
}

function parseCommandJson(stdout) {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_COMMAND_BYTES) fail('E_UNAVAILABLE')
  try {
    return JSON.parse(stdout)
  } catch {
    fail('E_UNAVAILABLE')
  }
}

async function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  const maximum = options.maximum ?? MAX_COMMAND_BYTES
  return await new Promise((resolvePromise, rejectPromise) => {
    let stdout = Buffer.alloc(0)
    let stderrBytes = 0
    let settled = false
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPOSITORY_ROOT,
      env: options.env ?? {},
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const abort = () => {
      child.kill('SIGKILL')
      finish(() => rejectPromise(new AcceptanceError('E_UNAVAILABLE')))
    }
    child.stdout.on('data', (chunk) => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)])
      if (stdout.byteLength > maximum) abort()
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > maximum) abort()
    })
    child.once('error', abort)
    child.once('close', (code) => {
      finish(() =>
        resolvePromise({
          exitCode: Number.isSafeInteger(code) ? code : 1,
          stdout: options.binary === true ? stdout : stdout.toString('utf8'),
        }),
      )
    })
    const timer = setTimeout(abort, timeoutMs)
    timer.unref()
  })
}

function commandValue(result) {
  if (result.exitCode !== 0) fail('E_UNAVAILABLE')
  return result.stdout.trim()
}

function parsePropertyLines(stdout, expectedKeys) {
  const values = new Map()
  const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n')
  for (const line of lines) {
    const separator = line.indexOf('=')
    if (separator <= 0) fail('E_UNAVAILABLE')
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (!expectedKeys.includes(key) || values.has(key) || containsControl(value)) {
      fail('E_UNAVAILABLE')
    }
    values.set(key, value)
  }
  if (values.size !== expectedKeys.length) fail('E_UNAVAILABLE')
  return values
}

function parseDecimal(value) {
  if (!/^[0-9]+$/u.test(value)) fail('E_UNAVAILABLE')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) fail('E_UNAVAILABLE')
  return parsed
}

const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  'DBUS_SESSION_BUS_ADDRESS',
  'HOME',
  'LOGNAME',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'XDG_RUNTIME_DIR',
])

/** Build a minimal child environment and reject Node/Git process injection. */
export function createM09ChildEnvironment(source, pathValue, platform = process.platform) {
  if (!isRecord(source) || typeof pathValue !== 'string' || pathValue === '') {
    fail('E_UNAVAILABLE')
  }
  for (const [key, value] of Object.entries(source)) {
    if (
      typeof value === 'string' &&
      value !== '' &&
      (key === 'NODE_OPTIONS' || key === 'NODE_PATH' || key.startsWith('GIT_'))
    ) {
      fail('E_UNAVAILABLE')
    }
  }
  const environment = { LANG: 'C', LC_ALL: 'C', PATH: pathValue }
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') {
      if (value.length > 8_192 || containsControl(value)) fail('E_UNAVAILABLE')
      environment[key] = value
    }
  }
  if (platform === 'win32') {
    for (const key of [
      'APPDATA',
      'COMSPEC',
      'LOCALAPPDATA',
      'PATHEXT',
      'SystemRoot',
      'USERPROFILE',
      'WINDIR',
    ]) {
      const value = source[key]
      if (typeof value === 'string' && value !== '' && !containsControl(value)) {
        environment[key] = value
      }
    }
  }
  return environment
}

async function verifiedExecutable(path) {
  if (!isAbsolute(path) || containsControl(path)) fail('E_UNAVAILABLE')
  const canonical = await realpath(path)
  const details = await lstat(canonical)
  if (details.isSymbolicLink() || !details.isFile()) fail('E_UNAVAILABLE')
  if (process.platform !== 'win32' && (details.mode & 0o111) === 0) fail('E_UNAVAILABLE')
  return canonical
}

async function executableFromPath(name, pathValue) {
  if (typeof pathValue !== 'string' || pathValue === '') fail('E_UNAVAILABLE')
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '' || !isAbsolute(directory) || containsControl(directory)) continue
    for (const suffix of suffixes) {
      try {
        return await verifiedExecutable(join(directory, `${name}${suffix}`))
      } catch {
        // Try the next exact PATH candidate.
      }
    }
  }
  fail('E_UNAVAILABLE')
}

function nullConfigurationPath() {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

function packageManagerEnvironment(source, nodePath) {
  const configurationPath = nullConfigurationPath()
  return {
    ...createM09ChildEnvironment(source, dirname(nodePath)),
    CI: '1',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    NPM_CONFIG_GLOBALCONFIG: configurationPath,
    NPM_CONFIG_USERCONFIG: configurationPath,
  }
}

function packageManagerFromInputs(inputs) {
  const data = inputs.get('package.json')
  if (!Buffer.isBuffer(data)) fail('E_UNAVAILABLE')
  let value
  try {
    value = JSON.parse(data.toString('utf8'))
  } catch {
    fail('E_UNAVAILABLE')
  }
  if (
    !isRecord(value) ||
    typeof value.packageManager !== 'string' ||
    !/^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.packageManager)
  ) {
    fail('E_UNAVAILABLE')
  }
  return {
    name: 'pnpm',
    specifier: value.packageManager,
    version: value.packageManager.slice('pnpm@'.length),
  }
}

function pnpmTrustFromInputs(inputs, packageManager) {
  const data = inputs.get(PNPM_TRUST_REPOSITORY_PATH)
  if (!Buffer.isBuffer(data)) fail('E_UNAVAILABLE')
  let value
  try {
    value = JSON.parse(data.toString('utf8'))
  } catch {
    fail('E_UNAVAILABLE')
  }
  exactKeys(value, [
    'entry',
    'entrySha256',
    'name',
    'registry',
    'runtimeFiles',
    'runtimeSha256',
    'schemaVersion',
    'tarball',
    'tarballIntegrity',
    'tarballSha1',
    'unpackedSize',
    'version',
  ])
  const trust = {
    entry: boundedText(value.entry, 128),
    entrySha256: boundedText(value.entrySha256, 64),
    manifestSha256: digest(data),
    name: value.name,
    registry: value.registry,
    runtimeFiles: safeInteger(value.runtimeFiles, true),
    runtimeSha256: boundedText(value.runtimeSha256, 64),
    schemaVersion: value.schemaVersion,
    tarball: value.tarball,
    tarballIntegrity: boundedText(value.tarballIntegrity, 128),
    tarballSha1: boundedText(value.tarballSha1, 40),
    unpackedSize: safeInteger(value.unpackedSize, true),
    version: boundedText(value.version, 64),
  }
  if (
    trust.schemaVersion !== 'dsh-luban/m09-pnpm-trust/v1' ||
    trust.name !== 'pnpm' ||
    trust.version !== packageManager.version ||
    packageManager.specifier !== `pnpm@${trust.version}` ||
    trust.registry !== 'https://registry.npmjs.org/' ||
    trust.tarball !== `https://registry.npmjs.org/pnpm/-/pnpm-${trust.version}.tgz` ||
    trust.entry !== 'bin/pnpm.mjs' ||
    !/^sha512-[a-zA-Z0-9+/]{86}==$/u.test(trust.tarballIntegrity) ||
    !/^[a-f0-9]{40}$/u.test(trust.tarballSha1) ||
    !/^[a-f0-9]{64}$/u.test(trust.entrySha256) ||
    !/^[a-f0-9]{64}$/u.test(trust.runtimeSha256)
  ) {
    fail('E_UNAVAILABLE')
  }
  return trust
}

async function collectPackageManagerFiles(root, directory, files) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => compareCodeUnits(left.name, right.name))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) fail('E_UNAVAILABLE')
    if (entry.isDirectory()) {
      await collectPackageManagerFiles(root, path, files)
    } else if (entry.isFile()) {
      const canonical = await realpath(path)
      if (resolve(canonical) !== resolve(path) || !withinDirectory(root, canonical)) {
        fail('E_UNAVAILABLE')
      }
      files.push(path)
    } else {
      fail('E_UNAVAILABLE')
    }
  }
}

async function packageManagerRuntime(root) {
  const paths = []
  await collectPackageManagerFiles(root, root, paths)
  if (paths.length === 0 || paths.length > 4_096) fail('E_UNAVAILABLE')
  const files = await Promise.all(
    paths.map(async (path) => {
      const data = await readBoundedFile(path, MAX_TOOL_FILE_BYTES)
      const relativePath = relative(root, path).replaceAll('\\', '/')
      if (!/^[\x20-\x7e]+$/u.test(relativePath) || relativePath.includes('\\')) {
        fail('E_UNAVAILABLE')
      }
      return { path: relativePath, sha256: digest(data), size: data.byteLength }
    }),
  )
  files.sort((left, right) => compareCodeUnits(left.path, right.path))
  return {
    files: files.length,
    sha256: digest(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })))),
    unpackedSize: files.reduce((total, file) => total + file.size, 0),
  }
}

async function packageManagerRootsFromLauncher(launcher, trust) {
  const launcherParent = dirname(launcher)
  const roots = new Set()
  if (!launcher.toLowerCase().endsWith('.exe')) {
    const launcherBytes = await readBoundedFile(launcher, 64 * 1024).catch(() => undefined)
    if (launcherBytes !== undefined) {
      const launcherText = launcherBytes.toString('utf8')
      const targetPattern =
        /(?:%~dp0|\$basedir(?:_win)?)([\\/][^"'\r\n]*?[\\/]node_modules[\\/]pnpm[\\/]bin[\\/]pnpm\.mjs)/giu
      for (const match of launcherText.matchAll(targetPattern)) {
        const relativeEntry = match[1].replace(/^[\\/]+/u, '')
        const entry = await realpath(resolve(launcherParent, relativeEntry)).catch(() => undefined)
        if (entry === undefined || basename(entry) !== basename(trust.entry)) continue
        roots.add(resolve(entry, '..', '..'))
      }
    }
  }
  const candidateRoot =
    basename(launcherParent) === 'bin'
      ? resolve(launcherParent, '..')
      : join(launcherParent, 'node_modules', 'pnpm')
  const directRoot = await realpath(candidateRoot).catch(() => undefined)
  if (directRoot !== undefined) roots.add(directRoot)

  const normalizedLauncher = launcher.replaceAll('\\', '/')
  if (normalizedLauncher.endsWith('/node_modules/corepack/dist/pnpm.js')) {
    const configuredCorepackHome = process.env.COREPACK_HOME
    const corepackHome =
      typeof configuredCorepackHome === 'string' && isAbsolute(configuredCorepackHome)
        ? configuredCorepackHome
        : join(userInfo().homedir, '.cache', 'node', 'corepack')
    const corepackRoot = await realpath(join(corepackHome, 'v1', 'pnpm', trust.version)).catch(
      () => undefined,
    )
    if (corepackRoot !== undefined) roots.add(corepackRoot)
  }
  return [...roots]
}

async function packageManagerEntry(toolchain, packageManager, trust) {
  const launcher = await executableFromPath('pnpm', process.env.PATH)
  const roots = await packageManagerRootsFromLauncher(launcher, trust)
  for (const packageRoot of roots) {
    if (!outsideRepository(packageRoot)) continue
    const entryPath = await realpath(join(packageRoot, ...trust.entry.split('/'))).catch(
      () => undefined,
    )
    if (entryPath === undefined || !withinDirectory(packageRoot, entryPath)) continue
    const validated = await Promise.all([
      readCanonicalRuntimeFile(entryPath),
      packageManagerRuntime(packageRoot),
    ]).catch(() => undefined)
    if (validated === undefined) continue
    const [entry, runtime] = validated
    if (
      digest(entry) !== trust.entrySha256 ||
      runtime.files !== trust.runtimeFiles ||
      runtime.sha256 !== trust.runtimeSha256 ||
      runtime.unpackedSize !== trust.unpackedSize
    ) {
      continue
    }
    return {
      entryPath,
      entrySha256: trust.entrySha256,
      environment: packageManagerEnvironment(toolchain.buildEnvironmentSource, toolchain.nodePath),
      manifestSha256: trust.manifestSha256,
      packageManager: packageManager.specifier,
      rootPath: packageRoot,
      runtimeFiles: trust.runtimeFiles,
      runtimeSha256: trust.runtimeSha256,
      tarballIntegrity: trust.tarballIntegrity,
      unpackedSize: trust.unpackedSize,
      version: trust.version,
    }
  }
  fail('E_PACKAGE_MANAGER_TRUST')
}

async function snapshotPackageManager(root, packageManager, trust) {
  const toolRoot = join(root, '.m09-tools')
  const snapshotRoot = join(toolRoot, 'pnpm')
  await mkdir(toolRoot, { mode: 0o700 })
  await cp(packageManager.rootPath, snapshotRoot, {
    errorOnExist: true,
    force: false,
    preserveTimestamps: false,
    recursive: true,
    verbatimSymlinks: true,
  })
  if (process.platform !== 'win32') await chmod(snapshotRoot, 0o700)
  await assertSafeDirectory(snapshotRoot, true)
  const snapshotEntry = await realpath(join(snapshotRoot, ...trust.entry.split('/'))).catch(() =>
    fail('E_PACKAGE_MANAGER_TRUST'),
  )
  if (!withinDirectory(snapshotRoot, snapshotEntry)) fail('E_PACKAGE_MANAGER_TRUST')
  const snapshot = {
    ...packageManager,
    entryPath: snapshotEntry,
    rootPath: snapshotRoot,
  }
  await assertPackageManagerMatches(snapshot)
  await assertPackageManagerMatches(packageManager)
  return snapshot
}

async function assertPackageManagerMatches(packageManager) {
  const [entry, runtime] = await Promise.all([
    readCanonicalRuntimeFile(packageManager.entryPath),
    packageManagerRuntime(packageManager.rootPath),
  ])
  if (
    digest(entry) !== packageManager.entrySha256 ||
    runtime.files !== packageManager.runtimeFiles ||
    runtime.sha256 !== packageManager.runtimeSha256 ||
    runtime.unpackedSize !== packageManager.unpackedSize
  ) {
    fail('E_PACKAGE_MANAGER_TRUST')
  }
}

async function runPackageManager(toolchain, packageManager, args, options = {}) {
  await assertPackageManagerMatches(packageManager)
  const result = await runProcess(
    toolchain.nodePath,
    [
      packageManager.entryPath,
      `--config.userconfig=${nullConfigurationPath()}`,
      `--config.globalconfig=${nullConfigurationPath()}`,
      ...args,
    ],
    {
      ...options,
      env: packageManager.environment,
      timeoutMs: options.timeoutMs ?? PACKAGE_MANAGER_TIMEOUT_MS,
      maximum: options.maximum ?? MAX_SOURCE_BYTES,
    },
  )
  await assertPackageManagerMatches(packageManager)
  return result
}

async function packageStorePath(toolchain, packageManager) {
  const result = await runPackageManager(toolchain, packageManager, ['store', 'path', '--silent'], {
    // pnpm probes cwd and selects a per-filesystem store; use the repository's writable parent.
    cwd: dirname(REPOSITORY_ROOT),
  })
  const storePath = pathInput(commandValue(result))
  if (!outsideRepository(storePath)) fail('E_UNAVAILABLE')
  await assertSafeDirectory(storePath, false)
  return storePath
}

function gitEnvironment(base, gitPath, nodePath, rejectInjection = true) {
  const pathValue = [...new Set([dirname(gitPath), dirname(nodePath)])].join(delimiter)
  const environmentSource = rejectInjection
    ? base
    : Object.fromEntries(
        Object.entries(base).filter(
          ([key]) => key !== 'NODE_OPTIONS' && key !== 'NODE_PATH' && !key.startsWith('GIT_'),
        ),
      )
  return {
    ...createM09ChildEnvironment(environmentSource, pathValue),
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function gitArgs(args) {
  return [
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    ...args,
  ]
}

async function runGit(toolchain, args, options = {}) {
  return await runProcess(toolchain.gitPath, gitArgs(args), {
    ...options,
    env: toolchain.gitEnvironment,
  })
}

function osReleaseValue(content, key) {
  const line = content.split('\n').find((candidate) => candidate.startsWith(`${key}=`))
  if (line === undefined) fail('E_PLATFORM_UNSUPPORTED')
  const raw = line.slice(key.length + 1)
  const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
  if (value === '' || containsControl(value) || !/^[a-zA-Z0-9._-]+$/u.test(value)) {
    fail('E_PLATFORM_UNSUPPORTED')
  }
  return value
}

function relativeRepositoryPath(path) {
  const value = relative(REPOSITORY_ROOT, path).replaceAll('\\', '/')
  if (value === '' || value === '..' || value.startsWith('../') || isAbsolute(value)) {
    fail('E_UNAVAILABLE')
  }
  return value
}

function withinDirectory(root, path) {
  const value = relative(root, path)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

async function readCanonicalRuntimeFile(path) {
  const canonical = await realpath(path)
  if (resolve(canonical) !== resolve(path)) fail('E_UNAVAILABLE')
  return await readBoundedFile(path, MAX_SOURCE_BYTES)
}

function staticModuleSpecifiers(source) {
  if (/\bimport\s*\(/u.test(source) || /\brequire\s*\(/u.test(source)) fail('E_UNAVAILABLE')
  const values = []
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"\r\n]*?\sfrom\s*)?["']([^"'\r\n]+)["']/gu
  for (const match of source.matchAll(pattern)) values.push(match[1])
  return values
}

async function collectRuntimeClosure(entry, root, allowedWorkspaceImport) {
  await assertSafeDirectory(root, false)
  const pending = [resolve(entry)]
  const files = new Map()
  const workspaceImports = new Set()
  while (pending.length > 0) {
    const path = pending.pop()
    if (files.has(path)) continue
    if (!withinDirectory(root, path) || !path.endsWith('.js')) fail('E_UNAVAILABLE')
    const data = await readCanonicalRuntimeFile(path)
    files.set(path, data)
    const source = data.toString('utf8')
    for (const specifier of staticModuleSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        if (
          !specifier.startsWith('./') ||
          !specifier.endsWith('.js') ||
          specifier.includes('\\') ||
          specifier.includes('?') ||
          specifier.includes('#') ||
          containsControl(specifier)
        ) {
          fail('E_UNAVAILABLE')
        }
        const imported = resolve(dirname(path), specifier)
        if (!withinDirectory(root, imported)) fail('E_UNAVAILABLE')
        pending.push(imported)
      } else if (isBuiltin(specifier)) {
        continue
      } else if (specifier === allowedWorkspaceImport) {
        workspaceImports.add(specifier)
      } else {
        fail('E_UNAVAILABLE')
      }
    }
  }
  return { files, workspaceImports }
}

function assertRuntimeClosureShape(serverFiles, coreFiles) {
  const expectedServerFiles = [...serverFiles.keys()].map((path) => basename(path)).sort()
  if (
    expectedServerFiles.length !== 3 ||
    expectedServerFiles.filter((name) => name === 'operator-cli.js').length !== 1 ||
    expectedServerFiles.filter((name) => /^process-runner-[a-zA-Z0-9_-]+\.js$/u.test(name))
      .length !== 1 ||
    expectedServerFiles.filter((name) => /^systemd-[a-zA-Z0-9_-]+\.js$/u.test(name)).length !== 1 ||
    new Set(expectedServerFiles).size !== expectedServerFiles.length
  ) {
    fail('E_UNAVAILABLE')
  }
  const expectedCoreFiles = [...coreFiles.keys()].map((path) => basename(path)).sort()
  if (!isDeepStrictEqual(expectedCoreFiles, ['index.js'])) {
    fail('E_UNAVAILABLE')
  }
}

async function manifestFor(paths, kind) {
  const uniquePaths = [...new Set(paths.map((path) => resolve(path)))].sort((left, right) =>
    relativeRepositoryPath(left).localeCompare(relativeRepositoryPath(right)),
  )
  const files = await Promise.all(
    uniquePaths.map(async (path) => ({
      path: relativeRepositoryPath(path),
      sha256: digest(await readCanonicalRuntimeFile(path)),
    })),
  )
  return { kind, files, sha256: digest(JSON.stringify(files)) }
}

function manifestFromFileMap(filesByPath, kind) {
  const files = [...filesByPath.entries()]
    .map(([path, data]) => ({ path, sha256: digest(data) }))
    .sort((left, right) => left.path.localeCompare(right.path))
  return { kind, files, sha256: digest(JSON.stringify(files)) }
}

function validBuildInputPath(path) {
  return (
    REQUIRED_BUILD_INPUTS.includes(path) ||
    /^packages\/(?:core|dsh-luban-server-mode)\/src\/[a-zA-Z0-9._/-]+\.tsx?$/u.test(path)
  )
}

async function readHeadBlob(toolchain, head, path) {
  const result = await runGit(toolchain, ['cat-file', 'blob', `${head}:${path}`], {
    binary: true,
    maximum: MAX_SOURCE_BYTES,
  })
  if (result.exitCode !== 0 || !Buffer.isBuffer(result.stdout)) fail('E_UNAVAILABLE')
  return result.stdout
}

async function headBuildInputs(toolchain, head) {
  const listed = await runGit(toolchain, [
    'ls-tree',
    '-r',
    '--name-only',
    head,
    '--',
    'packages/core/src',
    'packages/dsh-luban-server-mode/src',
  ])
  if (listed.exitCode !== 0) fail('E_UNAVAILABLE')
  const sourcePaths = listed.stdout
    .trim()
    .split('\n')
    .filter((path) => path !== '')
    .map((path) => path.replaceAll('\\', '/'))
  const paths = [...new Set([...REQUIRED_BUILD_INPUTS, ...sourcePaths])].sort()
  if (
    paths.length === REQUIRED_BUILD_INPUTS.length ||
    paths.some((path) => !validBuildInputPath(path))
  ) {
    fail('E_UNAVAILABLE')
  }
  const files = new Map()
  for (const path of paths) {
    const headData = await readHeadBlob(toolchain, head, path)
    const currentData = await readCanonicalRuntimeFile(join(REPOSITORY_ROOT, path))
    if (!headData.equals(currentData)) fail('E_UNAVAILABLE')
    files.set(path, headData)
  }
  return files
}

async function writeBuildSnapshot(root, files) {
  for (const [path, data] of files) {
    const target = join(root, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, data, { flag: 'wx', mode: 0o600 })
  }
}

async function assertSnapshotInputs(root, inputs) {
  for (const [path, expected] of inputs) {
    const actual = await readCanonicalRuntimeFile(join(root, ...path.split('/')))
    if (!actual.equals(expected)) fail('E_UNAVAILABLE')
  }
}

async function assertIsolatedInstallTree(root, directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await realpath(path)
      if (!withinDirectory(root, target)) fail('E_UNAVAILABLE')
    } else if (entry.isDirectory()) {
      await assertIsolatedInstallTree(root, path)
    }
  }
}

async function readIsolatedRuntimeFile(root, path) {
  const canonical = await realpath(path)
  if (!withinDirectory(root, canonical)) fail('E_UNAVAILABLE')
  return { canonical, data: await readBoundedFile(canonical, MAX_SOURCE_BYTES) }
}

async function installIsolatedBuildToolchain(root, toolchain, inputs) {
  const requiredPackageManager = packageManagerFromInputs(inputs)
  const trust = pnpmTrustFromInputs(inputs, requiredPackageManager)
  const externalPnpm = await packageManagerEntry(toolchain, requiredPackageManager, trust)
  const pnpm = await snapshotPackageManager(root, externalPnpm, trust)
  const storePath = await packageStorePath(toolchain, pnpm)
  const install = await runPackageManager(
    toolchain,
    pnpm,
    [
      'install',
      '--offline',
      '--frozen-lockfile',
      '--ignore-scripts',
      '--ignore-pnpmfile',
      '--verify-store-integrity=true',
      '--package-import-method=copy',
      '--store-dir',
      storePath,
      '--reporter=silent',
    ],
    { cwd: root },
  )
  if (install.exitCode !== 0) fail('E_UNAVAILABLE')
  await assertSnapshotInputs(root, inputs)
  await assertIsolatedInstallTree(root, join(root, 'node_modules'))

  const packageFile = await readIsolatedRuntimeFile(
    root,
    join(root, 'node_modules', 'tsdown', 'package.json'),
  )
  let packageValue
  try {
    packageValue = JSON.parse(packageFile.data.toString('utf8'))
  } catch {
    fail('E_UNAVAILABLE')
  }
  if (
    packageValue.name !== 'tsdown' ||
    typeof packageValue.version !== 'string' ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u.test(packageValue.version)
  ) {
    fail('E_UNAVAILABLE')
  }
  const runFile = await readIsolatedRuntimeFile(
    root,
    join(root, 'node_modules', 'tsdown', 'dist', 'run.mjs'),
  )
  await assertPackageManagerMatches(pnpm)
  await assertPackageManagerMatches(externalPnpm)
  return {
    externalPnpm,
    pnpm,
    runPath: runFile.canonical,
    public: {
      installMode: ISOLATED_INSTALL_MODE,
      packageManager: externalPnpm.packageManager,
      pnpmEntryPath: externalPnpm.entryPath,
      pnpmEntrySha256: externalPnpm.entrySha256,
      pnpmRootPath: externalPnpm.rootPath,
      pnpmRuntimeFiles: externalPnpm.runtimeFiles,
      pnpmRuntimeSha256: externalPnpm.runtimeSha256,
      pnpmRuntimeUnpackedSize: externalPnpm.unpackedSize,
      pnpmTarballIntegrity: externalPnpm.tarballIntegrity,
      pnpmTrustManifestSha256: externalPnpm.manifestSha256,
      pnpmVersion: externalPnpm.version,
      storePath,
      tsdownVersion: packageValue.version,
    },
  }
}

async function collectJavaScriptFiles(root, directory, files) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail('E_UNAVAILABLE')
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectJavaScriptFiles(root, path, files)
    } else if (entry.isFile() && /\.(?:cjs|mjs|js)$/u.test(entry.name)) {
      const repositoryPath = relative(root, path).replaceAll('\\', '/')
      files.set(repositoryPath, await readCanonicalRuntimeFile(path))
    }
  }
}

async function buildJavaScriptFiles(root) {
  const files = new Map()
  await collectJavaScriptFiles(root, join(root, 'packages', 'core', 'dist'), files)
  await collectJavaScriptFiles(root, join(root, 'packages', 'dsh-luban-server-mode', 'dist'), files)
  if (files.size === 0) fail('E_UNAVAILABLE')
  return files
}

async function freshHeadBuild(toolchain, inputs) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-luban-m09-head-build-'))
  try {
    await writeBuildSnapshot(root, inputs)
    const isolatedToolchain = await installIsolatedBuildToolchain(root, toolchain, inputs)
    const environment = createM09ChildEnvironment(
      toolchain.buildEnvironmentSource,
      dirname(toolchain.nodePath),
    )
    for (const packageName of ['core', 'dsh-luban-server-mode']) {
      const result = await runProcess(
        toolchain.nodePath,
        [isolatedToolchain.runPath, '--config', 'tsdown.config.ts'],
        {
          cwd: join(root, 'packages', packageName),
          env: environment,
          maximum: MAX_SOURCE_BYTES,
          timeoutMs: BUILD_TIMEOUT_MS,
        },
      )
      if (result.exitCode !== 0) fail('E_UNAVAILABLE')
    }
    await assertSnapshotInputs(root, inputs)
    await assertPackageManagerMatches(isolatedToolchain.pnpm)
    await assertPackageManagerMatches(isolatedToolchain.externalPnpm)
    return {
      files: await buildJavaScriptFiles(root),
      toolchain: isolatedToolchain.public,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function currentBuildJavaScriptFiles() {
  return await buildJavaScriptFiles(REPOSITORY_ROOT)
}

async function inspectRuntimeProvenance(toolchain, head) {
  const coreLinkTarget = await realpath(CORE_LINK_PATH)
  if (resolve(coreLinkTarget) !== resolve(CORE_PACKAGE_ROOT)) fail('E_UNAVAILABLE')
  const [serverPackageData, corePackageData] = await Promise.all([
    readCanonicalRuntimeFile(join(SERVER_PACKAGE_ROOT, 'package.json')),
    readCanonicalRuntimeFile(join(CORE_PACKAGE_ROOT, 'package.json')),
  ])
  let serverPackage
  let corePackage
  try {
    serverPackage = JSON.parse(serverPackageData.toString('utf8'))
    corePackage = JSON.parse(corePackageData.toString('utf8'))
  } catch {
    fail('E_UNAVAILABLE')
  }
  if (
    serverPackage.name !== 'dsh-luban-server-mode' ||
    serverPackage.type !== 'module' ||
    serverPackage.bin?.['luban-server-mode'] !== './dist/operator-cli.js' ||
    corePackage.name !== 'dsh-luban-core' ||
    corePackage.type !== 'module' ||
    corePackage.exports?.['.']?.default !== './dist/index.js'
  ) {
    fail('E_UNAVAILABLE')
  }
  const serverClosure = await collectRuntimeClosure(
    OPERATOR_CLI_PATH,
    SERVER_DIST_ROOT,
    'dsh-luban-core',
  )
  if (!serverClosure.workspaceImports.has('dsh-luban-core')) fail('E_UNAVAILABLE')
  const coreClosure = await collectRuntimeClosure(CORE_ENTRY_PATH, CORE_DIST_ROOT)
  if (coreClosure.workspaceImports.size !== 0) fail('E_UNAVAILABLE')
  assertRuntimeClosureShape(serverClosure.files, coreClosure.files)

  const inputs = await headBuildInputs(toolchain, head)
  const isolatedBuild = await freshHeadBuild(toolchain, inputs)
  const freshBuild = manifestFromFileMap(isolatedBuild.files, 'fresh-head-build-javascript')
  const currentBuild = manifestFromFileMap(
    await currentBuildJavaScriptFiles(),
    'fresh-head-build-javascript',
  )
  if (!isDeepStrictEqual(currentBuild, freshBuild)) fail('E_PROVENANCE_MISMATCH')

  return {
    buildInputs: manifestFromFileMap(inputs, 'head-build-inputs'),
    buildToolchain: isolatedBuild.toolchain,
    freshBuild,
    operatorRuntime: await manifestFor(
      [
        join(SERVER_PACKAGE_ROOT, 'package.json'),
        ...serverClosure.files.keys(),
        join(CORE_PACKAGE_ROOT, 'package.json'),
        ...coreClosure.files.keys(),
      ],
      'complete-runtime-closure',
    ),
  }
}

async function productionToolchain() {
  const [gitPath, loginctlPath, nodePath, systemctlPath] = await Promise.all([
    verifiedExecutable(PRODUCTION_TOOL_PATHS.git),
    verifiedExecutable(PRODUCTION_TOOL_PATHS.loginctl),
    verifiedExecutable(process.execPath),
    verifiedExecutable(PRODUCTION_TOOL_PATHS.systemctl),
  ])
  const toolchain = {
    buildEnvironmentSource: process.env,
    gitPath,
    loginctlPath,
    nodePath,
    systemctlPath,
    gitEnvironment: gitEnvironment(process.env, gitPath, nodePath),
    public: {
      gitPath,
      loginctlPath,
      nodePath,
      nodeVersion: process.version,
      systemctlPath,
    },
  }
  return toolchain
}

async function productionOperatorEnvironment(toolchain) {
  const dshPath = await executableFromPath('dsh', process.env.PATH)
  const pathValue = [
    ...new Set([
      dirname(toolchain.nodePath),
      dirname(dshPath),
      dirname(toolchain.systemctlPath),
      dirname(toolchain.loginctlPath),
    ]),
  ].join(delimiter)
  const environment = createM09ChildEnvironment(process.env, pathValue)
  const [resolvedNode, resolvedDsh, resolvedSystemctl, resolvedLoginctl] = await Promise.all([
    executableFromPath(process.platform === 'win32' ? 'node.exe' : 'node', pathValue),
    executableFromPath('dsh', pathValue),
    executableFromPath('systemctl', pathValue),
    executableFromPath('loginctl', pathValue),
  ])
  if (
    resolvedNode !== toolchain.nodePath ||
    resolvedDsh !== dshPath ||
    resolvedSystemctl !== toolchain.systemctlPath ||
    resolvedLoginctl !== toolchain.loginctlPath
  ) {
    fail('E_UNAVAILABLE')
  }
  return environment
}

function defaultOperator() {
  const current = userInfo()
  if (!Number.isSafeInteger(current.uid) || current.uid <= 0) fail('E_PLATFORM_UNSUPPORTED')
  const toolchainPromise = productionToolchain()
  const environmentPromise = toolchainPromise.then(productionOperatorEnvironment)
  let sourcePromise
  const source = async () => {
    sourcePromise ??= (async () => {
      const toolchain = await toolchainPromise
      const beforeHead = commandValue(
        await runGit(toolchain, ['rev-parse', '--verify', 'HEAD^{commit}']),
      )
      const beforeStatus = commandValue(
        await runGit(toolchain, ['status', '--porcelain=v1', '--untracked-files=no']),
      )
      if (!/^[a-f0-9]{40,64}$/u.test(beforeHead) || beforeStatus !== '') {
        fail('E_UNAVAILABLE')
      }
      const trackedRunner = await runGit(toolchain, [
        'ls-files',
        '--error-unmatch',
        '--',
        RUNNER_REPOSITORY_PATH,
      ])
      if (trackedRunner.exitCode !== 0 || commandValue(trackedRunner) !== RUNNER_REPOSITORY_PATH) {
        fail('E_UNAVAILABLE')
      }
      const [runner, headRunner, inspected] = await Promise.all([
        readBoundedFile(RUNNER_PATH, MAX_SOURCE_BYTES),
        readHeadBlob(toolchain, beforeHead, RUNNER_REPOSITORY_PATH),
        inspectRuntimeProvenance(toolchain, beforeHead),
      ])
      if (!runner.equals(headRunner)) fail('E_UNAVAILABLE')
      const { buildToolchain, ...provenance } = inspected
      const afterHead = commandValue(
        await runGit(toolchain, ['rev-parse', '--verify', 'HEAD^{commit}']),
      )
      const afterStatus = commandValue(
        await runGit(toolchain, ['status', '--porcelain=v1', '--untracked-files=no']),
      )
      if (afterHead !== beforeHead || afterStatus !== '') fail('E_UNAVAILABLE')
      return {
        gitHead: beforeHead,
        runnerSha256: digest(runner),
        toolchain: { ...toolchain.public, ...buildToolchain },
        ...provenance,
      }
    })()
    const identity = await sourcePromise
    const toolchain = await toolchainPromise
    const [runner, pnpmEntry, pnpmRuntime, currentBuild, head, status, coreLinkTarget] =
      await Promise.all([
        readBoundedFile(RUNNER_PATH, MAX_SOURCE_BYTES),
        readCanonicalRuntimeFile(identity.toolchain.pnpmEntryPath),
        packageManagerRuntime(identity.toolchain.pnpmRootPath),
        currentBuildJavaScriptFiles(),
        runGit(toolchain, ['rev-parse', '--verify', 'HEAD^{commit}']),
        runGit(toolchain, ['status', '--porcelain=v1', '--untracked-files=no']),
        realpath(CORE_LINK_PATH),
      ])
    if (
      digest(runner) !== identity.runnerSha256 ||
      digest(pnpmEntry) !== identity.toolchain.pnpmEntrySha256 ||
      pnpmRuntime.files !== identity.toolchain.pnpmRuntimeFiles ||
      pnpmRuntime.sha256 !== identity.toolchain.pnpmRuntimeSha256 ||
      pnpmRuntime.unpackedSize !== identity.toolchain.pnpmRuntimeUnpackedSize ||
      resolve(coreLinkTarget) !== resolve(CORE_PACKAGE_ROOT) ||
      commandValue(head) !== identity.gitHead ||
      commandValue(status) !== '' ||
      !isDeepStrictEqual(
        manifestFromFileMap(currentBuild, 'fresh-head-build-javascript'),
        identity.freshBuild,
      )
    ) {
      fail('E_UNAVAILABLE')
    }
    return identity
  }
  return {
    source,
    async host() {
      const [toolchain, environment] = await Promise.all([toolchainPromise, environmentPromise])
      const [machineId, bootId, osRelease, linger] = await Promise.all([
        readFile('/etc/machine-id', 'utf8'),
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        readFile('/etc/os-release', 'utf8'),
        runProcess(
          toolchain.loginctlPath,
          ['show-user', current.username, '--property=Linger', '--value'],
          { env: environment },
        ),
      ])
      if (osReleaseValue(osRelease, 'ID') !== 'ubuntu') fail('E_PLATFORM_UNSUPPORTED')
      const lingerValue = commandValue(linger).toLowerCase()
      if (lingerValue !== 'yes') fail('E_UNAVAILABLE')
      return {
        machineIdSha256: digest(machineId.trim()),
        hostnameSha256: digest(hostname()),
        bootId: bootId.trim(),
        ubuntuVersion: osReleaseValue(osRelease, 'VERSION_ID'),
        user: current.username,
        uid: current.uid,
        linger: 'yes',
      }
    },
    async cli({ command, apply, user }) {
      const [toolchain, environment] = await Promise.all([toolchainPromise, environmentPromise])
      await source()
      const args = [OPERATOR_CLI_PATH, command]
      if (apply) args.push('--apply')
      args.push('--user', user)
      const result = await runProcess(toolchain.nodePath, args, { env: environment })
      await source()
      return { exitCode: result.exitCode, envelope: parseCommandJson(result.stdout) }
    },
    async serviceProperties() {
      const [toolchain, environment] = await Promise.all([toolchainPromise, environmentPromise])
      const keys = [
        'Id',
        'InvocationID',
        'LoadState',
        'FragmentPath',
        'DropInPaths',
        'NeedDaemonReload',
        'UnitFileState',
        'ActiveState',
        'SubState',
        'MainPID',
        'Type',
        'ActiveEnterTimestampMonotonic',
        'Environment',
      ]
      const args = ['--user', 'show', SERVICE, '--all', '--no-pager']
      for (const key of keys) args.push('--property', key)
      const result = await runProcess(toolchain.systemctlPath, args, { env: environment })
      const values = parsePropertyLines(commandValue(result), keys)
      const get = (key) => values.get(key) ?? fail('E_UNAVAILABLE')
      return {
        id: get('Id'),
        invocationId: get('InvocationID').toLowerCase(),
        loadState: get('LoadState'),
        fragmentPath: get('FragmentPath'),
        dropInPaths: get('DropInPaths'),
        needDaemonReload: get('NeedDaemonReload'),
        unitFileState: get('UnitFileState') === '' ? 'not-found' : get('UnitFileState'),
        activeState: get('ActiveState'),
        subState: get('SubState'),
        mainPid: parseDecimal(get('MainPID')),
        type: get('Type'),
        activeEnterTimestampMonotonic: parseDecimal(get('ActiveEnterTimestampMonotonic')),
        environment: get('Environment'),
      }
    },
    async unitOwnership(unitPath) {
      const canonical = await realpath(unitPath)
      if (resolve(canonical) !== resolve(unitPath)) fail('E_OWNERSHIP')
      const before = await stat(unitPath, { bigint: true })
      if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_JSON_BYTES)) {
        fail('E_OWNERSHIP')
      }
      const content = await readBoundedFile(unitPath, MAX_JSON_BYTES)
      const after = await stat(unitPath, { bigint: true })
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
        fail('E_OWNERSHIP')
      }
      return {
        unitPath,
        sha256: digest(content),
        device: before.dev.toString(),
        inode: before.ino.toString(),
        size: Number(before.size),
      }
    },
    async currentSession() {
      const [toolchain, environment] = await Promise.all([toolchainPromise, environmentPromise])
      const keys = ['Id', 'Name', 'User', 'TimestampMonotonic']
      const readSession = async (sessionId) => {
        const args = ['show-session', sessionId, '--no-pager']
        for (const key of keys) args.push('--property', key)
        const values = parsePropertyLines(
          commandValue(await runProcess(toolchain.loginctlPath, args, { env: environment })),
          keys,
        )
        return {
          id: values.get('Id'),
          user: values.get('Name'),
          uid: parseDecimal(values.get('User') ?? ''),
          timestampMonotonic: parseDecimal(values.get('TimestampMonotonic') ?? ''),
        }
      }
      const currentSession = await readSession('self')
      if (
        currentSession.id === undefined ||
        !/^[a-zA-Z0-9_.:-]+$/u.test(currentSession.id) ||
        currentSession.id.length > 128 ||
        currentSession.user !== current.username ||
        currentSession.uid !== current.uid
      ) {
        fail('E_UNAVAILABLE')
      }
      const listed = commandValue(
        await runProcess(
          toolchain.loginctlPath,
          ['show-user', current.username, '--property=Sessions', '--value'],
          { env: environment },
        ),
      )
      const sessionIds = listed.split(/\s+/u).filter((value) => value !== '')
      if (
        sessionIds.length === 0 ||
        sessionIds.length > 64 ||
        !sessionIds.includes(currentSession.id) ||
        sessionIds.some((value) => !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(value))
      ) {
        fail('E_UNAVAILABLE')
      }
      const sessions = await Promise.all(sessionIds.map(readSession))
      if (
        sessions.some((session) => session.user !== current.username || session.uid !== current.uid)
      ) {
        fail('E_UNAVAILABLE')
      }
      return {
        ...currentSession,
        earliestTimestampMonotonic: Math.min(
          ...sessions.map((session) => session.timestampMonotonic),
        ),
      }
    },
  }
}

/** Fresh-build and inspect the exact operator runtime against current HEAD. */
export async function inspectM09OperatorRuntimeProvenance() {
  const nodePath = await verifiedExecutable(process.execPath)
  const gitPath = await executableFromPath('git', process.env.PATH)
  const toolchain = {
    buildEnvironmentSource: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== 'NODE_OPTIONS' && key !== 'NODE_PATH' && !key.startsWith('GIT_'),
      ),
    ),
    gitPath,
    nodePath,
    gitEnvironment: gitEnvironment(process.env, gitPath, nodePath, false),
  }
  const head = commandValue(await runGit(toolchain, ['rev-parse', '--verify', 'HEAD^{commit}']))
  if (!/^[a-f0-9]{40,64}$/u.test(head)) fail('E_UNAVAILABLE')
  return await inspectRuntimeProvenance(toolchain, head)
}

/** Execute one secret-free M09 acceptance stage. Injected operators are always simulated. */
export async function runM09SystemdRebootAcceptance(argv, injectedDependencies) {
  let parsed
  try {
    parsed = parseCli(argv)
  } catch (error) {
    return safeFailure(error)
  }
  if (parsed.help) return { exitCode: 0, output: HELP.trimEnd() }
  if (!parsed.apply) return plan(parsed.command, parsed.runDir)
  try {
    return await executeStage(
      parsed,
      injectedDependencies ?? {},
      injectedDependencies === undefined ? 'operator-attested' : 'simulated',
    )
  } catch (error) {
    return safeFailure(error)
  }
}

function isMain() {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isMain()) {
  const result = await runM09SystemdRebootAcceptance(process.argv.slice(2))
  process.stdout.write(`${result.output}\n`)
  process.exitCode = result.exitCode
}
