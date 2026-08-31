import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserEvent, BrowserProfile, BrowserResult, BrowserSession } from 'dsh-luban-core'
import { stringify } from 'yaml'
import { BridgeProcess } from './bridge-process.js'
import { BrowserService } from './browser-service.js'
import { resolveConfig, type ResolvedConfig } from './config.js'
import {
  assertSecretFree,
  LIVE_BROWSER_CANONICAL_TASK,
  LIVE_BROWSER_BUILD_PROVENANCE_SCHEMA,
  LIVE_BROWSER_CHALLENGE_HTML_TEMPLATE,
  LIVE_BROWSER_CHALLENGE_PORT,
  LIVE_BROWSER_CHALLENGE_URL,
  LIVE_BROWSER_EVIDENCE_SCHEMA,
  LIVE_BROWSER_FEATURES,
  LIVE_BROWSER_FIXTURE_SHA256,
  LIVE_BROWSER_MODEL_ROUTE,
  LIVE_BROWSER_TASK_SHA256,
  LIVE_BROWSER_TEMPLATE_ID,
  LiveAcceptanceError,
  parseLiveBrowserEvidence,
  sha256Text,
  type LiveBrowserChecks,
  type LiveBrowserBinaryEvidence,
  type LiveBrowserBuildEvidence,
  type LiveBrowserEvidence,
  type LiveBrowserExecution,
  type LiveBrowserPlatformEvidence,
  type LiveBrowserProfileEvidence,
  type LiveBrowserScreenshotEvidence,
} from './live-evidence.js'

export * from './live-evidence.js'

const OPT_IN_ENVIRONMENT = 'LUBAN_LIVE_ACCEPTANCE'
const DSH_MODEL_URL_ENVIRONMENT = 'LUBAN_BROWSER_DSH_LLM_URL'
const DSH_MODEL_TOKEN_ENVIRONMENT = 'LUBAN_BROWSER_DSH_LLM_TOKEN'
const TEMPORARY_DIRECTORY_PREFIX = 'luban-browser-live-'
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024
const MAX_BUILD_FILE_BYTES = 16 * 1024 * 1024
const MAX_BUILD_TREE_BYTES = 64 * 1024 * 1024
const MAX_BUILD_FILES = 2048
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value): number => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return crc >>> 0
})

interface GitEvidence {
  readonly sha: string
  readonly dirty: boolean
}

interface RequestedLiveBrowserProfile extends BrowserProfile {
  readonly kernel: 'auto' | 'chromium-headless'
  readonly headless: boolean
}

export interface ChallengeObservation {
  readonly requestCount: number
  readonly userAgent?: string
}

export interface ChallengeServerHandle {
  readonly url: typeof LIVE_BROWSER_CHALLENGE_URL
  snapshot(): ChallengeObservation
  close(): Promise<void>
}

export interface AcceptanceBrowserService {
  start(profile: BrowserProfile): Promise<BrowserSession>
  run(task: { readonly templateId: string; readonly goal: string }): AsyncIterable<BrowserEvent>
  close(): Promise<void>
}

interface ServiceFactoryInput {
  readonly config: ResolvedConfig
  readonly environment: NodeJS.ProcessEnv
  readonly nonce: string
}

interface LiveAcceptanceDependencies {
  readonly execution: LiveBrowserExecution
  readonly inspectPlatform: () => Promise<LiveBrowserPlatformEvidence>
  readonly inspectGit: (repositoryRoot: string) => Promise<GitEvidence>
  readonly inspectBuild: (
    repositoryRoot: string,
    expectedGit: GitEvidence,
  ) => Promise<LiveBrowserBuildEvidence>
  readonly startChallenge: (nonce: string) => Promise<ChallengeServerHandle>
  readonly createService: (input: ServiceFactoryInput) => AcceptanceBrowserService
  readonly nonce: () => string
  readonly now: () => Date
  readonly makeTemporaryDirectory: () => Promise<string>
  readonly writeTemplate: (path: string, contents: string) => Promise<void>
  readonly removeTemporaryDirectory: (path: string) => Promise<void>
}

