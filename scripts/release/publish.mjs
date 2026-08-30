#!/usr/bin/env node

import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  npmInvocation,
  packedManifestIssues,
  pathIsWithin,
  readPackedManifest,
  readJson,
  REPOSITORY_ROOT,
  sha256,
} from './lib.mjs'
import { auditPackages } from './audit-packages.mjs'
import { downloadGithubReleaseAsset, readGithubRelease } from './github-release.mjs'
import { inspectNpmArtifact } from './npm-registry.mjs'
import {
  createReleaseLedgerIdentity,
  createPublishLedger,
  checkpointPublishLedgerPrefix,
  MAX_PUBLISH_COMMIT_BYTES,
  MAX_PUBLISH_EVENT_BYTES,
  MAX_PUBLISH_LEDGER_BYTES,
  preflightPublishLedger,
  isPublishLedgerCommitName,
  isPublishLedgerEventName,
  PUBLISH_LEDGER_NAME,
  reconcilePublishLedger,
  repairPublishLedgerTail,
  resumePublishLedger,
} from './publish-ledger.mjs'
import { validateRepository } from './validate-release.mjs'

const NPM_REGISTRY = 'https://registry.npmjs.org/'
const WORKFLOW_PATH = '.github/workflows/release.yml'
const PRODUCTION_ADAPTER_OPTIONS = [
  'checkpoint',
  'clock',
  'fetcher',
  'githubToken',
  'id',
  'inspectNpm',
  'publishPackage',
  'verifyBundle',
  'verifySignatures',
]
const PROCESS_ENV_ALLOWLIST = [
  'APPDATA',
  'ComSpec',
  'COMSPEC',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'Path',
  'PATH',
  'PATHEXT',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemRoot',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]
const PROVENANCE_ENV_ALLOWLIST = [
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'CI',
  'GITHUB_ACTION',
  'GITHUB_ACTIONS',
  'GITHUB_EVENT_NAME',
  'GITHUB_JOB',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_REF_TYPE',
  'GITHUB_REPOSITORY',
  'GITHUB_REPOSITORY_ID',
  'GITHUB_REPOSITORY_OWNER_ID',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER',
  'GITHUB_SERVER_URL',
  'GITHUB_SHA',
  'GITHUB_WORKFLOW',
  'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKFLOW_SHA',
  'RUNNER_ENVIRONMENT',
]

function selectedEnvironment(source, keys) {
  const environment = {}
  for (const key of keys) {
    if (typeof source[key] === 'string') environment[key] = source[key]
  }
  return environment
}

function rejectProductionAdapters(options) {
  const injected = PRODUCTION_ADAPTER_OPTIONS.filter((key) => options[key] !== undefined)
  if (injected.length > 0) {
    throw new Error(
      `Production publish does not accept injected adapters: ${injected.sort().join(', ')}`,
    )
  }
}

function parseArgs(argv) {
  const options = { publish: false }
  const actions = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === '--root') options.root = value()
    else if (arg === '--artifacts') options.artifacts = value()
    else if (arg === '--ledger') options.ledger = value()
    else if (arg === '--repository') options.repository = value()
    else if (arg === '--expected-sha') options.expectedSha = value()
    else if (arg === '--publish') actions.push('publish')
    else if (arg === '--resume') actions.push('resume')
    else if (arg === '--reconcile') actions.push('reconcile')
    else if (arg === '--dry-run') actions.push('dry-run')
    else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (actions.length > 1) {
    throw new Error('--dry-run, --publish, --resume, and --reconcile are mutually exclusive')
  }
  options.publish = actions[0] === 'publish'
  options.resume = actions[0] === 'resume'
  options.reconcile = actions[0] === 'reconcile'
  return options
}

