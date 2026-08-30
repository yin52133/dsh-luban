#!/usr/bin/env node

import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { devNull } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..')
const RECONCILIATION_MODULE = new URL(
  '../../packages/dsh-luban-hud/src/rate-reconcile.ts',
  import.meta.url,
)
const TRACKED_SOURCE_PATHS = Object.freeze([
  'scripts/acceptance/m07-rate-reconcile.mjs',
  'packages/dsh-luban-hud/package.json',
  'packages/dsh-luban-hud/scripts/build.mjs',
  'packages/dsh-luban-hud/tsdown.config.ts',
  'packages/dsh-luban-hud/src/build-provenance.ts',
  'packages/dsh-luban-hud/src/rate-reconcile.ts',
  'packages/dsh-luban-hud/src/rate-ledger.ts',
  'packages/dsh-luban-hud/src/provider-request-identity.ts',
  'packages/dsh-luban-hud/src/rate-window.ts',
  'packages/dsh-luban-hud/src/runtime-artifact.ts',
  'packages/dsh-luban-hud/src/dsh-telemetry.ts',
  'packages/dsh-luban-hud/src/http-api.ts',
  'packages/dsh-luban-hud/src/index.ts',
  'packages/core/src/contracts.ts',
])
const PLAN_SCHEMA = 'dsh-luban/m07-rate-reconciliation-plan/v2'
const EVIDENCE_SCHEMA = 'dsh-luban/m07-rate-reconciliation-evidence/v3'
const HUD_EXPORT_SCHEMA = 'dsh-luban/m07-hud-rate-export/v1'
const HUD_CAPTURE_SCHEMA = 'dsh-luban/m07-hud-rate-capture/v4'
const HUD_RUNTIME_ARTIFACT_SCHEMA = 'dsh-luban/m07-hud-runtime-artifact/v1'
const HUD_BUILD_PROVENANCE_SCHEMA = 'dsh-luban/hud-build-provenance/v1'
const PROVIDER_EXPORT_SCHEMA = 'dsh-luban/m07-provider-rate-export/v1'
const FEATURE_ID = 'M07-F004'
const MAX_INPUT_BYTES = 10 * 1024 * 1024
const MAX_HTTP_RESPONSE_BYTES = 10 * 1024 * 1024
const MAX_OS_RELEASE_BYTES = 64 * 1024
const MAX_RUNTIME_ARTIFACT_BYTES = 10 * 1024 * 1024
const MAX_RUNTIME_ARTIFACT_FILES = 128
const MAX_RUNTIME_ARTIFACT_TOTAL_BYTES = 25 * 1024 * 1024
const MAX_BUILD_MANIFEST_BYTES = 1024 * 1024
const MAX_BUILD_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_BUILD_ARTIFACTS = 512
const MAX_BUILD_TOTAL_BYTES = 256 * 1024 * 1024
const HUD_REQUEST_TIMEOUT_MS = 10_000
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const CHALLENGE = /^[A-Za-z0-9][A-Za-z0-9_-]{31,127}$/u
const RATE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const PROVIDER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const HUD_CAPTURE_PATH = '/luban-hud/rate-capture'
const HUD_PACKAGE_NAME = 'dsh-luban-hud'
const HUD_RUNTIME_ENTRYPOINT = 'dist/index.js'
const GIT_NULL_CONFIG = process.platform === 'win32' ? 'NUL' : devNull
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const SUSPICIOUS_CREDENTIAL_KEYS = new Set([
  'apikey',
  'authorization',
  'bearer',
  'clientsecret',
  'cookie',
  'credential',
  'password',
  'privatekey',
  'proxyauthorization',
  'refreshtoken',
  'secret',
  'setcookie',
  'sessiontoken',
  'token',
  'accesstoken',
  'authtoken',
  'idtoken',
  'xapikey',
])
const GIT_ENVIRONMENT_ALLOWLIST = new Set([
  'COMSPEC',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'WINDIR',
])

class AcceptanceError extends Error {
  constructor(code, message, blocked = false) {
    super(message)
    this.name = 'AcceptanceError'
    this.code = code
    this.blocked = blocked
  }
}

function isoNow(now = Date.now()) {
  return new Date(now).toISOString()
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function boundedRunId(value = randomUUID()) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(value)) {
    throw new TypeError('runId must be a bounded identifier')
  }
  return value
}

function safeError(error) {
  const code =
    typeof error?.code === 'string' && /^[A-Z0-9_]{3,64}$/u.test(error.code)
      ? error.code
      : 'E_RATE_INTERNAL'
  const message =
    error instanceof AcceptanceError || error?.name === 'RateReconciliationError'
      ? String(error.message).slice(0, 512)
      : 'Rate reconciliation failed'
  return { code, message }
}

function check(checks, id, status, actual) {
  checks.push({ id, status, actual: String(actual).slice(0, 512) })
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

export async function inspectM07RuntimePlatform(
  runtimePlatform = process.platform,
  arch = process.arch,
  node = process.version,
  readOsRelease = () => readFile('/etc/os-release', 'utf8'),
) {
  if (runtimePlatform === 'win32') {
    return Object.freeze({ target: 'windows', runtimePlatform, arch, node })
  }
  if (runtimePlatform !== 'linux') {
    throw new AcceptanceError(
      'E_RATE_PLATFORM',
      `M07 reconciliation is unsupported on ${runtimePlatform}`,
      true,
    )
  }
  let release
  try {
    release = await readOsRelease()
  } catch {
    throw new AcceptanceError(
      'E_RATE_PLATFORM',
      'Ubuntu reconciliation requires readable /etc/os-release',
      true,
    )
  }
  if (
    typeof release !== 'string' ||
    Buffer.byteLength(release, 'utf8') > MAX_OS_RELEASE_BYTES ||
    osReleaseId(release) !== 'ubuntu'
  ) {
    throw new AcceptanceError(
      'E_RATE_PLATFORM',
      'Linux reconciliation requires /etc/os-release ID=ubuntu',
      true,
    )
  }
  return Object.freeze({
    target: 'ubuntu',
    runtimePlatform,
    arch,
    node,
    osReleaseId: 'ubuntu',
  })
}

export function createM07GitEnvironment(environment = process.env) {
  const sanitized = Object.create(null)
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (
      typeof value === 'string' &&
      GIT_ENVIRONMENT_ALLOWLIST.has(key.toUpperCase()) &&
      !SUSPICIOUS_CREDENTIAL_KEYS.has(normalizeCredentialKey(key))
    ) {
      sanitized[key] = value
    }
  }
  return Object.freeze({
    ...sanitized,
    GCM_INTERACTIVE: 'Never',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: GIT_NULL_CONFIG,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
  })
}

function runGit(root, args) {
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'credential.helper=',
      '-c',
      'submodule.recurse=false',
      ...args,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: createM07GitEnvironment(),
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  )
  if (result.error !== undefined || result.status !== 0) {
    throw new AcceptanceError('E_RATE_GIT', 'Unable to inspect Git source state', true)
  }
  return result.stdout ?? ''
}

export function inspectM07GitState(root, invokeGit = runGit) {
  const before = invokeGit(root, ['rev-parse', 'HEAD']).trim().toLowerCase()
  if (!GIT_SHA.test(before)) {
    throw new AcceptanceError('E_RATE_GIT', 'Git returned an invalid commit identity', true)
  }
  const status = invokeGit(root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignore-submodules=all',
  ])
  const after = invokeGit(root, ['rev-parse', 'HEAD']).trim().toLowerCase()
  if (!GIT_SHA.test(after) || before !== after) {
    throw new AcceptanceError(
      'E_RATE_GIT_HEAD_DRIFT',
      'Git HEAD changed while source state was inspected',
    )
  }
  return Object.freeze({ sha: before, clean: status.trim() === '' })
}