export interface RunLiveBrowserAcceptanceOptions {
  readonly repositoryRoot?: string
  readonly environment?: NodeJS.ProcessEnv
}

export async function runLiveBrowserAcceptance(
  options: RunLiveBrowserAcceptanceOptions = {},
): Promise<LiveBrowserEvidence> {
  return runWithDependencies(options, productionDependencies())
}

/** Test seam: evidence produced through this entry point can never become a live pass. */
export async function runLiveBrowserAcceptanceForTest(
  options: RunLiveBrowserAcceptanceOptions,
  dependencies: Omit<LiveAcceptanceDependencies, 'execution'>,
): Promise<LiveBrowserEvidence> {
  return runWithDependencies(options, { ...dependencies, execution: 'test-double' })
}

export async function inspectRuntimePlatform(
  runtimePlatform: NodeJS.Platform = process.platform,
  arch = process.arch,
  node = process.version,
  readOsRelease: () => Promise<string> = (): Promise<string> => readFile('/etc/os-release', 'utf8'),
): Promise<LiveBrowserPlatformEvidence> {
  if (runtimePlatform === 'win32') {
    return Object.freeze({ target: 'windows', runtimePlatform, arch, node })
  }
  if (runtimePlatform !== 'linux') {
    throw new LiveAcceptanceError(
      'E_LIVE_PLATFORM',
      'Live browser acceptance supports only Windows and Ubuntu',
    )
  }
  let release: string
  try {
    release = await readOsRelease()
  } catch {
    throw new LiveAcceptanceError('E_LIVE_PLATFORM', 'Unable to read /etc/os-release')
  }
  if (Buffer.byteLength(release) > 64 * 1024 || osReleaseId(release) !== 'ubuntu') {
    throw new LiveAcceptanceError(
      'E_LIVE_PLATFORM',
      'Linux live evidence is accepted only when /etc/os-release declares ID=ubuntu',
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

export async function startLoopbackChallenge(nonce: string): Promise<ChallengeServerHandle> {
  let requestCount = 0
  let userAgent: string | undefined
  const html = LIVE_BROWSER_CHALLENGE_HTML_TEMPLATE.replace('{{NONCE}}', nonce)
  const server = createServer((request, response): void => {
    if (
      request.method !== 'GET' ||
      request.url !== '/challenge' ||
      !isLoopbackAddress(request.socket.remoteAddress)
    ) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    requestCount += 1
    if (typeof request.headers['user-agent'] === 'string') {
      userAgent = request.headers['user-agent'].slice(0, 1024)
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
    })
    response.end(html)
  })
  try {
    await listen(server)
  } catch {
    server.close()
    throw new LiveAcceptanceError(
      'E_LIVE_CHALLENGE_SERVER',
      `Unable to bind the fixed loopback challenge port ${String(LIVE_BROWSER_CHALLENGE_PORT)}`,
    )
  }
  return Object.freeze({
    url: LIVE_BROWSER_CHALLENGE_URL,
    snapshot: (): ChallengeObservation =>
      Object.freeze({ requestCount, ...(userAgent === undefined ? {} : { userAgent }) }),
    close: (): Promise<void> => closeServer(server),
  })
}

async function runWithDependencies(
  options: RunLiveBrowserAcceptanceOptions,
  dependencies: LiveAcceptanceDependencies,
): Promise<LiveBrowserEvidence> {
  const environment = options.environment ?? process.env
  const gateway = modelGatewayEnvironment(environment)
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd())
  const [platform, git] = await Promise.all([
    dependencies.inspectPlatform(),
    dependencies.inspectGit(repositoryRoot),
  ])
  assertPlatform(platform)
  if (git.dirty) {
    throw new LiveAcceptanceError(
      'E_LIVE_GIT_DIRTY',
      'Live acceptance requires a clean source tree',
    )
  }
  const build = await dependencies.inspectBuild(repositoryRoot, git)

  const temporaryDirectory = await dependencies.makeTemporaryDirectory()
  let challenge: ChallengeServerHandle | undefined
  let service: AcceptanceBrowserService | undefined
  let result: LiveBrowserEvidence | undefined
  let operationError: unknown
  try {
    const dataDirectory = join(temporaryDirectory, 'data')
    const templatesDirectory = join(temporaryDirectory, 'templates')
    const profile = profileFor(platform)
    const config = resolveConfig({
      dataDir: dataDirectory,
      templatesDir: templatesDirectory,
      kernel: profile.kernel,
      headless: profile.headless,
      defaults: {
        maxSteps: LIVE_BROWSER_CANONICAL_TASK.maxSteps,
        timeoutSec: LIVE_BROWSER_CANONICAL_TASK.timeoutSec,
        allowDomains: LIVE_BROWSER_CANONICAL_TASK.allowDomains,
      },
      bridge: {
        passEnvironment: [DSH_MODEL_URL_ENVIRONMENT, DSH_MODEL_TOKEN_ENVIRONMENT],
      },
    })
    const nonce = dependencies.nonce()
    if (!/^[a-f0-9]{32}$/u.test(nonce)) {
      throw new LiveAcceptanceError('E_LIVE_NONCE', 'Challenge nonce generation failed')
    }
    await mkdir(templatesDirectory, { recursive: true, mode: 0o700 })
    await dependencies.writeTemplate(
      join(templatesDirectory, `${LIVE_BROWSER_TEMPLATE_ID}.yaml`),
      stringify(LIVE_BROWSER_CANONICAL_TASK),
    )
    challenge = await dependencies.startChallenge(nonce)
    if (challenge.url !== LIVE_BROWSER_CHALLENGE_URL) {
      throw new LiveAcceptanceError(
        'E_LIVE_CHALLENGE_SERVER',
        'Challenge server did not use the canonical loopback URL',
      )
    }
    service = dependencies.createService({ config, environment, nonce })
    result = await executeAcceptance({
      dependencies,
      service,
      challenge,
      config,
      platform,
      git,
      build,
      profile,
      gatewayToken: gateway.token,
      environment,
      nonce,
    })
  } catch (error: unknown) {
    operationError = error
  }

  const runtimeCleanup = await Promise.allSettled([
    service?.close() ?? Promise.resolve(),
    challenge?.close() ?? Promise.resolve(),
  ])
  const directoryCleanup = await Promise.allSettled([
    dependencies.removeTemporaryDirectory(temporaryDirectory),
  ])
  const cleanup = [...runtimeCleanup, ...directoryCleanup]
  let postRunGit: GitEvidence | undefined
  try {
    postRunGit = await dependencies.inspectGit(repositoryRoot)
  } catch (error: unknown) {
    if (operationError === undefined) operationError = error
  }
  if (postRunGit !== undefined && (postRunGit.dirty || postRunGit.sha !== git.sha)) {
    throw new LiveAcceptanceError(
      'E_LIVE_GIT_CHANGED',
      'Git HEAD or worktree changed during live browser acceptance',
    )
  }
  if (operationError !== undefined) {
    if (operationError instanceof LiveAcceptanceError) throw operationError
    throw new LiveAcceptanceError('E_LIVE_BROWSER_RUN', 'Live browser execution failed')
  }
  if (cleanup.some((item): boolean => item.status === 'rejected')) {
    throw new LiveAcceptanceError('E_LIVE_CLEANUP', 'Live browser runtime did not close cleanly')
  }
  if (result === undefined) {
    throw new LiveAcceptanceError('E_LIVE_INTERNAL', 'Live browser evidence was not produced')
  }
  return result
}

async function executeAcceptance(input: {
  readonly dependencies: LiveAcceptanceDependencies
  readonly service: AcceptanceBrowserService
  readonly challenge: ChallengeServerHandle
  readonly config: ResolvedConfig
  readonly platform: LiveBrowserPlatformEvidence
  readonly git: GitEvidence
  readonly build: LiveBrowserBuildEvidence
  readonly profile: BrowserProfile
  readonly gatewayToken: string
  readonly environment: NodeJS.ProcessEnv
  readonly nonce: string
}): Promise<LiveBrowserEvidence> {
  const startedAt = input.dependencies.now().toISOString()
  let browserResult: BrowserResult | undefined
  let progressEvents = 0
  const screenshotPaths = new Set<string>()
  const session = await input.service.start(input.profile)
  const attestedBrowser = attestedSessionBrowser(session.profile, input.platform)
  try {
    for await (const event of input.service.run({
      templateId: LIVE_BROWSER_TEMPLATE_ID,
      goal: '',
    })) {
      if (event.type === 'progress') progressEvents += 1
      if (event.type === 'screenshot') screenshotPaths.add(event.path)
      if (event.type === 'result') browserResult = event.result
    }
  } catch {
    // A stable failed evidence record is preferable to model runtime diagnostics.
  }
  if (browserResult !== undefined) {
    for (const path of browserResult.screenshots) screenshotPaths.add(path)
  }
  const screenshots = await verifyScreenshots([...screenshotPaths], input.config.artifactsDir)
  const observedNonce = structuredNonce(browserResult?.structured)
  const challenge = input.challenge.snapshot()
  const checks: LiveBrowserChecks = Object.freeze({
    optIn: true,
    dshModelGatewayPresent: true,
    gitClean: !input.git.dirty,
    buildProvenanceAttested: input.build.gitSha === input.git.sha,
    platformAttested: platformIsAttested(input.platform),
    browserProfileResolved: true,
    browserBinaryAttested: true,
    challengeFetched: challenge.requestCount >= 1,
    resultOk: browserResult?.status === 'ok',
    structuredNonceMatched: observedNonce === input.nonce,
    progressObserved: progressEvents >= 1,
    screenshotVerified: screenshots.length >= 1 && screenshots.length === screenshotPaths.size,
    secretFree: true,
  })
  const allChecksPass = Object.values(checks).every(Boolean)
  const execution = input.dependencies.execution
  const verdict = execution === 'test-double' ? 'test-only' : allChecksPass ? 'pass' : 'fail'
  const evidence: LiveBrowserEvidence = Object.freeze({
    schemaVersion: LIVE_BROWSER_EVIDENCE_SCHEMA,
    featureIds: LIVE_BROWSER_FEATURES,
    runId: randomUUID(),
    execution,
    verdict,
    startedAt,
    finishedAt: input.dependencies.now().toISOString(),
    git: Object.freeze({ ...input.git }),
    build: input.build,
    taskSha256: LIVE_BROWSER_TASK_SHA256,
    fixtureSha256: LIVE_BROWSER_FIXTURE_SHA256,
    modelRoute: LIVE_BROWSER_MODEL_ROUTE,
    platform: input.platform,
    browser: Object.freeze({
      profile: attestedBrowser.profile,
      binary: attestedBrowser.binary,
      bridgeVersion: '0.1.0',
      browserUseVersion: '0.13.8',
      python: '3.12',
      ...(challenge.userAgent === undefined
        ? {}
        : { challengeUserAgentSha256: sha256Text(challenge.userAgent) }),
    }),
    challenge: Object.freeze({
      requestCount: challenge.requestCount,
      expectedNonceSha256: sha256Text(input.nonce),
      ...(observedNonce === undefined ? {} : { observedNonceSha256: sha256Text(observedNonce) }),
      matched: observedNonce === input.nonce,
    }),
    result: Object.freeze({
      status: browserResult?.status ?? 'missing',
      progressEvents,
      ...(browserResult === undefined
        ? {}
        : { steps: browserResult.steps, durationMs: browserResult.durationMs }),
      screenshots: Object.freeze(screenshots),
    }),
    checks,
  })
  const secretValues = knownSecretValues(input.environment)
  if (!secretValues.includes(input.gatewayToken)) secretValues.push(input.gatewayToken)
  assertSecretFree(JSON.stringify(evidence), secretValues)
  return parseLiveBrowserEvidence(evidence)
}

function productionDependencies(): LiveAcceptanceDependencies {
  return {
    execution: 'production',
    inspectPlatform: inspectRuntimePlatform,
    inspectGit,
    inspectBuild: inspectRuntimeBuildProvenance,
    startChallenge: startLoopbackChallenge,
    createService: ({ config, environment }): AcceptanceBrowserService => {
      const bridge = new BridgeProcess({
        config: config.bridge,
        environment,
        log: (): void => undefined,
      })
      return new BrowserService({ config, bridge })
    },
    nonce: (): string => randomBytes(16).toString('hex'),
    now: (): Date => new Date(),
    makeTemporaryDirectory: async (): Promise<string> =>
      mkdtemp(join(await realpath(tmpdir()), TEMPORARY_DIRECTORY_PREFIX)),
    writeTemplate: (path, contents): Promise<void> =>
      writeFile(path, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    removeTemporaryDirectory: removeLiveAcceptanceTemporaryDirectory,
  }
}

/** Remove only a direct, non-symlinked child created under the operating-system temp directory. */
export async function removeLiveAcceptanceTemporaryDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new LiveAcceptanceError(
      'E_LIVE_TEMPORARY_DIRECTORY',
      'Refusing to remove a non-absolute temporary directory',
    )
  }
  let root: string
  let candidate: string
  try {
    root = await realpath(tmpdir())
    const metadata = await lstat(path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new LiveAcceptanceError(
        'E_LIVE_TEMPORARY_DIRECTORY',
        'Refusing to remove an invalid temporary directory',
      )
    }
    candidate = await realpath(path)
  } catch (error: unknown) {
    if (error instanceof LiveAcceptanceError) throw error
    throw new LiveAcceptanceError(
      'E_LIVE_TEMPORARY_DIRECTORY',
      'Unable to validate the live acceptance temporary directory',
    )
  }
  const name = basename(candidate)
  if (
    !sameFilesystemPath(dirname(candidate), root) ||
    !name.startsWith(TEMPORARY_DIRECTORY_PREFIX) ||
    name.length === TEMPORARY_DIRECTORY_PREFIX.length
  ) {
    throw new LiveAcceptanceError(
      'E_LIVE_TEMPORARY_DIRECTORY',
      'Refusing to remove a directory outside the live acceptance boundary',
    )
  }
  await rm(candidate, { recursive: true, force: false })
}

