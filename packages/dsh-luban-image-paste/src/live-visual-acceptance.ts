import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId as DshSessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { asSessionId } from 'dsh-luban-core'
import type { Config } from './config.js'
import { imagePrompt } from './dsh-injection.js'
import { detectImage } from './image-format.js'
import { AttachmentRepository } from './repository.js'
import { FileImageIngestService } from './service.js'
import type { StoredImage } from './types.js'
import {
  renderVisualNoncePng,
  validateVisualNoncePng,
  visualNonceFromRandomBytes,
  type ValidatedNoncePng,
} from './visual-nonce-png.js'

declare const __DSH_LUBAN_IMAGE_BUILD_HEAD__: string | undefined
declare const __DSH_LUBAN_IMAGE_BUILD_ID__: string | undefined

const FEATURE_ID = 'M06-F003'
const SCHEMA_VERSION = 2
export const VISUAL_ACCEPTANCE_BUILD_SCHEMA = 'dsh-luban/image-paste-build-provenance/v3' as const
const LUBAN_DIRECTORY = '.luban'
const OWNER_DIRECTORY = '.luban/m06-visual-acceptance'
const RUN_DIRECTORY = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const DEFAULT_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MODEL_PROBE_TIMEOUT_MS = 10_000
const VISUAL_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u
const MAX_BUILD_ARTIFACTS = 512
const MAX_BUILD_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_BUILD_TOTAL_BYTES = 256 * 1024 * 1024
const LOADED_RUNTIME_MODULE_PATH = fileURLToPath(import.meta.url)
const LOADED_BUILD_IDENTITY =
  typeof __DSH_LUBAN_IMAGE_BUILD_HEAD__ === 'string' &&
  /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(__DSH_LUBAN_IMAGE_BUILD_HEAD__) &&
  typeof __DSH_LUBAN_IMAGE_BUILD_ID__ === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    __DSH_LUBAN_IMAGE_BUILD_ID__,
  )
    ? Object.freeze({
        gitHead: __DSH_LUBAN_IMAGE_BUILD_HEAD__,
        buildId: __DSH_LUBAN_IMAGE_BUILD_ID__,
      })
    : undefined
const ACCEPTANCE_INSTRUCTION =
  'Open and inspect the referenced PNG with the available image/file tool. Reply with only the short code visible in the image pixels; do not infer it from filenames or surrounding text.'

export type VisualAcceptanceStatus = 'planned' | 'pass' | 'fail' | 'blocked' | 'simulated'

export interface VisualAcceptanceCheck {
  readonly id: string
  readonly status: 'pass' | 'fail' | 'blocked'
  readonly actual: string
}

export interface VisualAcceptanceEvidence {
  readonly schemaVersion: 2
  readonly featureId: 'M06-F003'
  readonly runId: string
  readonly execution: 'operator-plan' | 'production' | 'test-double'
  readonly evidenceKind: 'none' | 'live' | 'simulated'
  readonly status: VisualAcceptanceStatus
  readonly acceptancePassed: boolean
  readonly nonceSha256?: string
  readonly session?: {
    readonly requestedId: string
    readonly respondingId?: string
    readonly agentId?: string
    readonly turn?: number
  }
  readonly agent?: {
    readonly provider: string
    readonly model: string
  }
  readonly image?: {
    readonly mime: 'image/png'
    readonly valid: boolean
    readonly width?: number
    readonly height?: number
    readonly bytes: number
    readonly sha256: string
  }
  readonly git?: { readonly clean: boolean; readonly head: string }
  readonly build?: VisualAcceptanceBuildEvidence
  readonly platform: {
    readonly target: 'windows' | 'ubuntu' | 'other'
    readonly runtimePlatform: NodeJS.Platform
    readonly arch: string
    readonly node: string
    readonly osReleaseId?: 'ubuntu'
  }
  readonly response?: {
    readonly matched: boolean
    readonly sha256: string
    readonly bytes: number
  }
  readonly endpoint?: {
    readonly kind: 'mounted-loopback-candidate'
    readonly host: '127.0.0.1'
    readonly port: number
    readonly processId: number
    readonly nodeVersion: string
    readonly challengeSha256: string
    readonly requestSha256: string
    readonly responseSha256?: string
    readonly responseBytes?: number
    readonly listener?: {
      readonly kind: 'os-loopback-listener-pid'
      readonly host: '127.0.0.1'
      readonly port: number
      readonly processId: number
      readonly nodeExecutableSha256: string
      readonly dshEntrypointSha256: string
      readonly commandSha256: string
      readonly observedAt: string
    }
  }
  readonly checks: readonly VisualAcceptanceCheck[]
  readonly cleanup: 'not-needed' | 'pass' | 'fail'
  readonly simulatedOutcome?: 'pass' | 'fail'
  readonly error?: string
  readonly startedAt: string
  readonly finishedAt: string
}

export interface VisualAcceptanceBuildEvidence {
  readonly schemaVersion: typeof VISUAL_ACCEPTANCE_BUILD_SCHEMA
  readonly gitHead: string
  readonly buildId: string
  readonly dirty: false
  readonly runtime: 'repo-dist'
  readonly runtimeArtifact: {
    readonly path: string
    readonly sha256: string
    readonly bytes: number
  }
}

export interface LoadedVisualAcceptanceBuildIdentity {
  readonly gitHead: string
  readonly buildId: string
}

export interface MountedVisualAcceptanceOptions {
  readonly live: boolean
  readonly sessionId: string
  readonly timeoutMs?: number
  readonly challenge?: string
}

export interface MountedVisualAcceptanceMount {
  readonly repository: AttachmentRepository
  readonly service: FileImageIngestService
  readonly config: Config
}

export interface VisualTurnObservation {
  readonly requestedSessionId: string
  readonly respondingSessionId: string
  readonly responseText: string
  readonly expectedProvider: string
  readonly respondingProvider: string
  readonly expectedModel: string
  readonly respondingModel: string
}

export interface VisualObservationAssessment {
  readonly passed: boolean
  readonly reason:
    'pass' | 'wrong-session' | 'wrong-provider' | 'wrong-model' | 'missing-response' | 'wrong-nonce'
}

export interface SimulatedVisualAcceptanceOptions {
  readonly nonce: string
  readonly png: Uint8Array
  readonly sessionId: string
  readonly provider: string
  readonly model: string
  readonly execute: (input: {
    readonly simulationNonce: string
    readonly png: Uint8Array
  }) => Promise<VisualTurnObservation>
  readonly cleanup?: () => Promise<void>
}

export interface GitIdentity {
  readonly head: string
  readonly clean: true
}

class VisualAcceptanceBlocked extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'VisualAcceptanceBlocked'
  }
}

class VisualAcceptanceFailure extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'VisualAcceptanceFailure'
  }
}

