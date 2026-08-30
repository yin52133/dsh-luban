import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { sha256 } from './lib.mjs'

const LEDGER_SCHEMA_VERSION = 1
export const PUBLISH_LEDGER_NAME = 'publish-ledger.json'
export const PUBLISH_LEDGER_HEAD_NAME = 'publish-ledger-head.json'
export const MAX_PUBLISH_LEDGER_BYTES = 1_000_000
export const MAX_PUBLISH_EVENT_BYTES = 64 * 1024
export const MAX_PUBLISH_COMMIT_BYTES = 64 * 1024
const MAX_EVENTS = 10_000
const EVENT_FILE = /^(\d{8})\.json$/u
const COMMIT_FILE = /^publish-ledger-commit-(\d{8})\.json$/u
const TEMP_FILE =
  /^\.publish-ledger-tmp-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const SHA256 = /^[a-f0-9]{64}$/u

export function isPublishLedgerEventName(value) {
  return EVENT_FILE.test(value)
}

export function publishLedgerEventSequence(value) {
  const match = EVENT_FILE.exec(value)
  return match === null ? undefined : Number.parseInt(match[1], 10)
}

export function isPublishLedgerCommitName(value) {
  return COMMIT_FILE.test(value)
}

export function publishLedgerCommitSequence(value) {
  const match = COMMIT_FILE.exec(value)
  return match === null ? undefined : Number.parseInt(match[1], 10)
}

export function publishLedgerCommitName(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_EVENTS) {
    throw new Error('Publish ledger commit sequence is invalid')
  }
  return `publish-ledger-commit-${String(sequence).padStart(8, '0')}.json`
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function timestamp(clock) {
  const value = clock()
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new Error('Publish ledger clock must return an ISO-8601 UTC timestamp')
  }
  return value
}

function defaultClock() {
  return new Date().toISOString()
}

async function syncDirectory(path) {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    if (
      process.platform === 'win32' &&
      ['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'EPERM'].includes(error?.code)
    ) {
      return
    }
    throw error
  } finally {
    await handle?.close()
  }
}

/** Atomically install complete bytes without ever replacing an existing path. */
export async function atomicCreateOnceFile(target, content) {
  const path = resolve(target)
  const directory = dirname(path)
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(content)
  const temporaryPath = join(directory, `.publish-ledger-tmp-${randomUUID()}`)
  let handle
  let temporaryCreated = false
  let failure
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    temporaryCreated = true
    await handle.writeFile(payload)
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporaryPath, path)
    await syncDirectory(directory)
  } catch (error) {
    failure = error
  }
  try {
    await handle?.close()
  } catch (error) {
    failure ??= error
  }
  if (temporaryCreated) {
    try {
      await unlink(temporaryPath)
      await syncDirectory(directory)
    } catch (error) {
      if (error?.code !== 'ENOENT') failure ??= error
    }
  }
  if (failure !== undefined) throw failure
  return sha256(payload)
}

async function writeCreateOnce(path, value) {
  return atomicCreateOnceFile(path, canonicalJson(value))
}

async function atomicReplaceFile(target, content) {
  const path = resolve(target)
  const directory = dirname(path)
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(content)
  const temporaryPath = join(directory, `.publish-ledger-tmp-${randomUUID()}`)
  let handle
  let failure
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(payload)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, path)
    await syncDirectory(directory)
  } catch (error) {
    failure = error
  }
  try {
    await handle?.close()
  } catch (error) {
    failure ??= error
  }
  try {
    await unlink(temporaryPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') failure ??= error
  }
  if (failure !== undefined) throw failure
  return sha256(payload)
}

function headPath(ledgerPath) {
  return join(dirname(ledgerPath), PUBLISH_LEDGER_HEAD_NAME)
}

function publishLedgerHead(ledgerId, sequence, digest) {
  requiredString(ledgerId, 'Publish ledger head ID')
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !SHA256.test(digest)) {
    throw new Error('Publish ledger head is invalid')
  }
  return { schemaVersion: LEDGER_SCHEMA_VERSION, ledgerId, sequence, digest }
}

export function createPublishLedgerHeadContent(ledgerId, sequence, digest) {
  return Buffer.from(canonicalJson(publishLedgerHead(ledgerId, sequence, digest)))
}