function isInside(root, target) {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function sameFilesystemPath(left, right) {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

function normalizeCredentialKey(key) {
  return key.replaceAll(/[^A-Za-z0-9]/gu, '').toLowerCase()
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function canonicalUtc(value) {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}

function containsControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

function exactRateWindow(value, label) {
  if (
    !hasExactKeys(value, ['endUtc', 'startUtc']) ||
    !canonicalUtc(value.startUtc) ||
    !canonicalUtc(value.endUtc)
  ) {
    throw new AcceptanceError('E_RATE_WINDOW', `${label} window must use canonical UTC timestamps`)
  }
  const durationMs = Date.parse(value.endUtc) - Date.parse(value.startUtc)
  if (durationMs !== 60_000 && durationMs !== 300_000) {
    throw new AcceptanceError(
      'E_RATE_WINDOW',
      `${label} window must be exactly one or five minutes`,
    )
  }
  return Object.freeze({ startUtc: value.startUtc, endUtc: value.endUtc })
}

export function assertNoSuspiciousCredentialFields(value) {
  const pending = [value]
  const visited = new Set()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null || typeof current !== 'object') continue
    if (visited.has(current)) continue
    visited.add(current)
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    for (const [key, nested] of Object.entries(current)) {
      if (SUSPICIOUS_CREDENTIAL_KEYS.has(normalizeCredentialKey(key))) {
        throw new AcceptanceError(
          'E_RATE_SECRET_FIELD',
          'Rate export contains a suspicious credential field',
        )
      }
      pending.push(nested)
    }
  }
}

function captureChallenge(value) {
  if (typeof value !== 'string' || !CHALLENGE.test(value)) {
    throw new AcceptanceError('E_RATE_HUD_CHALLENGE', 'Mounted HUD challenge is invalid')
  }
  return value
}

export function createM07CaptureChallenge(random = randomBytes) {
  const bytes = random(32)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new AcceptanceError('E_RATE_HUD_CHALLENGE', 'Unable to create a fresh HUD challenge')
  }
  return captureChallenge(Buffer.from(bytes).toString('hex'))
}

function validInputSize(size) {
  return size > 0n && size <= BigInt(MAX_INPUT_BYTES)
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

async function readM07BoundedBytes(handle, maxBytes) {
  const chunks = []
  let total = 0
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
    if (bytesRead === 0) break
    chunks.push(chunk.subarray(0, bytesRead))
    total += bytesRead
  }
  if (total === 0 || total > maxBytes) throw new Error('invalid bounded file size')
  return Buffer.concat(chunks, total)
}

export async function readM07BoundedFile(handle, label, maxBytes = MAX_INPUT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_INPUT_BYTES) {
    throw new TypeError('maxBytes must be a positive bounded safe integer')
  }
  try {
    return await readM07BoundedBytes(handle, maxBytes)
  } catch {
    throw new AcceptanceError('E_RATE_INPUT_SIZE', `${label} export has an invalid size`)
  }
}

async function inspectTrackedM07Source(root, canonicalRoot, relativePath, invokeGit) {
  let canonicalSource
  let before
  let raw
  let handle
  try {
    const requestedSource = resolve(root, relativePath)
    const requested = await lstat(requestedSource, { bigint: true })
    if (!requested.isFile() || requested.isSymbolicLink()) throw new Error('not a regular file')
    canonicalSource = await realpath(requestedSource)
    if (!sameFilesystemPath(canonicalSource, resolve(canonicalRoot, relativePath))) {
      throw new Error('unexpected source identity')
    }
    before = await lstat(canonicalSource, { bigint: true })
    handle = await open(canonicalSource, constants.O_RDONLY | NO_FOLLOW)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      throw new AcceptanceError(
        'E_RATE_SOURCE_CHANGED',
        'Tracked reconciliation source changed before it was inspected',
      )
    }
    raw = await readM07BoundedBytes(handle, MAX_INPUT_BYTES)
    const openedAfter = await handle.stat({ bigint: true })
    const after = await lstat(canonicalSource, { bigint: true })
    const requestedAfter = await realpath(resolve(root, relativePath))
    if (
      !sameFilesystemPath(requestedAfter, canonicalSource) ||
      !sameFileSnapshot(opened, openedAfter) ||
      !sameFileSnapshot(openedAfter, after) ||
      after.size !== BigInt(raw.length)
    ) {
      throw new AcceptanceError(
        'E_RATE_SOURCE_CHANGED',
        'Tracked reconciliation source changed while it was inspected',
      )
    }
  } catch (error) {
    if (error instanceof AcceptanceError) throw error
    throw new AcceptanceError(
      'E_RATE_SOURCE_UNAVAILABLE',
      'Unable to inspect the tracked HUD reconciliation implementation',
      true,
    )
  } finally {
    await handle?.close()
  }
  const headBlob = invokeGit(root, ['rev-parse', `HEAD:${relativePath}`])
    .trim()
    .toLowerCase()
  const objectHash = headBlob.length === 64 ? 'sha256' : 'sha1'
  const worktreeBlob = createHash(objectHash)
    .update(Buffer.from(`blob ${String(raw.length)}\0`, 'utf8'))
    .update(raw)
    .digest('hex')
  if (!GIT_SHA.test(headBlob) || !GIT_SHA.test(worktreeBlob) || headBlob !== worktreeBlob) {
    throw new AcceptanceError(
      'E_RATE_SOURCE_PROVENANCE',
      'Reconciliation source does not match the tracked HEAD blob',
      true,
    )
  }
  return Object.freeze({
    relativePath,
    gitBlob: headBlob,
    sha256: sha256(raw),
    bytes: raw.length,
  })
}

function codeUnitCompare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function validRuntimeSpecifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !containsControlCharacter(value) &&
    !value.includes('\\') &&
    !value.includes('?') &&
    !value.includes('#')
  )
}

function staticM07RuntimeSpecifiers(source) {
  const dynamicMarkers = [...source.matchAll(/\bimport\s*\(/gu)].length
  const dynamicSpecifiers = [
    ...source.matchAll(/\bimport\s*\(\s*["']([^"'\\\r\n]+)["']\s*\)/gu),
  ].map((match) => match[1])
  if (dynamicMarkers !== dynamicSpecifiers.length || /\brequire\s*\(/u.test(source)) {
    throw new AcceptanceError(
      'E_RATE_RUNTIME_PROVENANCE',
      'HUD runtime artifact contains an unsupported dynamic module loader',
      true,
    )
  }
  const specifiers = []
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"\r\n]*?\sfrom\s*)?["']([^"'\r\n]+)["']/gu
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]
    if (!validRuntimeSpecifier(specifier)) {
      throw new AcceptanceError(
        'E_RATE_RUNTIME_PROVENANCE',
        'HUD runtime artifact contains an unsafe module specifier',
        true,
      )
    }
    specifiers.push(specifier)
  }
  const quotedRelativeSpecifiers = [
    ...source.matchAll(/["']((?:\.\.?\/)[^"'\r\n]*?\.js)["']/gu),
  ].map((match) => match[1])
  return [...new Set([...specifiers, ...dynamicSpecifiers, ...quotedRelativeSpecifiers])]
}

async function readStableM07RuntimeFile(
  canonicalRoot,
  relativePath,
  maximumBytes = MAX_RUNTIME_ARTIFACT_BYTES,
) {
  const requested = resolve(canonicalRoot, relativePath)
  if (!isInside(canonicalRoot, requested)) {
    throw new AcceptanceError(
      'E_RATE_RUNTIME_PROVENANCE',
      'HUD runtime artifact escaped its package boundary',
      true,
    )
  }
  let handle
  try {
    const requestedStat = await lstat(requested, { bigint: true })
    if (
      !requestedStat.isFile() ||
      requestedStat.isSymbolicLink() ||
      requestedStat.size <= 0n ||
      requestedStat.size > BigInt(maximumBytes)
    ) {
      throw new Error('not a bounded regular file')
    }
    const canonical = await realpath(requested)
    if (!sameFilesystemPath(canonical, requested)) {
      throw new Error('runtime file uses a symbolic path')
    }
    const before = await lstat(canonical, { bigint: true })
    handle = await open(canonical, constants.O_RDONLY | NO_FOLLOW)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      throw new AcceptanceError(
        'E_RATE_RUNTIME_CHANGED',
        'HUD runtime artifact changed before it was inspected',
      )
    }
    const raw = await readM07BoundedBytes(handle, maximumBytes)
    const openedAfter = await handle.stat({ bigint: true })
    const after = await lstat(canonical, { bigint: true })
    const finalCanonical = await realpath(requested)
    if (
      !sameFilesystemPath(finalCanonical, canonical) ||
      !sameFileSnapshot(requestedStat, before) ||
      !sameFileSnapshot(before, opened) ||
      !sameFileSnapshot(opened, openedAfter) ||
      !sameFileSnapshot(openedAfter, after) ||
      after.size !== BigInt(raw.length)
    ) {
      throw new AcceptanceError(
        'E_RATE_RUNTIME_CHANGED',
        'HUD runtime artifact changed while it was inspected',
      )
    }
    return raw
  } catch (error) {
    if (error instanceof AcceptanceError) throw error
    throw new AcceptanceError(
      'E_RATE_RUNTIME_PROVENANCE',
      'Unable to inspect the built HUD runtime artifact',
      true,
    )
  } finally {
    await handle?.close()
  }
}

