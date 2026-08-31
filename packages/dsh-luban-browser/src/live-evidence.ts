import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const LIVE_BROWSER_EVIDENCE_SCHEMA = 'dsh-luban/m11-live-browser/v3' as const
export const LIVE_BROWSER_DUAL_SCHEMA = 'dsh-luban/m11-live-browser-dual/v3' as const
export const LIVE_BROWSER_BUILD_PROVENANCE_SCHEMA = 'dsh-luban/browser-build-provenance/v2' as const
export const LIVE_BROWSER_FEATURES = Object.freeze(['M11-F001', 'M11-F004'] as const)
export const LIVE_BROWSER_CHALLENGE_PORT = 47_631
export const LIVE_BROWSER_CHALLENGE_URL =
  `http://127.0.0.1:${String(LIVE_BROWSER_CHALLENGE_PORT)}/challenge` as const
export const LIVE_BROWSER_TEMPLATE_ID = 'luban-live-acceptance-v1' as const

export const LIVE_BROWSER_MODEL_ROUTE = 'dsh-default' as const

export const LIVE_BROWSER_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: Object.freeze(['nonce']),
  additionalProperties: false,
  properties: Object.freeze({ nonce: Object.freeze({ type: 'string' }) }),
})

export const LIVE_BROWSER_CANONICAL_TASK = Object.freeze({
  id: LIVE_BROWSER_TEMPLATE_ID,
  title: 'Luban live browser acceptance',
  goal: [
    'Open the supplied start URL.',
    'Read the exact text inside the element with the data-luban-challenge attribute.',
    'Return only the JSON object required by the output schema.',
  ].join(' '),
  startUrl: LIVE_BROWSER_CHALLENGE_URL,
  allowDomains: Object.freeze(['127.0.0.1']),
  timeoutSec: 180,
  maxSteps: 12,
  profile: Object.freeze({ mode: 'isolated' as const }),
  outputSchema: LIVE_BROWSER_OUTPUT_SCHEMA,
})

export const LIVE_BROWSER_CHALLENGE_HTML_TEMPLATE = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>Luban live acceptance</title></head>',
  '<body><main><h1>Browser acceptance challenge</h1>',
  '<code data-luban-challenge>{{NONCE}}</code>',
  '</main></body></html>',
].join('')

export const LIVE_BROWSER_TASK_SHA256 = sha256Text(canonicalJson(LIVE_BROWSER_CANONICAL_TASK))
export const LIVE_BROWSER_FIXTURE_SHA256 = sha256Text(LIVE_BROWSER_CHALLENGE_HTML_TEMPLATE)

export const LIVE_BROWSER_CHECK_IDS = Object.freeze([
  'optIn',
  'dshModelGatewayPresent',
  'gitClean',
  'buildProvenanceAttested',
  'platformAttested',
  'browserProfileResolved',
  'browserBinaryAttested',
  'challengeFetched',
  'resultOk',
  'structuredNonceMatched',
  'progressObserved',
  'screenshotVerified',
  'secretFree',
] as const)

export type LiveBrowserCheckId = (typeof LIVE_BROWSER_CHECK_IDS)[number]
export type LiveBrowserChecks = Readonly<Record<LiveBrowserCheckId, boolean>>
export type LiveBrowserTarget = 'windows' | 'ubuntu'
export type LiveBrowserExecution = 'production' | 'test-double'
export type LiveBrowserVerdict = 'pass' | 'fail' | 'test-only'

export interface LiveBrowserPlatformEvidence {
  readonly target: LiveBrowserTarget
  readonly runtimePlatform: 'win32' | 'linux'
  readonly arch: string
  readonly node: string
  readonly osReleaseId?: 'ubuntu'
}

export interface LiveBrowserProfileEvidence {
  readonly kernel: 'chrome' | 'edge' | 'chromium-headless'
  readonly headless: boolean
  readonly isolated: true
}

export interface LiveBrowserBinaryEvidence {
  readonly kind: 'chrome' | 'edge' | 'chromium'
  readonly version: string
  readonly sha256: string
}

export interface LiveBrowserBuildEvidence {
  readonly schemaVersion: typeof LIVE_BROWSER_BUILD_PROVENANCE_SCHEMA
  readonly gitSha: string
  readonly dirty: false
  readonly treeSha256: string
  readonly fileCount: number
}