async function writePublishLedgerHead(ledgerPath, ledgerId, sequence, digest) {
  const path = headPath(ledgerPath)
  const value = publishLedgerHead(ledgerId, sequence, digest)
  await atomicReplaceFile(path, createPublishLedgerHeadContent(ledgerId, sequence, digest))
  return { name: PUBLISH_LEDGER_HEAD_NAME, path, value }
}

async function readPublishLedgerHead(ledgerPath, ledgerId) {
  const path = headPath(ledgerPath)
  const content = await boundedFile(path, MAX_PUBLISH_EVENT_BYTES)
  const head = parseJson(content, 'Publish ledger head')
  if (
    head === null ||
    typeof head !== 'object' ||
    Array.isArray(head) ||
    head.schemaVersion !== LEDGER_SCHEMA_VERSION ||
    head.ledgerId !== ledgerId ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 0 ||
    !SHA256.test(head.digest)
  ) {
    throw new Error('Publish ledger head is invalid')
  }
  return { ...head, content, name: PUBLISH_LEDGER_HEAD_NAME, path }
}

async function boundedFile(path, maximum) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > maximum) {
    throw new Error(`Publish ledger file is not a bounded regular file: ${path}`)
  }
  return readFile(path)
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value
}

function positiveIntegerString(value, label) {
  if (!/^[1-9]\d*$/u.test(value ?? '')) throw new Error(`${label} must be a positive integer`)
  return value
}

function validateReleaseAuthority(authority, release) {
  if (authority === null || typeof authority !== 'object' || Array.isArray(authority)) {
    throw new Error('Publish ledger release authority must be an object')
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(authority.repository ?? '')) {
    throw new Error('Publish ledger authority repository must be owner/name')
  }
  positiveIntegerString(authority.repositoryId, 'Publish ledger repository ID')
  positiveIntegerString(authority.repositoryOwnerId, 'Publish ledger repository owner ID')
  if (authority.workflowPath !== '.github/workflows/release.yml') {
    throw new Error('Publish ledger authority workflow path is invalid')
  }
  if (authority.ref !== `refs/tags/${release.tag}`) {
    throw new Error('Publish ledger authority ref does not match the release tag')
  }
  if (!/^[a-f0-9]{40,64}$/u.test(authority.commitSha ?? '')) {
    throw new Error('Publish ledger authority commit SHA is invalid')
  }
}

function validateAttemptAuthority(authority, releaseAuthority) {
  if (authority === null || typeof authority !== 'object' || Array.isArray(authority)) {
    throw new Error('Publish attempt authority must be an object')
  }
  positiveIntegerString(authority.runId, 'Publish attempt run ID')
  positiveIntegerString(authority.runAttempt, 'Publish attempt run attempt')
  if (
    authority.eventName !== 'push' ||
    authority.runnerEnvironment !== 'github-hosted' ||
    authority.workflowSha !== releaseAuthority.commitSha ||
    authority.workflowRef !==
      `${releaseAuthority.repository}/${releaseAuthority.workflowPath}@${releaseAuthority.ref}`
  ) {
    throw new Error('Publish attempt authority does not match the immutable release authority')
  }
  return {
    eventName: authority.eventName,
    runId: authority.runId,
    runAttempt: authority.runAttempt,
    runnerEnvironment: authority.runnerEnvironment,
    workflowRef: authority.workflowRef,
    workflowSha: authority.workflowSha,
  }
}

function validateReleaseIdentity(release) {
  if (release === null || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('Publish ledger release identity must be an object')
  }
  requiredString(release.version, 'Publish ledger version')
  if (release.tag !== `v${release.version}`) {
    throw new Error('Publish ledger tag/version identity is invalid')
  }
  if (!SHA256.test(release.manifestSha256)) {
    throw new Error('Publish ledger manifest SHA-256 is invalid')
  }
  validateReleaseAuthority(release.authority, release)
  if (!Array.isArray(release.packages) || release.packages.length === 0) {
    throw new Error('Publish ledger must contain packages')
  }
  const names = new Set()
  const files = new Set()
  for (const record of release.packages) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('Publish ledger package record must be an object')
    }
    const name = requiredString(record.name, 'Publish ledger package name')
    const file = requiredString(record.file, `${name}: publish ledger artifact file`)
    if (names.has(name) || files.has(file))
      throw new Error('Publish ledger packages must be unique')
    if (record.version !== release.version) {
      throw new Error(`${name}: publish ledger version does not match the release`)
    }
    if (!SHA256.test(record.sha256)) throw new Error(`${name}: publish ledger SHA-256 is invalid`)
    names.add(name)
    files.add(file)
  }
}

