#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  createVisualAcceptancePlan,
  downgradeVisualAcceptanceEvidence,
  inspectCleanVisualAcceptanceGit,
  inspectVisualAcceptanceBuild,
  sameVisualAcceptanceGit,
  VISUAL_ACCEPTANCE_BUILD_SCHEMA,
  visualAcceptanceRequestBody,
  type GitIdentity,
  type MountedVisualAcceptanceOptions,
  type VisualAcceptanceEvidence,
} from './live-visual-acceptance.js'
import { attestLoopbackListener, type LoopbackListenerAttestor } from './listener-attestation.js'

const HELP = `Usage: luban-img-visual-acceptance [options]

Default mode is a read-only plan. A provider turn is possible only with --live.

Options:
  --live                 Invoke the mounted production visual acceptance service
  --session <id>         Existing idle top-level DSH session (required with --live)
  --timeout-ms <number>  Turn timeout forwarded to the mounted service
  --base-url <url>       Authenticated API root (literal loopback host only)
  --output <path>        New evidence file (live: below .luban/acceptance)
  --help                 Show this help

Authentication is read only from LUBAN_SESSION_COOKIE and LUBAN_CSRF_TOKEN.
`

const MAX_RESPONSE_BYTES = 256 * 1024
const DEFAULT_LIVE_TIMEOUT_MS = 120_000
const REQUEST_GRACE_MS = 30_000
const LOOPBACK_HOSTNAME = '127.0.0.1'
const REQUIRED_PASS_CHECKS = Object.freeze([
  'target-platform',
  'git-clean',
  'plugin-build-provenance',
  'mounted-service-config',
  'live-agent-session',
  'png-valid',
  'production-image-landing',
  'nonce-not-seeded',
  'exact-message-turn',
  'same-session-response',
  'same-provider-model-response',
  'visual-nonce-readback',
  'visual-model-route',
  'provider-request-identity',
  'nonce-output-boundary',
  'cleanup',
  'git-clean-after',
  'listener-process-attestation',
] as const)
const SERVER_REQUIRED_PASS_CHECKS = REQUIRED_PASS_CHECKS.filter(
  (id): boolean => id !== 'listener-process-attestation',
)

interface ParsedCli {
  readonly live: boolean
  readonly help: boolean
  readonly sessionId?: string
  readonly timeoutMs?: number
  readonly baseUrl?: string
  readonly output?: string
}

interface CliIo {
  readonly cwd: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly fetch: typeof fetch
  readonly createChallenge: () => string
  readonly attestListener: LoopbackListenerAttestor
  write(value: string): void
}

interface CliGitBoundary {
  readonly repositoryRoot: string
  readonly identity: GitIdentity
}

export interface VisualAcceptanceCliTestDependencies {
  readonly cwd?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly fetch?: typeof fetch
  readonly createChallenge?: () => string
  readonly attestListener?: LoopbackListenerAttestor
  readonly write?: (value: string) => void
}

export interface VisualAcceptanceCliResult {
  readonly exitCode: 0 | 1 | 2
  readonly evidence?: VisualAcceptanceEvidence
  readonly evidencePath?: string
  readonly output: string
}

function parseCli(argv: readonly string[]): ParsedCli {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      live: { type: 'boolean' },
      session: { type: 'string' },
      'timeout-ms': { type: 'string' },
      'base-url': { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const live = parsed.values.live === true
  const sessionId = parsed.values.session
  if (sessionId !== undefined && (sessionId.trim() === '' || sessionId.length > 512)) {
    throw new Error('session id is invalid')
  }
  let timeoutMs: number | undefined
  if (parsed.values['timeout-ms'] !== undefined) {
    if (!/^\d+$/u.test(parsed.values['timeout-ms'])) throw new Error('timeout is invalid')
    timeoutMs = Number(parsed.values['timeout-ms'])
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 10 * 60_000) {
      throw new Error('timeout is invalid')
    }
  }
  if (live && sessionId === undefined) throw new Error('--live requires --session')
  if (!live && timeoutMs !== undefined) throw new Error('--timeout-ms requires --live')
  return {
    live,
    help: parsed.values.help === true,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(parsed.values['base-url'] === undefined ? {} : { baseUrl: parsed.values['base-url'] }),
    ...(parsed.values.output === undefined ? {} : { output: parsed.values.output }),
  }
}