export interface LiveBrowserScreenshotEvidence {
  readonly sha256: string
  readonly bytes: number
  readonly pngMagic: true
  readonly pngStructure: true
}

export interface LiveBrowserEvidence {
  readonly schemaVersion: typeof LIVE_BROWSER_EVIDENCE_SCHEMA
  readonly featureIds: typeof LIVE_BROWSER_FEATURES
  readonly runId: string
  readonly execution: LiveBrowserExecution
  readonly verdict: LiveBrowserVerdict
  readonly startedAt: string
  readonly finishedAt: string
  readonly git: {
    readonly sha: string
    readonly dirty: boolean
  }
  readonly build: LiveBrowserBuildEvidence
  readonly taskSha256: string
  readonly fixtureSha256: string
  readonly modelRoute: typeof LIVE_BROWSER_MODEL_ROUTE
  readonly platform: LiveBrowserPlatformEvidence
  readonly browser: {
    readonly profile: LiveBrowserProfileEvidence
    readonly binary: LiveBrowserBinaryEvidence
    readonly bridgeVersion: '0.1.0'
    readonly browserUseVersion: '0.13.8'
    readonly python: '3.12'
    readonly challengeUserAgentSha256?: string
  }
  readonly challenge: {
    readonly requestCount: number
    readonly expectedNonceSha256: string
    readonly observedNonceSha256?: string
    readonly matched: boolean
  }
  readonly result: {
    readonly status: 'ok' | 'failed' | 'timeout' | 'missing'
    readonly progressEvents: number
    readonly steps?: number
    readonly durationMs?: number
    readonly screenshots: readonly LiveBrowserScreenshotEvidence[]
  }
  readonly checks: LiveBrowserChecks
}

export interface DualLiveBrowserEvidence {
  readonly schemaVersion: typeof LIVE_BROWSER_DUAL_SCHEMA
  readonly featureIds: typeof LIVE_BROWSER_FEATURES
  readonly verdict: 'pass'
  readonly gitSha: string
  readonly taskSha256: string
  readonly fixtureSha256: string
  readonly generatedAt: string
  readonly inputs: {
    readonly windows: { readonly runId: string; readonly evidenceSha256: string }
    readonly ubuntu: { readonly runId: string; readonly evidenceSha256: string }
  }
}

export class LiveAcceptanceError extends Error {
  public readonly code: string