function isoNow(): string {
  return new Date().toISOString()
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function mountedConfigDigest(config: Config): string {
  return sha256(
    JSON.stringify({
      workspaceRoot: config.workspaceRoot,
      attachDir: config.attachDir,
      maxBytes: config.maxBytes,
      maxSidePx: config.maxSidePx,
      compression: config.compression,
      compressionQuality: config.compressionQuality,
      retainDays: config.retainDays,
      recentLimit: config.recentLimit,
      cleanupIntervalMinutes: config.cleanupIntervalMinutes,
      injectStyle: config.injectStyle,
      clipboardTimeoutMs: config.clipboardTimeoutMs,
    }),
  )
}

export function visualAcceptanceRequestBody(options: MountedVisualAcceptanceOptions): string {
  if (!options.live || !VISUAL_CHALLENGE.test(options.challenge ?? '')) {
    throw new TypeError('visual acceptance challenge is invalid')
  }
  return JSON.stringify({
    live: true,
    sessionId: options.sessionId,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    challenge: options.challenge,
  })
}

function platformEvidence(): VisualAcceptanceEvidence['platform'] {
  return {
    target: 'other',
    runtimePlatform: process.platform,
    arch: process.arch,
    node: process.version,
  }
}

export function createVisualAcceptancePlan(sessionId?: string): VisualAcceptanceEvidence {
  const startedAt = isoNow()
  return {
    schemaVersion: SCHEMA_VERSION,
    featureId: FEATURE_ID,
    runId: randomUUID(),
    execution: 'operator-plan',
    evidenceKind: 'none',
    status: 'planned',
    acceptancePassed: false,
    ...(sessionId === undefined ? {} : { session: { requestedId: sessionId } }),
    platform: platformEvidence(),
    checks: [],
    cleanup: 'not-needed',
    startedAt,
    finishedAt: isoNow(),
  }
}

/** Permanently downgrade evidence crossing any injected/test execution seam. */
export function downgradeVisualAcceptanceEvidence(
  evidence: VisualAcceptanceEvidence,
): VisualAcceptanceEvidence {
  const startedAt = isoNow()
  return {
    schemaVersion: SCHEMA_VERSION,
    featureId: FEATURE_ID,
    runId: randomUUID(),
    execution: 'test-double',
    evidenceKind: 'simulated',
    status: 'simulated',
    acceptancePassed: false,
    platform: platformEvidence(),
    checks: [
      {
        id: 'test-double-boundary',
        status: 'blocked',
        actual: 'injected execution cannot produce production evidence',
      },
    ],
    cleanup: 'not-needed',
    simulatedOutcome: evidence.acceptancePassed ? 'pass' : 'fail',
    startedAt,
    finishedAt: isoNow(),
  }
}

function recordCheck(
  checks: VisualAcceptanceCheck[],
  id: string,
  status: VisualAcceptanceCheck['status'],
  actual: string,
): void {
  checks.push({ id, status, actual: actual.slice(0, 500) })
}

function requireCheck(
  checks: VisualAcceptanceCheck[],
  id: string,
  condition: boolean,
  actual: string,
): void {
  recordCheck(checks, id, condition ? 'pass' : 'fail', actual)
  if (!condition) throw new VisualAcceptanceFailure(`${id} failed`)
}

function timeoutMs(value: number | undefined): number {
  const candidate = value ?? DEFAULT_TIMEOUT_MS
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < MIN_TIMEOUT_MS ||
    candidate > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(
      `timeoutMs must be between ${String(MIN_TIMEOUT_MS)} and ${String(MAX_TIMEOUT_MS)}`,
    )
  }
  return candidate
}

function runGit(workspaceRoot: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new VisualAcceptanceBlocked('git identity is unavailable')
  }
  return result.stdout.trim()
}

export function inspectCleanVisualAcceptanceGit(
  workspaceRoot: string,
  execute: (args: readonly string[]) => string = (args): string => runGit(workspaceRoot, args),
): GitIdentity {
  const headBefore = execute(['rev-parse', '--verify', 'HEAD']).trim().toLowerCase()
  const status = execute(['status', '--porcelain=v1', '--untracked-files=normal'])
  const headAfter = execute(['rev-parse', '--verify', 'HEAD']).trim().toLowerCase()
  if (status !== '') throw new VisualAcceptanceBlocked('git worktree is not clean')
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(headBefore) || headAfter !== headBefore) {
    throw new VisualAcceptanceBlocked('git HEAD is invalid or changed during inspection')
  }
  return { head: headBefore, clean: true }
}

export function sameVisualAcceptanceGit(before: GitIdentity, after: GitIdentity): boolean {
  const rawBefore: unknown = before
  const rawAfter: unknown = after
  return (
    isRecord(rawBefore) &&
    isRecord(rawAfter) &&
    rawBefore.clean === true &&
    rawAfter.clean === true &&
    rawBefore.head === rawAfter.head
  )
}

function osReleaseId(contents: string): string | undefined {
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^ID=(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/u.exec(line.trim())
    if (match !== null) return match[1] ?? match[2] ?? match[3]
  }
  return undefined
}

/** Attest the only runtime families covered by the M06 shared-platform contract. */
export async function inspectVisualAcceptancePlatform(
  runtimePlatform: NodeJS.Platform = process.platform,
  arch = process.arch,
  node = process.version,
  readOsRelease: () => Promise<string> = (): Promise<string> => readFile('/etc/os-release', 'utf8'),
): Promise<VisualAcceptanceEvidence['platform']> {
  if (runtimePlatform === 'win32') {
    return { target: 'windows', runtimePlatform, arch, node }
  }
  if (runtimePlatform !== 'linux') {
    throw new VisualAcceptanceBlocked('live visual acceptance supports only Windows and Ubuntu')
  }
  let release: string
  try {
    release = await readOsRelease()
  } catch {
    throw new VisualAcceptanceBlocked('Ubuntu identity is unavailable')
  }
  if (Buffer.byteLength(release, 'utf8') > 64 * 1024 || osReleaseId(release) !== 'ubuntu') {
    throw new VisualAcceptanceBlocked(
      'Linux live visual acceptance requires ID=ubuntu in /etc/os-release',
    )
  }
  return {
    target: 'ubuntu',
    runtimePlatform,
    arch,
    node,
    osReleaseId: 'ubuntu',
  }
}