function apiRoot(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('base URL is invalid')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hostname.toLowerCase() !== LOOPBACK_HOSTNAME ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('base URL must use a literal loopback host without credentials or fragments')
  }
  url.pathname = url.pathname.replace(/\/+$/u, '')
  if (!url.pathname.endsWith('/luban-image-paste')) {
    throw new Error('base URL must end with /luban-image-paste')
  }
  return url.toString().replace(/\/$/u, '')
}

function gitOutput(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('live evidence requires an available Git repository')
  }
  return result.stdout.trim()
}

async function inspectCliGitBoundary(cwd: string): Promise<CliGitBoundary> {
  const rawRoot = gitOutput(cwd, ['rev-parse', '--show-toplevel'])
  if (rawRoot === '') throw new Error('live evidence requires an available Git repository')
  const repositoryRoot = await realpath(resolve(rawRoot))
  return {
    repositoryRoot,
    identity: inspectCleanVisualAcceptanceGit(repositoryRoot),
  }
}

function gitIgnored(repositoryRoot: string, target: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', '--', target], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  })
  if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) {
    throw new Error('unable to verify the live evidence output boundary')
  }
  return result.status === 0
}

/** Live output is confined to the repository's dedicated ignored evidence root. */
export function assertVisualAcceptanceOutputBoundary(
  repositoryRoot: string,
  outputPath: string,
  isIgnored: (repository: string, target: string) => boolean = gitIgnored,
): string {
  const repository = resolve(repositoryRoot)
  const target = resolve(outputPath)
  const acceptanceRoot = resolve(repository, '.luban', 'acceptance')
  const within = relative(acceptanceRoot, target)
  if (
    within === '' ||
    within === '..' ||
    within.startsWith(`..${sep}`) ||
    isAbsolute(within) ||
    !isIgnored(repository, target)
  ) {
    throw new Error('live evidence output must be below the ignored .luban/acceptance directory')
  }
  return target
}