function runtimeRelativePath(value) {
  return value.replaceAll('\\', '/')
}

export async function inspectM07RuntimeArtifact(root) {
  const requestedPackageRoot = resolve(root, 'packages', HUD_PACKAGE_NAME)
  let canonicalPackageRoot
  let canonicalDistRoot
  try {
    const packageStat = await lstat(requestedPackageRoot)
    if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) throw new Error('package root')
    canonicalPackageRoot = await realpath(requestedPackageRoot)
    if (!sameFilesystemPath(canonicalPackageRoot, requestedPackageRoot)) {
      throw new Error('package root identity')
    }
    const requestedDistRoot = resolve(canonicalPackageRoot, 'dist')
    const distStat = await lstat(requestedDistRoot)
    if (!distStat.isDirectory() || distStat.isSymbolicLink()) throw new Error('dist root')
    canonicalDistRoot = await realpath(requestedDistRoot)
    if (!sameFilesystemPath(canonicalDistRoot, requestedDistRoot)) {
      throw new Error('dist root identity')
    }
  } catch {
    throw new AcceptanceError(
      'E_RATE_RUNTIME_PROVENANCE',
      'Unable to inspect the built HUD runtime artifact',
      true,
    )
  }

  let manifest
  try {
    manifest = JSON.parse(
      (await readStableM07RuntimeFile(canonicalPackageRoot, 'package.json')).toString('utf8'),
    )
  } catch (error) {
    if (error instanceof AcceptanceError) throw error
    throw new AcceptanceError('E_RATE_RUNTIME_PROVENANCE', 'HUD package manifest is invalid', true)
  }
  if (
    manifest?.name !== HUD_PACKAGE_NAME ||
    typeof manifest.version !== 'string' ||
    manifest.version.length > 128 ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version) ||
    manifest.type !== 'module' ||
    manifest.main !== `./${HUD_RUNTIME_ENTRYPOINT}` ||
    manifest.exports?.['.']?.default !== `./${HUD_RUNTIME_ENTRYPOINT}`
  ) {
    throw new AcceptanceError(
      'E_RATE_RUNTIME_PROVENANCE',
      'HUD package manifest does not identify the expected runtime entrypoint',
      true,
    )
  }

  const pending = ['index.js']
  const files = new Map()
  let totalBytes = 0
  while (pending.length > 0) {
    const distRelativePath = pending.pop()
    if (files.has(distRelativePath)) continue
    if (
      files.size >= MAX_RUNTIME_ARTIFACT_FILES ||
      !distRelativePath.endsWith('.js') ||
      !isInside(canonicalDistRoot, resolve(canonicalDistRoot, distRelativePath))
    ) {
      throw new AcceptanceError(
        'E_RATE_RUNTIME_PROVENANCE',
        'HUD runtime artifact closure is invalid or exceeds its file bound',
        true,
      )
    }
    const raw = await readStableM07RuntimeFile(canonicalDistRoot, distRelativePath)
    totalBytes += raw.length
    if (totalBytes > MAX_RUNTIME_ARTIFACT_TOTAL_BYTES) {
      throw new AcceptanceError(
        'E_RATE_RUNTIME_PROVENANCE',
        'HUD runtime artifact closure exceeds its total size bound',
        true,
      )
    }
    files.set(distRelativePath, raw)
    for (const specifier of staticM07RuntimeSpecifiers(raw.toString('utf8'))) {
      if (specifier.startsWith('.')) {
        if (!specifier.startsWith('./') || !specifier.endsWith('.js')) {
          throw new AcceptanceError(
            'E_RATE_RUNTIME_PROVENANCE',
            'HUD runtime artifact contains an unsupported relative module specifier',
            true,
          )
        }
        const imported = resolve(canonicalDistRoot, dirname(distRelativePath), specifier)
        if (!isInside(canonicalDistRoot, imported)) {
          throw new AcceptanceError(
            'E_RATE_RUNTIME_PROVENANCE',
            'HUD runtime artifact import escaped its dist boundary',
            true,
          )
        }
        pending.push(runtimeRelativePath(relative(canonicalDistRoot, imported)))
      } else if (
        !isBuiltin(specifier) &&
        !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/u.test(
          specifier,
        )
      ) {
        throw new AcceptanceError(
          'E_RATE_RUNTIME_PROVENANCE',
          'HUD runtime artifact contains an unsafe external module specifier',
          true,
        )
      }
    }
  }

  const descriptors = [...files.entries()]
    .map(([distRelativePath, raw]) => ({
      relativePath: `dist/${runtimeRelativePath(distRelativePath)}`,
      sha256: sha256(raw),
      bytes: raw.length,
    }))
    .sort((left, right) => codeUnitCompare(left.relativePath, right.relativePath))
  const bundleSha256 = sha256(
    descriptors
      .map(
        ({ relativePath, sha256: digest, bytes }) =>
          `${relativePath}\0${digest}\0${String(bytes)}\n`,
      )
      .join(''),
  )
  return Object.freeze({
    schemaVersion: HUD_RUNTIME_ARTIFACT_SCHEMA,
    packageName: HUD_PACKAGE_NAME,
    packageVersion: manifest.version,
    entrypoint: HUD_RUNTIME_ENTRYPOINT,
    files: Object.freeze(descriptors.map((descriptor) => Object.freeze(descriptor))),
    bundleSha256,
  })
}

function safeM07BuildArtifactPath(value) {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 512 &&
    !value.includes('\\') &&
    !containsControlCharacter(value) &&
    value
      .split('/')
      .every(
        (segment) =>
          segment !== '' &&
          segment !== '.' &&
          segment !== '..' &&
          /^[A-Za-z0-9._-]+$/u.test(segment),
      )
  )
}

async function collectM07DistributionPaths(distributionRoot, directory = distributionRoot) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    throw new AcceptanceError(
      'E_RATE_BUILD_PROVENANCE',
      'Unable to enumerate the HUD build distribution',
      true,
    )
  }
  const paths = []
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name)
    const relativePath = runtimeRelativePath(relative(distributionRoot, absolute))
    if (entry.isSymbolicLink()) {
      throw new AcceptanceError(
        'E_RATE_BUILD_PROVENANCE',
        'HUD build distribution contains a symbolic link',
        true,
      )
    }
    if (entry.isDirectory()) {
      paths.push(...(await collectM07DistributionPaths(distributionRoot, absolute)))
      continue
    }
    if (!entry.isFile() || !safeM07BuildArtifactPath(relativePath)) {
      throw new AcceptanceError(
        'E_RATE_BUILD_PROVENANCE',
        'HUD build distribution contains an unsupported entry',
        true,
      )
    }
    if (relativePath !== 'build-provenance.json') paths.push(relativePath)
  }
  return paths.sort(codeUnitCompare)
}