function modelGatewayEnvironment(environment: NodeJS.ProcessEnv): { readonly token: string } {
  if (environment[OPT_IN_ENVIRONMENT] !== '1') {
    throw new LiveAcceptanceError(
      'E_LIVE_OPT_IN_REQUIRED',
      `${OPT_IN_ENVIRONMENT}=1 is required for live browser acceptance`,
    )
  }
  const endpoint = environment[DSH_MODEL_URL_ENVIRONMENT]
  const token = environment[DSH_MODEL_TOKEN_ENVIRONMENT]
  if (typeof endpoint !== 'string' || endpoint.trim() === '' || !isGatewayToken(token)) {
    throw new LiveAcceptanceError(
      'E_LIVE_MODEL_GATEWAY_REQUIRED',
      `A parent DSH model gateway (${DSH_MODEL_URL_ENVIRONMENT} and ${DSH_MODEL_TOKEN_ENVIRONMENT}) is required for standalone live acceptance`,
    )
  }
  return { token }
}

export async function inspectRuntimeBuildProvenance(
  repositoryRoot: string,
  expectedGit: GitEvidence,
  runtimeModulePath = fileURLToPath(import.meta.url),
): Promise<LiveBrowserBuildEvidence> {
  try {
    const canonicalRepository = await realpath(repositoryRoot)
    const distributionPath = join(canonicalRepository, 'packages', 'dsh-luban-browser', 'dist')
    const distributionMetadata = await lstat(distributionPath)
    if (!distributionMetadata.isDirectory() || distributionMetadata.isSymbolicLink()) {
      throw new Error('invalid distribution directory')
    }
    const canonicalDistribution = await realpath(distributionPath)
    const runtimeMetadata = await lstat(runtimeModulePath)
    if (!runtimeMetadata.isFile() || runtimeMetadata.isSymbolicLink()) {
      throw new Error('invalid runtime module')
    }
    const canonicalRuntime = await realpath(runtimeModulePath)
    if (!isWithin(canonicalDistribution, canonicalRuntime)) {
      throw new Error('runtime module is outside repository distribution')
    }

    const provenancePath = join(canonicalDistribution, 'build-provenance.json')
    const provenanceMetadata = await lstat(provenancePath)
    if (
      !provenanceMetadata.isFile() ||
      provenanceMetadata.isSymbolicLink() ||
      provenanceMetadata.size < 1 ||
      provenanceMetadata.size > 64 * 1024
    ) {
      throw new Error('invalid provenance file')
    }
    const canonicalProvenance = await realpath(provenancePath)
    if (!sameFilesystemPath(canonicalProvenance, provenancePath)) {
      throw new Error('provenance file escaped distribution')
    }
    const decoded = JSON.parse(await readFile(canonicalProvenance, 'utf8')) as unknown
    const tree = await hashDistributionTree(canonicalDistribution)
    if (
      !isRecord(decoded) ||
      !hasExactKeys(decoded, ['schemaVersion', 'gitSha', 'dirty', 'treeSha256', 'fileCount']) ||
      decoded.schemaVersion !== LIVE_BROWSER_BUILD_PROVENANCE_SCHEMA ||
      typeof decoded.gitSha !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(decoded.gitSha) ||
      decoded.dirty !== false ||
      decoded.gitSha !== expectedGit.sha ||
      decoded.treeSha256 !== tree.sha256 ||
      decoded.fileCount !== tree.fileCount ||
      expectedGit.dirty
    ) {
      throw new Error('build provenance does not match Git state')
    }
    return Object.freeze({
      schemaVersion: LIVE_BROWSER_BUILD_PROVENANCE_SCHEMA,
      gitSha: decoded.gitSha,
      dirty: false,
      treeSha256: tree.sha256,
      fileCount: tree.fileCount,
    })
  } catch (error: unknown) {
    if (error instanceof LiveAcceptanceError) throw error
    throw new LiveAcceptanceError(
      'E_LIVE_BUILD_PROVENANCE',
      'Runtime module is not a clean build of the current repository commit',
    )
  }
}

