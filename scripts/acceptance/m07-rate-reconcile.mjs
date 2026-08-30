#!/usr/bin/env node

import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..')
const RECONCILIATION_MODULE = new URL(
  '../../packages/dsh-luban-hud/src/rate-reconcile.ts',
  import.meta.url,
)
const RECONCILIATION_SOURCE_PATH = 'packages/dsh-luban-hud/src/rate-reconcile.ts'
const PLAN_SCHEMA = 'dsh-luban/m07-rate-reconciliation-plan/v1'
const EVIDENCE_SCHEMA = 'dsh-luban/m07-rate-reconciliation-evidence/v2'
const HUD_EXPORT_SCHEMA = 'dsh-luban/m07-hud-rate-export/v1'
const PROVIDER_EXPORT_SCHEMA = 'dsh-luban/m07-provider-rate-export/v1'
const FEATURE_ID = 'M07-F004'
const MAX_INPUT_BYTES = 10 * 1024 * 1024
const MAX_OS_RELEASE_BYTES = 64 * 1024
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const SHA256 = /^[a-f0-9]{64}$/u
const SUSPICIOUS_CREDENTIAL_KEYS = new Set([
  'apikey',
  'authorization',
  'bearer',
  'clientsecret',
  'cookie',
  'credential',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'sessiontoken',
  'accesstoken',
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

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })
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
  const status = invokeGit(root, ['status', '--porcelain=v1', '--untracked-files=all'])
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

export async function readM07BoundedFile(handle, label, maxBytes = MAX_INPUT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_INPUT_BYTES) {
    throw new TypeError('maxBytes must be a positive bounded safe integer')
  }
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
  if (total === 0 || total > maxBytes) {
    throw new AcceptanceError('E_RATE_INPUT_SIZE', `${label} export has an invalid size`)
  }
  return Buffer.concat(chunks, total)
}