  public constructor(code: string, message: string) {
    super(message)
    this.name = 'LiveAcceptanceError'
    this.code = code
  }
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function evidenceSha256(evidence: LiveBrowserEvidence): string {
  return sha256Text(canonicalJson(evidence))
}

export function aggregateLiveBrowserEvidence(
  evidence: readonly LiveBrowserEvidence[],
  now: () => Date = (): Date => new Date(),
): DualLiveBrowserEvidence {
  if (evidence.length !== 2) {
    throw new LiveAcceptanceError(
      'E_LIVE_EVIDENCE_COUNT',
      'Exactly one Windows and one Ubuntu evidence file are required',
    )
  }
  for (const item of evidence) assertAggregatableEvidence(item)

  const windows = evidence.find((item): boolean => item.platform.target === 'windows')
  const ubuntu = evidence.find((item): boolean => item.platform.target === 'ubuntu')
  if (windows === undefined || ubuntu === undefined) {
    throw new LiveAcceptanceError(
      'E_LIVE_EVIDENCE_PLATFORM',
      'Evidence must contain one Windows run and one Ubuntu run',
    )
  }
  if (
    windows.git.sha !== ubuntu.git.sha ||
    windows.taskSha256 !== ubuntu.taskSha256 ||
    windows.fixtureSha256 !== ubuntu.fixtureSha256
  ) {
    throw new LiveAcceptanceError(
      'E_LIVE_EVIDENCE_MISMATCH',
      'Windows and Ubuntu evidence do not describe the same source, task, and fixture',
    )
  }

  return Object.freeze({
    schemaVersion: LIVE_BROWSER_DUAL_SCHEMA,
    featureIds: LIVE_BROWSER_FEATURES,
    verdict: 'pass',
    gitSha: windows.git.sha,
    taskSha256: windows.taskSha256,
    fixtureSha256: windows.fixtureSha256,
    generatedAt: now().toISOString(),
    inputs: Object.freeze({
      windows: Object.freeze({
        runId: windows.runId,
        evidenceSha256: evidenceSha256(windows),
      }),
      ubuntu: Object.freeze({
        runId: ubuntu.runId,
        evidenceSha256: evidenceSha256(ubuntu),
      }),
    }),
  })
}

export function parseLiveBrowserEvidence(value: unknown): LiveBrowserEvidence {
  if (!isRecord(value) || value.schemaVersion !== LIVE_BROWSER_EVIDENCE_SCHEMA) {
    throw new LiveAcceptanceError('E_LIVE_EVIDENCE_INVALID', 'Evidence schema is invalid')
  }
  const candidate = value as unknown as LiveBrowserEvidence
  assertEvidenceShape(candidate)
  return deepFreeze(candidate)
}

export async function readLiveBrowserEvidence(path: string): Promise<LiveBrowserEvidence> {
  let raw: string
  try {
    raw = await readFile(resolve(path), 'utf8')
  } catch {
    throw new LiveAcceptanceError('E_LIVE_EVIDENCE_READ', 'Unable to read live evidence')
  }
  if (Buffer.byteLength(raw) > 1024 * 1024) {
    throw new LiveAcceptanceError('E_LIVE_EVIDENCE_INVALID', 'Live evidence is too large')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw) as unknown
  } catch {
    throw new LiveAcceptanceError('E_LIVE_EVIDENCE_INVALID', 'Live evidence is not valid JSON')
  }
  return parseLiveBrowserEvidence(decoded)
}

export async function writeEvidenceFile(
  path: string,
  value: LiveBrowserEvidence | DualLiveBrowserEvidence,
  secrets: readonly string[] = [],
): Promise<string> {
  const target = resolve(path)
  const serialized = `${JSON.stringify(value, undefined, 2)}\n`
  assertSecretFree(serialized, secrets)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(target, 'wx', 0o600)
    await handle.writeFile(serialized, 'utf8')
  } catch (error: unknown) {
    if (errorCode(error) === 'EEXIST') {
      throw new LiveAcceptanceError(
        'E_LIVE_EVIDENCE_EXISTS',
        'Refusing to overwrite an existing evidence file',
      )
    }
    throw new LiveAcceptanceError('E_LIVE_EVIDENCE_WRITE', 'Unable to write live evidence')
  } finally {
    await handle?.close()
  }
  return target
}

export function assertSecretFree(serialized: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret.length >= 8 && serialized.includes(secret)) {
      throw new LiveAcceptanceError(
        'E_LIVE_SECRET_OUTPUT',
        'Refusing to emit evidence containing a credential value',
      )
    }
  }
}

export function failedCliEnvelope(error: unknown): Readonly<Record<string, unknown>> {
  const failure =
    error instanceof LiveAcceptanceError
      ? error
      : new LiveAcceptanceError('E_LIVE_INTERNAL', 'Live acceptance failed')
  return Object.freeze({
    schemaVersion: 'dsh-luban/live-acceptance-error/v1',
    runId: randomUUID(),
    verdict: 'fail',
    error: Object.freeze({ code: failure.code, message: failure.message }),
  })
}