function releaseIdentityMatches(actual, expected) {
  return canonicalJson(actual) === canonicalJson(expected)
}

export function createReleaseLedgerIdentity(release, manifestSha256, authority) {
  const identity = {
    version: release.version,
    tag: release.tag,
    manifestSha256,
    authority: {
      repository: authority?.repository,
      repositoryId: authority?.repositoryId,
      repositoryOwnerId: authority?.repositoryOwnerId,
      workflowPath: authority?.workflowPath,
      ref: authority?.ref,
      commitSha: authority?.commitSha,
    },
    packages: release.packages.map(({ name, version, file, sha256: artifactSha256 }) => ({
      name,
      version,
      file,
      sha256: artifactSha256,
    })),
  }
  validateReleaseIdentity(identity)
  return identity
}

function validateInitialLedger(ledger, expectedRelease) {
  if (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error('Publish ledger must be a JSON object')
  }
  if (ledger.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error(`Unsupported publish ledger schema: ${String(ledger.schemaVersion)}`)
  }
  requiredString(ledger.ledgerId, 'Publish ledger ID')
  requiredString(ledger.createdAt, 'Publish ledger creation timestamp')
  validateReleaseIdentity(ledger.release)
  if (expectedRelease !== undefined && !releaseIdentityMatches(ledger.release, expectedRelease)) {
    throw new Error('Publish ledger does not match the immutable release artifacts')
  }
}