async function hashDistributionTree(
  root: string,
): Promise<Readonly<{ sha256: string; fileCount: number }>> {
  const files: { readonly name: string; readonly path: string; readonly size: number }[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right): number =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const name = relative(root, path).replaceAll('\\', '/')
      if (name === 'build-provenance.json') continue
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error('distribution contains a symbolic link')
      if (metadata.isDirectory()) {
        await visit(path)
      } else if (metadata.isFile()) {
        if (metadata.size > MAX_BUILD_FILE_BYTES) throw new Error('distribution file is too large')
        files.push({ name, path, size: metadata.size })
        if (files.length > MAX_BUILD_FILES) throw new Error('distribution has too many files')
      } else {
        throw new Error('distribution contains an unsupported entry')
      }
    }
  }
  await visit(root)
  files.sort((left, right): number =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
  const totalBytes = files.reduce((sum, file): number => sum + file.size, 0)
  if (files.length === 0 || totalBytes > MAX_BUILD_TREE_BYTES) {
    throw new Error('distribution tree has an invalid size')
  }
  const digest = createHash('sha256')
  for (const file of files) {
    const contents = await readFile(file.path)
    if (contents.byteLength !== file.size) throw new Error('distribution changed while hashing')
    digest.update(file.name, 'utf8')
    digest.update('\0')
    digest.update(String(contents.byteLength), 'ascii')
    digest.update('\0')
    digest.update(contents)
  }
  return Object.freeze({ sha256: digest.digest('hex'), fileCount: files.length })
}