export async function inspectM07BuildProvenance(root, expectedGitHead, runtimeArtifact) {
  if (!GIT_SHA.test(expectedGitHead)) {
    throw new AcceptanceError('E_RATE_BUILD_PROVENANCE', 'Expected HUD build HEAD is invalid', true)
  }
  const normalizedRuntimeArtifact = normalizeM07RuntimeArtifact(runtimeArtifact)
  let canonicalPackageRoot
  let canonicalDistRoot
  try {
    canonicalPackageRoot = await realpath(resolve(root, 'packages', HUD_PACKAGE_NAME))
    canonicalDistRoot = await realpath(resolve(canonicalPackageRoot, 'dist'))
  } catch {
    throw new AcceptanceError(
      'E_RATE_BUILD_PROVENANCE',
      'Unable to locate the HUD build distribution',
      true,
    )
  }
  if (
    !sameFilesystemPath(canonicalPackageRoot, resolve(root, 'packages', HUD_PACKAGE_NAME)) ||
    !sameFilesystemPath(canonicalDistRoot, resolve(canonicalPackageRoot, 'dist'))
  ) {
    throw new AcceptanceError(
      'E_RATE_BUILD_PROVENANCE',
      'HUD build distribution uses a symbolic path',
      true,
    )
  }
  const manifestBytes = await readStableM07RuntimeFile(
    canonicalDistRoot,
    'build-provenance.json',
    MAX_BUILD_MANIFEST_BYTES,
  )
  let manifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw new AcceptanceError('E_RATE_BUILD_PROVENANCE', 'HUD build manifest is invalid', true)
  }
  if (
    !hasExactKeys(manifest, ['artifacts', 'buildId', 'dirty', 'gitHead', 'schemaVersion']) ||
    manifest.schemaVersion !== HUD_BUILD_PROVENANCE_SCHEMA ||
    manifest.gitHead !== expectedGitHead ||
    !BUILD_ID.test(manifest.buildId) ||
    manifest.dirty !== false ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length < 1 ||
    manifest.artifacts.length > MAX_BUILD_ARTIFACTS
  ) {
    throw new AcceptanceError(
      'E_RATE_BUILD_PROVENANCE',
      'HUD build manifest is not a clean build of repository HEAD',
      true,
    )
  }
  const artifacts = new Map()
  let totalBytes = 0
  for (const artifact of manifest.artifacts) {
    if (
      !hasExactKeys(artifact, ['bytes', 'path', 'sha256']) ||
      !safeM07BuildArtifactPath(artifact.path) ||
      artifact.path === 'build-provenance.json' ||
      artifacts.has(artifact.path) ||
      !SHA256.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 1 ||
      artifact.bytes > MAX_BUILD_ARTIFACT_BYTES
    ) {
      throw new AcceptanceError(
        'E_RATE_BUILD_PROVENANCE',
        'HUD build manifest artifact is invalid',
        true,
      )
    }
    totalBytes += artifact.bytes
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BUILD_TOTAL_BYTES) {
      throw new AcceptanceError(
        'E_RATE_BUILD_PROVENANCE',
        'HUD build manifest exceeds its total size bound',
        true,
      )
    }
    const bytes = await readStableM07RuntimeFile(
      canonicalDistRoot,
      artifact.path,
      MAX_BUILD_ARTIFACT_BYTES,
    )
    if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
      throw new AcceptanceError(
        'E_RATE_BUILD_PROVENANCE',
        'HUD build artifact does not match its manifest',
        true,
      )
    }
    artifacts.set(artifact.path, Object.freeze({ sha256: artifact.sha256, bytes: artifact.bytes }))
  }
  const manifestOrder = manifest.artifacts.map(({ path }) => path)
  const sortedManifestOrder = [...manifestOrder].sort(codeUnitCompare)
  const distributionBefore = await collectM07DistributionPaths(canonicalDistRoot)
  if (
    !manifestOrder.every((path, index) => path === sortedManifestOrder[index]) ||
    distributionBefore.length !== artifacts.size ||
    distributionBefore.some((path) => !artifacts.has(path))
  ) {
    throw new AcceptanceError(
      'E_RATE_BUILD_PROVENANCE',
      'HUD build manifest does not cover the complete canonical distribution',
      true,
    )
  }
  for (const runtimeFile of normalizedRuntimeArtifact.files) {
    const path = runtimeFile.relativePath.slice('dist/'.length)
    const artifact = artifacts.get(path)
    if (artifact?.sha256 !== runtimeFile.sha256 || artifact?.bytes !== runtimeFile.bytes) {
      throw new AcceptanceError(
        'E_RATE_BUILD_PROVENANCE',
        'HUD runtime closure does not match the complete build manifest',
        true,
      )
    }
  }
  const manifestAfter = await readStableM07RuntimeFile(
    canonicalDistRoot,
    'build-provenance.json',
    MAX_BUILD_MANIFEST_BYTES,
  )
  const distributionAfter = await collectM07DistributionPaths(canonicalDistRoot)
  if (
    sha256(manifestAfter) !== sha256(manifestBytes) ||
    JSON.stringify(distributionAfter) !== JSON.stringify(distributionBefore)
  ) {
    throw new AcceptanceError(
      'E_RATE_BUILD_PROVENANCE',
      'HUD build distribution changed during inspection',
    )
  }
  return Object.freeze({
    schemaVersion: HUD_BUILD_PROVENANCE_SCHEMA,
    gitHead: expectedGitHead,
    buildId: manifest.buildId,
    dirty: false,
    runtime: 'repo-dist',
    manifestSha256: sha256(manifestBytes),
    runtimeBundleSha256: normalizedRuntimeArtifact.bundleSha256,
  })
}

export async function inspectM07SourceProvenance(root, expectedGitHead, invokeGit = runGit) {
  let canonicalRoot
  try {
    canonicalRoot = await realpath(resolve(root))
  } catch {
    throw new AcceptanceError(
      'E_RATE_SOURCE_UNAVAILABLE',
      'Unable to inspect the tracked HUD reconciliation implementation',
      true,
    )
  }
  const files = []
  for (const relativePath of TRACKED_SOURCE_PATHS) {
    files.push(await inspectTrackedM07Source(root, canonicalRoot, relativePath, invokeGit))
  }
  const bundleSha256 = sha256(
    files
      .map(
        (file) => `${file.relativePath}\0${file.gitBlob}\0${file.sha256}\0${String(file.bytes)}\n`,
      )
      .join(''),
  )
  const runtimeArtifact = await inspectM07RuntimeArtifact(root)
  const build = await inspectM07BuildProvenance(root, expectedGitHead, runtimeArtifact)
  return Object.freeze({
    bundleSha256,
    files: Object.freeze(files),
    runtimeArtifact,
    build,
  })
}

export async function readExternalRateExport(root, path, label) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new AcceptanceError('E_RATE_INPUT_REQUIRED', `${label} export path is required`, true)
  }
  const candidate = resolve(path)
  let canonicalRoot
  let canonicalPath
  let before
  try {
    canonicalRoot = await realpath(resolve(root))
    const requested = await lstat(candidate, { bigint: true })
    if (!requested.isFile() || requested.isSymbolicLink()) {
      throw new AcceptanceError(
        'E_RATE_INPUT_READ',
        `Unable to read ${label} export as a regular file`,
        true,
      )
    }
    if (!validInputSize(requested.size)) {
      throw new AcceptanceError('E_RATE_INPUT_SIZE', `${label} export has an invalid size`)
    }
    canonicalPath = await realpath(candidate)
    before = await lstat(canonicalPath, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || !sameFileSnapshot(requested, before)) {
      throw new AcceptanceError(
        'E_RATE_INPUT_CHANGED',
        `${label} export changed while its identity was inspected`,
      )
    }
  } catch (error) {
    if (error instanceof AcceptanceError) throw error
    throw new AcceptanceError('E_RATE_INPUT_READ', `Unable to read ${label} export`, true)
  }
  if (isInside(canonicalRoot, canonicalPath)) {
    throw new AcceptanceError(
      'E_RATE_INPUT_PROVENANCE',
      `${label} export must be outside the repository`,
      true,
    )
  }
  let raw
  let handle
  try {
    handle = await open(canonicalPath, 'r')
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      throw new AcceptanceError(
        'E_RATE_INPUT_CHANGED',
        `${label} export changed before it was read`,
      )
    }
    raw = await readM07BoundedFile(handle, label)
    const openedAfter = await handle.stat({ bigint: true })
    const canonicalAfter = await realpath(candidate)
    if (
      !sameFilesystemPath(canonicalPath, canonicalAfter) ||
      !openedAfter.isFile() ||
      !sameFileSnapshot(opened, openedAfter) ||
      openedAfter.size !== BigInt(raw.length)
    ) {
      throw new AcceptanceError('E_RATE_INPUT_CHANGED', `${label} export changed while it was read`)
    }
  } catch (error) {
    if (error instanceof AcceptanceError) throw error
    throw new AcceptanceError('E_RATE_INPUT_READ', `Unable to read ${label} export`, true)
  } finally {
    await handle?.close()
  }
  if (raw.length === 0 || raw.length > MAX_INPUT_BYTES) {
    throw new AcceptanceError('E_RATE_INPUT_SIZE', `${label} export has an invalid size`)
  }
  let value
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new AcceptanceError('E_RATE_INPUT_JSON', `${label} export is not valid JSON`)
  }
  assertNoSuspiciousCredentialFields(value)
  return Object.freeze({
    canonicalPath,
    sha256: sha256(raw),
    bytes: raw.length,
    value,
  })
}

function loopbackHostname(hostname) {
  const normalized = hostname.toLowerCase()
  if (normalized === '[::1]') return true
  const octets = normalized.split('.')
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/u.test(octet)) &&
    octets.map(Number).every((octet) => octet >= 0 && octet <= 255) &&
    Number(octets[0]) === 127
  )
}