export async function assertVisualAcceptanceOutputParents(
  repositoryRoot: string,
  outputPath: string,
): Promise<void> {
  const repository = resolve(repositoryRoot)
  const targetParent = dirname(resolve(outputPath))
  const within = relative(repository, targetParent)
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
    throw new Error('live evidence output parent escaped the repository')
  }
  let current = repository
  for (const part of within.split(sep)) {
    current = resolve(current, part)
    try {
      const entry = await lstat(current)
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('live evidence output parent is not a real directory')
      }
      if (relative(await realpath(current), current) !== '') {
        throw new Error('live evidence output parent changed identity')
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

function pendingOutput(cwd: string): string {
  return resolve(cwd, '.luban', 'acceptance', 'm06-pending.json')
}

function requireSameCliGit(boundary: CliGitBoundary): void {
  const current = inspectCleanVisualAcceptanceGit(boundary.repositoryRoot)
  if (!sameVisualAcceptanceGit(boundary.identity, current)) {
    throw new Error('Git identity changed during the live acceptance command')
  }
}

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`)
  return value
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function boundedResponseBytes(response: Response): Promise<Buffer> {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error('mounted acceptance response is too large')
  }
  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('mounted acceptance response is too large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(
    chunks.map((chunk): Buffer => Buffer.from(chunk)),
    total,
  )
}

interface MountedAcceptanceResponse {
  readonly evidence: VisualAcceptanceEvidence
  readonly challenge: string
  readonly requestBody: string
  readonly responseSha256: string
  readonly responseBytes: number
  readonly host: '127.0.0.1'
  readonly port: number
}

async function requestMountedAcceptance(
  parsed: ParsedCli,
  io: CliIo,
): Promise<MountedAcceptanceResponse> {
  const cookie = requiredEnvironment(io.environment, 'LUBAN_SESSION_COOKIE')
  const csrf = requiredEnvironment(io.environment, 'LUBAN_CSRF_TOKEN')
  const root = apiRoot(
    parsed.baseUrl ??
      io.environment.LUBAN_IMAGE_BASE_URL ??
      'http://127.0.0.1:42600/luban-image-paste',
  )
  const rootUrl = new URL(root)
  const port = Number(
    rootUrl.port === '' ? (rootUrl.protocol === 'https:' ? 443 : 80) : rootUrl.port,
  )
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('mounted acceptance port is invalid')
  }
  const challenge = io.createChallenge()
  if (!/^[A-Za-z0-9_-]{43}$/u.test(challenge)) {
    throw new Error('visual acceptance challenge generation failed')
  }
  const options: MountedVisualAcceptanceOptions = {
    live: true,
    sessionId: parsed.sessionId ?? '',
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    challenge,
  }
  const requestBody = visualAcceptanceRequestBody(options)
  const controller = new AbortController()
  const timer = setTimeout(
    (): void => controller.abort(),
    (parsed.timeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS) + REQUEST_GRACE_MS,
  )
  timer.unref()
  let response: Response
  try {
    response = await io.fetch(`${root}/visual-acceptance`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie,
        'x-luban-csrf': csrf,
      },
      body: requestBody,
      signal: controller.signal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`mounted acceptance request failed (${String(response.status)})`)
    }
    const raw = await boundedResponseBytes(response)
    if (controller.signal.aborted) throw new Error('mounted acceptance request timed out')
    const decoded: unknown = JSON.parse(raw.toString('utf8'))
    if (!isRecord(decoded) || !hasExactKeys(decoded, ['evidence'])) {
      throw new Error('mounted acceptance returned invalid JSON')
    }
    const evidence = parseProductionEvidence(decoded.evidence)
    if (evidence.session?.requestedId !== parsed.sessionId) {
      throw new Error('mounted acceptance returned evidence for another session')
    }
    return {
      evidence,
      challenge,
      requestBody,
      responseSha256: sha256(raw),
      responseBytes: raw.byteLength,
      host: '127.0.0.1',
      port,
    }
  } catch (error: unknown) {
    if (controller.signal.aborted) throw new Error('mounted acceptance request timed out')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function parseProductionEvidence(value: unknown): VisualAcceptanceEvidence {
  if (!isRecord(value)) throw new Error('mounted acceptance evidence is invalid')
  const allowed = [
    'schemaVersion',
    'featureId',
    'runId',
    'execution',
    'evidenceKind',
    'status',
    'acceptancePassed',
    'nonceSha256',
    'session',
    'agent',
    'providerRequest',
    'image',
    'git',
    'build',
    'platform',
    'response',
    'endpoint',
    'checks',
    'cleanup',
    'error',
    'startedAt',
    'finishedAt',
  ]
  if (
    Object.keys(value).some((key): boolean => !allowed.includes(key)) ||
    value.schemaVersion !== 2 ||
    value.featureId !== 'M06-F003' ||
    typeof value.runId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.runId) ||
    value.execution !== 'production' ||
    value.evidenceKind !== 'live' ||
    typeof value.status !== 'string' ||
    !['pass', 'fail', 'blocked'].includes(value.status) ||
    typeof value.acceptancePassed !== 'boolean' ||
    !isIsoTimestamp(value.startedAt) ||
    !isIsoTimestamp(value.finishedAt) ||
    Date.parse(value.finishedAt) < Date.parse(value.startedAt) ||
    !isPlatform(value.platform) ||
    !isChecks(value.checks) ||
    typeof value.cleanup !== 'string' ||
    !['not-needed', 'pass', 'fail'].includes(value.cleanup) ||
    (value.nonceSha256 !== undefined && !isSha256(value.nonceSha256)) ||
    (value.error !== undefined && !isBoundedText(value.error, 500))
  ) {
    throw new Error('mounted acceptance evidence is invalid')
  }
  const git = value.git
  const build = value.build
  if (git !== undefined && !isGitEvidence(git)) throw new Error('Git evidence is invalid')
  if (build !== undefined && !isBuildEvidence(build)) throw new Error('build evidence is invalid')
  if (
    git !== undefined &&
    build !== undefined &&
    (git as { readonly head: string }).head !== (build as { readonly gitHead: string }).gitHead
  ) {
    throw new Error('build and Git evidence disagree')
  }
  if (value.session !== undefined && !isSessionEvidence(value.session)) {
    throw new Error('session evidence is invalid')
  }
  if (value.agent !== undefined && !isAgentEvidence(value.agent)) {
    throw new Error('agent evidence is invalid')
  }
  if (value.providerRequest !== undefined && !isProviderRequestEvidence(value.providerRequest)) {
    throw new Error('provider request evidence is invalid')
  }
  if (value.image !== undefined && !isImageEvidence(value.image)) {
    throw new Error('image evidence is invalid')
  }
  if (value.response !== undefined && !isResponseEvidence(value.response)) {
    throw new Error('response evidence is invalid')
  }
  if (value.endpoint !== undefined && !isEndpointEvidence(value.endpoint)) {
    throw new Error('endpoint evidence is invalid')
  }
  const passing =
    value.status === 'pass' &&
    value.cleanup === 'pass' &&
    isGitEvidence(git) &&
    isBuildEvidence(build) &&
    isSessionEvidence(value.session) &&
    value.session.respondingId === value.session.requestedId &&
    value.session.agentId === value.session.requestedId &&
    isNonNegativeInteger(value.session.turn) &&
    isAgentEvidence(value.agent) &&
    isProviderRequestEvidence(value.providerRequest) &&
    value.providerRequest.binding.sessionIdSha256 === sha256(value.session.requestedId) &&
    value.providerRequest.binding.turn === value.session.turn &&
    value.providerRequest.binding.provider === value.agent.provider &&
    value.providerRequest.binding.model === value.agent.model &&
    isImageEvidence(value.image) &&
    isResponseEvidence(value.response) &&
    value.response.matched &&
    isEndpointEvidence(value.endpoint) &&
    value.providerRequest.binding.challengeSha256 === value.endpoint.challengeSha256 &&
    value.endpoint.listener !== undefined &&
    value.endpoint.responseSha256 !== undefined &&
    value.endpoint.responseBytes !== undefined &&
    isSha256(value.nonceSha256) &&
    value.platform.target !== 'other' &&
    value.error === undefined &&
    requiredChecksPassed(value.checks)
  if (value.acceptancePassed !== passing || (value.status === 'pass') !== passing) {
    throw new Error('acceptance verdict contradicts evidence')
  }
  return value as unknown as VisualAcceptanceEvidence
}

function isPlatform(value: unknown): value is VisualAcceptanceEvidence['platform'] {
  if (!isRecord(value)) return false
  if (!hasExactKeys(value, ['target', 'runtimePlatform', 'arch', 'node'], ['osReleaseId'])) {
    return false
  }
  if (
    !isBoundedText(value.arch, 64) ||
    !isBoundedText(value.runtimePlatform, 32) ||
    typeof value.node !== 'string' ||
    !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.node)
  ) {
    return false
  }
  if (value.target === 'windows') {
    return value.runtimePlatform === 'win32' && value.osReleaseId === undefined
  }
  if (value.target === 'ubuntu') {
    return value.runtimePlatform === 'linux' && value.osReleaseId === 'ubuntu'
  }
  return value.target === 'other' && value.osReleaseId === undefined
}

function isGitEvidence(value: unknown): value is { readonly clean: true; readonly head: string } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['clean', 'head']) &&
    value.clean === true &&
    typeof value.head === 'string' &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.head)
  )
}

function isBuildEvidence(value: unknown): value is NonNullable<VisualAcceptanceEvidence['build']> {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'gitHead',
      'buildId',
      'dirty',
      'runtime',
      'runtimeArtifact',
    ]) &&
    value.schemaVersion === VISUAL_ACCEPTANCE_BUILD_SCHEMA &&
    typeof value.gitHead === 'string' &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.gitHead) &&
    typeof value.buildId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.buildId) &&
    value.dirty === false &&
    value.runtime === 'repo-dist' &&
    isRuntimeArtifact(value.runtimeArtifact)
  )
}

function isRuntimeArtifact(
  value: unknown,
): value is NonNullable<VisualAcceptanceEvidence['build']>['runtimeArtifact'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['path', 'sha256', 'bytes']) &&
    isBoundedText(value.path, 512) &&
    !value.path.includes('\\') &&
    value.path.split('/').every((part): boolean => part !== '' && part !== '.' && part !== '..') &&
    isSha256(value.sha256) &&
    isNonNegativeInteger(value.bytes) &&
    value.bytes > 0
  )
}

function isSessionEvidence(
  value: unknown,
): value is NonNullable<VisualAcceptanceEvidence['session']> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['requestedId'], ['respondingId', 'agentId', 'turn']) &&
    isBoundedText(value.requestedId, 512) &&
    (value.respondingId === undefined || isBoundedText(value.respondingId, 512)) &&
    (value.agentId === undefined || isBoundedText(value.agentId, 512)) &&
    (value.turn === undefined || isNonNegativeInteger(value.turn))
  )
}

function isAgentEvidence(value: unknown): value is NonNullable<VisualAcceptanceEvidence['agent']> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['provider', 'model']) &&
    isBoundedText(value.provider, 256) &&
    isBoundedText(value.model, 256)
  )
}

function isProviderRequestEvidence(
  value: unknown,
): value is NonNullable<VisualAcceptanceEvidence['providerRequest']> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'adapter', 'binding', 'providerRequestIdSha256']) ||
    value.schemaVersion !== 'dsh-luban/provider-request-identity-evidence/v1' ||
    !isSha256(value.providerRequestIdSha256) ||
    !isRecord(value.adapter) ||
    !hasExactKeys(value.adapter, ['id', 'version', 'runtimeSha256']) ||
    typeof value.adapter.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value.adapter.id) ||
    !isBoundedText(value.adapter.version, 128) ||
    value.adapter.version.trim() !== value.adapter.version ||
    !isSha256(value.adapter.runtimeSha256) ||
    !isRecord(value.binding) ||
    !hasExactKeys(value.binding, [
      'sessionIdSha256',
      'assistantEventSeq',
      'turn',
      'step',
      'assistantMessageIdSha256',
      'provider',
      'model',
      'challengeSha256',
    ])
  ) {
    return false
  }
  return (
    isSha256(value.binding.sessionIdSha256) &&
    isNonNegativeInteger(value.binding.assistantEventSeq) &&
    isNonNegativeInteger(value.binding.turn) &&
    isNonNegativeInteger(value.binding.step) &&
    isSha256(value.binding.assistantMessageIdSha256) &&
    isBoundedText(value.binding.provider, 256) &&
    isBoundedText(value.binding.model, 256) &&
    isSha256(value.binding.challengeSha256)
  )
}

function isImageEvidence(value: unknown): value is NonNullable<VisualAcceptanceEvidence['image']> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['mime', 'valid', 'bytes', 'sha256'], ['width', 'height']) &&
    value.mime === 'image/png' &&
    value.valid === true &&
    isNonNegativeInteger(value.bytes) &&
    value.bytes > 0 &&
    isSha256(value.sha256) &&
    (value.width === undefined || (isNonNegativeInteger(value.width) && value.width > 0)) &&
    (value.height === undefined || (isNonNegativeInteger(value.height) && value.height > 0))
  )
}

function isResponseEvidence(value: unknown): value is {
  readonly matched: boolean
  readonly sha256: string
  readonly bytes: number
} {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['matched', 'sha256', 'bytes']) &&
    typeof value.matched === 'boolean' &&
    isSha256(value.sha256) &&
    isNonNegativeInteger(value.bytes) &&
    value.bytes > 0
  )
}

function isEndpointEvidence(
  value: unknown,
): value is NonNullable<VisualAcceptanceEvidence['endpoint']> {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['kind', 'host', 'port', 'processId', 'nodeVersion', 'challengeSha256', 'requestSha256'],
      ['responseSha256', 'responseBytes', 'listener'],
    ) ||
    value.kind !== 'mounted-loopback-candidate' ||
    value.host !== '127.0.0.1' ||
    !isNonNegativeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535 ||
    !isNonNegativeInteger(value.processId) ||
    value.processId < 1 ||
    typeof value.nodeVersion !== 'string' ||
    !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.nodeVersion) ||
    !isSha256(value.challengeSha256) ||
    !isSha256(value.requestSha256) ||
    (value.responseSha256 !== undefined && !isSha256(value.responseSha256)) ||
    (value.responseBytes !== undefined &&
      (!isNonNegativeInteger(value.responseBytes) || value.responseBytes < 1)) ||
    (value.responseSha256 === undefined) !== (value.responseBytes === undefined)
  ) {
    return false
  }
  if (value.listener === undefined) return value.responseSha256 === undefined
  return (
    value.responseSha256 !== undefined &&
    isRecord(value.listener) &&
    hasExactKeys(value.listener, [
      'kind',
      'host',
      'port',
      'processId',
      'nodeExecutableSha256',
      'dshEntrypointSha256',
      'commandSha256',
      'observedAt',
    ]) &&
    value.listener.kind === 'os-loopback-listener-pid' &&
    value.listener.host === value.host &&
    value.listener.port === value.port &&
    value.listener.processId === value.processId &&
    isSha256(value.listener.nodeExecutableSha256) &&
    isSha256(value.listener.dshEntrypointSha256) &&
    isSha256(value.listener.commandSha256) &&
    isIsoTimestamp(value.listener.observedAt)
  )
}

function isChecks(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 64) return false
  const ids = new Set<string>()
  return value.every((check): boolean => {
    if (
      !isRecord(check) ||
      !hasExactKeys(check, ['id', 'status', 'actual']) ||
      !isBoundedText(check.id, 128) ||
      typeof check.status !== 'string' ||
      !['pass', 'fail', 'blocked'].includes(check.status) ||
      !isBoundedText(check.actual, 500) ||
      ids.has(check.id)
    ) {
      return false
    }
    ids.add(check.id)
    return true
  })
}

function requiredChecksPassed(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  if (value.some((check): boolean => !isRecord(check) || check.status !== 'pass')) return false
  const passed = new Set(
    value.flatMap((check): string[] =>
      isRecord(check) && check.status === 'pass' && typeof check.id === 'string' ? [check.id] : [],
    ),
  )
  return REQUIRED_PASS_CHECKS.every((id): boolean => passed.has(id))
}

function serverCandidateChecksPassed(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  let listenerPending = false
  const passed = new Set<string>()
  for (const check of value) {
    if (!isRecord(check) || typeof check.id !== 'string') return false
    if (check.id === 'listener-process-attestation') {
      if (listenerPending || check.status !== 'blocked') return false
      listenerPending = true
      continue
    }
    if (check.status !== 'pass') return false
    passed.add(check.id)
  }
  return listenerPending && SERVER_REQUIRED_PASS_CHECKS.every((id): boolean => passed.has(id))
}

async function attestMountedAcceptance(
  response: MountedAcceptanceResponse,
  attestListener: LoopbackListenerAttestor,
  repositoryRoot: string,
  localBuild: NonNullable<VisualAcceptanceEvidence['build']>,
): Promise<VisualAcceptanceEvidence> {
  const candidate = response.evidence
  const endpoint = candidate.endpoint
  if (
    candidate.status !== 'blocked' ||
    candidate.acceptancePassed ||
    candidate.error !== 'standalone CLI listener/process endpoint attestation is required' ||
    candidate.cleanup !== 'pass' ||
    !isGitEvidence(candidate.git) ||
    !isBuildEvidence(candidate.build) ||
    JSON.stringify(candidate.build) !== JSON.stringify(localBuild) ||
    !isSessionEvidence(candidate.session) ||
    candidate.session.respondingId !== candidate.session.requestedId ||
    candidate.session.agentId !== candidate.session.requestedId ||
    !isNonNegativeInteger(candidate.session.turn) ||
    !isAgentEvidence(candidate.agent) ||
    !isProviderRequestEvidence(candidate.providerRequest) ||
    candidate.providerRequest.binding.sessionIdSha256 !== sha256(candidate.session.requestedId) ||
    candidate.providerRequest.binding.turn !== candidate.session.turn ||
    candidate.providerRequest.binding.provider !== candidate.agent.provider ||
    candidate.providerRequest.binding.model !== candidate.agent.model ||
    !isImageEvidence(candidate.image) ||
    !isResponseEvidence(candidate.response) ||
    !candidate.response.matched ||
    !isSha256(candidate.nonceSha256) ||
    candidate.platform.target === 'other' ||
    !isEndpointEvidence(endpoint) ||
    endpoint.listener !== undefined ||
    endpoint.responseSha256 !== undefined ||
    endpoint.port !== response.port ||
    endpoint.nodeVersion !== candidate.platform.node ||
    endpoint.challengeSha256 !== sha256(response.challenge) ||
    candidate.providerRequest.binding.challengeSha256 !== endpoint.challengeSha256 ||
    endpoint.requestSha256 !== sha256(response.requestBody) ||
    !serverCandidateChecksPassed(candidate.checks)
  ) {
    return candidate
  }
  const listener = await attestListener({
    host: endpoint.host,
    port: endpoint.port,
    processId: endpoint.processId,
    workspaceRoot: repositoryRoot,
    dshEntrypoint: resolve(repositoryRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  })
  const { error: candidateError, ...candidateWithoutError } = candidate
  void candidateError
  const finalEvidence: VisualAcceptanceEvidence = {
    ...candidateWithoutError,
    status: 'pass',
    acceptancePassed: true,
    endpoint: {
      ...endpoint,
      responseSha256: response.responseSha256,
      responseBytes: response.responseBytes,
      listener,
    },
    checks: candidate.checks.map((check) =>
      check.id === 'listener-process-attestation'
        ? {
            id: check.id,
            status: 'pass' as const,
            actual: `pid=${String(endpoint.processId)};port=${String(endpoint.port)}`,
          }
        : check,
    ),
  }
  return parseProductionEvidence(finalEvidence)
}

export function defaultVisualAcceptanceOutput(
  cwd: string,
  evidence: VisualAcceptanceEvidence,
  liveRepositoryRoot?: string,
): string {
  return resolve(
    liveRepositoryRoot ?? cwd,
    '.luban',
    'acceptance',
    `m06-${evidence.platform.target}-${evidence.runId}.json`,
  )
}

export async function writeVisualAcceptanceEvidence(
  path: string,
  evidence: VisualAcceptanceEvidence,
  secrets: readonly string[] = [],
  verifyAfterWrite?: () => void,
): Promise<string> {
  const target = resolve(path)
  const serialized = `${JSON.stringify(evidence, undefined, 2)}\n`
  for (const secret of secrets) {
    if (secret.length >= 8 && serialized.includes(secret)) {
      throw new Error('refusing to write evidence containing a credential')
    }
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(target, 'wx', 0o600)
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    if (verifyAfterWrite !== undefined) {
      try {
        verifyAfterWrite()
      } catch (error: unknown) {
        const invalid = Buffer.from(
          `${JSON.stringify({
            schemaVersion: 1,
            acceptancePassed: false,
            error: 'Git identity changed after evidence output',
          })}\n`,
          'utf8',
        )
        await handle.truncate(0)
        await handle.write(invalid, 0, invalid.byteLength, 0)
        await handle.sync()
        throw error
      }
    }
  } finally {
    await handle?.close()
  }
  return target
}

async function requireUnusedOutput(path: string): Promise<void> {
  try {
    await lstat(resolve(path))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('evidence output already exists')
}

async function runCli(
  argv: readonly string[],
  io: CliIo,
  testDouble: boolean,
): Promise<VisualAcceptanceCliResult> {
  try {
    const parsed = parseCli(argv)
    if (parsed.help) {
      const output = HELP.trimEnd()
      io.write(`${output}\n`)
      return { exitCode: 0, output }
    }
    const gitBoundary = parsed.live && !testDouble ? await inspectCliGitBoundary(io.cwd) : undefined
    if (gitBoundary !== undefined) {
      assertVisualAcceptanceOutputBoundary(
        gitBoundary.repositoryRoot,
        parsed.output ?? pendingOutput(gitBoundary.repositoryRoot),
      )
      await assertVisualAcceptanceOutputParents(
        gitBoundary.repositoryRoot,
        parsed.output ?? pendingOutput(gitBoundary.repositoryRoot),
      )
    }
    if (parsed.live && parsed.output !== undefined) {
      await requireUnusedOutput(parsed.output)
    }
    const mountedResponse = parsed.live ? await requestMountedAcceptance(parsed, io) : undefined
    const received = mountedResponse?.evidence ?? createVisualAcceptancePlan(parsed.sessionId)
    const localBuild =
      mountedResponse !== undefined && !testDouble && gitBoundary !== undefined
        ? await inspectVisualAcceptanceBuild(gitBoundary.repositoryRoot, gitBoundary.identity)
        : undefined
    const evidence =
      mountedResponse === undefined
        ? received
        : testDouble
          ? downgradeVisualAcceptanceEvidence(received)
          : await attestMountedAcceptance(
              mountedResponse,
              io.attestListener,
              gitBoundary?.repositoryRoot ?? io.cwd,
              localBuild ??
                (() => {
                  throw new Error('local build attestation is unavailable')
                })(),
            )
    const output =
      parsed.output ?? defaultVisualAcceptanceOutput(io.cwd, evidence, gitBoundary?.repositoryRoot)
    if (gitBoundary !== undefined) {
      assertVisualAcceptanceOutputBoundary(gitBoundary.repositoryRoot, output)
      await assertVisualAcceptanceOutputParents(gitBoundary.repositoryRoot, output)
      if (evidence.git !== undefined && evidence.git.head !== gitBoundary.identity.head) {
        throw new Error('mounted acceptance evidence belongs to another Git HEAD')
      }
      if (evidence.build !== undefined && evidence.build.gitHead !== gitBoundary.identity.head) {
        throw new Error('mounted acceptance build belongs to another Git HEAD')
      }
      requireSameCliGit(gitBoundary)
    }
    const path = await writeVisualAcceptanceEvidence(
      output,
      evidence,
      secretValues(io.environment),
      gitBoundary === undefined ? undefined : (): void => requireSameCliGit(gitBoundary),
    )
    const summary = JSON.stringify({
      schemaVersion: evidence.schemaVersion,
      runId: evidence.runId,
      execution: evidence.execution,
      evidenceKind: evidence.evidenceKind,
      status: evidence.status,
      acceptancePassed: evidence.acceptancePassed,
      evidencePath: path,
    })
    io.write(`${summary}\n`)
    const exitCode = evidence.acceptancePassed
      ? 0
      : evidence.status === 'blocked' || received.status === 'blocked'
        ? 2
        : parsed.live
          ? 1
          : 0
    return { exitCode, evidence, evidencePath: path, output: summary }
  } catch {
    const output = JSON.stringify({
      schemaVersion: 1,
      ok: false,
      error: { code: 'E_VISUAL_ACCEPTANCE', message: 'Visual acceptance command failed' },
    })
    io.write(`${output}\n`)
    return { exitCode: 1, output }
  }
}

/** Test seam: injected transport can only emit simulated, never production, evidence. */
export function runVisualAcceptanceCliForTest(
  argv: readonly string[],
  dependencies: VisualAcceptanceCliTestDependencies = {},
): Promise<VisualAcceptanceCliResult> {
  return runCli(
    argv,
    {
      cwd: dependencies.cwd ?? process.cwd(),
      environment: dependencies.environment ?? {},
      fetch:
        dependencies.fetch ?? (() => Promise.reject(new Error('test transport is not configured'))),
      createChallenge: dependencies.createChallenge ?? ((): string => 'A'.repeat(43)),
      attestListener:
        dependencies.attestListener ??
        (() => Promise.reject(new Error('test listener attestor is not configured'))),
      write: dependencies.write ?? ((): void => undefined),
    },
    true,
  )
}

function secretValues(environment: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(environment).flatMap(([name, value]): string[] =>
    value !== undefined &&
    value.length >= 8 &&
    (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/u.test(name) ||
      name === 'LUBAN_SESSION_COOKIE' ||
      name === 'LUBAN_CSRF_TOKEN')
      ? [value]
      : [],
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key): boolean => Object.hasOwn(value, key)) &&
    keys.every((key): boolean => allowed.has(key))
  )
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximum &&
    hasNoControlCharacters(value)
  )
}

function hasNoControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return false
  }
  return true
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isMain(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isMain()) {
  const result = await runCli(
    process.argv.slice(2),
    {
      cwd: process.cwd(),
      environment: process.env,
      fetch,
      createChallenge: (): string => randomBytes(32).toString('base64url'),
      attestListener: attestLoopbackListener,
      write: (value): void => {
        process.stdout.write(value)
      },
    },
    false,
  )
  process.exitCode = result.exitCode
}