async function inspectGit(repositoryRoot: string): Promise<GitEvidence> {
  const shaBefore = (await git(repositoryRoot, ['rev-parse', 'HEAD'])).trim().toLowerCase()
  const status = await git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=normal'])
  const shaAfter = (await git(repositoryRoot, ['rev-parse', 'HEAD'])).trim().toLowerCase()
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(shaBefore) || shaAfter !== shaBefore) {
    throw new LiveAcceptanceError('E_LIVE_GIT', 'Git returned an invalid commit identity')
  }
  return Object.freeze({ sha: shaBefore, dirty: status.trim() !== '' })
}

function git(repositoryRoot: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolvePromise, reject): void => {
    execFile(
      'git',
      args,
      { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout): void => {
        if (error !== null) {
          reject(new LiveAcceptanceError('E_LIVE_GIT', 'Unable to inspect Git state'))
          return
        }
        resolvePromise(stdout)
      },
    )
  })
}

function profileFor(platform: LiveBrowserPlatformEvidence): RequestedLiveBrowserProfile {
  return Object.freeze(
    platform.target === 'windows'
      ? { kernel: 'auto', headless: false }
      : { kernel: 'chromium-headless', headless: true },
  )
}

function assertPlatform(platform: LiveBrowserPlatformEvidence): void {
  if (!platformIsAttested(platform)) {
    throw new LiveAcceptanceError(
      'E_LIVE_PLATFORM',
      'Runtime platform evidence does not match Windows or Ubuntu',
    )
  }
}

