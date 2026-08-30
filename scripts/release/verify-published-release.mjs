#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  downloadGithubReleaseAsset,
  isCommitSha,
  isGitHubRepository,
  readGithubRelease,
} from './github-release.mjs'
import { discoverPackages, isPublishable, sha256, pathIsWithin, REPOSITORY_ROOT } from './lib.mjs'
import { inspectNpmArtifact } from './npm-registry.mjs'
import {
  appendPublishLedgerEvent,
  createReleaseLedgerIdentity,
  loadPublishLedger,
  PUBLISH_LEDGER_NAME,
} from './publish-ledger.mjs'
import { verifyArtifactManifest } from './publish.mjs'

const WORKFLOW_PATH = '.github/workflows/release.yml'

function parseArgs(argv) {
  const options = {}
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
    else if (arg === '--repository-id') options.repositoryId = value()
    else if (arg === '--repository-owner-id') options.repositoryOwnerId = value()
    else if (arg === '--expected-sha') options.expectedSha = value()
    else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function exactNames(actual, expected, label) {
  const actualNames = actual.map(({ name }) => name).sort()
  const expectedNames = expected.map(({ name }) => name).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(`${label} does not contain the exact expected asset set`)
  }
}

/** Read the remote tag and public Release, hashing the complete exact asset set. */
export async function inspectGithubPublishedRelease(input, options = {}) {
  const remote = await readGithubRelease(
    { repository: input.repository, tag: input.tag },
    {
      fetcher: options.fetcher,
      timeoutMs: options.timeoutMs,
      token: options.token,
    },
  )
  if (remote.release === null) throw new Error('GitHub Release is missing')
  exactNames(remote.release.assets, input.assets, 'GitHub Release')
  const expectedByName = new Map(input.assets.map((asset) => [asset.name, asset]))
  const assets = await Promise.all(
    remote.release.assets.map(async (asset) => {
      const expected = expectedByName.get(asset.name)
      if (expected === undefined) throw new Error(`${asset.name}: unexpected GitHub Release asset`)
      const content = await downloadGithubReleaseAsset(
        asset,
        expected.content.length,
        { repository: input.repository },
        { fetcher: options.fetcher, timeoutMs: options.timeoutMs, token: options.token },
      )
      return { name: asset.name, sha256: sha256(content), size: content.length }
    }),
  )
  return {
    repository: input.repository,
    tag: remote.release.tag,
    title: remote.release.title,
    body: remote.release.body,
    tagCommitSha: remote.tagCommitSha,
    releaseId: remote.release.id,
    draft: remote.release.draft,
    prerelease: remote.release.prerelease,
    assets,
  }
}

function assertConsistency({ release, expectedSha, github, npm }) {
  if (!Number.isSafeInteger(github.releaseId) || github.releaseId <= 0) {
    throw new Error('GitHub Release ID is invalid')
  }
  if (github.tag !== release.tag || github.tagCommitSha !== expectedSha) {
    throw new Error('GitHub tag does not resolve to the expected workflow commit')
  }
  if (github.title !== release.tag || github.body !== release.notes) {
    throw new Error('GitHub Release title or body does not match the immutable release notes')
  }
  if (github.draft !== false) throw new Error('GitHub Release is still a draft')
  if (github.prerelease !== false) throw new Error('GitHub Release is marked as a prerelease')
  if (!Array.isArray(github.assets)) throw new Error('GitHub Release assets are invalid')
  const githubAssets = new Map(github.assets.map((asset) => [asset.name, asset]))
  if (githubAssets.size !== github.assets.length) {
    throw new Error('GitHub Release assets contain duplicate names')
  }
  exactNames(github.assets, release.assets, 'GitHub Release verification result')
  for (const expected of release.assets) {
    const actual = githubAssets.get(expected.name)
    if (
      actual === undefined ||
      actual.sha256 !== expected.sha256 ||
      actual.size !== expected.content.length
    ) {
      throw new Error(
        `${expected.name}: GitHub Release asset does not match the immutable artifact`,
      )
    }
  }
  for (const record of npm) {
    if (record.status !== 'matching' || record.registryTarballSha256 !== record.sha256) {
      throw new Error(`${record.name}: npm tarball does not match the immutable artifact`)
    }
  }
}