function parseJson(content, label) {
  try {
    return JSON.parse(content.toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

function initialPackageState(record) {
  return {
    ...record,
    state: 'pending',
    attempts: 0,
    activeAttemptId: null,
    activeAttemptAuthority: null,
    confirmation: null,
    publishAuthority: null,
    publishedAt: null,
  }
}

function validateEventBase(event, ledger, expectedSequence, previousDigest) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Publish ledger event must be an object')
  }
  if (event.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error(`Unsupported publish ledger event schema: ${String(event.schemaVersion)}`)
  }
  if (event.ledgerId !== ledger.ledgerId) throw new Error('Publish ledger event ID does not match')
  if (event.sequence !== expectedSequence)
    throw new Error('Publish ledger event sequence is broken')
  if (event.previousDigest !== previousDigest) {
    throw new Error('Publish ledger event digest chain is broken')
  }
  requiredString(event.at, 'Publish ledger event timestamp')
  requiredString(event.type, 'Publish ledger event type')
}

function packageState(packages, name) {
  const record = packages.find((candidate) => candidate.name === name)
  if (record === undefined) throw new Error(`Publish ledger event names unknown package: ${name}`)
  return record
}

function assertCoreFirstPrefix(packages) {
  const firstUnpublished = packages.findIndex((record) => record.state !== 'published')
  const boundary = firstUnpublished === -1 ? packages.length : firstUnpublished
  if (packages.slice(boundary).some((record) => record.state === 'published')) {
    throw new Error('Publish ledger violates core-first package ordering')
  }
  const attempting = packages
    .map((record, index) => ({ index, state: record.state }))
    .filter(({ state }) => state === 'attempting')
  if (attempting.length > 1 || (attempting.length === 1 && attempting[0].index !== boundary)) {
    throw new Error('Publish ledger has an out-of-order active attempt')
  }
}

function applyEvent(packages, verification, event, releaseAuthority) {
  if (event.type === 'attempt-started') {
    const record = packageState(packages, event.package)
    if (record.state !== 'pending') {
      throw new Error(`${record.name}: publish attempt cannot start from ${record.state}`)
    }
    const firstPending = packages.find((candidate) => candidate.state !== 'published')
    if (firstPending !== record) {
      throw new Error(`${record.name}: publish attempt violates core-first package ordering`)
    }
    requiredString(event.attemptId, `${record.name}: publish attempt ID`)
    const authority = validateAttemptAuthority(event.authority, releaseAuthority)
    record.state = 'attempting'
    record.attempts += 1
    record.activeAttemptId = event.attemptId
    record.activeAttemptAuthority = authority
    return verification
  }
  if (event.type === 'publish-confirmed') {
    const record = packageState(packages, event.package)
    if (record.state !== 'attempting' || record.activeAttemptId !== event.attemptId) {
      throw new Error(`${record.name}: publish confirmation does not match the active attempt`)
    }
    record.state = 'published'
    record.activeAttemptId = null
    record.publishAuthority = record.activeAttemptAuthority
    record.activeAttemptAuthority = null
    record.confirmation = 'publish-exit'
    record.publishedAt = event.at
    return verification
  }
  if (event.type === 'reconciled-absent') {
    const record = packageState(packages, event.package)
    if (record.state !== 'attempting' || record.activeAttemptId !== event.attemptId) {
      throw new Error(`${record.name}: absent reconciliation does not match the active attempt`)
    }
    record.state = 'pending'
    record.activeAttemptId = null
    record.activeAttemptAuthority = null
    return verification
  }
  if (event.type === 'reconciled-matching') {
    const record = packageState(packages, event.package)
    if (record.state !== 'attempting' || record.activeAttemptId !== event.attemptId) {
      throw new Error(`${record.name}: matching reconciliation does not match the active attempt`)
    }
    record.state = 'published'
    record.activeAttemptId = null
    record.publishAuthority = record.activeAttemptAuthority
    record.activeAttemptAuthority = null
    record.confirmation = 'ambiguous-reconcile'
    record.publishedAt = event.at
    return verification
  }
  if (event.type === 'release-verified') {
    if (!packages.every((record) => record.state === 'published') || verification !== null) {
      throw new Error('Release verification event is out of order')
    }
    const repository = requiredString(event.repository, 'Verified GitHub repository')
    const expectedCommitSha = requiredString(event.expectedCommitSha, 'Verified commit SHA')
    if (!/^[a-f0-9]{40,64}$/u.test(expectedCommitSha)) {
      throw new Error('Verified commit SHA is invalid')
    }
    if (!Number.isSafeInteger(event.githubReleaseId) || event.githubReleaseId <= 0) {
      throw new Error('Verified GitHub Release ID is invalid')
    }
    if (
      repository !== releaseAuthority.repository ||
      expectedCommitSha !== releaseAuthority.commitSha
    ) {
      throw new Error('Release verification does not match the immutable release authority')
    }
    return { at: event.at, expectedCommitSha, githubReleaseId: event.githubReleaseId, repository }
  }
  throw new Error(`Unsupported publish ledger event type: ${event.type}`)
}

function ledgerStatus(packages, verification) {
  if (verification !== null) return 'verified'
  if (packages.every((record) => record.state === 'published')) return 'published'
  if (packages.some((record) => record.state === 'attempting')) return 'reconcile-required'
  return 'ready'
}

function eventDirectory(ledgerPath) {
  return `${ledgerPath}.events`
}

function commitDirectory(ledgerPath) {
  return `${ledgerPath}.commits`
}

export function createPublishLedgerCommitContent({
  ledgerId,
  sequence,
  entryName,
  entrySize,
  entryDigest,
  previousDigest,
  previousCommitDigest,
}) {
  requiredString(ledgerId, 'Publish ledger commit ID')
  const expectedEntryName =
    sequence === 0 ? PUBLISH_LEDGER_NAME : `${String(sequence).padStart(8, '0')}.json`
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    sequence > MAX_EVENTS ||
    entryName !== expectedEntryName ||
    !Number.isSafeInteger(entrySize) ||
    entrySize <= 0 ||
    !SHA256.test(entryDigest) ||
    (sequence === 0
      ? previousDigest !== null || previousCommitDigest !== null
      : !SHA256.test(previousDigest) || !SHA256.test(previousCommitDigest))
  ) {
    throw new Error('Publish ledger commit is invalid')
  }
  return Buffer.from(
    canonicalJson({
      schemaVersion: LEDGER_SCHEMA_VERSION,
      ledgerId,
      sequence,
      entryName,
      entrySize,
      entryDigest,
      previousDigest,
      previousCommitDigest,
    }),
  )
}