function assertEvidenceShape(evidence: LiveBrowserEvidence): void {
  if (
    !hasExactKeys(evidence, [
      'schemaVersion',
      'featureIds',
      'runId',
      'execution',
      'verdict',
      'startedAt',
      'finishedAt',
      'git',
      'build',
      'taskSha256',
      'fixtureSha256',
      'modelRoute',
      'platform',
      'browser',
      'challenge',
      'result',
      'checks',
    ]) ||
    !isExact(evidence.schemaVersion, LIVE_BROWSER_EVIDENCE_SCHEMA) ||
    !sameFeatures(evidence.featureIds) ||
    !isBoundedIdentifier(evidence.runId) ||
    !isOneOf(evidence.execution, ['production', 'test-double']) ||
    !isOneOf(evidence.verdict, ['pass', 'fail', 'test-only'])
  ) {
    invalidEvidence('Evidence identity fields are invalid')
  }

  const startedAt = isoTimestamp(evidence.startedAt)
  const finishedAt = isoTimestamp(evidence.finishedAt)
  if (startedAt === undefined || finishedAt === undefined || finishedAt < startedAt) {
    invalidEvidence('Evidence timestamps are invalid or out of order')
  }

  if (
    evidence.taskSha256 !== LIVE_BROWSER_TASK_SHA256 ||
    evidence.fixtureSha256 !== LIVE_BROWSER_FIXTURE_SHA256
  ) {
    throw new LiveAcceptanceError(
      'E_LIVE_EVIDENCE_MISMATCH',
      'Evidence does not use the canonical live task and fixture',
    )
  }
  if (!isExact(evidence.modelRoute, LIVE_BROWSER_MODEL_ROUTE)) {
    invalidEvidence('Evidence does not use the current DSH default model')
  }

  if (
    !hasExactKeys(evidence.git, ['sha', 'dirty']) ||
    !isGitSha(evidence.git.sha) ||
    typeof evidence.git.dirty !== 'boolean'
  ) {
    invalidEvidence('Evidence Git fields are invalid')
  }
  const rawBuild: unknown = evidence.build
  if (
    !isRecord(rawBuild) ||
    !hasExactKeys(rawBuild, ['schemaVersion', 'gitSha', 'dirty', 'treeSha256', 'fileCount']) ||
    rawBuild.schemaVersion !== LIVE_BROWSER_BUILD_PROVENANCE_SCHEMA ||
    !isGitSha(rawBuild.gitSha) ||
    rawBuild.dirty !== false ||
    rawBuild.gitSha !== evidence.git.sha ||
    !isSha256(rawBuild.treeSha256) ||
    !isPositiveInteger(rawBuild.fileCount)
  ) {
    throw new LiveAcceptanceError(
      'E_LIVE_EVIDENCE_PROVENANCE',
      'Evidence build provenance does not match its clean source commit',
    )
  }

  assertPlatformShape(evidence.platform, evidence.browser)
  assertChallengeShape(evidence.challenge)
  assertResultShape(evidence.result)
  assertCheckShape(evidence.checks)

  const checks = evidence.checks
  if (
    !checks.optIn ||
    !checks.dshModelGatewayPresent ||
    !checks.buildProvenanceAttested ||
    !checks.platformAttested ||
    !checks.browserProfileResolved ||
    !checks.browserBinaryAttested ||
    !checks.secretFree ||
    checks.gitClean !== !evidence.git.dirty ||
    checks.challengeFetched !== evidence.challenge.requestCount >= 1 ||
    checks.resultOk !== (evidence.result.status === 'ok') ||
    checks.structuredNonceMatched !== evidence.challenge.matched ||
    checks.progressObserved !== evidence.result.progressEvents >= 1 ||
    checks.screenshotVerified !== evidence.result.screenshots.length >= 1
  ) {
    throw new LiveAcceptanceError(
      'E_LIVE_EVIDENCE_CHECK',
      'Evidence checks contradict the recorded observations',
    )
  }

  const allChecksPass = LIVE_BROWSER_CHECK_IDS.every((id): boolean => checks[id])
  if (!verdictMatchesExecution(evidence.execution, evidence.verdict, allChecksPass)) {
    invalidEvidence('Evidence execution and verdict are inconsistent')
  }
}