export function validateM07HudUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new AcceptanceError('E_RATE_HUD_URL', 'HUD URL must be a bounded loopback HTTP URL', true)
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new AcceptanceError('E_RATE_HUD_URL', 'HUD URL must be a valid loopback HTTP URL', true)
  }
  if (
    url.protocol !== 'http:' ||
    !loopbackHostname(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '/' && url.pathname !== HUD_CAPTURE_PATH)
  ) {
    throw new AcceptanceError(
      'E_RATE_HUD_URL',
      'HUD URL must be credential-free loopback HTTP with no query or fragment',
      true,
    )
  }
  url.pathname = HUD_CAPTURE_PATH
  return url
}

export function extractProviderRateWindow(value) {
  if (
    !hasExactKeys(value, ['records', 'schemaVersion', 'source', 'window']) ||
    value.schemaVersion !== PROVIDER_EXPORT_SCHEMA ||
    !hasExactKeys(value.source, ['exportedAt', 'kind', 'origin', 'provider']) ||
    value.source.kind !== 'provider-billing-export' ||
    value.source.origin !== 'real-provider-export' ||
    typeof value.source.provider !== 'string' ||
    !PROVIDER_IDENTIFIER.test(value.source.provider) ||
    !canonicalUtc(value.source.exportedAt) ||
    !Array.isArray(value.records) ||
    value.records.length === 0 ||
    value.records.length > 100_000
  ) {
    throw new AcceptanceError(
      'E_RATE_PROVIDER_SCHEMA',
      'Provider export cannot establish a real billing window',
    )
  }
  const window = exactRateWindow(value.window, 'Provider export')
  if (Date.parse(value.source.exportedAt) < Date.parse(window.endUtc)) {
    throw new AcceptanceError(
      'E_RATE_PROVIDER_SCHEMA',
      'Provider export timestamp precedes its billing window',
    )
  }
  return window
}

export async function readM07BoundedResponseBody(body, maxBytes = MAX_HTTP_RESPONSE_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_HTTP_RESPONSE_BYTES) {
    throw new TypeError('maxBytes must be a positive bounded safe integer')
  }
  if (body === null || typeof body?.getReader !== 'function') {
    throw new AcceptanceError('E_RATE_HUD_RESPONSE', 'Mounted HUD returned an empty response')
  }
  const reader = body.getReader()
  const chunks = []
  let total = 0
  try {
    while (total <= maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        throw new AcceptanceError(
          'E_RATE_HUD_RESPONSE',
          'Mounted HUD returned an invalid response stream',
        )
      }
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new AcceptanceError(
          'E_RATE_HUD_RESPONSE_SIZE',
          'Mounted HUD response exceeds the allowed size',
        )
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) {
    throw new AcceptanceError('E_RATE_HUD_RESPONSE', 'Mounted HUD returned an empty response')
  }
  return Buffer.concat(chunks, total)
}

function validProviderRequestEvidence(value, metadata, record, challengeSha256) {
  return (
    hasExactKeys(value, ['adapter', 'binding', 'providerRequestIdSha256', 'schemaVersion']) &&
    value.schemaVersion === 'dsh-luban/provider-request-identity-evidence/v1' &&
    hasExactKeys(value.adapter, ['id', 'runtimeSha256', 'version']) &&
    typeof value.adapter.id === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value.adapter.id) &&
    typeof value.adapter.version === 'string' &&
    value.adapter.version.length > 0 &&
    value.adapter.version.length <= 128 &&
    value.adapter.version.trim() === value.adapter.version &&
    !containsControlCharacter(value.adapter.version) &&
    SHA256.test(value.adapter.runtimeSha256) &&
    hasExactKeys(value.binding, [
      'assistantEventSeq',
      'assistantMessageIdSha256',
      'challengeSha256',
      'model',
      'provider',
      'sessionIdSha256',
      'step',
      'turn',
    ]) &&
    value.binding.sessionIdSha256 === sha256(metadata.sessionId) &&
    value.binding.assistantEventSeq === metadata.eventSeq &&
    value.binding.turn === metadata.turn &&
    value.binding.step === metadata.step &&
    value.binding.assistantMessageIdSha256 === sha256(metadata.messageId) &&
    value.binding.provider === metadata.provider &&
    value.binding.model === metadata.model &&
    value.binding.challengeSha256 === challengeSha256 &&
    value.providerRequestIdSha256 === sha256(record?.id ?? '')
  )
}

function validCaptureMetadata(value, record, challengeSha256) {
  const boundedText = (field) =>
    typeof field === 'string' &&
    field.length > 0 &&
    field.length <= 128 &&
    !containsControlCharacter(field)
  return (
    hasExactKeys(value, [
      'eventSeq',
      'id',
      'messageId',
      'model',
      'provider',
      'providerRequest',
      'sessionId',
      'step',
      'turn',
    ]) &&
    typeof value.id === 'string' &&
    RATE_IDENTIFIER.test(value.id) &&
    value.id === record?.id &&
    typeof value.sessionId === 'string' &&
    RATE_IDENTIFIER.test(value.sessionId) &&
    typeof value.messageId === 'string' &&
    RATE_IDENTIFIER.test(value.messageId) &&
    boundedText(value.provider) &&
    boundedText(value.model) &&
    Number.isSafeInteger(value.eventSeq) &&
    value.eventSeq >= 0 &&
    Number.isSafeInteger(value.turn) &&
    value.turn >= 0 &&
    Number.isSafeInteger(value.step) &&
    value.step >= 0 &&
    validProviderRequestEvidence(value.providerRequest, value, record, challengeSha256)
  )
}