function platformIsAttested(platform: LiveBrowserPlatformEvidence): boolean {
  if (platform.target === 'windows') {
    return platform.runtimePlatform === 'win32' && platform.osReleaseId === undefined
  }
  return platform.runtimePlatform === 'linux' && platform.osReleaseId === 'ubuntu'
}

function attestedSessionBrowser(
  actual: BrowserProfile,
  platform: LiveBrowserPlatformEvidence,
): Readonly<{
  profile: LiveBrowserProfileEvidence
  binary: LiveBrowserBinaryEvidence
}> {
  const binary = actual.binary
  const keys = Object.keys(actual)
  const kernel = actual.kernel
  if (
    keys.length !== 4 ||
    !['kernel', 'headless', 'isolated', 'binary'].every((key): boolean => keys.includes(key)) ||
    !isLiveBrowserKernel(kernel) ||
    (platform.target === 'windows'
      ? kernel !== 'chrome' && kernel !== 'edge'
      : kernel !== 'chromium-headless') ||
    actual.headless !== (platform.target === 'ubuntu') ||
    actual.isolated !== true ||
    !isRecord(binary) ||
    !hasExactKeys(binary, ['kind', 'version', 'sha256']) ||
    !isLiveBrowserBinaryKind(binary.kind) ||
    !binaryMatchesLiveKernel(kernel, binary.kind) ||
    typeof binary.version !== 'string' ||
    binary.version.length > 128 ||
    !/^\d+(?:\.\d+){1,3}(?:[-+._A-Za-z0-9]*)?$/u.test(binary.version) ||
    typeof binary.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(binary.sha256)
  ) {
    throw new LiveAcceptanceError(
      'E_LIVE_BROWSER_PROFILE',
      'Browser bridge did not return the required actual browser attestation',
    )
  }
  return Object.freeze({
    profile: Object.freeze({
      kernel,
      headless: actual.headless,
      isolated: true,
    }),
    binary: Object.freeze({
      kind: binary.kind,
      version: binary.version,
      sha256: binary.sha256,
    }),
  })
}