function assertPlatformShape(
  platform: LiveBrowserPlatformEvidence,
  browser: LiveBrowserEvidence['browser'],
): void {
  if (
    !hasExactKeys(platform, ['target', 'runtimePlatform', 'arch', 'node'], ['osReleaseId']) ||
    !isBoundedIdentifier(platform.arch) ||
    typeof platform.node !== 'string' ||
    !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(platform.node) ||
    !hasExactKeys(
      browser,
      ['profile', 'binary', 'bridgeVersion', 'browserUseVersion', 'python'],
      ['challengeUserAgentSha256'],
    ) ||
    !isExact(browser.bridgeVersion, '0.1.0') ||
    !isExact(browser.browserUseVersion, '0.13.8') ||
    !isExact(browser.python, '3.12') ||
    (browser.challengeUserAgentSha256 !== undefined &&
      !isSha256(browser.challengeUserAgentSha256)) ||
    !hasExactKeys(browser.profile, ['kernel', 'headless', 'isolated']) ||
    !isExact(browser.profile.isolated, true) ||
    !hasExactKeys(browser.binary, ['kind', 'version', 'sha256']) ||
    !isBrowserVersion(browser.binary.version) ||
    !isSha256(browser.binary.sha256)
  ) {
    invalidEvidence('Evidence platform or browser profile fields are invalid')
  }

  if (platform.target === 'windows') {
    if (
      platform.runtimePlatform !== 'win32' ||
      platform.osReleaseId !== undefined ||
      (browser.profile.kernel !== 'chrome' && browser.profile.kernel !== 'edge') ||
      browser.binary.kind !== browser.profile.kernel ||
      !isExact(browser.profile.headless, false)
    ) {
      throw new LiveAcceptanceError(
        'E_LIVE_EVIDENCE_PLATFORM',
        'Windows evidence does not attest a Windows browser profile',
      )
    }
    return
  }
  if (
    !isExact(platform.target, 'ubuntu') ||
    platform.runtimePlatform !== 'linux' ||
    platform.osReleaseId !== 'ubuntu' ||
    browser.profile.kernel !== 'chromium-headless' ||
    !['chromium', 'chrome'].includes(browser.binary.kind) ||
    !isExact(browser.profile.headless, true)
  ) {
    throw new LiveAcceptanceError(
      'E_LIVE_EVIDENCE_PLATFORM',
      'Ubuntu evidence does not attest the required runtime and profile',
    )
  }
}

function assertChallengeShape(challenge: LiveBrowserEvidence['challenge']): void {
  if (
    !hasExactKeys(
      challenge,
      ['requestCount', 'expectedNonceSha256', 'matched'],
      ['observedNonceSha256'],
    ) ||
    !isNonNegativeInteger(challenge.requestCount) ||
    !isSha256(challenge.expectedNonceSha256) ||
    (challenge.observedNonceSha256 !== undefined && !isSha256(challenge.observedNonceSha256)) ||
    typeof challenge.matched !== 'boolean' ||
    challenge.matched !==
      (challenge.observedNonceSha256 !== undefined &&
        challenge.observedNonceSha256 === challenge.expectedNonceSha256)
  ) {
    invalidEvidence('Evidence challenge fields are invalid or inconsistent')
  }
}

function assertResultShape(result: LiveBrowserEvidence['result']): void {
  if (
    !hasExactKeys(result, ['status', 'progressEvents', 'screenshots'], ['steps', 'durationMs']) ||
    !['ok', 'failed', 'timeout', 'missing'].includes(result.status) ||
    !isNonNegativeInteger(result.progressEvents) ||
    !Array.isArray(result.screenshots) ||
    (result.status === 'missing'
      ? result.steps !== undefined || result.durationMs !== undefined
      : !isNonNegativeInteger(result.steps) || !isNonNegativeInteger(result.durationMs))
  ) {
    invalidEvidence('Evidence result fields are invalid')
  }

  const screenshotDigests = new Set<string>()
  for (const screenshot of result.screenshots as readonly unknown[]) {
    if (!isRecord(screenshot)) {
      invalidEvidence('Evidence screenshot proof is invalid or duplicated')
    }
    const sha256 = screenshot.sha256
    const bytes = screenshot.bytes
    if (
      !hasExactKeys(screenshot, ['sha256', 'bytes', 'pngMagic', 'pngStructure']) ||
      !isSha256(sha256) ||
      typeof bytes !== 'number' ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      screenshot.pngMagic !== true ||
      screenshot.pngStructure !== true ||
      screenshotDigests.has(sha256)
    ) {
      invalidEvidence('Evidence screenshot proof is invalid or duplicated')
    }
    screenshotDigests.add(sha256)
  }
}

function assertCheckShape(checks: LiveBrowserChecks): void {
  if (!hasExactKeys(checks, LIVE_BROWSER_CHECK_IDS)) {
    invalidEvidence('Evidence checks are incomplete or contain unknown checks')
  }
  for (const id of LIVE_BROWSER_CHECK_IDS) {
    if (typeof checks[id] !== 'boolean') {
      invalidEvidence('Evidence checks must be boolean')
    }
  }
}