export async function inspectM07SourceProvenance(root, invokeGit = runGit) {
  let canonicalRoot
  let canonicalSource
  let before
  let raw
  try {
    canonicalRoot = await realpath(resolve(root))
    const requestedSource = resolve(root, RECONCILIATION_SOURCE_PATH)
    const requested = await lstat(requestedSource, { bigint: true })
    if (!requested.isFile() || requested.isSymbolicLink()) throw new Error('not a regular file')
    canonicalSource = await realpath(requestedSource)
    if (!sameFilesystemPath(canonicalSource, resolve(canonicalRoot, RECONCILIATION_SOURCE_PATH))) {
      throw new Error('unexpected source identity')
    }
    before = await lstat(canonicalSource, { bigint: true })
    raw = await readFile(canonicalSource)
    const after = await lstat(canonicalSource, { bigint: true })
    if (!sameFileSnapshot(before, after) || after.size !== BigInt(raw.length)) {
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
  }
  const headBlob = invokeGit(root, ['rev-parse', `HEAD:${RECONCILIATION_SOURCE_PATH}`])
    .trim()
    .toLowerCase()
  const worktreeBlob = invokeGit(root, [
    'hash-object',
    `--path=${RECONCILIATION_SOURCE_PATH}`,
    RECONCILIATION_SOURCE_PATH,
  ])
    .trim()
    .toLowerCase()
  if (!GIT_SHA.test(headBlob) || !GIT_SHA.test(worktreeBlob) || headBlob !== worktreeBlob) {
    throw new AcceptanceError(
      'E_RATE_SOURCE_PROVENANCE',
      'Reconciliation source does not match the tracked HEAD blob',
      true,
    )
  }
  return Object.freeze({
    relativePath: RECONCILIATION_SOURCE_PATH,
    gitBlob: headBlob,
    sha256: sha256(raw),
    bytes: raw.length,
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

async function productionReconcile(hud, provider) {
  let module
  try {
    module = await import(RECONCILIATION_MODULE.href)
  } catch {
    throw new AcceptanceError(
      'E_RATE_SOURCE_UNAVAILABLE',
      'Unable to load the tracked HUD reconciliation implementation',
      true,
    )
  }
  if (typeof module.reconcileRateExports !== 'function') {
    throw new AcceptanceError(
      'E_RATE_SOURCE_UNAVAILABLE',
      'Tracked HUD source does not expose rate reconciliation',
      true,
    )
  }
  return module.reconcileRateExports(hud, provider, { requireLiveOrigins: true })
}

export function createM07RateReconciliationPlan(options = {}) {
  const root = resolve(options.root ?? REPOSITORY_ROOT)
  return Object.freeze({
    schemaVersion: PLAN_SCHEMA,
    featureId: FEATURE_ID,
    runId: boundedRunId(options.runId),
    root,
    requestedMode: options.live === true ? 'operator-attested' : 'plan',
    sources: Object.freeze([
      'HUD event export outside the repository',
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
    acceptanceBoundary:
      'external JSON proves reconciliation only; direct live acceptance requires a built-in trusted capture adapter',
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
  if (typeof options.hudExport !== 'string' || typeof options.providerExport !== 'string') {
    throw new AcceptanceError(
      'E_RATE_INPUT_REQUIRED',
      'Live mode requires both HUD and provider export paths',
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

export function requiresTrustedM07Capture(execution, operationStatus, integrityPass) {
  return execution === 'production' && operationStatus === 'pass' && integrityPass === true
}

function inputSummary(input, reconciliation, kind) {
  if (input === null) return null
  const source = kind === 'hud' ? reconciliation?.sources?.hud : reconciliation?.sources?.provider
  const expectedSchema = kind === 'hud' ? HUD_EXPORT_SCHEMA : PROVIDER_EXPORT_SCHEMA
  return {
    sha256: input.sha256,
    bytes: input.bytes,
    schemaVersion: input.value?.schemaVersion === expectedSchema ? expectedSchema : 'invalid',
    origin: typeof source?.origin === 'string' ? source.origin : 'unknown',
    ...(kind === 'provider' && typeof source?.provider === 'string'
      ? { provider: source.provider }
      : {}),
  }
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
  const runtime = {
    inspectPlatform: inspectM07RuntimePlatform,
    inspectGit: inspectM07GitState,
    inspectSource: inspectM07SourceProvenance,
    readInput: readExternalRateExport,
    reconcile: productionReconcile,
    ...dependencies,
  }
  const checks = []
  let platform = null
  let before = null
  let after = null
  let sourceBefore = null
  let sourceAfter = null
  let hudInput = null
  let providerInput = null
  let reconciliation = null
  let failure
  let operationStatus = 'fail'

  try {
    if (execution === 'production' && !sameFilesystemPath(plan.root, REPOSITORY_ROOT)) {
      throw new AcceptanceError(
        'E_RATE_REPOSITORY_ROOT',
        'Production reconciliation must attest this repository root',
        true,
      )
    }
    requiredLiveOptions(options)
    check(checks, 'real-provider-export-confirmed', 'pass', true)
    platform = await runtime.inspectPlatform()
    check(checks, 'platform-attested', 'pass', platform.target)
    before = await runtime.inspectGit(plan.root)
    check(checks, 'git-before-clean', before.clean ? 'pass' : 'blocked', before.clean)
    if (before.clean !== true) {
      throw new AcceptanceError(
        'E_RATE_GIT_DIRTY',
        'Live reconciliation requires a clean source tree before reading exports',
        true,
      )
    }
    sourceBefore = await runtime.inspectSource(plan.root)
    check(checks, 'tracked-source-bound-to-head', 'pass', sourceBefore.gitBlob)
    ;[hudInput, providerInput] = await Promise.all([
      runtime.readInput(plan.root, options.hudExport, 'HUD'),
      runtime.readInput(plan.root, options.providerExport, 'provider'),
    ])
    assertNoSuspiciousCredentialFields(hudInput.value)
    assertNoSuspiciousCredentialFields(providerInput.value)
    if (
      hudInput.canonicalPath === providerInput.canonicalPath ||
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
        'Reconciliation did not attest live HUD and real provider origins',
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

  if (sourceBefore !== null) {
    try {
      sourceAfter = await runtime.inspectSource(plan.root)
      const sameSource =
        sourceAfter.gitBlob === sourceBefore.gitBlob &&
        sourceAfter.sha256 === sourceBefore.sha256 &&
        sourceAfter.bytes === sourceBefore.bytes
      check(checks, 'tracked-source-unchanged', sameSource ? 'pass' : 'fail', sameSource)
      if (!sameSource) {
        failure = new AcceptanceError(
          'E_RATE_SOURCE_CHANGED',
          'Tracked reconciliation source changed during reconciliation',
        )
        operationStatus = 'fail'
      }
    } catch (error) {
      failure = error
      operationStatus = 'fail'
      check(checks, 'tracked-source-after-inspected', 'fail', false)
    }
  }

  if (before !== null) {
    try {
      after = await runtime.inspectGit(plan.root)
      const clean = after.clean === true
      const sameHead = after.sha === before.sha
      check(checks, 'git-after-clean', clean ? 'pass' : 'fail', clean)
      check(checks, 'git-head-unchanged', sameHead ? 'pass' : 'fail', sameHead)
      if (before.clean === true && (!clean || !sameHead)) {
        failure = new AcceptanceError(
          !clean ? 'E_RATE_GIT_DIRTY_AFTER' : 'E_RATE_GIT_HEAD_DRIFT',
          !clean
            ? 'Source tree became dirty during reconciliation'
            : 'Git HEAD changed during reconciliation',
        )
        operationStatus = 'fail'
      }
    } catch (error) {
      if (before.clean === true) {
        failure = error
        operationStatus = 'fail'
      }
      check(checks, 'git-after-inspected', 'fail', false)
    }
  }

  const integrityPass =
    before?.clean === true &&
    after?.clean === true &&
    before.sha === after.sha &&
    sourceBefore !== null &&
    sourceAfter !== null &&
    resultHasLiveOrigins(reconciliation)
  if (requiresTrustedM07Capture(execution, operationStatus, integrityPass)) {
    failure = new AcceptanceError(
      'E_RATE_TRUSTED_CAPTURE_REQUIRED',
      'External JSON reconciliation is operator-attested; direct live acceptance requires a built-in trusted capture adapter',
      true,
    )
    operationStatus = 'blocked'
    check(checks, 'trusted-capture-bound', 'blocked', false)
  }
  const status =
    execution === 'test-double' && operationStatus === 'pass' ? 'simulated' : operationStatus
  return Object.freeze({
    schemaVersion: EVIDENCE_SCHEMA,
    featureId: FEATURE_ID,
    runId: plan.runId,
    execution,
    evidenceKind: execution === 'production' ? 'operator-attested' : 'simulated',
    status,
    acceptancePassed: false,
    platform,
    git: Object.freeze({ before, after }),
    source: Object.freeze({ before: sourceBefore, after: sourceAfter }),
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

function nextPath(argv, index, option) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a path`)
  return value
}

function parseArguments(argv) {
  const options = { live: false, providerExportConfirmed: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--live') options.live = true
    else if (argument === '--confirm-real-provider-export') options.providerExportConfirmed = true
    else if (argument === '--hud-export') {
      options.hudExport = nextPath(argv, index, argument)
      index += 1
    } else if (argument === '--provider-export') {
      options.providerExport = nextPath(argv, index, argument)
      index += 1
    } else if (argument === '--output') {
      options.output = nextPath(argv, index, argument)
      index += 1
    } else if (argument === '--run-id') {
      options.runId = nextPath(argv, index, argument)
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
  return options
}

export async function runM07RateReconciliationCli(argv, log = (value) => console.log(value)) {
  const options = parseArguments(argv)
  if (options.help === true) {
    log('Usage: node scripts/acceptance/m07-rate-reconcile.mjs')
    log(
      '       node scripts/acceptance/m07-rate-reconcile.mjs --live --confirm-real-provider-export --hud-export <external-json> --provider-export <external-json> --output <new-json-path>',
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