function isLiveBrowserKernel(value: unknown): value is LiveBrowserProfileEvidence['kernel'] {
  return typeof value === 'string' && ['chrome', 'edge', 'chromium-headless'].includes(value)
}

function binaryMatchesLiveKernel(
  kernel: LiveBrowserProfileEvidence['kernel'],
  kind: LiveBrowserBinaryEvidence['kind'],
): boolean {
  if (kernel === 'chromium-headless') return kind === 'chromium' || kind === 'chrome'
  return kernel === kind
}

function isLiveBrowserBinaryKind(value: unknown): value is LiveBrowserBinaryEvidence['kind'] {
  return typeof value === 'string' && ['chrome', 'edge', 'chromium'].includes(value)
}

function structuredNonce(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === 'nonce' && typeof value.nonce === 'string'
    ? value.nonce
    : undefined
}

async function verifyScreenshots(
  paths: readonly string[],
  artifactsDirectory: string,
): Promise<readonly LiveBrowserScreenshotEvidence[]> {
  if (paths.length === 0) return []
  let root: string
  try {
    root = await realpath(artifactsDirectory)
  } catch {
    return []
  }
  const evidence: LiveBrowserScreenshotEvidence[] = []
  const digests = new Set<string>()
  for (const path of paths) {
    try {
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_SCREENSHOT_BYTES) {
        return []
      }
      const canonical = await realpath(path)
      if (!isWithin(root, canonical)) return []
      const bytes = await readFile(canonical)
      if (
        bytes.length < PNG_MAGIC.length ||
        !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ||
        !hasValidPngStructure(bytes)
      ) {
        return []
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (digests.has(sha256)) continue
      digests.add(sha256)
      evidence.push(
        Object.freeze({ sha256, bytes: bytes.length, pngMagic: true, pngStructure: true }),
      )
    } catch {
      return []
    }
  }
  return Object.freeze(evidence)
}