async function immutableAssets(artifacts, release, manifestContent, ledger) {
  if (ledger.journal.initial.name !== 'publish-ledger.json') {
    throw new Error('Remote checkpoint ledger must be named publish-ledger.json')
  }
  const checkpointEvents = ledger.journal.events.filter(({ type }) => type !== 'release-verified')
  const checkpointSequence = checkpointEvents.at(-1)?.sequence ?? 0
  const checkpointCommits = ledger.journal.commits.filter(
    ({ sequence }) => sequence <= checkpointSequence,
  )
  if (checkpointCommits.length !== checkpointSequence + 1) {
    throw new Error('Local publish commits do not cover the public checkpoint journal')
  }
  return [
    {
      name: 'release-manifest.json',
      content: manifestContent,
      sha256: sha256(manifestContent),
    },
    ...(await Promise.all(
      release.packages.map(async (record) => {
        const content = await readFile(join(artifacts, record.file))
        return { name: record.file, content, sha256: record.sha256 }
      }),
    )),
    {
      name: PUBLISH_LEDGER_NAME,
      content: ledger.journal.initial.content,
      sha256: ledger.journal.initial.digest,
    },
    ...checkpointEvents.map(({ name, content, digest }) => ({ name, content, sha256: digest })),
    ...checkpointCommits.map(({ name, content, digest }) => ({
      name,
      content,
      sha256: digest,
    })),
  ]
}

function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/u.test(value ?? '')) throw new Error(`${label} is required`)
  return value
}