/** Bind a production run to the clean build actually loaded from this repository. */
export async function inspectVisualAcceptanceBuild(
  repositoryRoot: string,
  expectedGit: GitIdentity,
  runtimeModulePath = LOADED_RUNTIME_MODULE_PATH,
  loadedBuildIdentity?: LoadedVisualAcceptanceBuildIdentity,
): Promise<VisualAcceptanceBuildEvidence> {
  try {
    const rawExpectedGit: unknown = expectedGit
    if (
      !isRecord(rawExpectedGit) ||
      rawExpectedGit.clean !== true ||
      typeof rawExpectedGit.head !== 'string'
    ) {
      throw new Error('invalid expected Git identity')
    }
    const repository = await realpath(repositoryRoot)
    const distribution = join(repository, 'packages', 'dsh-luban-image-paste', 'dist')
    const distributionEntry = await lstat(distribution)
    if (!distributionEntry.isDirectory() || distributionEntry.isSymbolicLink()) {
      throw new Error('invalid distribution')
    }
    const canonicalDistribution = await realpath(distribution)
    const runtimeEntry = await lstat(runtimeModulePath)
    if (!runtimeEntry.isFile() || runtimeEntry.isSymbolicLink()) {
      throw new Error('invalid runtime module')
    }
    const runtime = await realpath(runtimeModulePath)
    if (!pathWithin(canonicalDistribution, runtime)) {
      throw new Error('runtime outside repository distribution')
    }

    const provenancePath = join(canonicalDistribution, 'build-provenance.json')
    const provenanceEntry = await lstat(provenancePath)
    if (
      !provenanceEntry.isFile() ||
      provenanceEntry.isSymbolicLink() ||
      provenanceEntry.size < 1 ||
      provenanceEntry.size > 64 * 1024
    ) {
      throw new Error('invalid provenance file')
    }
    if (!samePath(await realpath(provenancePath), provenancePath)) {
      throw new Error('provenance escaped distribution')
    }
    const decoded: unknown = JSON.parse(await readFile(provenancePath, 'utf8'))
    if (
      !isRecord(decoded) ||
      !hasExactKeys(decoded, ['schemaVersion', 'gitHead', 'buildId', 'dirty', 'artifacts']) ||
      decoded.schemaVersion !== VISUAL_ACCEPTANCE_BUILD_SCHEMA ||
      typeof decoded.gitHead !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(decoded.gitHead) ||
      decoded.dirty !== false ||
      decoded.gitHead !== rawExpectedGit.head ||
      typeof decoded.buildId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        decoded.buildId,
      ) ||
      !Array.isArray(decoded.artifacts) ||
      decoded.artifacts.length < 1 ||
      decoded.artifacts.length > MAX_BUILD_ARTIFACTS
    ) {
      throw new Error('build provenance mismatch')
    }
    const isLoadedRuntime = runtimeModulePath === LOADED_RUNTIME_MODULE_PATH
    if (isLoadedRuntime && loadedBuildIdentity !== undefined) {
      throw new Error('loaded runtime identity cannot be overridden')
    }
    const loadedIdentity = isLoadedRuntime ? LOADED_BUILD_IDENTITY : loadedBuildIdentity
    if (loadedIdentity?.gitHead !== decoded.gitHead || loadedIdentity.buildId !== decoded.buildId) {
      throw new Error('loaded build identity does not match disk provenance')
    }
    const runtimeRelative = relative(canonicalDistribution, runtime).split(sep).join('/')
    const artifactPaths = new Set<string>()
    let totalArtifactBytes = 0
    let runtimeArtifact: VisualAcceptanceBuildEvidence['runtimeArtifact'] | undefined
    for (const candidate of decoded.artifacts) {
      if (
        !isRecord(candidate) ||
        !hasExactKeys(candidate, ['path', 'sha256', 'bytes']) ||
        typeof candidate.path !== 'string' ||
        !isSafeBuildArtifactPath(candidate.path) ||
        artifactPaths.has(candidate.path) ||
        typeof candidate.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(candidate.sha256) ||
        typeof candidate.bytes !== 'number' ||
        !Number.isSafeInteger(candidate.bytes) ||
        candidate.bytes < 1 ||
        candidate.bytes > MAX_BUILD_ARTIFACT_BYTES ||
        totalArtifactBytes + candidate.bytes > MAX_BUILD_TOTAL_BYTES
      ) {
        throw new Error('invalid build artifact')
      }
      totalArtifactBytes += candidate.bytes
      artifactPaths.add(candidate.path)
      const artifactPath = resolve(canonicalDistribution, ...candidate.path.split('/'))
      if (
        !pathWithin(canonicalDistribution, artifactPath) ||
        relative(canonicalDistribution, artifactPath).split(sep).join('/') !== candidate.path
      ) {
        throw new Error('build artifact escaped distribution')
      }
      const artifactEntry = await lstat(artifactPath)
      if (
        !artifactEntry.isFile() ||
        artifactEntry.isSymbolicLink() ||
        artifactEntry.size !== candidate.bytes ||
        !pathWithin(canonicalDistribution, await realpath(artifactPath))
      ) {
        throw new Error('build artifact metadata mismatch')
      }
      const artifactBytes = await readFile(artifactPath)
      if (
        artifactBytes.byteLength !== candidate.bytes ||
        sha256(artifactBytes) !== candidate.sha256
      ) {
        throw new Error('build artifact digest mismatch')
      }
      if (candidate.path === runtimeRelative) {
        runtimeArtifact = {
          path: candidate.path,
          sha256: candidate.sha256,
          bytes: candidate.bytes,
        }
      }
    }
    if (runtimeArtifact === undefined) {
      throw new Error('runtime module is not in the build manifest')
    }
    const currentArtifactPaths = await collectBuildArtifactPaths(canonicalDistribution)
    if (
      currentArtifactPaths.length !== artifactPaths.size ||
      currentArtifactPaths.some((path): boolean => !artifactPaths.has(path))
    ) {
      throw new Error('distribution contents do not match the build manifest')
    }
    return {
      schemaVersion: VISUAL_ACCEPTANCE_BUILD_SCHEMA,
      gitHead: decoded.gitHead,
      buildId: decoded.buildId,
      dirty: false,
      runtime: 'repo-dist',
      runtimeArtifact,
    }
  } catch {
    throw new VisualAcceptanceBlocked(
      'loaded image-paste module is not a clean build of the current repository HEAD',
    )
  }
}

async function collectBuildArtifactPaths(
  distribution: string,
  directory = distribution,
  paths: string[] = [],
): Promise<readonly string[]> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    const artifactPath = relative(distribution, absolute).split(sep).join('/')
    if (artifactPath === 'build-provenance.json') continue
    if (entry.isSymbolicLink()) throw new Error('distribution contains a symbolic link')
    if (entry.isDirectory()) {
      await collectBuildArtifactPaths(distribution, absolute, paths)
      continue
    }
    if (!entry.isFile() || !isSafeBuildArtifactPath(artifactPath)) {
      throw new Error('distribution contains an unsafe artifact')
    }
    paths.push(artifactPath)
    if (paths.length > MAX_BUILD_ARTIFACTS) {
      throw new Error('distribution contains too many artifacts')
    }
  }
  return paths
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === ''
}

function pathWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function isSafeBuildArtifactPath(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 512 &&
    !value.includes('\\') &&
    !hasBuildArtifactControlCharacter(value) &&
    value.split('/').every((part): boolean => part !== '' && part !== '.' && part !== '..')
  )
}

function hasBuildArtifactControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length && expected.every((key): boolean => Object.hasOwn(value, key))
  )
}

function ownedDirectory(workspaceRoot: string): string {
  return resolve(workspaceRoot, OWNER_DIRECTORY)
}