function assertAggregatableEvidence(evidence: LiveBrowserEvidence): void {
  assertEvidenceShape(evidence)
  if (evidence.execution !== 'production' || evidence.verdict !== 'pass') {
    throw new LiveAcceptanceError(
      'E_LIVE_EVIDENCE_NOT_LIVE',
      'Only passing production evidence can be aggregated',
    )
  }
  if (evidence.git.dirty || LIVE_BROWSER_CHECK_IDS.some((id) => !evidence.checks[id])) {
    throw new LiveAcceptanceError(
      'E_LIVE_EVIDENCE_CHECK',
      'Every live acceptance check must pass on a clean source tree',
    )
  }
  if (
    evidence.challenge.requestCount < 1 ||
    !evidence.challenge.matched ||
    evidence.result.status !== 'ok' ||
    evidence.result.progressEvents < 1 ||
    evidence.result.screenshots.length < 1
  ) {
    throw new LiveAcceptanceError(
      'E_LIVE_EVIDENCE_CHECK',
      'Live result, challenge, progress, or screenshot evidence is incomplete',
    )
  }
  const { platform, browser } = evidence
  if (platform.target === 'windows') {
    if (
      platform.runtimePlatform !== 'win32' ||
      platform.osReleaseId !== undefined ||
      !['chrome', 'edge'].includes(browser.profile.kernel) ||
      browser.binary.kind !== browser.profile.kernel ||
      browser.profile.headless
    ) {
      throw new LiveAcceptanceError(
        'E_LIVE_EVIDENCE_PLATFORM',
        'Windows evidence does not attest a Windows Chrome or Edge run',
      )
    }
  } else if (
    !isExact(platform.target, 'ubuntu') ||
    platform.runtimePlatform !== 'linux' ||
    platform.osReleaseId !== 'ubuntu' ||
    browser.profile.kernel !== 'chromium-headless' ||
    !['chromium', 'chrome'].includes(browser.binary.kind) ||
    !browser.profile.headless
  ) {
    throw new LiveAcceptanceError(
      'E_LIVE_EVIDENCE_PLATFORM',
      'Ubuntu evidence does not attest a headless Chromium run on Ubuntu',
    )
  }
}

function sameFeatures(value: unknown): value is typeof LIVE_BROWSER_FEATURES {
  return (
    Array.isArray(value) &&
    value.length === LIVE_BROWSER_FEATURES.length &&
    value.every((item, index): boolean => item === LIVE_BROWSER_FEATURES[index])
  )
}

function isExact(value: unknown, expected: string | boolean): boolean {
  return value === expected
}

function isOneOf(value: unknown, expected: readonly (string | boolean)[]): boolean {
  return expected.includes(value as string | boolean)
}

function verdictMatchesExecution(
  execution: unknown,
  verdict: unknown,
  allChecksPass: boolean,
): boolean {
  return execution === 'test-double'
    ? verdict === 'test-only'
    : execution === 'production' && verdict === (allChecksPass ? 'pass' : 'fail')
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key): boolean => Object.hasOwn(value, key)) &&
    keys.every((key): boolean => allowed.has(key))
  )
}

function isoTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return new Date(timestamp).toISOString() === value ? timestamp : undefined
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[0-9A-Za-z._-]+$/u.test(value)
  )
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function invalidEvidence(message: string): never {
  throw new LiveAcceptanceError('E_LIVE_EVIDENCE_INVALID', message)
}

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) return value
  seen.add(value)
  for (const item of Object.values(value)) deepFreeze(item, seen)
  return Object.isFrozen(value) ? value : Object.freeze(value)
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) {
    throw new LiveAcceptanceError(
      'E_LIVE_EVIDENCE_INVALID',
      'Canonical evidence must contain only finite JSON values',
    )
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key): readonly [string, unknown] => [key, canonicalValue(value[key])]),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function isBrowserVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    /^\d+(?:\.\d+){1,3}(?:[-+._A-Za-z0-9]*)?$/u.test(value)
  )
}

function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}