/** Verify tag -> exact public Release assets -> matching npm tarballs. */
async function verifyPublishedReleaseCore(options, runtime = {}) {
  const root = resolve(options.root ?? REPOSITORY_ROOT)
  if (options.artifacts === undefined) throw new Error('--artifacts is required')
  const artifacts = resolve(root, options.artifacts)
  if (!pathIsWithin(root, artifacts) || artifacts === root) {
    throw new Error('Artifact directory must stay inside the repository')
  }
  const expectedPackages = (await discoverPackages(root))
    .filter(({ manifest }) => isPublishable(manifest))
    .map(({ manifest }) => manifest.name)
  const release = await verifyArtifactManifest(root, artifacts, expectedPackages)
  const manifestContent = await readFile(join(artifacts, 'release-manifest.json'))
  const releaseNotes = await readFile(join(artifacts, 'RELEASE_NOTES.md'), 'utf8')
  const ledgerPath = resolve(root, options.ledger ?? join(artifacts, 'publish-ledger.json'))
  if (!pathIsWithin(artifacts, ledgerPath) || ledgerPath === artifacts) {
    throw new Error('Publish ledger must stay inside the release artifact directory')
  }
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY
  if (!isGitHubRepository(repository)) throw new Error('--repository must be owner/name')
  const expectedSha = (options.expectedSha ?? process.env.GITHUB_SHA)?.toLowerCase()
  if (!isCommitSha(expectedSha)) throw new Error('--expected-sha is required')
  const repositoryId = positiveInteger(
    options.repositoryId ?? process.env.GITHUB_REPOSITORY_ID,
    '--repository-id',
  )
  const repositoryOwnerId = positiveInteger(
    options.repositoryOwnerId ?? process.env.GITHUB_REPOSITORY_OWNER_ID,
    '--repository-owner-id',
  )
  const identity = createReleaseLedgerIdentity(release, sha256(manifestContent), {
    repository,
    repositoryId,
    repositoryOwnerId,
    workflowPath: WORKFLOW_PATH,
    ref: `refs/tags/${release.tag}`,
    commitSha: expectedSha,
  })
  const ledger = await loadPublishLedger(ledgerPath, identity)
  if (!['published', 'verified'].includes(ledger.status)) {
    throw new Error(`Post-publish verification requires a published ledger, got ${ledger.status}`)
  }
  if (
    ledger.verification !== null &&
    (ledger.verification.repository !== repository ||
      ledger.verification.expectedCommitSha !== expectedSha)
  ) {
    throw new Error('Publish ledger was already verified for a different repository or commit')
  }

  const expectedAssets = await immutableAssets(artifacts, release, manifestContent, ledger)
  const github = await (runtime.inspectGithub ?? inspectGithubPublishedRelease)(
    { repository, tag: release.tag, assets: expectedAssets },
    { fetcher: runtime.fetcher, timeoutMs: options.timeoutMs, token: runtime.githubToken },
  )
  const npm = await Promise.all(
    release.packages.map(async (record) => {
      const ledgerRecord = ledger.packages.find(({ name }) => name === record.name)
      if (ledgerRecord?.state !== 'published') {
        throw new Error(`${record.name}: published ledger does not record a completed publish`)
      }
      const inspection = await (runtime.inspectNpm ?? inspectNpmArtifact)(record, {
        artifacts,
        timeoutMs: options.timeoutMs,
      })
      return { ...inspection, ...record }
    }),
  )
  assertConsistency({
    release: { ...release, assets: expectedAssets, notes: releaseNotes },
    expectedSha,
    github,
    npm,
  })
  if (ledger.verification !== null && ledger.verification.githubReleaseId !== github.releaseId) {
    throw new Error('Publish ledger was already verified for a different GitHub Release')
  }
  if (runtime.simulated === true) {
    return {
      passed: false,
      wouldPass: true,
      simulated: true,
      version: release.version,
      tag: release.tag,
      expectedSha,
      repository,
      githubReleaseId: github.releaseId,
      ledger: ledgerPath,
      status: ledger.status,
      packages: npm.map(({ name, version, sha256: artifactSha256 }) => ({
        name,
        version,
        sha256: artifactSha256,
      })),
    }
  }
  const verifiedLedger =
    ledger.status === 'verified'
      ? ledger
      : await appendPublishLedgerEvent(
          ledgerPath,
          identity,
          {
            type: 'release-verified',
            repository,
            expectedCommitSha: expectedSha,
            githubReleaseId: github.releaseId,
          },
          {},
        )
  return {
    passed: true,
    version: release.version,
    tag: release.tag,
    expectedSha,
    repository,
    githubReleaseId: github.releaseId,
    ledger: ledgerPath,
    status: verifiedLedger.status,
    packages: npm.map(({ name, version, sha256: artifactSha256 }) => ({
      name,
      version,
      sha256: artifactSha256,
    })),
  }
}

/** Production verification never accepts replacement remote or clock adapters. */
export async function verifyPublishedRelease(options = {}) {
  const injected = ['clock', 'fetcher', 'githubToken', 'inspectGithub', 'inspectNpm'].filter(
    (key) => options[key] !== undefined,
  )
  if (injected.length > 0) {
    throw new Error(
      `Production release verification does not accept injected adapters: ${injected.join(', ')}`,
    )
  }
  return verifyPublishedReleaseCore(options)
}

/** Test-only simulation validates all bindings but cannot append release-verified or pass. */
export async function simulatePublishedRelease(options = {}, adapters = {}) {
  if (typeof adapters.inspectGithub !== 'function' || typeof adapters.inspectNpm !== 'function') {
    throw new Error('Simulated release verification requires GitHub and npm inspectors')
  }
  return verifyPublishedReleaseCore(options, { ...adapters, simulated: true })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/release/verify-published-release.mjs --artifacts <dir> [--ledger <path>] --repository <owner/name> --repository-id <id> --repository-owner-id <id> --expected-sha <commit>',
    )
    return
  }
  console.log(JSON.stringify(await verifyPublishedRelease(options), null, 2))
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      `verify-published-release: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  })
}