interface DirectoryIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function plainDirectoryIdentity(path: string, label: string): Promise<DirectoryIdentity> {
  const entry = await lstat(path, { bigint: true })
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a plain directory`)
  }
  if (!samePath(await realpath(path), path)) {
    throw new Error(`${label} must not traverse a link or junction`)
  }
  return { dev: entry.dev, ino: entry.ino }
}

async function createDirectoryIfMissing(path: string): Promise<void> {
  try {
    await mkdir(path)
  } catch (error: unknown) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw error
    }
  }
}

interface OwnedDirectoryBoundary {
  readonly workspace: string
  readonly luban: string
  readonly owner: string
  readonly lubanIdentity: DirectoryIdentity
  readonly ownerIdentity: DirectoryIdentity
}

async function inspectOwnedDirectoryBoundary(
  workspaceRoot: string,
): Promise<OwnedDirectoryBoundary> {
  const workspace = await realpath(workspaceRoot)
  const luban = resolve(workspace, LUBAN_DIRECTORY)
  const owner = ownedDirectory(workspace)
  const workspaceIdentity = await plainDirectoryIdentity(workspace, 'workspace root')
  const lubanIdentity = await plainDirectoryIdentity(luban, 'workspace .luban directory')
  const ownerIdentity = await plainDirectoryIdentity(owner, 'M06 visual acceptance owner')
  if (dirname(luban) !== workspace || dirname(owner) !== luban) {
    throw new Error('M06 visual acceptance owner escaped its lexical workspace boundary')
  }
  const currentWorkspace = await plainDirectoryIdentity(workspace, 'workspace root')
  if (!sameIdentity(workspaceIdentity, currentWorkspace)) {
    throw new Error('workspace root changed identity during M06 boundary inspection')
  }
  return { workspace, luban, owner, lubanIdentity, ownerIdentity }
}

async function prepareOwnedDirectoryBoundary(
  workspaceRoot: string,
): Promise<OwnedDirectoryBoundary> {
  const workspace = await realpath(workspaceRoot)
  const luban = resolve(workspace, LUBAN_DIRECTORY)
  const owner = ownedDirectory(workspace)
  await plainDirectoryIdentity(workspace, 'workspace root')
  await createDirectoryIfMissing(luban)
  await plainDirectoryIdentity(luban, 'workspace .luban directory')
  await createDirectoryIfMissing(owner)
  return inspectOwnedDirectoryBoundary(workspace)
}

/** Lexically restrict recursive cleanup to one unpredictable direct child owned by this runner. */
export function isOwnedVisualAcceptanceRoot(workspaceRoot: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false
  const target = resolve(candidate)
  const owner = ownedDirectory(workspaceRoot)
  const child = relative(owner, target)
  return (
    child !== '' &&
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child) &&
    !child.includes(sep) &&
    dirname(target) === owner &&
    RUN_DIRECTORY.test(basename(target))
  )
}

/** Create one plain unpredictable run directory without following pre-existing links. */
export async function createVisualAcceptanceRoot(
  workspaceRoot: string,
  runId: string,
): Promise<string> {
  const boundary = await prepareOwnedDirectoryBoundary(workspaceRoot)
  const candidate = resolve(boundary.owner, `run-${runId}`)
  if (!isOwnedVisualAcceptanceRoot(boundary.workspace, candidate)) {
    throw new Error('Refusing to create an unowned M06 visual acceptance path')
  }
  const before = await inspectOwnedDirectoryBoundary(boundary.workspace)
  if (
    !sameIdentity(before.lubanIdentity, boundary.lubanIdentity) ||
    !sameIdentity(before.ownerIdentity, boundary.ownerIdentity)
  ) {
    throw new Error('M06 visual acceptance owner changed before run creation')
  }
  await mkdir(candidate)
  const candidateIdentity = await plainDirectoryIdentity(candidate, 'M06 visual acceptance run')
  const after = await inspectOwnedDirectoryBoundary(boundary.workspace)
  const currentCandidate = await plainDirectoryIdentity(candidate, 'M06 visual acceptance run')
  if (
    !sameIdentity(after.lubanIdentity, boundary.lubanIdentity) ||
    !sameIdentity(after.ownerIdentity, boundary.ownerIdentity) ||
    !sameIdentity(currentCandidate, candidateIdentity)
  ) {
    throw new Error('M06 visual acceptance boundary changed during run creation')
  }
  return candidate
}

/** Remove only a canonical, non-linked acceptance root whose identity is stable at deletion. */
export async function removeVisualAcceptanceRoot(
  workspaceRoot: string,
  candidate: string,
): Promise<void> {
  const boundary = await inspectOwnedDirectoryBoundary(workspaceRoot)
  if (!isOwnedVisualAcceptanceRoot(boundary.workspace, candidate)) {
    throw new Error('Refusing to clean an unowned M06 visual acceptance path')
  }
  const lexicalTarget = resolve(candidate)
  const initial = await plainDirectoryIdentity(
    lexicalTarget,
    'M06 visual acceptance cleanup target',
  )
  const canonicalTarget = await realpath(lexicalTarget)
  if (
    !samePath(canonicalTarget, lexicalTarget) ||
    !samePath(dirname(canonicalTarget), boundary.owner) ||
    !RUN_DIRECTORY.test(basename(canonicalTarget))
  ) {
    throw new Error('Refusing to clean a canonically unowned M06 visual acceptance path')
  }
  const currentBoundary = await inspectOwnedDirectoryBoundary(boundary.workspace)
  const current = await plainDirectoryIdentity(
    lexicalTarget,
    'M06 visual acceptance cleanup target',
  )
  if (
    !sameIdentity(currentBoundary.lubanIdentity, boundary.lubanIdentity) ||
    !sameIdentity(currentBoundary.ownerIdentity, boundary.ownerIdentity) ||
    !sameIdentity(current, initial)
  ) {
    throw new Error('M06 visual acceptance cleanup target changed identity')
  }
  await rm(lexicalTarget, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 })
}

function textFromBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(
      (block): block is ContentBlock & { readonly type: 'text'; readonly text: string } =>
        block.type === 'text',
    )
    .map((block): string => block.text)
    .join('\n')
}

function responseContainsNonce(response: string, nonce: string): boolean {
  const normalized = response.toUpperCase()
  const index = normalized.indexOf(nonce)
  if (index < 0) return false
  const before = normalized[index - 1]
  const after = normalized[index + nonce.length]
  return (
    (before === undefined || !/[A-Z0-9]/u.test(before)) &&
    (after === undefined || !/[A-Z0-9]/u.test(after))
  )
}

/** Assess only a same-session, same-route model response; no response text enters evidence. */
export function assessVisualObservation(
  nonce: string,
  observation: VisualTurnObservation,
): VisualObservationAssessment {
  if (observation.respondingSessionId !== observation.requestedSessionId) {
    return { passed: false, reason: 'wrong-session' }
  }
  if (observation.respondingProvider !== observation.expectedProvider) {
    return { passed: false, reason: 'wrong-provider' }
  }
  if (observation.respondingModel !== observation.expectedModel) {
    return { passed: false, reason: 'wrong-model' }
  }
  if (observation.responseText.trim() === '') return { passed: false, reason: 'missing-response' }
  if (!responseContainsNonce(observation.responseText, nonce)) {
    return { passed: false, reason: 'wrong-nonce' }
  }
  return { passed: true, reason: 'pass' }
}

/** Find a plaintext nonce leak without returning the sensitive value itself. */
export function findVisualNonceLeaks(
  nonce: string,
  surfaces: Readonly<Record<string, string>>,
): readonly string[] {
  return Object.entries(surfaces)
    .filter(([, value]): boolean => value.includes(nonce))
    .map(([name]): string => name)
}

/**
 * The nonce must be absent from every input surface. After dispatch, only the
 * model-authored assistant output for the observed turn may contain its readback.
 */
export function findUnexpectedPostTurnNonceLeaks(
  nonce: string,
  events: readonly SessionEvent[],
  baselineSequence: number,
  turn: number,
  responseStep: number,
): readonly string[] {
  return events
    .filter((event): boolean => {
      if (event.seq <= baselineSequence || !JSON.stringify(event.data).includes(nonce)) {
        return false
      }
      return !(
        (event.type === 'assistant/chunk' || event.type === 'assistant/message') &&
        event.data.turn === turn &&
        event.data.step === responseStep
      )
    })
    .map((event): string => `${event.type}:${String(event.seq)}`)
}

function sessionContainsNonce(agent: Agent, nonce: string): boolean {
  return agent.session.events.some((event): boolean => JSON.stringify(event.data).includes(nonce))
}

function freshNonce(agent: Agent, stableEvidence: readonly string[]): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const nonce = visualNonceFromRandomBytes(new Uint8Array(randomBytes(16)))
    if (
      !sessionContainsNonce(agent, nonce) &&
      stableEvidence.every((value): boolean => !value.includes(nonce))
    ) {
      return nonce
    }
  }
  throw new VisualAcceptanceFailure('unable to generate a non-colliding visual nonce')
}

function topLevelRoot(agents: AgentRegistry, agent: Agent): boolean {
  const header = agent.session.header
  return (
    header.origin !== 'subagent' &&
    (header.delegationDepth === undefined || header.delegationDepth === 0) &&
    agents.roots().includes(agent)
  )
}

interface InjectedUserEvent {
  readonly event: SessionEvent<'user/message'>
  readonly turn: number
}

interface InjectedTurnSettlement {
  readonly turn: number
  readonly reason: SessionEvent<'turn/end'>['data']['reason']['kind']
}

function injectedUserEvent(
  events: readonly SessionEvent[],
  baselineSequence: number,
  image: StoredImage,
  expectedTurn: number,
): InjectedUserEvent | undefined {
  const event = events.find((candidate): candidate is SessionEvent<'user/message'> => {
    if (candidate.seq <= baselineSequence || candidate.type !== 'user/message') return false
    const source = candidate.data.source
    return (
      source.kind === 'plugin' &&
      source.plugin === 'dsh-luban-image-paste' &&
      textFromBlocks(candidate.data.content).includes(image.relPath)
    )
  })
  if (event === undefined) return undefined
  const turnStart = events.findLast(
    (candidate): candidate is SessionEvent<'turn/start'> =>
      candidate.seq > baselineSequence &&
      candidate.seq < event.seq &&
      candidate.type === 'turn/start',
  )
  return turnStart?.data.turn === expectedTurn ? { event, turn: expectedTurn } : undefined
}

interface VisualTurnTracker {
  readonly bind: (messageId: string) => void
  readonly wait: (milliseconds: number) => Promise<InjectedTurnSettlement>
  readonly dispose: () => void
}

/** Bind inbox claim and turn settlement to the exact prepared UserMessage id. */
export function createVisualTurnTracker(ctx: Context, agent: Agent): VisualTurnTracker {
  let expectedMessageId: string | undefined
  let claimedTurn: number | undefined
  let outcome: InjectedTurnSettlement | Error | undefined
  let resolveWait: ((value: InjectedTurnSettlement) => void) | undefined
  let rejectWait: ((error: Error) => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const unregisterAll: (() => void)[] = []
  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    while (unregisterAll.length > 0) unregisterAll.pop()?.()
  }
  const finish = (value: InjectedTurnSettlement | Error): void => {
    if (outcome !== undefined || disposed) return
    outcome = value
    cleanup()
    if (value instanceof Error) rejectWait?.(value)
    else resolveWait?.(value)
  }
  const inspectTurnEnd = (): void => {
    if (claimedTurn === undefined) return
    const ended = agent.session.events.find(
      (event): event is SessionEvent<'turn/end'> =>
        event.type === 'turn/end' && event.data.turn === claimedTurn,
    )
    if (ended !== undefined) {
      finish({ turn: claimedTurn, reason: ended.data.reason.kind })
    }
  }

  unregisterAll.push(
    ctx.on('agent/inbox/claimed', (payload): void => {
      if (
        payload.agent !== agent ||
        expectedMessageId === undefined ||
        payload.message.id !== expectedMessageId
      ) {
        return
      }
      if (claimedTurn !== undefined && claimedTurn !== payload.turn) {
        finish(new VisualAcceptanceFailure('visual message was claimed by multiple turns'))
        return
      }
      claimedTurn = payload.turn
      inspectTurnEnd()
    }),
    ctx.on('agent/inbox/discarded', (payload): void => {
      if (
        payload.agent === agent &&
        expectedMessageId !== undefined &&
        payload.message.id === expectedMessageId
      ) {
        finish(new VisualAcceptanceFailure('visual message was discarded before execution'))
      }
    }),
    ctx.on('session/event', (session, event): void => {
      if (session === agent.session && event.type === 'turn/end') inspectTurnEnd()
    }),
  )

  return {
    bind(messageId: string): void {
      if (disposed || expectedMessageId !== undefined || messageId.trim() === '') {
        throw new VisualAcceptanceFailure('visual message tracker binding is invalid')
      }
      expectedMessageId = messageId
    },
    wait(milliseconds: number): Promise<InjectedTurnSettlement> {
      if (disposed) return Promise.reject(new VisualAcceptanceFailure('visual tracker is disposed'))
      if (expectedMessageId === undefined) {
        return Promise.reject(new VisualAcceptanceFailure('visual message id was not prepared'))
      }
      if (outcome !== undefined) {
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
      }
      if (resolveWait !== undefined) {
        return Promise.reject(new VisualAcceptanceFailure('visual tracker wait was duplicated'))
      }
      return new Promise<InjectedTurnSettlement>((resolveTurn, rejectTurn): void => {
        resolveWait = resolveTurn
        rejectWait = rejectTurn
        timer = setTimeout(
          (): void => finish(new VisualAcceptanceFailure('visual turn timed out')),
          milliseconds,
        )
        timer.unref()
        inspectTurnEnd()
      })
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      cleanup()
    },
  }
}

interface ObservedVisualTurn {
  readonly observation: VisualTurnObservation
  readonly route: { readonly provider: string; readonly model: string }
  readonly step: number
  readonly turn: number
}

function requestHeaderForAssistant(
  events: readonly SessionEvent[],
  assistant: SessionEvent<'assistant/message'>,
): SessionEvent<'request/header'> | undefined {
  return events.findLast(
    (event): event is SessionEvent<'request/header'> =>
      event.seq < assistant.seq && event.type === 'request/header',
  )
}

/** Select one completed, exact-turn response and reject route inheritance across steps. */
export function observeVisualTurn(
  agent: Agent,
  baselineSequence: number,
  image: StoredImage,
  expectedTurn: number,
  nonce: string,
): ObservedVisualTurn {
  const userEvent = injectedUserEvent(agent.session.events, baselineSequence, image, expectedTurn)
  if (userEvent === undefined) throw new VisualAcceptanceFailure('injected user event is missing')
  const turn = userEvent.turn
  const assistants = agent.session.events.filter(
    (event): event is SessionEvent<'assistant/message'> =>
      event.seq > userEvent.event.seq &&
      event.type === 'assistant/message' &&
      event.data.turn === turn,
  )
  const completed = agent.session.events.some(
    (event): boolean =>
      event.seq > userEvent.event.seq &&
      event.type === 'turn/end' &&
      event.data.turn === turn &&
      event.data.reason.kind === 'completed',
  )
  if (!completed) throw new VisualAcceptanceFailure('visual turn did not complete')
  const responding = assistants.at(-1)
  if (responding === undefined) throw new VisualAcceptanceFailure('visual response is missing')
  const responseText = textFromBlocks(responding.data.message.content)
  if (responseText.trim() === '' || responding.data.interrupted === true) {
    throw new VisualAcceptanceFailure('final visual response is empty or interrupted')
  }
  if (!responseContainsNonce(responseText, nonce)) {
    throw new VisualAcceptanceFailure('final visual response did not contain the nonce')
  }
  if (
    assistants.some(
      (event): boolean =>
        event !== responding &&
        responseContainsNonce(textFromBlocks(event.data.message.content), nonce),
    )
  ) {
    throw new VisualAcceptanceFailure('visual nonce appeared before the final assistant response')
  }
  const routes = assistants.map(
    (
      assistant,
    ): {
      readonly provider: string
      readonly model: string
    } => {
      const requestHeader = requestHeaderForAssistant(agent.session.events, assistant)
      if (requestHeader === undefined) {
        throw new VisualAcceptanceFailure('visual response has no step-bound request header')
      }
      const requested = requestHeader.data.header.config
      const responded = assistant.data.message.source
      if (requested.provider !== responded.provider || requested.model !== responded.model) {
        throw new VisualAcceptanceFailure('visual response route did not match its request header')
      }
      return { provider: responded.provider, model: responded.model }
    },
  )
  const route = routes.at(-1)
  if (route === undefined) throw new VisualAcceptanceFailure('visual response route is missing')
  if (
    routes.some(
      (candidate): boolean =>
        candidate.provider !== route.provider || candidate.model !== route.model,
    )
  ) {
    throw new VisualAcceptanceFailure('visual turn crossed provider or model routes')
  }
  return {
    turn,
    step: responding.data.step,
    route,
    observation: {
      requestedSessionId: agent.id,
      respondingSessionId: agent.session.id,
      responseText,
      expectedProvider: route.provider,
      respondingProvider: route.provider,
      expectedModel: route.model,
      respondingModel: route.model,
    },
  }
}

function imageEvidence(
  png: Uint8Array,
  validation: ValidatedNoncePng,
): NonNullable<VisualAcceptanceEvidence['image']> {
  return {
    mime: 'image/png',
    valid: true,
    width: validation.width,
    height: validation.height,
    bytes: validation.bytes,
    sha256: sha256(png),
  }
}

/** Explicit simulation seam: even a perfect fake response can never produce live acceptance. */
export async function runSimulatedVisualAcceptance(
  options: SimulatedVisualAcceptanceOptions,
): Promise<VisualAcceptanceEvidence> {
  const startedAt = isoNow()
  const checks: VisualAcceptanceCheck[] = []
  let validation: ValidatedNoncePng | undefined
  let observation: VisualTurnObservation | undefined
  let assessment: VisualObservationAssessment | undefined
  let cleanup: VisualAcceptanceEvidence['cleanup'] =
    options.cleanup === undefined ? 'not-needed' : 'pass'
  try {
    validation = validateVisualNoncePng(options.png)
    recordCheck(checks, 'png-valid', 'pass', 'strict PNG validation passed')
    observation = await options.execute({ simulationNonce: options.nonce, png: options.png })
    assessment = assessVisualObservation(options.nonce, observation)
    recordCheck(
      checks,
      'visual-observation',
      assessment.passed ? 'pass' : 'fail',
      assessment.reason,
    )
  } catch {
    recordCheck(checks, 'simulated-execution', 'fail', 'simulation failed closed')
  } finally {
    if (options.cleanup !== undefined) {
      try {
        await options.cleanup()
      } catch {
        cleanup = 'fail'
        recordCheck(checks, 'cleanup', 'fail', 'simulated cleanup failed')
      }
    }
  }
  const outcome = assessment?.passed === true && cleanup !== 'fail' ? 'pass' : 'fail'
  const result: VisualAcceptanceEvidence = {
    schemaVersion: SCHEMA_VERSION,
    featureId: FEATURE_ID,
    runId: randomUUID(),
    execution: 'test-double',
    evidenceKind: 'simulated',
    status: 'simulated',
    acceptancePassed: false,
    nonceSha256: sha256(options.nonce),
    session: {
      requestedId: options.sessionId,
      ...(observation === undefined ? {} : { respondingId: observation.respondingSessionId }),
    },
    agent: { provider: options.provider, model: options.model },
    ...(validation === undefined ? {} : { image: imageEvidence(options.png, validation) }),
    platform: platformEvidence(),
    checks,
    cleanup,
    simulatedOutcome: outcome,
    startedAt,
    finishedAt: isoNow(),
  }
  if (JSON.stringify(result).includes(options.nonce)) {
    throw new Error('simulated evidence leaked the visual nonce')
  }
  return result
}

/** Live runner bound to the mounted rc2 AgentRegistry and LLM service lookup. */
export class MountedVisualAcceptanceService {
  readonly #ctx: Context
  readonly #agents: AgentRegistry
  readonly #workspaceRoot: string
  readonly #mount: MountedVisualAcceptanceMount | undefined
  #running = false

  public constructor(ctx: Context, mount: MountedVisualAcceptanceMount | string) {
    this.#ctx = ctx
    this.#agents = ctx.agents
    this.#mount = typeof mount === 'string' ? undefined : mount
    this.#workspaceRoot = typeof mount === 'string' ? mount : mount.repository.workspaceRoot
  }

  public async run(options: MountedVisualAcceptanceOptions): Promise<VisualAcceptanceEvidence> {
    const startedAt = isoNow()
    const runId = randomUUID()
    const explicitLive: unknown = options.live
    if (explicitLive !== true) {
      return createVisualAcceptancePlan(options.sessionId)
    }
    if (this.#running) {
      return {
        schemaVersion: SCHEMA_VERSION,
        featureId: FEATURE_ID,
        runId,
        execution: 'production',
        evidenceKind: 'live',
        status: 'blocked',
        acceptancePassed: false,
        session: { requestedId: options.sessionId },
        platform: platformEvidence(),
        checks: [
          { id: 'exclusive-run', status: 'blocked', actual: 'another live acceptance is active' },
        ],
        cleanup: 'not-needed',
        error: 'another M06 visual acceptance is already active',
        startedAt,
        finishedAt: isoNow(),
      }
    }
    this.#running = true
    try {
      return await this.#runLive(options, startedAt, runId)
    } finally {
      this.#running = false
    }
  }

  async #runLive(
    options: MountedVisualAcceptanceOptions,
    startedAt: string,
    runId: string,
  ): Promise<VisualAcceptanceEvidence> {
    const checks: VisualAcceptanceCheck[] = []
    let status: VisualAcceptanceStatus = 'pass'
    let error: string | undefined
    let cleanup: VisualAcceptanceEvidence['cleanup'] = 'not-needed'
    let nonce: string | undefined
    let png: Uint8Array | undefined
    let validation: ValidatedNoncePng | undefined
    let image: StoredImage | undefined
    let landedImageEvidence: VisualAcceptanceEvidence['image'] | undefined
    let repository: AttachmentRepository | undefined
    let mountedService: FileImageIngestService | undefined
    let agent: Agent | undefined
    let route: { readonly provider: string; readonly model: string } | undefined
    let git: GitIdentity | undefined
    let build: VisualAcceptanceBuildEvidence | undefined
    let response: VisualAcceptanceEvidence['response'] | undefined
    let endpoint: VisualAcceptanceEvidence['endpoint'] | undefined
    let turn: number | undefined
    let baselineSequence: number | undefined
    let turnTracker: VisualTurnTracker | undefined
    const execution = {
      maintenanceClaimed: false,
      injected: false,
      turnSettled: false,
    }
    let canonicalWorkspace: string | undefined
    let platform = platformEvidence()
    const requestedSessionId = options.sessionId

    try {
      const waitTimeout = timeoutMs(options.timeoutMs)
      const requestBody = visualAcceptanceRequestBody(options)
      const mount = this.#mount
      if (mount === undefined) {
        throw new VisualAcceptanceBlocked('production service/config mount is unavailable')
      }
      if (
        this.#ctx.webServer.host !== '127.0.0.1' ||
        !Number.isSafeInteger(this.#ctx.webServer.port) ||
        this.#ctx.webServer.port < 1 ||
        this.#ctx.webServer.port > 65_535
      ) {
        throw new VisualAcceptanceFailure('mounted loopback endpoint identity is invalid')
      }
      endpoint = {
        kind: 'mounted-loopback-candidate',
        host: '127.0.0.1',
        port: this.#ctx.webServer.port,
        processId: process.pid,
        nodeVersion: process.version,
        challengeSha256: sha256(options.challenge ?? ''),
        requestSha256: sha256(requestBody),
      }
      platform = await inspectVisualAcceptancePlatform()
      recordCheck(checks, 'target-platform', 'pass', platform.target)
      canonicalWorkspace = await realpath(this.#workspaceRoot)
      if (
        Object.getPrototypeOf(mount.repository) !== AttachmentRepository.prototype ||
        Object.getPrototypeOf(mount.service) !== FileImageIngestService.prototype ||
        !Object.isFrozen(mount.config) ||
        !mount.service.matchesMount(mount.repository, mount.config)
      ) {
        throw new VisualAcceptanceFailure('production service/config mount identity is invalid')
      }
      const canonicalConfigWorkspace = await realpath(mount.config.workspaceRoot)
      const canonicalConfigAttachRoot = await realpath(
        resolve(canonicalWorkspace, mount.config.attachDir),
      )
      if (
        !samePath(canonicalWorkspace, canonicalConfigWorkspace) ||
        !samePath(canonicalWorkspace, mount.repository.workspaceRoot) ||
        !samePath(canonicalConfigAttachRoot, mount.repository.attachRoot) ||
        this.#ctx.get('lubanImageIngest') !== mount.service ||
        this.#ctx.get('lubanImageVisualAcceptance') !== this
      ) {
        throw new VisualAcceptanceFailure('production service/config is not the mounted capability')
      }
      repository = mount.repository
      mountedService = mount.service
      const productionRepository = mount.repository
      const productionService = mount.service
      recordCheck(
        checks,
        'mounted-service-config',
        'pass',
        `sha256=${mountedConfigDigest(mount.config)}`,
      )
      git = inspectCleanVisualAcceptanceGit(canonicalWorkspace)
      recordCheck(checks, 'git-clean', 'pass', git.head)
      build = await inspectVisualAcceptanceBuild(canonicalWorkspace, git)
      recordCheck(checks, 'plugin-build-provenance', 'pass', build.gitHead)

      const id = DshSessionId(requestedSessionId)
      agent = this.#agents.get(id)
      if (agent === undefined)
        throw new VisualAcceptanceBlocked('requested DSH session is not live')
      if (agent.id !== requestedSessionId || agent.session.id !== requestedSessionId) {
        throw new VisualAcceptanceFailure('agent/session identity mismatch')
      }
      if (!topLevelRoot(this.#agents, agent)) {
        throw new VisualAcceptanceBlocked('requested DSH session is not a top-level root')
      }
      if (agent.status !== 'idle')
        throw new VisualAcceptanceBlocked('requested DSH agent is not idle')
      const sessionCwd = agent.session.header.cwd
      if (sessionCwd === undefined || !samePath(await realpath(sessionCwd), canonicalWorkspace)) {
        throw new VisualAcceptanceFailure('requested DSH session belongs to another workspace')
      }
      const liveAgent = agent
      const workspace = canonicalWorkspace
      const gitIdentity = git
      try {
        await liveAgent.runMaintenance(async (signal): Promise<void> => {
          execution.maintenanceClaimed = true
          signal.throwIfAborted()
          if (this.#agents.get(id) !== liveAgent || !topLevelRoot(this.#agents, liveAgent)) {
            throw new VisualAcceptanceFailure('requested agent changed before visual setup')
          }
          if (liveAgent.inbox.hasPending) {
            throw new VisualAcceptanceBlocked('requested DSH agent inbox is not empty')
          }
          recordCheck(
            checks,
            'live-agent-session',
            'pass',
            'same top-level session with exclusive maintenance ownership',
          )

          const generatedNonce = freshNonce(liveAgent, [
            requestedSessionId,
            liveAgent.options.provider ?? '',
            liveAgent.options.model ?? '',
            gitIdentity.head,
            workspace,
            runId,
            ACCEPTANCE_INSTRUCTION,
          ])
          nonce = generatedNonce
          const renderedPng = renderVisualNoncePng(generatedNonce)
          png = renderedPng
          validation = validateVisualNoncePng(renderedPng)
          requireCheck(
            checks,
            'png-valid',
            !Buffer.from(renderedPng).includes(Buffer.from(generatedNonce, 'ascii')),
            'strict PNG with pixels-only input nonce',
          )

          const pngBuffer = new ArrayBuffer(renderedPng.byteLength)
          new Uint8Array(pngBuffer).set(renderedPng)
          const ingestedImage = await productionService.fromBlobWithSource(
            new Blob([pngBuffer], { type: 'image/png' }),
            {
              source: 'paste',
              nameHint: 'visual-acceptance.png',
              declaredMime: 'image/png',
            },
          )
          image = ingestedImage
          const stored = await productionService.content(ingestedImage.id)
          const storedSha256 = sha256(stored.bytes)
          const sameRenderedBytes = storedSha256 === sha256(renderedPng)
          if (sameRenderedBytes) validateVisualNoncePng(stored.bytes)
          const storedWidth = stored.image.compression.width ?? validation.width
          const storedHeight = stored.image.compression.height ?? validation.height
          requireCheck(
            checks,
            'production-image-landing',
            stored.image.id === ingestedImage.id &&
              stored.image.mime === 'image/png' &&
              detectImage(stored.bytes).mime === 'image/png' &&
              stored.image.bytes === stored.bytes.byteLength &&
              stored.image.sha256 === storedSha256 &&
              pathWithin(productionRepository.attachRoot, stored.image.absPath) &&
              (sameRenderedBytes || stored.image.compression.status === 'compressed'),
            `bytes=${String(stored.bytes.byteLength)}`,
          )
          landedImageEvidence = {
            mime: 'image/png',
            valid: true,
            width: storedWidth,
            height: storedHeight,
            bytes: stored.bytes.byteLength,
            sha256: storedSha256,
          }

          const injectStyle = productionService.defaultInjectStyle
          const prompt = imagePrompt(ingestedImage, injectStyle, {
            instruction: ACCEPTANCE_INSTRUCTION,
          })
          const leaks = findVisualNonceLeaks(generatedNonce, {
            prompt,
            originalName: ingestedImage.originalName,
            relativePath: ingestedImage.relPath,
            absolutePath: ingestedImage.absPath,
            sessionBeforeTurn: JSON.stringify(liveAgent.session.events),
          })
          requireCheck(
            checks,
            'nonce-not-seeded',
            leaks.length === 0,
            `leaks=${String(leaks.length)}`,
          )

          signal.throwIfAborted()
          baselineSequence = liveAgent.session.events.at(-1)?.seq ?? -1
          const tracker = createVisualTurnTracker(this.#ctx, liveAgent)
          turnTracker = tracker
          const queueReceipt = { queued: false }
          try {
            await productionService.injectById(
              asSessionId(requestedSessionId),
              ingestedImage.id,
              injectStyle,
              {
                instruction: ACCEPTANCE_INSTRUCTION,
                expectedAgent: liveAgent,
                signal,
                onPreparedMessage: tracker.bind,
                onBeforeQueueMessage: (): void => {
                  if (liveAgent.inbox.hasPending) {
                    throw new VisualAcceptanceBlocked(
                      'requested DSH agent inbox changed during visual setup',
                    )
                  }
                },
                queueReceipt,
              },
            )
          } finally {
            execution.injected = queueReceipt.queued
          }
          signal.throwIfAborted()
        })
      } catch (caught: unknown) {
        if (!execution.maintenanceClaimed) {
          throw new VisualAcceptanceBlocked('requested DSH agent true idle phase is unavailable')
        }
        throw caught
      }
      if (baselineSequence === undefined || image === undefined || nonce === undefined) {
        throw new VisualAcceptanceFailure('visual turn setup did not commit atomically')
      }
      if (turnTracker === undefined) {
        throw new VisualAcceptanceFailure('visual message tracker was not installed')
      }
      const settlement = await turnTracker.wait(waitTimeout)
      execution.turnSettled = true
      recordCheck(checks, 'exact-message-turn', 'pass', `turn=${String(settlement.turn)}`)
      if (settlement.reason !== 'completed') {
        if (settlement.reason === 'blocked') {
          throw new VisualAcceptanceBlocked('visual turn was blocked before model execution')
        }
        throw new VisualAcceptanceFailure(`visual turn ended as ${settlement.reason}`)
      }
      if (this.#agents.get(id) !== liveAgent || liveAgent.session.id !== requestedSessionId) {
        throw new VisualAcceptanceFailure('requested agent/session changed during visual turn')
      }
      const observed = observeVisualTurn(liveAgent, baselineSequence, image, settlement.turn, nonce)
      turn = observed.turn
      const userEvent = injectedUserEvent(
        liveAgent.session.events,
        baselineSequence,
        image,
        settlement.turn,
      )
      if (userEvent === undefined || textFromBlocks(userEvent.event.data.content).includes(nonce)) {
        throw new VisualAcceptanceFailure('nonce leaked into injected session text')
      }
      const assessment = assessVisualObservation(nonce, observed.observation)
      requireCheck(
        checks,
        'same-session-response',
        assessment.reason !== 'wrong-session',
        assessment.reason,
      )
      requireCheck(
        checks,
        'same-provider-model-response',
        assessment.reason !== 'wrong-provider' && assessment.reason !== 'wrong-model',
        assessment.reason,
      )
      requireCheck(checks, 'visual-nonce-readback', assessment.passed, assessment.reason)
      route = observed.route
      const llm = this.#ctx.get('llm')
      if (llm === undefined) {
        throw new VisualAcceptanceBlocked('DSH LLM capability registry is unavailable')
      }
      let modelInfo: Awaited<ReturnType<typeof llm.resolveModelInfo>>
      try {
        modelInfo = await llm.resolveModelInfo(
          route.provider,
          route.model,
          AbortSignal.timeout(MODEL_PROBE_TIMEOUT_MS),
        )
      } catch {
        throw new VisualAcceptanceBlocked('actual visual response route metadata is unavailable')
      }
      if (modelInfo.inputModalities?.includes('image') !== true) {
        throw new VisualAcceptanceBlocked(
          'actual visual response route does not attest image input capability',
        )
      }
      recordCheck(checks, 'visual-model-route', 'pass', `${route.provider}/${route.model}`)
      const postTurnLeaks = findUnexpectedPostTurnNonceLeaks(
        nonce,
        liveAgent.session.events,
        baselineSequence,
        turn,
        observed.step,
      )
      requireCheck(
        checks,
        'nonce-output-boundary',
        postTurnLeaks.length === 0,
        `unexpectedLeaks=${String(postTurnLeaks.length)}`,
      )
      response = {
        matched: true,
        sha256: sha256(observed.observation.responseText),
        bytes: Buffer.byteLength(observed.observation.responseText, 'utf8'),
      }
    } catch (caught: unknown) {
      status = caught instanceof VisualAcceptanceBlocked ? 'blocked' : 'fail'
      error =
        caught instanceof VisualAcceptanceBlocked || caught instanceof VisualAcceptanceFailure
          ? caught.message
          : 'live visual acceptance failed without exposing provider details'
      recordCheck(
        checks,
        caught instanceof VisualAcceptanceBlocked ? 'live-preflight' : 'live-execution',
        caught instanceof VisualAcceptanceBlocked ? 'blocked' : 'fail',
        error,
      )
    } finally {
      turnTracker?.dispose()
      if (execution.injected && !execution.turnSettled) {
        status = 'fail'
        error = 'visual turn did not quiesce for safe cleanup'
        cleanup = 'fail'
        recordCheck(
          checks,
          'turn-quiescence',
          'fail',
          'fixture retained; unrelated agent inbox work was not cancelled',
        )
      }
      if (
        repository !== undefined &&
        mountedService !== undefined &&
        image !== undefined &&
        (!execution.injected || execution.turnSettled)
      ) {
        try {
          await repository.removeReference(image.id, asSessionId(requestedSessionId))
          await mountedService.delete(image.id)
          cleanup = 'pass'
          recordCheck(checks, 'cleanup', 'pass', 'mounted attachment removed')
        } catch {
          cleanup = 'fail'
          status = 'fail'
          error = 'mounted visual acceptance attachment cleanup failed'
          recordCheck(checks, 'cleanup', 'fail', 'mounted attachment retained')
        }
      }
      if (git !== undefined && canonicalWorkspace !== undefined) {
        try {
          const after = inspectCleanVisualAcceptanceGit(canonicalWorkspace)
          if (sameVisualAcceptanceGit(git, after)) {
            recordCheck(checks, 'git-clean-after', 'pass', after.head)
          } else {
            status = 'fail'
            error = 'git identity changed during visual acceptance'
            recordCheck(checks, 'git-clean-after', 'fail', 'worktree or HEAD changed')
          }
        } catch {
          status = 'fail'
          error = 'git identity changed during visual acceptance'
          recordCheck(checks, 'git-clean-after', 'fail', 'worktree or HEAD changed')
        }
      }
    }

    if (status === 'pass') {
      status = 'blocked'
      error = 'standalone CLI listener/process endpoint attestation is required'
      recordCheck(
        checks,
        'listener-process-attestation',
        'blocked',
        'standalone CLI must bind the reported PID to the loopback listener',
      )
    }

    const result: VisualAcceptanceEvidence = {
      schemaVersion: SCHEMA_VERSION,
      featureId: FEATURE_ID,
      runId,
      execution: 'production',
      evidenceKind: 'live',
      status,
      acceptancePassed: false,
      ...(nonce === undefined ? {} : { nonceSha256: sha256(nonce) }),
      session: {
        requestedId: requestedSessionId,
        ...(agent === undefined ? {} : { respondingId: agent.session.id, agentId: agent.id }),
        ...(turn === undefined ? {} : { turn }),
      },
      ...(route === undefined ? {} : { agent: route }),
      ...(landedImageEvidence !== undefined
        ? { image: landedImageEvidence }
        : png === undefined || validation === undefined
          ? {}
          : { image: imageEvidence(png, validation) }),
      ...(git === undefined ? {} : { git: { clean: true, head: git.head } }),
      ...(build === undefined ? {} : { build }),
      platform,
      ...(response === undefined ? {} : { response }),
      ...(endpoint === undefined ? {} : { endpoint }),
      checks,
      cleanup,
      ...(error === undefined ? {} : { error }),
      startedAt,
      finishedAt: isoNow(),
    }
    if (nonce !== undefined && JSON.stringify(result).includes(nonce)) {
      throw new Error('live evidence leaked the visual nonce')
    }
    return result
  }
}

export const visualAcceptanceInstruction = ACCEPTANCE_INSTRUCTION