async function writePublishLedgerCommit(ledgerPath, input) {
  const directory = commitDirectory(ledgerPath)
  await mkdir(directory, { recursive: true })
  await syncDirectory(dirname(directory))
  const name = publishLedgerCommitName(input.sequence)
  const path = join(directory, name)
  const content = createPublishLedgerCommitContent(input)
  let digest
  try {
    digest = await atomicCreateOnceFile(path, content)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = await boundedFile(path, MAX_PUBLISH_COMMIT_BYTES)
    if (!existing.equals(content)) throw new Error(`${name}: local publish commit is a fork`)
    digest = sha256(existing)
  }
  return { name, path, content, digest, sequence: input.sequence }
}

/** Create the immutable release identity. Existing paths are never adopted or overwritten. */
export async function createPublishLedger(ledgerPath, release, options = {}) {
  validateReleaseIdentity(release)
  const path = resolve(ledgerPath)
  const ledger = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    ledgerId: (options.id ?? randomUUID)(),
    createdAt: timestamp(options.clock ?? defaultClock),
    release,
  }
  const initialDigest = await writeCreateOnce(path, ledger)
  const initialContent = await boundedFile(path, MAX_PUBLISH_LEDGER_BYTES)
  const commit = await writePublishLedgerCommit(path, {
    ledgerId: ledger.ledgerId,
    sequence: 0,
    entryName: PUBLISH_LEDGER_NAME,
    entrySize: initialContent.length,
    entryDigest: initialDigest,
    previousDigest: null,
    previousCommitDigest: null,
  })
  const head = await writePublishLedgerHead(path, ledger.ledgerId, 0, initialDigest)
  await options.checkpoint?.({
    kind: 'initial',
    name: basename(path),
    path,
    content: initialContent,
    sequence: 0,
    digest: initialDigest,
    commit,
    head,
  })
  return loadPublishLedger(path, release)
}