function hasValidPngStructure(bytes: Buffer): boolean {
  let offset = PNG_MAGIC.length
  let sawHeader = false
  let sawImageData = false
  let sawEnd = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const typeOffset = offset + 4
    const dataOffset = typeOffset + 4
    const dataEnd = dataOffset + length
    const chunkEnd = dataEnd + 4
    if (chunkEnd > bytes.length) return false

    const type = bytes.toString('ascii', typeOffset, dataOffset)
    if (!/^[A-Za-z]{4}$/u.test(type)) return false
    if (bytes.readUInt32BE(dataEnd) !== pngCrc32(bytes.subarray(typeOffset, dataEnd))) {
      return false
    }

    if (!sawHeader) {
      if (
        type !== 'IHDR' ||
        length !== 13 ||
        !validPngHeader(bytes.subarray(dataOffset, dataEnd))
      ) {
        return false
      }
      sawHeader = true
    } else if (type === 'IHDR') {
      return false
    }

    if (type === 'IDAT') sawImageData = true
    if (type === 'IEND') {
      if (length !== 0 || !sawImageData || chunkEnd !== bytes.length) return false
      sawEnd = true
      offset = chunkEnd
      break
    }
    offset = chunkEnd
  }
  return sawHeader && sawImageData && sawEnd && offset === bytes.length
}

function validPngHeader(header: Buffer): boolean {
  const width = header.readUInt32BE(0)
  const height = header.readUInt32BE(4)
  const bitDepth = header[8]
  const colorType = header[9]
  const compression = header[10]
  const filter = header[11]
  const interlace = header[12]
  if (
    width === 0 ||
    height === 0 ||
    bitDepth === undefined ||
    colorType === undefined ||
    compression !== 0 ||
    filter !== 0 ||
    (interlace !== 0 && interlace !== 1)
  ) {
    return false
  }
  const allowedDepths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  }
  return allowedDepths[colorType]?.includes(bitDepth) ?? false
}

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (PNG_CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return (
    path !== '' &&
    !isAbsolute(path) &&
    path !== '..' &&
    !path.startsWith('../') &&
    !path.startsWith('..\\')
  )
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function listen(server: Server): Promise<void> {
  return new Promise<void>((resolvePromise, reject): void => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(
      { host: '127.0.0.1', port: LIVE_BROWSER_CHALLENGE_PORT, exclusive: true },
      (): void => {
        server.off('error', onError)
        resolvePromise()
      },
    )
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolvePromise, reject): void => {
    server.close((error): void => {
      if (error === undefined) resolvePromise()
      else reject(error)
    })
  })
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === '127.0.0.1' || value === '::ffff:127.0.0.1'
}

function osReleaseId(value: string): string | undefined {
  for (const line of value.split(/\r?\n/u)) {
    const match = /^ID=(.*)$/u.exec(line.trim())
    if (match === null) continue
    const raw = match[1]?.trim()
    if (raw === undefined) return undefined
    return raw.replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2').toLowerCase()
  }
  return undefined
}

function isGatewayToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length >= 32
}

function knownSecretValues(environment: NodeJS.ProcessEnv): string[] {
  const value = environment[DSH_MODEL_TOKEN_ENVIRONMENT]
  return value === undefined || value.length < 8 ? [] : [value]
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