function normalizeM07RuntimeArtifact(value) {
  if (
    !hasExactKeys(value, [
      'bundleSha256',
      'entrypoint',
      'files',
      'packageName',
      'packageVersion',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== HUD_RUNTIME_ARTIFACT_SCHEMA ||
    value.packageName !== HUD_PACKAGE_NAME ||
    typeof value.packageVersion !== 'string' ||
    value.packageVersion.length > 128 ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value.packageVersion) ||
    value.entrypoint !== HUD_RUNTIME_ENTRYPOINT ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > MAX_RUNTIME_ARTIFACT_FILES ||
    !SHA256.test(value.bundleSha256)
  ) {
    throw new AcceptanceError(
      'E_RATE_HUD_RUNTIME_PROVENANCE',
      'Mounted HUD runtime artifact identity is invalid',
      true,
    )
  }
  let totalBytes = 0
  const normalizedFiles = value.files.map((file) => {
    if (
      !hasExactKeys(file, ['bytes', 'relativePath', 'sha256']) ||
      typeof file.relativePath !== 'string' ||
      file.relativePath.length > 512 ||
      file.relativePath.split('/')[0] !== 'dist' ||
      file.relativePath
        .split('/')
        .some(
          (segment) =>
            segment === '' ||
            segment === '.' ||
            segment === '..' ||
            !/^[A-Za-z0-9._-]+$/u.test(segment),
        ) ||
      !file.relativePath.endsWith('.js') ||
      !SHA256.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      file.bytes > MAX_RUNTIME_ARTIFACT_BYTES
    ) {
      throw new AcceptanceError(
        'E_RATE_HUD_RUNTIME_PROVENANCE',
        'Mounted HUD runtime artifact file identity is invalid',
        true,
      )
    }
    totalBytes += file.bytes
    return Object.freeze({
      relativePath: file.relativePath,
      sha256: file.sha256,
      bytes: file.bytes,
    })
  })
  if (totalBytes > MAX_RUNTIME_ARTIFACT_TOTAL_BYTES) {
    throw new AcceptanceError(
      'E_RATE_HUD_RUNTIME_PROVENANCE',
      'Mounted HUD runtime artifact exceeds its total size bound',
      true,
    )
  }
  const sorted = [...normalizedFiles].sort((left, right) =>
    codeUnitCompare(left.relativePath, right.relativePath),
  )
  if (
    !normalizedFiles.every((file, index) => file.relativePath === sorted[index]?.relativePath) ||
    new Set(normalizedFiles.map(({ relativePath }) => relativePath)).size !==
      normalizedFiles.length ||
    normalizedFiles.filter(({ relativePath }) => relativePath === HUD_RUNTIME_ENTRYPOINT).length !==
      1
  ) {
    throw new AcceptanceError(
      'E_RATE_HUD_RUNTIME_PROVENANCE',
      'Mounted HUD runtime artifact file closure is not canonical',
      true,
    )
  }
  const computedBundle = sha256(
    normalizedFiles
      .map(
        ({ relativePath, sha256: digest, bytes }) =>
          `${relativePath}\0${digest}\0${String(bytes)}\n`,
      )
      .join(''),
  )
  if (computedBundle !== value.bundleSha256) {
    throw new AcceptanceError(
      'E_RATE_HUD_RUNTIME_PROVENANCE',
      'Mounted HUD runtime artifact bundle digest is invalid',
      true,
    )
  }
  return Object.freeze({
    schemaVersion: HUD_RUNTIME_ARTIFACT_SCHEMA,
    packageName: HUD_PACKAGE_NAME,
    packageVersion: value.packageVersion,
    entrypoint: HUD_RUNTIME_ENTRYPOINT,
    files: Object.freeze(normalizedFiles),
    bundleSha256: computedBundle,
  })
}

function normalizeM07BuildProvenance(value) {
  if (
    !hasExactKeys(value, [
      'buildId',
      'dirty',
      'gitHead',
      'manifestSha256',
      'runtime',
      'runtimeBundleSha256',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== HUD_BUILD_PROVENANCE_SCHEMA ||
    !GIT_SHA.test(value.gitHead) ||
    !BUILD_ID.test(value.buildId) ||
    typeof value.dirty !== 'boolean' ||
    value.runtime !== 'repo-dist' ||
    !SHA256.test(value.manifestSha256) ||
    !SHA256.test(value.runtimeBundleSha256)
  ) {
    throw new AcceptanceError(
      'E_RATE_HUD_BUILD_PROVENANCE',
      'Mounted HUD build provenance is invalid',
      true,
    )
  }
  return Object.freeze({
    schemaVersion: HUD_BUILD_PROVENANCE_SCHEMA,
    gitHead: value.gitHead,
    buildId: value.buildId,
    dirty: value.dirty,
    runtime: 'repo-dist',
    manifestSha256: value.manifestSha256,
    runtimeBundleSha256: value.runtimeBundleSha256,
  })
}

export function validateMountedHudCapture(value, expectedWindow, challenge) {
  const window = exactRateWindow(expectedWindow, 'Expected provider')
  const challengeSha256 = sha256(captureChallenge(challenge))
  const runtimeArtifact = normalizeM07RuntimeArtifact(value?.source?.runtimeArtifact)
  const build = normalizeM07BuildProvenance(value?.source?.build)
  assertNoSuspiciousCredentialFields(value)
  if (
    !hasExactKeys(value, ['captures', 'export', 'schemaVersion', 'source']) ||
    value.schemaVersion !== HUD_CAPTURE_SCHEMA ||
    !hasExactKeys(value.source, [
      'challengeSha256',
      'build',
      'coverageStartUtc',
      'exportedAt',
      'kind',
      'nodeVersion',
      'processId',
      'runtimeArtifact',
    ]) ||
    value.source.kind !== 'mounted-hud-capture' ||
    !canonicalUtc(value.source.exportedAt) ||
    !canonicalUtc(value.source.coverageStartUtc) ||
    !Number.isSafeInteger(value.source.processId) ||
    value.source.processId <= 0 ||
    typeof value.source.nodeVersion !== 'string' ||
    value.source.nodeVersion.length === 0 ||
    value.source.nodeVersion.length > 128 ||
    !SHA256.test(value.source.challengeSha256) ||
    value.source.challengeSha256 !== challengeSha256
  ) {
    throw new AcceptanceError(
      'E_RATE_HUD_CAPTURE_SCHEMA',
      'Mounted HUD capture wrapper provenance is invalid',
    )
  }
  if (Date.parse(value.source.coverageStartUtc) > Date.parse(window.startUtc)) {
    throw new AcceptanceError(
      'E_RATE_HUD_COVERAGE',
      'Mounted HUD capture does not cover the complete provider window',
      true,
    )
  }
  if (
    !hasExactKeys(value.export, ['records', 'schemaVersion', 'source', 'window']) ||
    value.export.schemaVersion !== HUD_EXPORT_SCHEMA ||
    !hasExactKeys(value.export.source, ['exportedAt', 'kind', 'origin']) ||
    value.export.source.kind !== 'hud-event-export' ||
    value.export.source.origin !== 'live-hud-events' ||
    !canonicalUtc(value.export.source.exportedAt) ||
    value.export.source.exportedAt !== value.source.exportedAt ||
    !Array.isArray(value.export.records) ||
    !Array.isArray(value.captures) ||
    value.captures.length === 0 ||
    value.captures.length > 10_000 ||
    value.captures.length !== value.export.records.length ||
    !value.captures.every((metadata, index) =>
      validCaptureMetadata(metadata, value.export.records[index], challengeSha256),
    ) ||
    new Set(value.export.records.map((record) => record?.id)).size !== value.export.records.length
  ) {
    throw new AcceptanceError('E_RATE_HUD_CAPTURE_SCHEMA', 'Mounted HUD capture payload is invalid')
  }
  const providerAdapter = value.captures[0]?.providerRequest?.adapter
  if (
    providerAdapter === undefined ||
    value.captures.some(
      (metadata) =>
        JSON.stringify(metadata.providerRequest.adapter) !== JSON.stringify(providerAdapter),
    )
  ) {
    throw new AcceptanceError(
      'E_RATE_PROVIDER_IDENTITY',
      'Mounted HUD capture changed provider request adapter identity within the window',
      true,
    )
  }
  const exportedWindow = exactRateWindow(value.export.window, 'Mounted HUD export')
  if (
    exportedWindow.startUtc !== window.startUtc ||
    exportedWindow.endUtc !== window.endUtc ||
    Date.parse(value.source.exportedAt) < Date.parse(window.endUtc)
  ) {
    throw new AcceptanceError(
      'E_RATE_HUD_CAPTURE_WINDOW',
      'Mounted HUD capture is not bound to the provider billing window',
    )
  }
  return Object.freeze({
    value: value.export,
    capture: Object.freeze({
      schemaVersion: HUD_CAPTURE_SCHEMA,
      sourceKind: 'mounted-hud-capture',
      coverageStartUtc: value.source.coverageStartUtc,
      exportedAt: value.source.exportedAt,
      challengeSha256,
      runtimeArtifact,
      build,
      providerRequestIdentity: Object.freeze({
        adapter: Object.freeze({ ...providerAdapter }),
        count: value.captures.length,
        bindingsSha256: sha256(
          value.captures
            .map(({ providerRequest }) => providerRequest.providerRequestIdSha256)
            .join('\n'),
        ),
      }),
    }),
  })
}

function sessionCookie(environment) {
  const value = environment?.LUBAN_SESSION_COOKIE
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.trim() !== value ||
    !value.includes('=') ||
    containsControlCharacter(value)
  ) {
    throw new AcceptanceError(
      'E_RATE_HUD_COOKIE',
      'Mounted HUD capture requires LUBAN_SESSION_COOKIE in the environment',
      true,
    )
  }
  return value
}

export async function fetchMountedHudRateCapture(hudUrl, providerWindow, challenge, options = {}) {
  const endpoint = validateM07HudUrl(hudUrl)
  const window = exactRateWindow(providerWindow, 'Provider export')
  const boundedChallenge = captureChallenge(challenge)
  const timeoutMs = options.timeoutMs ?? HUD_REQUEST_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? MAX_HTTP_RESPONSE_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new TypeError('timeoutMs must be a positive integer no greater than 30000')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_HTTP_RESPONSE_BYTES) {
    throw new TypeError('maxBytes must be a positive bounded safe integer')
  }
  endpoint.searchParams.set('startUtc', window.startUtc)
  endpoint.searchParams.set('endUtc', window.endUtc)
  endpoint.searchParams.set('challenge', boundedChallenge)
  const cookie = sessionCookie(options.environment ?? process.env)
  const controller = new globalThis.AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  let raw
  try {
    const response = await (options.fetchImpl ?? globalThis.fetch)(endpoint, {
      method: 'GET',
      headers: Object.freeze({
        accept: 'application/json',
        cookie,
      }),
      redirect: 'error',
      signal: controller.signal,
    })
    if (response.status !== 200) {
      throw new AcceptanceError(
        'E_RATE_HUD_STATUS',
        `Mounted HUD capture returned HTTP ${String(response.status)}`,
        true,
      )
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      throw new AcceptanceError('E_RATE_HUD_RESPONSE', 'Mounted HUD capture did not return JSON')
    }
    const contentLength = response.headers.get('content-length')
    if (
      contentLength !== null &&
      (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maxBytes)
    ) {
      throw new AcceptanceError(
        'E_RATE_HUD_RESPONSE_SIZE',
        'Mounted HUD response exceeds the allowed size',
      )
    }
    raw = await readM07BoundedResponseBody(response.body, maxBytes)
  } catch (error) {
    if (error instanceof AcceptanceError) throw error
    if (controller.signal.aborted) {
      throw new AcceptanceError('E_RATE_HUD_TIMEOUT', 'Mounted HUD capture timed out', true)
    }
    throw new AcceptanceError('E_RATE_HUD_FETCH', 'Unable to fetch mounted HUD capture', true)
  } finally {
    globalThis.clearTimeout(timeout)
  }
  const responseText = raw.toString('utf8')
  if (responseText.includes(cookie) || responseText.includes(boundedChallenge)) {
    throw new AcceptanceError(
      'E_RATE_SECRET_FIELD',
      'Mounted HUD response reflects authentication or challenge material',
    )
  }
  let value
  try {
    value = JSON.parse(responseText)
  } catch {
    throw new AcceptanceError('E_RATE_HUD_RESPONSE', 'Mounted HUD returned invalid JSON')
  }
  const validated = validateMountedHudCapture(
    value,
    window,
    boundedChallenge,
    options.expectedRuntimeArtifact,
    options.expectedBuild,
  )
  return Object.freeze({
    sha256: sha256(raw),
    bytes: raw.length,
    ...validated,
  })
}

async function productionReconcile(hud, provider) {
  let module
  try {
    module = await import(RECONCILIATION_MODULE.href)
  } catch {
    throw new AcceptanceError(
      'E_RATE_SOURCE_UNAVAILABLE',
      'Unable to load the HUD reconciliation implementation',
      true,
    )
  }
  if (typeof module.reconcileRateExports !== 'function') {
    throw new AcceptanceError(
      'E_RATE_SOURCE_UNAVAILABLE',
      'HUD package does not expose rate reconciliation',
      true,
    )
  }
  return module.reconcileRateExports(hud, provider, { requireLiveOrigins: true })
}

function mountedHudRequested(options) {
  return typeof options.hudUrl === 'string' && options.hudUrl.trim() !== ''
}

export function createM07RateReconciliationPlan(options = {}) {
  const root = resolve(options.root ?? REPOSITORY_ROOT)
  const mountedHud = mountedHudRequested(options)
  return Object.freeze({
    schemaVersion: PLAN_SCHEMA,
    featureId: FEATURE_ID,
    runId: boundedRunId(options.runId),
    root,
    requestedMode:
      options.live === true
        ? mountedHud
          ? 'mounted-hud-with-provider-export'
          : 'external-export-diagnostic'
        : 'plan',
    sources: Object.freeze([
      mountedHud
        ? 'authenticated mounted HUD capture over credential-free loopback HTTP'
        : 'operator-provided HUD event export outside the repository',
      'independent real provider billing/token export outside the repository',
    ]),
    window: 'one exact 1-minute or 5-minute UTC interval shared by both exports',
    tokenBasis: Object.freeze([
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'unknownTokens',
    ]),
    tolerance: Object.freeze({ requestCountRelative: 0, tokenRelative: 0.05 }),
    acceptanceBoundary: mountedHud
      ? 'mounted HUD capture must contain provider request IDs and reconcile with a real billing export; Windows and Ubuntu are run separately'
      : 'two operator-provided JSON files are diagnostic; functional acceptance requires mounted HUD capture',
    writes: options.live === true ? 'one new evidence file only' : 'none',
  })
}

function requiredLiveOptions(options) {
  if (options.providerExportConfirmed !== true) {
    throw new AcceptanceError(
      'E_RATE_PROVIDER_CONFIRMATION',
      'Live mode requires explicit confirmation of a real provider export',
      true,
    )
  }
  if (typeof options.providerExport !== 'string' || options.providerExport.trim() === '') {
    throw new AcceptanceError(
      'E_RATE_INPUT_REQUIRED',
      'Live mode requires a provider export path',
      true,
    )
  }
  const hasHudExport = typeof options.hudExport === 'string' && options.hudExport.trim() !== ''
  const hasHudUrl = typeof options.hudUrl === 'string' && options.hudUrl.trim() !== ''
  if (hasHudExport === hasHudUrl) {
    throw new AcceptanceError(
      'E_RATE_HUD_SOURCE',
      'Live mode requires exactly one of HUD export path or mounted HUD URL',
      true,
    )
  }
}

function resultHasLiveOrigins(result) {
  return (
    result?.status === 'pass' &&
    result.sources?.hud?.origin === 'live-hud-events' &&
    result.sources?.provider?.origin === 'real-provider-export'
  )
}

export function requiresM07FunctionalBoundary(execution, operationStatus, functionalityPass) {
  return execution === 'production' && operationStatus === 'pass' && functionalityPass === true
}

export function requiredM07BoundaryCode(execution, hudMode, operationStatus, functionalityPass) {
  if (!requiresM07FunctionalBoundary(execution, operationStatus, functionalityPass)) return null
  return hudMode === 'mounted' ? null : 'E_RATE_MOUNTED_CAPTURE_REQUIRED'
}

export function m07EvidenceKind(execution, hudMode) {
  if (execution !== 'production') return 'simulated'
  return hudMode === 'mounted'
    ? 'mounted-hud-provider-reconciled'
    : 'operator-provided-external-exports'
}

function productionBoundaryError(code) {
  return new AcceptanceError(
    code,
    'External JSON reconciliation is diagnostic; functional acceptance requires mounted HUD capture',
    true,
  )
}

function inputSummary(input, reconciliation, kind) {
  if (input === null || input === undefined) return null
  const source = kind === 'hud' ? reconciliation?.sources?.hud : reconciliation?.sources?.provider
  const expectedSchema = kind === 'hud' ? HUD_EXPORT_SCHEMA : PROVIDER_EXPORT_SCHEMA
  const summary = {
    sha256: input.sha256,
    bytes: input.bytes,
    schemaVersion: input.value?.schemaVersion === expectedSchema ? expectedSchema : 'invalid',
    origin: typeof source?.origin === 'string' ? source.origin : 'unknown',
    ...(kind === 'provider' && typeof source?.provider === 'string'
      ? { provider: source.provider }
      : {}),
  }
  if (kind === 'hud' && input.capture !== undefined) {
    return {
      ...summary,
      transport: 'authenticated-loopback-http',
      capture: input.capture,
    }
  }
  return summary
}

export async function runM07RateReconciliation(options = {}, dependencies = {}) {
  const plan = createM07RateReconciliationPlan(options)
  const startedAt = isoNow()
  if (options.live !== true) {
    return Object.freeze({
      ...plan,
      execution: 'none',
      evidenceKind: 'none',
      status: 'planned',
      acceptancePassed: false,
      startedAt,
      finishedAt: isoNow(),
    })
  }

  const injected = Object.keys(dependencies).length > 0
  const execution = injected ? 'test-double' : 'production'
  const hudMode = mountedHudRequested(options) ? 'mounted' : 'external'
  const runtime = {
    inspectPlatform: inspectM07RuntimePlatform,
    readInput: readExternalRateExport,
    extractProviderWindow: extractProviderRateWindow,
    createChallenge: createM07CaptureChallenge,
    fetchHudCapture: fetchMountedHudRateCapture,
    reconcile: productionReconcile,
    ...dependencies,
  }
  const checks = []
  let platform = null
  let hudInput = null
  let providerInput = null
  let reconciliation = null
  let failure
  let operationStatus = 'fail'

  try {
    requiredLiveOptions(options)
    check(checks, 'real-provider-export-confirmed', 'pass', true)
    platform = await runtime.inspectPlatform()
    check(checks, 'platform-supported', 'pass', platform.target)
    providerInput = await runtime.readInput(plan.root, options.providerExport, 'provider')
    assertNoSuspiciousCredentialFields(providerInput.value)
    if (hudMode === 'mounted') {
      const providerWindow = runtime.extractProviderWindow(providerInput.value)
      const challenge = captureChallenge(runtime.createChallenge())
      hudInput = await runtime.fetchHudCapture(options.hudUrl, providerWindow, challenge)
      if (hudInput.capture?.sourceKind !== 'mounted-hud-capture') {
        throw new AcceptanceError(
          'E_RATE_HUD_CAPTURE_SCHEMA',
          'Mounted HUD fetch did not return a rate capture',
        )
      }
      check(checks, 'mounted-hud-challenge-bound', 'pass', hudInput.capture.challengeSha256)
      check(checks, 'mounted-hud-complete-coverage', 'pass', hudInput.capture.coverageStartUtc)
      check(
        checks,
        'provider-request-identities-bound',
        'pass',
        `${hudInput.capture.providerRequestIdentity.adapter.id}:${String(hudInput.capture.providerRequestIdentity.count)}`,
      )
    } else {
      hudInput = await runtime.readInput(plan.root, options.hudExport, 'HUD')
    }
    assertNoSuspiciousCredentialFields(hudInput.value)
    if (
      (typeof hudInput.canonicalPath === 'string' &&
        hudInput.canonicalPath === providerInput.canonicalPath) ||
      hudInput.sha256 === providerInput.sha256
    ) {
      throw new AcceptanceError(
        'E_RATE_INPUT_INDEPENDENCE',
        'HUD and provider exports must be independent input files',
      )
    }
    if (!SHA256.test(hudInput.sha256) || !SHA256.test(providerInput.sha256)) {
      throw new AcceptanceError('E_RATE_INPUT_HASH', 'Rate export digest is invalid')
    }
    check(checks, 'independent-inputs', 'pass', true)
    reconciliation = await runtime.reconcile(hudInput.value, providerInput.value, {
      requireLiveOrigins: true,
    })
    if (!resultHasLiveOrigins(reconciliation)) {
      throw new AcceptanceError(
        'E_RATE_LIVE_SOURCE',
        'Reconciliation did not contain live HUD and real provider origins',
      )
    }
    check(checks, 'complete-token-basis', 'pass', true)
    check(checks, 'request-count-exact', 'pass', reconciliation.deltas.requestCount.relative)
    check(checks, 'token-error-within-five-percent', 'pass', true)
    operationStatus = 'pass'
  } catch (error) {
    failure = error
    operationStatus = error instanceof AcceptanceError && error.blocked ? 'blocked' : 'fail'
    const outcome = safeError(error)
    check(checks, 'acceptance-outcome', operationStatus, outcome.code)
  }

  const functionalityPass =
    (hudMode === 'external' ||
      (hudInput?.capture?.sourceKind === 'mounted-hud-capture' &&
        hudInput.capture.providerRequestIdentity?.count > 0)) &&
    resultHasLiveOrigins(reconciliation)
  const boundaryCode = requiredM07BoundaryCode(
    execution,
    hudMode,
    operationStatus,
    functionalityPass,
  )
  if (boundaryCode !== null) {
    failure = productionBoundaryError(boundaryCode)
    operationStatus = 'blocked'
    check(checks, 'mounted-hud-capture-required', 'blocked', false)
  }
  const status =
    execution === 'test-double' && operationStatus === 'pass' ? 'simulated' : operationStatus
  const acceptancePassed =
    execution === 'production' &&
    hudMode === 'mounted' &&
    operationStatus === 'pass' &&
    functionalityPass
  return Object.freeze({
    schemaVersion: EVIDENCE_SCHEMA,
    featureId: FEATURE_ID,
    runId: plan.runId,
    execution,
    evidenceKind: m07EvidenceKind(execution, hudMode),
    status,
    acceptancePassed,
    platform,
    git: null,
    source: null,
    inputs: Object.freeze({
      hud: inputSummary(hudInput, reconciliation, 'hud'),
      provider: inputSummary(providerInput, reconciliation, 'provider'),
    }),
    window: reconciliation?.window ?? null,
    totals: reconciliation?.totals ?? null,
    deltas: reconciliation?.deltas ?? null,
    tolerance:
      reconciliation?.tolerance ?? Object.freeze({ requestCountRelative: 0, tokenRelative: 0.05 }),
    checks: Object.freeze(checks),
    ...(failure === undefined ? {} : { error: Object.freeze(safeError(failure)) }),
    startedAt,
    finishedAt: isoNow(),
  })
}

export async function resolveM07EvidenceTarget(root, path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new AcceptanceError('E_RATE_OUTPUT_REQUIRED', 'Evidence output path is required', true)
  }
  const requestedTarget = resolve(path)
  let canonicalRoot
  let canonicalParent
  try {
    canonicalRoot = await realpath(resolve(root))
    const parent = dirname(requestedTarget)
    const parentMetadata = await lstat(parent)
    if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
      throw new Error('not a regular directory')
    }
    canonicalParent = await realpath(parent)
  } catch {
    throw new AcceptanceError(
      'E_RATE_OUTPUT_PARENT',
      'Evidence output requires an existing regular parent directory',
      true,
    )
  }
  const target = resolve(canonicalParent, basename(requestedTarget))
  if (isInside(canonicalRoot, target)) {
    throw new AcceptanceError(
      'E_RATE_OUTPUT_PROVENANCE',
      'Live evidence output must be outside the repository',
      true,
    )
  }
  try {
    await lstat(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return target
    throw new AcceptanceError('E_RATE_OUTPUT_READ', 'Unable to inspect evidence output path', true)
  }
  throw new AcceptanceError('E_RATE_OUTPUT_EXISTS', 'Evidence output must be a new file', true)
}

