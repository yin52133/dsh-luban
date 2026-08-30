#!/usr/bin/env node

import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  downloadGithubReleaseAsset,
  isCommitSha,
  isGitHubRepository,
  readGithubRelease,
} from './github-release.mjs'
import { discoverPackages, isPublishable, pathIsWithin, REPOSITORY_ROOT, sha256 } from './lib.mjs'
import {
  atomicCreateOnceFile,
  createReleaseLedgerIdentity,
  isPublishLedgerCommitName,
  isPublishLedgerEventName,
  materializePublishLedgerMetadata,
  MAX_PUBLISH_COMMIT_BYTES,
  MAX_PUBLISH_EVENT_BYTES,
  MAX_PUBLISH_LEDGER_BYTES,
  PUBLISH_LEDGER_NAME,
  publishLedgerCommitSequence,
  publishLedgerEventSequence,
  repairPublishLedgerTail,
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
    else if (arg === '--github-output') options.githubOutput = value()
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

async function inspectRecoverableGithubRelease(input, options = {}) {
  const remote = await readGithubRelease(
    { repository: input.repository, tag: input.tag },
    {
      allowMissing: true,
      fetcher: options.fetcher,
      timeoutMs: options.timeoutMs,
      token: options.token,
    },
  )
  if (remote.release === null) return { tagCommitSha: remote.tagCommitSha, release: null }
  const immutable = new Map(input.immutableAssets.map((asset) => [asset.name, asset]))
  const assets = await Promise.all(
    remote.release.assets.map(async (asset) => {
      const expected = immutable.get(asset.name)
      const maximum =
        expected?.content.length ??
        (asset.name === PUBLISH_LEDGER_NAME
          ? MAX_PUBLISH_LEDGER_BYTES
          : isPublishLedgerEventName(asset.name)
            ? MAX_PUBLISH_EVENT_BYTES
            : isPublishLedgerCommitName(asset.name)
              ? MAX_PUBLISH_COMMIT_BYTES
              : undefined)
      if (maximum === undefined) {
        throw new Error(`${asset.name}: unexpected GitHub Release asset`)
      }
      const content = await downloadGithubReleaseAsset(
        asset,
        maximum,
        { repository: input.repository },
        { fetcher: options.fetcher, timeoutMs: options.timeoutMs, token: options.token },
      )
      return { name: asset.name, content }
    }),
  )
  return {
    tagCommitSha: remote.tagCommitSha,
    release: { ...remote.release, assets },
  }
}

async function restoreCreateOnce(path, content) {
  try {
    await atomicCreateOnceFile(path, content)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = await readFile(path)
    if (!existing.equals(content)) {
      throw new Error(`${path}: existing local recovery file does not match the Release asset`)
    }
  }
}

async function immutableAssets(artifacts, release, manifestContent) {
  return [
    { name: 'release-manifest.json', content: manifestContent },
    ...(await Promise.all(
      release.packages.map(async (record) => ({
        name: record.file,
        content: await readFile(join(artifacts, record.file)),
      })),
    )),
  ]
}

function validateImmutableAssets(remoteAssets, expectedAssets) {
  const remote = new Map(remoteAssets.map((asset) => [asset.name, asset]))
  for (const expected of expectedAssets) {
    const actual = remote.get(expected.name)
    if (
      actual === undefined ||
      actual.content.length !== expected.content.length ||
      sha256(actual.content) !== sha256(expected.content)
    ) {
      throw new Error(`${expected.name}: existing GitHub Release asset is not immutable`)
    }
  }
}

async function restoreLedger(ledgerPath, identity, remoteAssets, options = {}) {
  const initial = remoteAssets.find(({ name }) => name === PUBLISH_LEDGER_NAME)
  const events = remoteAssets
    .filter(({ name }) => isPublishLedgerEventName(name))
    .map((event) => ({ ...event, sequence: publishLedgerEventSequence(event.name) }))
    .sort((left, right) => left.sequence - right.sequence)
  const commits = remoteAssets
    .filter(({ name }) => isPublishLedgerCommitName(name))
    .map((commit) => ({ ...commit, sequence: publishLedgerCommitSequence(commit.name) }))
    .sort((left, right) => left.sequence - right.sequence)
  if (initial === undefined) {
    if (events.length > 0 || commits.length > 0)
      throw new Error('GitHub Release has journal state without an initial ledger')
    return null
  }

  for (let index = 0; index < events.length; index += 1) {
    if (events[index].sequence !== index + 1) {
      throw new Error('Remote publish journal event sequence has a gap or fork')
    }
  }
  for (let index = 0; index < commits.length; index += 1) {
    if (commits[index].sequence !== index) {
      throw new Error('Remote publish journal commit sequence has a gap or fork')
    }
  }
  const entryCount = events.length + 1
  const orphanSequence = commits.length === entryCount - 1 ? entryCount - 1 : null
  if (commits.length !== entryCount && orphanSequence === null) {
    throw new Error('Remote publish journal has more than one orphan tail or an impossible commit')
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'luban-release-recovery-'))
  const stagedLedgerPath = join(temporaryDirectory, PUBLISH_LEDGER_NAME)
  try {
    await mkdir(dirname(stagedLedgerPath), { recursive: true })
    await restoreCreateOnce(stagedLedgerPath, initial.content)
    if (events.length > 0) {
      const directory = `${stagedLedgerPath}.events`
      await mkdir(directory, { recursive: true })
      for (const event of events) {
        await restoreCreateOnce(join(directory, event.name), event.content)
      }
    }
    const stagedLedger = await materializePublishLedgerMetadata(stagedLedgerPath, identity)
    exactNames(stagedLedger.journal.events, events, 'Recovered publish journal')
    if (stagedLedger.journal.events.some(({ type }) => type === 'release-verified')) {
      throw new Error('Remote publish journal contains a non-checkpoint verification event')
    }
    for (const remoteCommit of commits) {
      const canonical = stagedLedger.journal.commits[remoteCommit.sequence]
      if (
        canonical === undefined ||
        canonical.name !== remoteCommit.name ||
        !canonical.content.equals(remoteCommit.content)
      ) {
        throw new Error(`${remoteCommit.name}: remote publish journal commit is a fork`)
      }
    }

    if (options.simulated === true) {
      return { ledger: stagedLedger, orphanSequence }
    }

    await mkdir(dirname(ledgerPath), { recursive: true })
    await restoreCreateOnce(ledgerPath, stagedLedger.journal.initial.content)
    if (stagedLedger.journal.events.length > 0) {
      await mkdir(`${ledgerPath}.events`, { recursive: true })
      for (const event of stagedLedger.journal.events) {
        await restoreCreateOnce(join(`${ledgerPath}.events`, event.name), event.content)
      }
    }
    await mkdir(`${ledgerPath}.commits`, { recursive: true })
    for (const commit of stagedLedger.journal.commits) {
      await restoreCreateOnce(join(`${ledgerPath}.commits`, commit.name), commit.content)
    }
    const ledger = await repairPublishLedgerTail(ledgerPath, identity)
    return { ledger, orphanSequence }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/u.test(value ?? '')) throw new Error(`${label} is required`)
  return value
}