export async function verifyArtifactManifest(root, artifacts, expectedPackages) {
  if (!pathIsWithin(root, artifacts) || resolve(root) === resolve(artifacts))
    throw new Error('Artifact directory must stay inside the repository')
  const release = await readJson(join(artifacts, 'release-manifest.json'))
  const rootManifest = await readJson(join(root, 'package.json'))
  if (release.schemaVersion !== 1)
    throw new Error(`Unsupported artifact schema: ${String(release.schemaVersion)}`)
  if (release.version !== rootManifest.version || release.tag !== `v${rootManifest.version}`) {
    throw new Error(`Artifact version/tag does not match root ${rootManifest.version}`)
  }
  if (!Array.isArray(release.packages) || release.packages.length === 0)
    throw new Error('Artifact manifest has no packages')
  const names = []
  const files = new Set()
  for (const record of release.packages) {
    if (record === null || typeof record !== 'object')
      throw new Error('Artifact package record must be an object')
    if (typeof record.name !== 'string' || record.name.trim() === '')
      throw new Error('Artifact package name is required')
    if (record.version !== release.version)
      throw new Error(`${record.name}: artifact version is not fixed to ${release.version}`)
    if (
      typeof record.file !== 'string' ||
      basename(record.file) !== record.file ||
      !record.file.endsWith('.tgz')
    ) {
      throw new Error(`${record.name}: artifact file must be a local .tgz basename`)
    }
    if (files.has(record.file)) throw new Error(`Duplicate artifact file: ${record.file}`)
    if (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256))
      throw new Error(`${record.name}: artifact checksum must be a lowercase SHA-256 digest`)
    names.push(record.name)
    files.add(record.file)
    const content = await readFile(resolve(artifacts, record.file))
    if (sha256(content) !== record.sha256)
      throw new Error(`${record.name}: artifact checksum mismatch`)
    const packedManifest = readPackedManifest(content)
    const packedIssues = packedManifestIssues(record, packedManifest)
    if (packedManifest.publishConfig !== undefined) {
      const publishConfig = packedManifest.publishConfig
      if (
        publishConfig === null ||
        typeof publishConfig !== 'object' ||
        Array.isArray(publishConfig)
      ) {
        packedIssues.push(`${record.name}: packed publishConfig must be an object`)
      } else {
        const unsupported = Object.keys(publishConfig).filter((key) => key !== 'access')
        if (unsupported.length > 0) {
          packedIssues.push(
            `${record.name}: packed publishConfig contains forbidden settings: ${unsupported
              .sort()
              .join(', ')}`,
          )
        }
        if (publishConfig.access !== 'public') {
          packedIssues.push(`${record.name}: packed publishConfig.access must be public`)
        }
      }
    }
    if (packedIssues.length > 0) throw new Error(packedIssues.join('\n'))
  }
  if (new Set(names).size !== names.length) throw new Error('Artifact package names must be unique')
  let orderedPackages = release.packages
  if (expectedPackages !== undefined) {
    const expected = [...expectedPackages].sort()
    const actual = [...names].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Artifact packages do not match the validated repository: expected ${expected.join(', ')}, got ${actual.join(', ')}`,
      )
    }
    const recordsByName = new Map(release.packages.map((record) => [record.name, record]))
    orderedPackages = expectedPackages.map((name) => recordsByName.get(name))
  }
  return { ...release, packages: orderedPackages }
}

function positiveIntegerEnvironment(value, label) {
  if (!/^[1-9]\d*$/u.test(value ?? '')) throw new Error(`${label} must be a positive integer`)
  return value
}

export function validateReleaseWorkflowIdentity(
  environment,
  rootVersion,
  options = {},
  requirements = {},
) {
  const expectedRef = `refs/tags/v${rootVersion}`
  if (environment.CI !== 'true' || environment.GITHUB_ACTIONS !== 'true')
    throw new Error('Actual publish is allowed only in GitHub Actions CI')
  if (environment.GITHUB_EVENT_NAME !== 'push')
    throw new Error('Actual publish requires a GitHub tag push event')
  if (environment.GITHUB_SERVER_URL !== 'https://github.com')
    throw new Error('Actual publish requires github.com as the workflow authority')
  if (environment.GITHUB_REF !== expectedRef)
    throw new Error(`Actual publish requires ${expectedRef}`)
  if (environment.GITHUB_REF_TYPE !== 'tag' || environment.GITHUB_REF_NAME !== `v${rootVersion}`) {
    throw new Error('GitHub ref identity does not match the release tag')
  }
  if (environment.LUBAN_RELEASE_APPROVED !== 'true')
    throw new Error('Protected release environment approval is missing')
  if (requirements.requireNpmToken !== false && !environment.NODE_AUTH_TOKEN) {
    throw new Error('NODE_AUTH_TOKEN is required for npm publish')
  }
  const repository = options.repository ?? environment.GITHUB_REPOSITORY
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? '') ||
    repository !== environment.GITHUB_REPOSITORY
  ) {
    throw new Error('--repository must be owner/name')
  }
  const repositoryId = positiveIntegerEnvironment(
    environment.GITHUB_REPOSITORY_ID,
    'GITHUB_REPOSITORY_ID',
  )
  const repositoryOwnerId = positiveIntegerEnvironment(
    environment.GITHUB_REPOSITORY_OWNER_ID,
    'GITHUB_REPOSITORY_OWNER_ID',
  )
  const expectedSha = (options.expectedSha ?? environment.GITHUB_SHA)?.toLowerCase()
  if (
    !/^[a-f0-9]{40,64}$/u.test(expectedSha ?? '') ||
    expectedSha !== environment.GITHUB_SHA?.toLowerCase()
  ) {
    throw new Error('--expected-sha must equal the GitHub Actions commit')
  }
  const workflowRef = `${repository}/${WORKFLOW_PATH}@${expectedRef}`
  if (environment.GITHUB_WORKFLOW_REF !== workflowRef) {
    throw new Error(`Actual publish requires workflow identity ${workflowRef}`)
  }
  if (environment.GITHUB_WORKFLOW_SHA?.toLowerCase() !== expectedSha) {
    throw new Error('GitHub workflow SHA does not match the release commit')
  }
  if (environment.RUNNER_ENVIRONMENT !== 'github-hosted') {
    throw new Error('Actual publish requires a GitHub-hosted runner')
  }
  const runId = positiveIntegerEnvironment(environment.GITHUB_RUN_ID, 'GITHUB_RUN_ID')
  const runAttempt = positiveIntegerEnvironment(
    environment.GITHUB_RUN_ATTEMPT,
    'GITHUB_RUN_ATTEMPT',
  )
  const token = environment.GH_TOKEN ?? environment.GITHUB_TOKEN
  if (typeof token !== 'string' || token === '') {
    throw new Error('GH_TOKEN is required for durable publish checkpoints')
  }
  return {
    eventName: environment.GITHUB_EVENT_NAME,
    expectedRef,
    expectedSha,
    repository,
    repositoryId,
    repositoryOwnerId,
    runnerEnvironment: environment.RUNNER_ENVIRONMENT,
    runAttempt,
    runId,
    token,
    workflowRef,
    workflowSha: environment.GITHUB_WORKFLOW_SHA.toLowerCase(),
  }
}

function publishContext(rootVersion, options, requirements) {
  return validateReleaseWorkflowIdentity(process.env, rootVersion, options, requirements)
}

function githubEnvironment(context) {
  return {
    ...selectedEnvironment(process.env, PROCESS_ENV_ALLOWLIST),
    GH_PROMPT_DISABLED: '1',
    GH_TOKEN: context.token,
  }
}

function exactAssetBytes(name, expected, actual) {
  const expectedDigest = Buffer.from(sha256(expected), 'hex')
  const actualDigest = Buffer.from(sha256(actual), 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expectedDigest, actualDigest)) {
    throw new Error(`${name}: immutable GitHub Release asset is a fork`)
  }
}

/** Create one immutable asset, treating an existing byte-identical asset as an idempotent retry. */
export async function ensureExactAsset(name, bytes, adapter) {
  if (basename(name) !== name || !Buffer.isBuffer(bytes)) {
    throw new Error('Immutable asset name or bytes are invalid')
  }
  const existing = await adapter.read(name)
  if (existing !== null) {
    exactAssetBytes(name, bytes, existing)
    return { created: false, name, sha256: sha256(bytes), size: bytes.length }
  }
  let createError
  try {
    await adapter.create(name, bytes)
  } catch (error) {
    createError = error
  }
  const confirmed = await adapter.read(name)
  if (confirmed === null) {
    throw new Error(`${name}: create-once GitHub Release asset was not confirmed`, {
      cause: createError,
    })
  }
  exactAssetBytes(name, bytes, confirmed)
  return { created: createError === undefined, name, sha256: sha256(bytes), size: bytes.length }
}

function journalAssetMaximum(name) {
  if (name === PUBLISH_LEDGER_NAME) return MAX_PUBLISH_LEDGER_BYTES
  if (isPublishLedgerEventName(name)) return MAX_PUBLISH_EVENT_BYTES
  if (isPublishLedgerCommitName(name)) return MAX_PUBLISH_COMMIT_BYTES
  throw new Error(`${name}: invalid publish journal asset name`)
}

async function readDraftAsset(tag, context, name) {
  const remote = await readGithubRelease(
    { repository: context.repository, tag },
    { token: context.token },
  )
  if (
    remote.tagCommitSha !== context.expectedSha ||
    remote.release?.tag !== tag ||
    remote.release.draft !== true ||
    remote.release.prerelease !== false
  ) {
    throw new Error(`${tag}: durable checkpoints require the exact draft GitHub Release`)
  }
  const asset = remote.release.assets.find((candidate) => candidate.name === name)
  if (asset === undefined) return null
  return downloadGithubReleaseAsset(
    asset,
    journalAssetMaximum(name),
    { repository: context.repository },
    { token: context.token },
  )
}

export function githubReleaseCheckpoint(tag, context) {
  return async ({ name, path, content, commit }) => {
    if (
      basename(path) !== name ||
      !Buffer.isBuffer(content) ||
      commit === null ||
      typeof commit !== 'object' ||
      basename(commit.path ?? '') !== commit.name ||
      !Buffer.isBuffer(commit.content)
    ) {
      throw new Error('Publish checkpoint entry or commit is invalid')
    }
    const localContent = await readFile(path)
    exactAssetBytes(name, content, localContent)
    const environment = githubEnvironment(context)
    const adapterFor = (assetPath) => ({
      read: (assetName) => readDraftAsset(tag, context, assetName),
      create: async () => {
        const result = spawnSync(
          'gh',
          ['release', 'upload', tag, assetPath, '--repo', context.repository],
          {
            encoding: 'utf8',
            windowsHide: true,
            env: environment,
            timeout: 120_000,
          },
        )
        if (result.status !== 0) {
          throw new Error(`${basename(assetPath)}: create-once GitHub upload failed`)
        }
      },
    })
    await ensureExactAsset(name, content, adapterFor(path))
    await ensureExactAsset(commit.name, commit.content, adapterFor(commit.path))
  }
}

async function publishPackage(artifacts, record) {
  const directory = await mkdtemp(join(tmpdir(), 'luban-npm-publish-'))
  try {
    const userConfig = join(directory, 'npmrc')
    const globalConfig = join(directory, 'global-npmrc')
    const cache = join(directory, 'cache')
    await writeFile(
      userConfig,
      `registry=${NPM_REGISTRY}\nalways-auth=true\n//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
    await writeFile(globalConfig, `registry=${NPM_REGISTRY}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    const invocation = npmInvocation([
      'publish',
      join(artifacts, record.file),
      '--access=public',
      '--dry-run=false',
      '--provenance',
      '--ignore-scripts',
      '--tag=latest',
      `--registry=${NPM_REGISTRY}`,
      `--userconfig=${userConfig}`,
      `--globalconfig=${globalConfig}`,
      `--cache=${cache}`,
    ])
    const environment = {
      ...selectedEnvironment(process.env, PROCESS_ENV_ALLOWLIST),
      ...selectedEnvironment(process.env, PROVENANCE_ENV_ALLOWLIST),
      NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
      NPM_CONFIG_CACHE: cache,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_REGISTRY: NPM_REGISTRY,
      NPM_CONFIG_USERCONFIG: userConfig,
      NO_UPDATE_NOTIFIER: '1',
    }
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'inherit',
      env: environment,
      timeout: 10 * 60_000,
    })
    if (result.status !== 0) {
      throw new Error(
        `npm publish exited without a durable success confirmation for ${record.name}`,
      )
    }
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

export async function publishRelease(options = {}) {
  rejectProductionAdapters(options)
  const root = resolve(options.root ?? REPOSITORY_ROOT)
  const metadata = await validateRepository(root)
  if (metadata.issues.length > 0)
    throw new Error(
      `Release metadata is invalid:\n${metadata.issues.map((issue) => `- ${issue}`).join('\n')}`,
    )

  const action =
    options.reconcile === true
      ? 'reconcile'
      : options.resume === true
        ? 'resume'
        : options.publish === true
          ? 'publish'
          : 'dry-run'
  if (options.artifacts === undefined) {
    if (action !== 'dry-run') throw new Error(`--artifacts is required with --${action}`)
    const packAudit = await auditPackages(root)
    if (packAudit.issues.length > 0)
      throw new Error(
        `Package audit failed:\n${packAudit.issues.map((issue) => `- ${issue}`).join('\n')}`,
      )
    return {
      dryRun: true,
      version: metadata.rootVersion,
      packages: packAudit.packages,
      artifacts: 'not supplied',
    }
  }

  const artifacts = resolve(root, options.artifacts)
  const release = await verifyArtifactManifest(root, artifacts, metadata.packages)
  if (action === 'dry-run')
    return { dryRun: true, version: release.version, tag: release.tag, packages: release.packages }

  const ledgerPath = resolve(root, options.ledger ?? join(artifacts, 'publish-ledger.json'))
  if (
    !pathIsWithin(artifacts, ledgerPath) ||
    artifacts === ledgerPath ||
    basename(ledgerPath) !== PUBLISH_LEDGER_NAME
  ) {
    throw new Error(`Publish ledger must be ${PUBLISH_LEDGER_NAME} inside the artifact directory`)
  }
  const manifestSha256 = sha256(await readFile(join(artifacts, 'release-manifest.json')))
  const context = publishContext(release.version, options, {
    requireNpmToken: action !== 'reconcile',
  })
  const releaseAuthority = {
    repository: context.repository,
    repositoryId: context.repositoryId,
    repositoryOwnerId: context.repositoryOwnerId,
    workflowPath: WORKFLOW_PATH,
    ref: context.expectedRef,
    commitSha: context.expectedSha,
  }
  const identity = createReleaseLedgerIdentity(release, manifestSha256, releaseAuthority)
  const attemptAuthority = {
    eventName: context.eventName,
    runId: context.runId,
    runAttempt: context.runAttempt,
    runnerEnvironment: context.runnerEnvironment,
    workflowRef: context.workflowRef,
    workflowSha: context.workflowSha,
  }
  const checkpoint = githubReleaseCheckpoint(release.tag, context)
  const inspect = (record) => {
    const packageAttempt =
      record.state === 'attempting' ? record.activeAttemptAuthority : record.publishAuthority
    const provenance =
      packageAttempt === null || packageAttempt === undefined
        ? undefined
        : { ...releaseAuthority, ...packageAttempt }
    return inspectNpmArtifact(record, {
      artifacts,
      timeoutMs: options.timeoutMs,
      provenance,
    })
  }

  if (action !== 'publish') await repairPublishLedgerTail(ledgerPath, identity)

  if (action === 'reconcile') {
    await checkpointPublishLedgerPrefix(ledgerPath, identity, checkpoint)
    const result = await reconcilePublishLedger(ledgerPath, identity, inspect, { checkpoint })
    return {
      dryRun: false,
      action,
      version: release.version,
      tag: release.tag,
      ledger: ledgerPath,
      status: result.ledger.status,
      ready: result.ready,
      issues: result.issues,
      packages: result.ledger.packages,
    }
  }

  if (action === 'publish') {
    await createPublishLedger(ledgerPath, identity, { checkpoint })
    await checkpointPublishLedgerPrefix(ledgerPath, identity, checkpoint)
    await preflightPublishLedger(ledgerPath, identity, inspect)
    await checkpointPublishLedgerPrefix(ledgerPath, identity, checkpoint)
  } else {
    await checkpointPublishLedgerPrefix(ledgerPath, identity, checkpoint)
    const reconciliation = await reconcilePublishLedger(ledgerPath, identity, inspect, {
      checkpoint,
    })
    if (!reconciliation.ready) {
      throw new Error(
        `Publish resume is blocked by reconciliation: ${reconciliation.issues.join('; ')}`,
      )
    }
    await checkpointPublishLedgerPrefix(ledgerPath, identity, checkpoint)
  }
  await resumePublishLedger(ledgerPath, identity, (record) => publishPackage(artifacts, record), {
    attemptAuthority,
    checkpoint,
  })
  await checkpointPublishLedgerPrefix(ledgerPath, identity, checkpoint)
  const confirmation = await reconcilePublishLedger(ledgerPath, identity, inspect, { checkpoint })
  if (!confirmation.ready || confirmation.ledger.status !== 'published') {
    throw new Error(
      `Published packages could not be confirmed with trusted provenance: ${confirmation.issues.join('; ')}`,
    )
  }
  const ledger = confirmation.ledger
  return {
    dryRun: false,
    action,
    version: release.version,
    tag: release.tag,
    ledger: ledgerPath,
    status: ledger.status,
    packages: ledger.packages,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/release/publish.mjs [--dry-run | --publish | --resume | --reconcile] [--artifacts <dir>] [--ledger <path>] [--repository <owner/name>] [--expected-sha <commit>]',
    )
    return
  }
  const result = await publishRelease(options)
  console.log(JSON.stringify(result, null, 2))
  if (result.ready === false) process.exitCode = 2
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`publish: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