export async function writeM07RateEvidence(path, evidence, options = {}) {
  const root = options.root ?? REPOSITORY_ROOT
  const target = await resolveM07EvidenceTarget(root, path)
  assertNoSuspiciousCredentialFields(evidence)
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`
  try {
    await writeFile(target, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new AcceptanceError('E_RATE_OUTPUT_EXISTS', 'Evidence output must be a new file', true)
    }
    throw new AcceptanceError('E_RATE_OUTPUT_WRITE', 'Unable to write evidence output', true)
  }
  const [metadata, persisted, canonicalTarget, canonicalRoot] = await Promise.all([
    lstat(target),
    readFile(target),
    realpath(target),
    realpath(resolve(root)),
  ])
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    !sameFilesystemPath(canonicalTarget, target) ||
    isInside(canonicalRoot, canonicalTarget) ||
    persisted.length !== Buffer.byteLength(serialized, 'utf8') ||
    sha256(persisted) !== sha256(serialized)
  ) {
    throw new AcceptanceError('E_RATE_OUTPUT_VERIFY', 'Evidence output verification failed')
  }
  return Object.freeze({ target, sha256: sha256(serialized) })
}

function nextValue(argv, index, option) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

function parseArguments(argv) {
  const options = { live: false, providerExportConfirmed: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--live') options.live = true
    else if (argument === '--confirm-real-provider-export') options.providerExportConfirmed = true
    else if (argument === '--hud-export') {
      options.hudExport = nextValue(argv, index, argument)
      index += 1
    } else if (argument === '--hud-url') {
      options.hudUrl = nextValue(argv, index, argument)
      index += 1
    } else if (argument === '--provider-export') {
      options.providerExport = nextValue(argv, index, argument)
      index += 1
    } else if (argument === '--output') {
      options.output = nextValue(argv, index, argument)
      index += 1
    } else if (argument === '--run-id') {
      options.runId = nextValue(argv, index, argument)
      index += 1
    } else if (argument === '--help') options.help = true
    else throw new Error(`Unknown option: ${argument}`)
  }
  if (options.live && options.output === undefined && options.help !== true) {
    throw new Error('--live requires --output <new-json-path>')
  }
  if (!options.live && options.output !== undefined && options.help !== true) {
    throw new Error('--output is only valid with --live')
  }
  if (options.hudExport !== undefined && options.hudUrl !== undefined) {
    throw new Error('--hud-export and --hud-url are mutually exclusive')
  }
  return options
}

export async function runM07RateReconciliationCli(argv, log = (value) => console.log(value)) {
  const options = parseArguments(argv)
  if (options.help === true) {
    log('Usage: node scripts/acceptance/m07-rate-reconcile.mjs')
    log(
      '       node scripts/acceptance/m07-rate-reconcile.mjs --live --confirm-real-provider-export --hud-export <external-json> --provider-export <external-json> --output <new-json-path>',
    )
    log(
      '       LUBAN_SESSION_COOKIE=<cookie> node scripts/acceptance/m07-rate-reconcile.mjs --live --confirm-real-provider-export --hud-url <loopback-http-base-or-endpoint> --provider-export <external-json> --output <new-json-path>',
    )
    return 0
  }
  if (options.output !== undefined) {
    await resolveM07EvidenceTarget(REPOSITORY_ROOT, options.output)
  }
  const result = await runM07RateReconciliation(options)
  if (options.output !== undefined) {
    const artifact = await writeM07RateEvidence(options.output, result, { root: REPOSITORY_ROOT })
    log(JSON.stringify({ ...result, artifact }, null, 2))
  } else {
    log(JSON.stringify(result, null, 2))
  }
  if (result.status === 'blocked') return 2
  if (result.status === 'fail') return 1
  return 0
}

async function main() {
  process.exitCode = await runM07RateReconciliationCli(process.argv.slice(2))
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`m07-rate-reconcile: ${safeError(error).message}`)
    process.exitCode = 1
  })
}