async function replayPublishLedgerEntries(ledgerPath, expectedRelease) {
  const path = resolve(ledgerPath)
  const initialContent = await boundedFile(path, MAX_PUBLISH_LEDGER_BYTES)
  const ledger = parseJson(initialContent, 'Publish ledger')
  validateInitialLedger(ledger, expectedRelease)

  const directory = eventDirectory(path)
  let entries = []
  try {
    const metadata = await lstat(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Publish ledger event path must be a real directory')
    }
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (entries.length > MAX_EVENTS) throw new Error('Publish ledger contains too many events')
  const events = entries
    .flatMap((entry) => {
      if (TEMP_FILE.test(entry.name)) {
        if (!entry.isFile()) {
          throw new Error(`Publish ledger contains invalid temporary debris: ${entry.name}`)
        }
        return []
      }
      if (!entry.isFile())
        throw new Error(`Publish ledger contains a non-file event: ${entry.name}`)
      const match = EVENT_FILE.exec(entry.name)
      if (match === null)
        throw new Error(`Publish ledger contains an invalid event file: ${entry.name}`)
      return [{ name: entry.name, sequence: Number.parseInt(match[1], 10) }]
    })
    .sort((left, right) => left.sequence - right.sequence || left.name.localeCompare(right.name))

  const packages = ledger.release.packages.map(initialPackageState)
  let verification = null
  let previousDigest = sha256(initialContent)
  let expectedSequence = 1
  const journalEvents = []
  for (const entry of events) {
    if (entry.sequence !== expectedSequence) {
      throw new Error('Publish ledger event sequence has a gap or fork')
    }
    const content = await boundedFile(join(directory, entry.name), MAX_PUBLISH_EVENT_BYTES)
    const digest = sha256(content)
    const event = parseJson(content, `Publish ledger event ${entry.name}`)
    validateEventBase(event, ledger, expectedSequence, previousDigest)
    verification = applyEvent(packages, verification, event, ledger.release.authority)
    assertCoreFirstPrefix(packages)
    journalEvents.push({
      ...entry,
      content,
      digest,
      path: join(directory, entry.name),
      type: event.type,
    })
    previousDigest = digest
    expectedSequence += 1
  }

  return {
    ...ledger,
    path,
    eventDirectory: directory,
    commitDirectory: commitDirectory(path),
    sequence: expectedSequence - 1,
    lastDigest: previousDigest,
    status: ledgerStatus(packages, verification),
    packages,
    verification,
    journal: {
      initial: {
        content: initialContent,
        digest: sha256(initialContent),
        name: basename(path),
        path,
      },
      events: journalEvents,
    },
  }
}

function commitInput(ledger, entry, previousEntry, previousCommitDigest) {
  return {
    ledgerId: ledger.ledgerId,
    sequence: entry.sequence,
    entryName: entry.name,
    entrySize: entry.content.length,
    entryDigest: entry.digest,
    previousDigest: previousEntry?.digest ?? null,
    previousCommitDigest,
  }
}

async function readPublishLedgerCommits(ledger, options = {}) {
  let entries = []
  try {
    const metadata = await lstat(ledger.commitDirectory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Publish ledger commit path must be a real directory')
    }
    entries = await readdir(ledger.commitDirectory, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (entries.length > MAX_EVENTS + 1) throw new Error('Publish ledger contains too many commits')
  const commits = entries
    .flatMap((entry) => {
      if (TEMP_FILE.test(entry.name)) {
        if (!entry.isFile()) {
          throw new Error(`Publish ledger contains invalid temporary debris: ${entry.name}`)
        }
        return []
      }
      if (!entry.isFile()) {
        throw new Error(`Publish ledger contains a non-file commit: ${entry.name}`)
      }
      const match = COMMIT_FILE.exec(entry.name)
      if (match === null) {
        throw new Error(`Publish ledger contains an invalid commit file: ${entry.name}`)
      }
      return [{ name: entry.name, sequence: Number.parseInt(match[1], 10) }]
    })
    .sort((left, right) => left.sequence - right.sequence || left.name.localeCompare(right.name))
  const journalEntries = [{ ...ledger.journal.initial, sequence: 0 }, ...ledger.journal.events]
  const singleMissingTail =
    options.allowSingleMissingTail === true && commits.length === journalEntries.length - 1
  if (commits.length !== journalEntries.length && !singleMissingTail) {
    throw new Error('Publish ledger commits do not cover the complete journal')
  }
  let previousCommitDigest = null
  const journalCommits = []
  for (let sequence = 0; sequence < commits.length; sequence += 1) {
    const commit = commits[sequence]
    const entry = journalEntries[sequence]
    if (commit?.sequence !== sequence || commit.name !== publishLedgerCommitName(sequence)) {
      throw new Error('Publish ledger commit sequence has a gap or fork')
    }
    const content = await boundedFile(
      join(ledger.commitDirectory, commit.name),
      MAX_PUBLISH_COMMIT_BYTES,
    )
    const expectedContent = createPublishLedgerCommitContent(
      commitInput(ledger, entry, journalEntries[sequence - 1], previousCommitDigest),
    )
    if (!content.equals(expectedContent)) {
      throw new Error(`${commit.name}: publish ledger commit does not match its journal entry`)
    }
    const digest = sha256(content)
    journalCommits.push({
      ...commit,
      content,
      digest,
      path: join(ledger.commitDirectory, commit.name),
    })
    previousCommitDigest = digest
  }
  return journalCommits
}

function entryDigestAt(ledger, sequence) {
  if (sequence === 0) return ledger.journal.initial.digest
  return ledger.journal.events[sequence - 1]?.digest
}

/** Repair only the two local crash windows: one tail commit, or a missing/one-step-lag head. */
export async function repairPublishLedgerTail(ledgerPath, expectedRelease) {
  const ledger = await replayPublishLedgerEntries(ledgerPath, expectedRelease)
  const commits = await readPublishLedgerCommits(ledger, { allowSingleMissingTail: true })
  let head
  try {
    head = await readPublishLedgerHead(ledger.path, ledger.ledgerId)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (
    head !== undefined &&
    (head.sequence !== ledger.sequence || head.digest !== ledger.lastDigest) &&
    !(
      ledger.sequence > 0 &&
      head.sequence === ledger.sequence - 1 &&
      head.digest === entryDigestAt(ledger, ledger.sequence - 1)
    )
  ) {
    throw new Error('Publish ledger head is neither canonical nor a one-step crash prefix')
  }
  if (commits.length === ledger.sequence) {
    const entries = [{ ...ledger.journal.initial, sequence: 0 }, ...ledger.journal.events]
    const previousCommitDigest = commits.at(-1)?.digest ?? null
    await writePublishLedgerCommit(
      ledger.path,
      commitInput(ledger, entries.at(-1), entries.at(-2), previousCommitDigest),
    )
  }
  if (head?.sequence !== ledger.sequence || head.digest !== ledger.lastDigest) {
    await writePublishLedgerHead(ledger.path, ledger.ledgerId, ledger.sequence, ledger.lastDigest)
  }
  return loadPublishLedger(ledger.path, expectedRelease)
}

/** Materialize canonical local commit records and head for a fully validated entry chain. */
export async function materializePublishLedgerMetadata(ledgerPath, expectedRelease) {
  const ledger = await replayPublishLedgerEntries(ledgerPath, expectedRelease)
  const entries = [{ ...ledger.journal.initial, sequence: 0 }, ...ledger.journal.events]
  let previousCommitDigest = null
  for (let sequence = 0; sequence < entries.length; sequence += 1) {
    const commit = await writePublishLedgerCommit(
      ledger.path,
      commitInput(ledger, entries[sequence], entries[sequence - 1], previousCommitDigest),
    )
    previousCommitDigest = commit.digest
  }
  await writePublishLedgerHead(ledger.path, ledger.ledgerId, ledger.sequence, ledger.lastDigest)
  return loadPublishLedger(ledger.path, expectedRelease)
}

/** Replay the append-only journal and reject gaps, forks, edits, or impossible transitions. */
export async function loadPublishLedger(ledgerPath, expectedRelease) {
  const ledger = await replayPublishLedgerEntries(ledgerPath, expectedRelease)
  const commits = await readPublishLedgerCommits(ledger)
  const head = await readPublishLedgerHead(ledger.path, ledger.ledgerId)
  if (head.sequence !== ledger.sequence || head.digest !== ledger.lastDigest) {
    throw new Error('Publish ledger head does not match the complete journal')
  }
  return { ...ledger, journal: { ...ledger.journal, commits, head } }
}

/** Append one fsynced, create-once event; concurrent forks are detected during replay. */
export async function appendPublishLedgerEvent(ledgerPath, expectedRelease, event, options = {}) {
  const current = await loadPublishLedger(ledgerPath, expectedRelease)
  if (current.sequence >= MAX_EVENTS) {
    throw new Error('Publish ledger contains too many events')
  }
  const next = {
    ...event,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    ledgerId: current.ledgerId,
    sequence: current.sequence + 1,
    previousDigest: current.lastDigest,
    at: timestamp(options.clock ?? defaultClock),
  }
  const payload = canonicalJson(next)
  const digest = sha256(payload)
  const filename = `${String(next.sequence).padStart(8, '0')}.json`
  const directory = current.eventDirectory
  await mkdir(directory, { recursive: true })
  await syncDirectory(dirname(directory))
  const eventPath = join(directory, filename)
  await writeCreateOnce(eventPath, next)
  const content = await boundedFile(eventPath, MAX_PUBLISH_EVENT_BYTES)
  const commit = await writePublishLedgerCommit(current.path, {
    ledgerId: current.ledgerId,
    sequence: next.sequence,
    entryName: filename,
    entrySize: content.length,
    entryDigest: digest,
    previousDigest: current.lastDigest,
    previousCommitDigest: current.journal.commits.at(-1).digest,
  })
  const head = await writePublishLedgerHead(current.path, current.ledgerId, next.sequence, digest)
  await options.checkpoint?.({
    kind: 'event',
    name: filename,
    path: eventPath,
    content,
    sequence: next.sequence,
    digest,
    commit,
    head,
    type: next.type,
  })
  return loadPublishLedger(ledgerPath, expectedRelease)
}

/** Re-confirm every immutable entry/commit pair before registry reads or journal advancement. */
export async function checkpointPublishLedgerPrefix(ledgerPath, expectedRelease, checkpoint) {
  const ledger = await loadPublishLedger(ledgerPath, expectedRelease)
  if (typeof checkpoint !== 'function') return ledger
  const entries = [{ ...ledger.journal.initial, sequence: 0 }, ...ledger.journal.events]
  for (const entry of entries) {
    await checkpoint({
      kind: entry.sequence === 0 ? 'initial' : 'event',
      name: entry.name,
      path: entry.path,
      content: entry.content,
      sequence: entry.sequence,
      digest: entry.digest,
      commit: ledger.journal.commits[entry.sequence],
      head: ledger.journal.head,
      prefix: true,
      type: entry.type,
    })
  }
  return loadPublishLedger(ledgerPath, expectedRelease)
}

function normalizeInspection(result, name) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`${name}: registry inspector returned an invalid result`)
  }
  if (!['absent', 'matching', 'conflict', 'unknown'].includes(result.status)) {
    throw new Error(`${name}: registry inspector returned invalid status ${String(result.status)}`)
  }
  return { name, ...result }
}

export async function preflightPublishLedger(ledgerPath, expectedRelease, inspectPackage) {
  const ledger = await loadPublishLedger(ledgerPath, expectedRelease)
  if (ledger.status !== 'ready' || ledger.packages.some((record) => record.attempts !== 0)) {
    throw new Error('New publish requires a pristine create-once ledger; use --resume')
  }
  const inspections = await Promise.all(
    ledger.packages.map(async (record) =>
      normalizeInspection(await inspectPackage(record), record.name),
    ),
  )
  const unavailable = inspections.filter((inspection) => inspection.status !== 'absent')
  if (unavailable.length > 0) {
    throw new Error(
      `Publish preflight cannot prove every version is unused: ${unavailable
        .map(({ name, status }) => `${name}=${status}`)
        .join(', ')}`,
    )
  }
  return { ledger, inspections }
}

/** Resolve every ambiguous attempt against exact registry tarball bytes before allowing resume. */
export async function reconcilePublishLedger(
  ledgerPath,
  expectedRelease,
  inspectPackage,
  options = {},
) {
  let ledger = await loadPublishLedger(ledgerPath, expectedRelease)
  const inspections = await Promise.all(
    ledger.packages.map(async (record) =>
      normalizeInspection(await inspectPackage(record), record.name),
    ),
  )
  const issues = []
  for (const inspection of inspections) {
    const record = ledger.packages.find(({ name }) => name === inspection.name)
    if (record === undefined) throw new Error(`Unknown reconciliation package: ${inspection.name}`)
    if (record.state === 'attempting' && inspection.status === 'matching') {
      ledger = await appendPublishLedgerEvent(
        ledgerPath,
        expectedRelease,
        {
          type: 'reconciled-matching',
          package: record.name,
          attemptId: record.activeAttemptId,
        },
        options,
      )
      continue
    }
    if (record.state === 'attempting' && inspection.status === 'absent') {
      ledger = await appendPublishLedgerEvent(
        ledgerPath,
        expectedRelease,
        {
          type: 'reconciled-absent',
          package: record.name,
          attemptId: record.activeAttemptId,
        },
        options,
      )
      continue
    }
    const expectedStatus = record.state === 'published' ? 'matching' : 'absent'
    if (inspection.status !== expectedStatus) {
      issues.push(`${record.name}: expected ${expectedStatus}, observed ${inspection.status}`)
    }
  }
  ledger = await loadPublishLedger(ledgerPath, expectedRelease)
  return {
    ledger,
    inspections,
    issues,
    ready: issues.length === 0 && ledger.status !== 'reconcile-required',
  }
}

/** Publish pending packages in manifest order, stopping on the first ambiguous result. */
export async function resumePublishLedger(
  ledgerPath,
  expectedRelease,
  publishPackage,
  options = {},
) {
  let ledger = await loadPublishLedger(ledgerPath, expectedRelease)
  if (ledger.status === 'reconcile-required') {
    throw new Error('Publish ledger contains an ambiguous attempt; run --reconcile before --resume')
  }
  if (ledger.status === 'verified') return ledger
  for (const record of ledger.packages) {
    const current = ledger.packages.find(({ name }) => name === record.name)
    if (current?.state === 'published') continue
    if (current?.state !== 'pending') {
      throw new Error(`${record.name}: cannot resume package from ${String(current?.state)}`)
    }
    const attemptId = (options.id ?? randomUUID)()
    ledger = await appendPublishLedgerEvent(
      ledgerPath,
      expectedRelease,
      {
        type: 'attempt-started',
        package: record.name,
        attemptId,
        authority: options.attemptAuthority,
      },
      options,
    )
    try {
      await publishPackage(record)
    } catch (error) {
      throw new Error(
        `${record.name}: npm publish outcome is ambiguous; the durable ledger requires --reconcile before --resume`,
        { cause: error },
      )
    }
    ledger = await appendPublishLedgerEvent(
      ledgerPath,
      expectedRelease,
      { type: 'publish-confirmed', package: record.name, attemptId },
      options,
    )
  }
  return ledger
}