/** Restore the remote create-once journal and choose create, resume, or verify. */
async function recoverReleaseCore(options, runtime = {}) {
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
  const ledgerPath = resolve(root, options.ledger ?? join(artifacts, PUBLISH_LEDGER_NAME))
  if (
    !pathIsWithin(artifacts, ledgerPath) ||
    ledgerPath === artifacts ||
    ledgerPath.split(/[\\/]/u).at(-1) !== PUBLISH_LEDGER_NAME
  ) {
    throw new Error(`Publish ledger must be ${PUBLISH_LEDGER_NAME} inside the artifact directory`)
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
  const expectedAssets = await immutableAssets(artifacts, release, manifestContent)
  const remote = await (runtime.inspectGithub ?? inspectRecoverableGithubRelease)(
    { repository, tag: release.tag, immutableAssets: expectedAssets },
    { fetcher: runtime.fetcher, timeoutMs: options.timeoutMs, token: runtime.githubToken },
  )
  if (remote?.tagCommitSha !== expectedSha) {
    throw new Error('GitHub tag does not resolve to the expected workflow commit')
  }
  if (remote.release === null) {
    return { mode: 'create', releaseExists: false, draft: false, ledger: null }
  }
  if (
    remote.release?.tag !== release.tag ||
    remote.release.title !== release.tag ||
    remote.release.body !== releaseNotes ||
    typeof remote.release.draft !== 'boolean' ||
    remote.release.prerelease !== false ||
    !Array.isArray(remote.release.assets)
  ) {
    throw new Error('Existing GitHub Release metadata is incompatible with this release')
  }
  const names = remote.release.assets.map(({ name }) => name)
  if (names.some((name) => typeof name !== 'string') || new Set(names).size !== names.length) {
    throw new Error('Existing GitHub Release asset names must be unique strings')
  }
  const allowed = remote.release.assets.filter(
    ({ name }) =>
      expectedAssets.some((expected) => expected.name === name) ||
      name === PUBLISH_LEDGER_NAME ||
      isPublishLedgerEventName(name) ||
      isPublishLedgerCommitName(name),
  )
  exactNames(remote.release.assets, allowed, 'Existing GitHub Release')
  validateImmutableAssets(remote.release.assets, expectedAssets)
  const restored = await restoreLedger(ledgerPath, identity, remote.release.assets, {
    simulated: runtime.simulated,
  })
  const ledger = restored?.ledger ?? null
  const orphanSequence = restored?.orphanSequence ?? null
  if (remote.release.draft) {
    if (ledger?.status === 'verified') {
      throw new Error('A draft GitHub Release cannot have a verified publish ledger')
    }
    return {
      mode: ledger === null ? 'publish' : 'resume',
      releaseExists: true,
      draft: true,
      ledger: ledger?.status ?? null,
      orphanSequence,
    }
  }
  if (ledger === null || ledger.status !== 'published' || orphanSequence !== null) {
    throw new Error('A public GitHub Release requires a fully published remote ledger')
  }
  return {
    mode: 'verify',
    releaseExists: true,
    draft: false,
    ledger: ledger.status,
  }
}

/** Production recovery never accepts replacement GitHub or credential adapters. */
export async function recoverRelease(options = {}) {
  const injected = ['fetcher', 'githubToken', 'inspectGithub'].filter(
    (key) => options[key] !== undefined,
  )
  if (injected.length > 0) {
    throw new Error(`Production recovery does not accept injected adapters: ${injected.join(', ')}`)
  }
  return recoverReleaseCore(options)
}

/** Read-only test simulation; remote state is validated in an isolated temporary journal. */
export async function simulateRecoverRelease(options = {}, adapters = {}) {
  const result = await recoverReleaseCore(options, { ...adapters, simulated: true })
  return { ...result, simulated: true }
}

async function writeGithubOutput(path, result) {
  if (path === undefined) return
  await appendFile(
    resolve(path),
    `mode=${result.mode}\nrelease_exists=${String(result.releaseExists)}\nrelease_draft=${String(result.draft)}\n`,
  )
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/release/recover-release.mjs --artifacts <dir> --repository <owner/name> --repository-id <id> --repository-owner-id <id> --expected-sha <commit> [--ledger <path>] [--github-output <path>]',
    )
    return
  }
  const result = await recoverRelease(options)
  await writeGithubOutput(options.githubOutput, result)
  console.log(JSON.stringify(result, null, 2))
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`recover-release: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
