import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256 } from '../release/lib.mjs'
import { inspectNpmArtifact, inspectNpmArtifactForTest } from '../release/npm-registry.mjs'
import { recoverRelease, simulateRecoverRelease } from '../release/recover-release.mjs'
import {
  ensureExactAsset,
  publishRelease,
  validateReleaseWorkflowIdentity,
  verifyArtifactManifest,
} from '../release/publish.mjs'
import {
  appendPublishLedgerEvent,
  atomicCreateOnceFile,
  checkpointPublishLedgerPrefix,
  createPublishLedger,
  loadPublishLedger,
  materializePublishLedgerMetadata,
  PUBLISH_LEDGER_HEAD_NAME,
  publishLedgerCommitName,
  preflightPublishLedger,
  reconcilePublishLedger,
  repairPublishLedgerTail,
  resumePublishLedger,
} from '../release/publish-ledger.mjs'
import {
  inspectGithubPublishedRelease,
  simulatePublishedRelease,
  verifyPublishedRelease,
} from '../release/verify-published-release.mjs'

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPOSITORY_ROOT = resolve(TEST_DIR, '..', '..')
const RELEASE_NOTES = '## [1.0.0]\n\nTest release notes.\n'
const RELEASE_AUTHORITY = {
  repository: 'owner/repository',
  repositoryId: '1234',
  repositoryOwnerId: '123',
  workflowPath: '.github/workflows/release.yml',
  ref: 'refs/tags/v1.0.0',
  commitSha: 'a'.repeat(40),
}
const temporaryRoots = []

async function temporaryRoot() {
  const root = await mkdtemp(join(resolve(REPOSITORY_ROOT, 'scripts'), '.m12-publish-test-'))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

function clock() {
  let tick = 0
  return () => `2026-08-30T00:00:${String(tick++).padStart(2, '0')}.000Z`
}

function ids(prefix) {
  let sequence = 0
  return () => `${prefix}-${String(sequence++)}`
}

function attemptAuthority(runId = '5678', runAttempt = '1') {
  return {
    eventName: 'push',
    runId,
    runAttempt,
    runnerEnvironment: 'github-hosted',
    workflowRef: `${RELEASE_AUTHORITY.repository}/${RELEASE_AUTHORITY.workflowPath}@${RELEASE_AUTHORITY.ref}`,
    workflowSha: RELEASE_AUTHORITY.commitSha,
  }
}

function identity(packages = ['dsh-luban-core', 'dsh-luban-sample']) {
  return {
    version: '1.0.0',
    tag: 'v1.0.0',
    manifestSha256: 'f'.repeat(64),
    authority: RELEASE_AUTHORITY,
    packages: packages.map((name, index) => ({
      name,
      version: '1.0.0',
      file: `${String(index)}.tgz`,
      sha256: String(index + 1).repeat(64),
    })),
  }
}

function response(status, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content ?? '')
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (name.toLowerCase() === 'content-length' ? String(body.length) : null),
    },
    arrayBuffer: async () => body,
  }
}

function trustedNpm(record, options) {
  return {
    status: 'matching',
    trusted: true,
    registryTarballSha256: record.sha256,
    provenance: { verified: true, ...options.provenance },
  }
}

function packedManifestTarball(manifest) {
  const payload = Buffer.from(JSON.stringify(manifest))
  const header = Buffer.alloc(512)
  header.write('package/package.json', 0, 'utf8')
  header.write(`${payload.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('0', 156, 'ascii')
  const padding = Buffer.alloc(Math.ceil(payload.length / 512) * 512 - payload.length)
  return gzipSync(Buffer.concat([header, payload, padding, Buffer.alloc(1024)]))
}

async function publishedFixture(packedOverrides = {}) {
  const root = await temporaryRoot()
  const artifacts = join(root, '.release-artifacts')
  await mkdir(artifacts)
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: '1.0.0', private: true })}\n`,
  )
  await mkdir(join(root, 'packages/core'), { recursive: true })
  await writeFile(
    join(root, 'packages/core/package.json'),
    `${JSON.stringify({ name: 'dsh-luban-core', version: '1.0.0' })}\n`,
  )
  const tarball = packedManifestTarball({
    name: 'dsh-luban-core',
    version: '1.0.0',
    ...packedOverrides,
  })
  const releaseManifest = {
    schemaVersion: 1,
    version: '1.0.0',
    tag: 'v1.0.0',
    packages: [
      {
        name: 'dsh-luban-core',
        version: '1.0.0',
        file: 'core.tgz',
        sha256: sha256(tarball),
      },
    ],
  }
  const manifestContent = Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`)
  await writeFile(join(artifacts, 'core.tgz'), tarball)
  await writeFile(join(artifacts, 'RELEASE_NOTES.md'), RELEASE_NOTES)
  await writeFile(join(artifacts, 'release-manifest.json'), manifestContent)
  const releaseIdentity = {
    version: '1.0.0',
    tag: 'v1.0.0',
    manifestSha256: sha256(manifestContent),
    authority: RELEASE_AUTHORITY,
    packages: releaseManifest.packages,
  }
  const ledger = join(artifacts, 'publish-ledger.json')
  const ledgerClock = clock()
  await createPublishLedger(ledger, releaseIdentity, { clock: ledgerClock, id: ids('ledger') })
  await preflightPublishLedger(ledger, releaseIdentity, async () => ({ status: 'absent' }))
  await resumePublishLedger(ledger, releaseIdentity, async () => undefined, {
    attemptAuthority: attemptAuthority(),
    clock: ledgerClock,
    id: ids('attempt'),
  })
  return { artifacts, ledger, releaseIdentity, root }
}

describe('M12 append-only npm publish ledger', () => {
  it('persists partial success and requires exact reconciliation before a safe resume', async () => {
    const root = await temporaryRoot()
    const ledgerPath = join(root, 'publish-ledger.json')
    const release = identity()
    const ledgerClock = clock()
    await createPublishLedger(ledgerPath, release, { clock: ledgerClock, id: ids('ledger') })
    await expect(
      createPublishLedger(ledgerPath, release, { clock: ledgerClock, id: ids('other') }),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    await preflightPublishLedger(ledgerPath, release, async () => ({ status: 'absent' }))

    const publish = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('connection closed after secret-token-value was uploaded'))
    await expect(
      resumePublishLedger(ledgerPath, release, publish, {
        attemptAuthority: attemptAuthority(),
        clock: ledgerClock,
        id: ids('attempt'),
      }),
    ).rejects.toThrow(/ambiguous.*--reconcile/u)
    expect(publish).toHaveBeenCalledTimes(2)
    await expect(
      resumePublishLedger(ledgerPath, release, async () => undefined, {
        attemptAuthority: attemptAuthority(),
        clock: ledgerClock,
      }),
    ).rejects.toThrow(/--reconcile/u)

    const partial = await loadPublishLedger(ledgerPath, release)
    expect(partial).toMatchObject({ status: 'reconcile-required', sequence: 3 })
    expect(partial.packages).toMatchObject([
      { name: 'dsh-luban-core', state: 'published', attempts: 1 },
      { name: 'dsh-luban-sample', state: 'attempting', attempts: 1 },
    ])
    const persisted = [
      await readFile(ledgerPath, 'utf8'),
      ...(await Promise.all(
        (await readdir(partial.eventDirectory)).map((name) =>
          readFile(join(partial.eventDirectory, name), 'utf8'),
        ),
      )),
    ].join('\n')
    expect(persisted).not.toContain('secret-token-value')

    const reconciliation = await reconcilePublishLedger(
      ledgerPath,
      release,
      async ({ name }) => ({
        status: name === 'dsh-luban-core' ? 'matching' : 'absent',
        trusted: name === 'dsh-luban-core',
        registryTarballSha256: name === 'dsh-luban-core' ? release.packages[0].sha256 : undefined,
      }),
      { clock: ledgerClock },
    )
    expect(reconciliation).toMatchObject({ ready: true, ledger: { status: 'ready' } })

    const resumedPublish = vi.fn().mockResolvedValue(undefined)
    const completed = await resumePublishLedger(ledgerPath, release, resumedPublish, {
      attemptAuthority: attemptAuthority('5679'),
      clock: ledgerClock,
      id: ids('resume'),
    })
    expect(resumedPublish).toHaveBeenCalledTimes(1)
    expect(resumedPublish).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'dsh-luban-sample' }),
    )
    expect(completed).toMatchObject({ status: 'published' })
  })

  it('fails closed on registry conflicts and any edited journal event', async () => {
    const root = await temporaryRoot()
    const ledgerPath = join(root, 'publish-ledger.json')
    const release = identity(['dsh-luban-core'])
    const ledgerClock = clock()
    await createPublishLedger(ledgerPath, release, { clock: ledgerClock, id: ids('ledger') })
    await expect(
      preflightPublishLedger(ledgerPath, release, async () => ({ status: 'matching' })),
    ).rejects.toThrow(/cannot prove every version is unused/u)
    await resumePublishLedger(
      ledgerPath,
      release,
      async () => {
        throw new Error('ambiguous')
      },
      {
        attemptAuthority: attemptAuthority(),
        clock: ledgerClock,
        id: ids('attempt'),
      },
    ).catch(() => undefined)
    const conflict = await reconcilePublishLedger(
      ledgerPath,
      release,
      async () => ({ status: 'conflict' }),
      { clock: ledgerClock },
    )
    expect(conflict).toMatchObject({ ready: false })
    expect(conflict.issues[0]).toMatch(/observed conflict/u)

    const view = await loadPublishLedger(ledgerPath, release)
    const [event] = await readdir(view.eventDirectory)
    await writeFile(join(view.eventDirectory, event), '{}\n')
    await expect(loadPublishLedger(ledgerPath, release)).rejects.toThrow(/publish ledger event/u)
  })

  it('never adopts a matching package without its durable attempt or bypasses core-first order', async () => {
    const root = await temporaryRoot()
    const ledgerPath = join(root, 'publish-ledger.json')
    const release = identity()
    const ledgerClock = clock()
    await createPublishLedger(ledgerPath, release, { clock: ledgerClock, id: ids('ledger') })
    const reconciled = await reconcilePublishLedger(
      ledgerPath,
      release,
      async ({ name }) => ({
        status: name === 'dsh-luban-core' ? 'absent' : 'matching',
        trusted: name === 'dsh-luban-sample',
      }),
      { clock: ledgerClock },
    )
    expect(reconciled).toMatchObject({
      ready: false,
      ledger: {
        packages: [
          { name: 'dsh-luban-core', state: 'pending', attempts: 0 },
          { name: 'dsh-luban-sample', state: 'pending' },
        ],
      },
    })
    expect(reconciled.issues).toEqual(['dsh-luban-sample: expected absent, observed matching'])
    expect(reconciled.ledger.sequence).toBe(0)
  })

  it('uses atomic no-replace files and checkpoints attempts before npm side effects', async () => {
    const root = await temporaryRoot()
    const ledgerPath = join(root, 'publish-ledger.json')
    const release = identity(['dsh-luban-core'])
    const temporaryName = '.publish-ledger-tmp-00000000-0000-4000-8000-000000000000'
    await writeFile(join(root, temporaryName), 'truncated temporary bytes')
    const order = []
    const ledgerClock = clock()
    await createPublishLedger(ledgerPath, release, {
      clock: ledgerClock,
      id: ids('ledger'),
      checkpoint: async ({ kind }) => order.push(kind),
    })
    const eventDirectory = `${ledgerPath}.events`
    await mkdir(eventDirectory)
    await writeFile(join(eventDirectory, temporaryName), 'partial event')
    await expect(loadPublishLedger(ledgerPath, release)).resolves.toMatchObject({ sequence: 0 })
    await resumePublishLedger(ledgerPath, release, async () => order.push('npm-publish'), {
      attemptAuthority: attemptAuthority(),
      clock: ledgerClock,
      id: ids('attempt'),
      checkpoint: async ({ type }) => order.push(type),
    })
    expect(order).toEqual(['initial', 'attempt-started', 'npm-publish', 'publish-confirmed'])
    await expect(atomicCreateOnceFile(ledgerPath, 'replacement')).rejects.toMatchObject({
      code: 'EEXIST',
    })
  })

  it('rejects a journal whose trusted head proves a suffix was truncated', async () => {
    const root = await temporaryRoot()
    const ledgerPath = join(root, 'publish-ledger.json')
    const release = identity(['dsh-luban-core'])
    const ledgerClock = clock()
    await createPublishLedger(ledgerPath, release, { clock: ledgerClock, id: ids('ledger') })
    const completed = await resumePublishLedger(ledgerPath, release, async () => undefined, {
      attemptAuthority: attemptAuthority(),
      clock: ledgerClock,
      id: ids('attempt'),
    })
    await unlink(completed.journal.events.at(-1).path)
    await expect(loadPublishLedger(ledgerPath, release)).rejects.toThrow(
      /commits do not cover the complete journal/u,
    )
  })

  it('rejects verification events that do not match the immutable release authority', async () => {
    const root = await temporaryRoot()
    const ledgerPath = join(root, 'publish-ledger.json')
    const release = identity(['dsh-luban-core'])
    const ledgerClock = clock()
    await createPublishLedger(ledgerPath, release, { clock: ledgerClock, id: ids('ledger') })
    await resumePublishLedger(ledgerPath, release, async () => undefined, {
      attemptAuthority: attemptAuthority(),
      clock: ledgerClock,
      id: ids('attempt'),
    })
    await expect(
      appendPublishLedgerEvent(
        ledgerPath,
        release,
        {
          type: 'release-verified',
          repository: 'other/repository',
          expectedCommitSha: RELEASE_AUTHORITY.commitSha,
          githubReleaseId: 42,
        },
        { clock: ledgerClock },
      ),
    ).rejects.toThrow(/immutable release authority/u)
    await expect(loadPublishLedger(ledgerPath, release)).rejects.toThrow(
      /immutable release authority/u,
    )
  })

  it('checkpoints reconciliation and subsequent resume without a remote sequence gap', async () => {
    const root = await temporaryRoot()
    const ledgerPath = join(root, 'publish-ledger.json')
    const release = identity(['dsh-luban-core'])
    const ledgerClock = clock()
    const checkpoints = []
    const checkpoint = async ({ kind, name, sequence, head }) => {
      checkpoints.push({ kind, name, sequence, headSequence: head.value.sequence })
    }
    await createPublishLedger(ledgerPath, release, {
      checkpoint,
      clock: ledgerClock,
      id: ids('ledger'),
    })
    await expect(
      resumePublishLedger(
        ledgerPath,
        release,
        async () => {
          throw new Error('ambiguous')
        },
        {
          attemptAuthority: attemptAuthority(),
          checkpoint,
          clock: ledgerClock,
          id: ids('attempt'),
        },
      ),
    ).rejects.toThrow(/--reconcile/u)
    await reconcilePublishLedger(ledgerPath, release, async () => ({ status: 'absent' }), {
      checkpoint,
      clock: ledgerClock,
    })
    await resumePublishLedger(ledgerPath, release, async () => undefined, {
      attemptAuthority: attemptAuthority('5679'),
      checkpoint,
      clock: ledgerClock,
      id: ids('resume'),
    })
    expect(checkpoints).toEqual([
      {
        kind: 'initial',
        name: 'publish-ledger.json',
        sequence: 0,
        headSequence: 0,
      },
      { kind: 'event', name: '00000001.json', sequence: 1, headSequence: 1 },
      { kind: 'event', name: '00000002.json', sequence: 2, headSequence: 2 },
      { kind: 'event', name: '00000003.json', sequence: 3, headSequence: 3 },
      { kind: 'event', name: '00000004.json', sequence: 4, headSequence: 4 },
    ])
  })

  it('allows only one concurrent runner to acquire a fixed-name remote attempt checkpoint', async () => {
    const root = await temporaryRoot()
    const seedPath = join(root, 'seed', 'publish-ledger.json')
    const release = identity(['dsh-luban-core'])
    await mkdir(join(root, 'seed'))
    const seeded = await createPublishLedger(seedPath, release, {
      clock: clock(),
      id: () => 'shared-ledger',
    })
    const runnerPaths = [join(root, 'runner-a'), join(root, 'runner-b')].map((directory) =>
      join(directory, 'publish-ledger.json'),
    )
    for (const ledgerPath of runnerPaths) {
      await mkdir(resolve(ledgerPath, '..'), { recursive: true })
      await writeFile(ledgerPath, seeded.journal.initial.content)
      await mkdir(`${ledgerPath}.commits`)
      await writeFile(
        join(`${ledgerPath}.commits`, seeded.journal.commits[0].name),
        seeded.journal.commits[0].content,
      )
      await writeFile(
        join(resolve(ledgerPath, '..'), PUBLISH_LEDGER_HEAD_NAME),
        seeded.journal.head.content,
      )
    }
    const remoteAssets = new Map([
      ['publish-ledger.json', seeded.journal.initial.content],
      [seeded.journal.commits[0].name, seeded.journal.commits[0].content],
    ])
    const createOnceAdapter = {
      read: async (name) => remoteAssets.get(name) ?? null,
      create: async (name, content) => {
        if (remoteAssets.has(name)) throw new Error(`${name}: already exists`)
        remoteAssets.set(name, content)
      },
    }
    const checkpoint = async ({ name, content, commit }) => {
      await ensureExactAsset(name, content, createOnceAdapter)
      await ensureExactAsset(commit.name, commit.content, createOnceAdapter)
    }
    const npmPublish = vi.fn().mockResolvedValue(undefined)
    const outcomes = await Promise.allSettled(
      runnerPaths.map((ledgerPath, index) =>
        resumePublishLedger(ledgerPath, release, npmPublish, {
          attemptAuthority: attemptAuthority(String(5678 + index)),
          checkpoint,
          clock: clock(),
          id: () => `runner-${String(index)}`,
        }),
      ),
    )
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(npmPublish).toHaveBeenCalledTimes(1)
    expect(new Set(remoteAssets.keys())).toEqual(
      new Set([
        'publish-ledger.json',
        publishLedgerCommitName(0),
        '00000001.json',
        publishLedgerCommitName(1),
        '00000002.json',
        publishLedgerCommitName(2),
      ]),
    )
  })

  it('repairs exactly one local crash tail without skipping the next sequence', async () => {
    const root = await temporaryRoot()
    const ledgerPath = join(root, 'publish-ledger.json')
    const release = identity(['dsh-luban-core'])
    const ledgerClock = clock()
    const initial = await createPublishLedger(ledgerPath, release, {
      clock: ledgerClock,
      id: ids('ledger'),
    })
    await resumePublishLedger(
      ledgerPath,
      release,
      async () => {
        throw new Error('crash after the durable attempt')
      },
      {
        attemptAuthority: attemptAuthority(),
        clock: ledgerClock,
        id: ids('attempt'),
      },
    ).catch(() => undefined)
    const crashed = await loadPublishLedger(ledgerPath, release)
    await unlink(crashed.journal.commits.at(-1).path)
    await writeFile(join(root, PUBLISH_LEDGER_HEAD_NAME), initial.journal.head.content)

    const repaired = await repairPublishLedgerTail(ledgerPath, release)
    expect(repaired).toMatchObject({ sequence: 1, status: 'reconcile-required' })
    expect(repaired.journal.commits.map(({ sequence }) => sequence)).toEqual([0, 1])
    expect(repaired.journal.head.sequence).toBe(1)

    const remotePrefix = []
    await checkpointPublishLedgerPrefix(ledgerPath, release, async ({ sequence, commit }) => {
      remotePrefix.push([sequence, commit.sequence])
    })
    await reconcilePublishLedger(ledgerPath, release, async () => ({ status: 'absent' }), {
      clock: ledgerClock,
    })
    await checkpointPublishLedgerPrefix(ledgerPath, release, async () => undefined)
    const publish = vi.fn().mockResolvedValue(undefined)
    const completed = await resumePublishLedger(ledgerPath, release, publish, {
      attemptAuthority: attemptAuthority('5679'),
      clock: ledgerClock,
      id: ids('retry'),
    })
    expect(remotePrefix).toEqual([
      [0, 0],
      [1, 1],
    ])
    expect(publish).toHaveBeenCalledTimes(1)
    expect(completed.journal.events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4])

    await unlink(completed.journal.head.path)
    const missingHeadRepaired = await repairPublishLedgerTail(ledgerPath, release)
    expect(missingHeadRepaired).toMatchObject({ sequence: 4, status: 'published' })
    expect(missingHeadRepaired.journal.head.sequence).toBe(4)
  })

  it('recovers an ambiguous published result without a duplicate npm side effect', async () => {
    const root = await temporaryRoot()
    const sourcePath = join(root, 'source', 'publish-ledger.json')
    const recoveredPath = join(root, 'recovered', 'publish-ledger.json')
    const release = identity(['dsh-luban-core'])
    const ledgerClock = clock()
    await mkdir(resolve(sourcePath, '..'), { recursive: true })
    await createPublishLedger(sourcePath, release, { clock: ledgerClock, id: ids('ledger') })
    const npmSideEffect = vi.fn(async () => {
      throw new Error('runner died after npm accepted the tarball')
    })
    await resumePublishLedger(sourcePath, release, npmSideEffect, {
      attemptAuthority: attemptAuthority(),
      clock: ledgerClock,
      id: ids('attempt'),
    }).catch(() => undefined)
    const source = await loadPublishLedger(sourcePath, release)

    await mkdir(resolve(recoveredPath, '..'), { recursive: true })
    await writeFile(recoveredPath, source.journal.initial.content)
    await mkdir(`${recoveredPath}.events`)
    for (const event of source.journal.events) {
      await writeFile(join(`${recoveredPath}.events`, event.name), event.content)
    }
    await materializePublishLedgerMetadata(recoveredPath, release)
    const reconciliation = await reconcilePublishLedger(
      recoveredPath,
      release,
      async () => ({ status: 'matching', trusted: true }),
      { clock: ledgerClock },
    )
    expect(reconciliation.ledger.status).toBe('published')

    const duplicatePublish = vi.fn().mockResolvedValue(undefined)
    await resumePublishLedger(recoveredPath, release, duplicatePublish, {
      attemptAuthority: attemptAuthority('5679'),
      clock: ledgerClock,
      id: ids('retry'),
    })
    expect(npmSideEffect).toHaveBeenCalledTimes(1)
    expect(duplicatePublish).not.toHaveBeenCalled()
  })

  it('retains each package publishing attempt authority across a later workflow retry', async () => {
    const root = await temporaryRoot()
    const ledgerPath = join(root, 'publish-ledger.json')
    const release = identity()
    const ledgerClock = clock()
    const firstAuthority = attemptAuthority('5678', '1')
    const secondAuthority = attemptAuthority('9000', '2')
    await createPublishLedger(ledgerPath, release, { clock: ledgerClock, id: ids('ledger') })
    const firstPublish = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('ambiguous second package'))
    await resumePublishLedger(ledgerPath, release, firstPublish, {
      attemptAuthority: firstAuthority,
      clock: ledgerClock,
      id: ids('first'),
    }).catch(() => undefined)
    await reconcilePublishLedger(
      ledgerPath,
      release,
      async ({ name }) =>
        name === 'dsh-luban-core' ? { status: 'matching', trusted: true } : { status: 'absent' },
      { clock: ledgerClock },
    )
    await resumePublishLedger(ledgerPath, release, async () => undefined, {
      attemptAuthority: secondAuthority,
      clock: ledgerClock,
      id: ids('second'),
    })
    const completed = await loadPublishLedger(ledgerPath, release)
    expect(completed.packages).toMatchObject([
      { name: 'dsh-luban-core', publishAuthority: firstAuthority },
      { name: 'dsh-luban-sample', publishAuthority: secondAuthority },
    ])
  })
})

describe('M12 read-only registry and three-way verification', () => {
  it('makes create-once remote assets idempotent only for byte-identical retries', async () => {
    const assets = new Map()
    const creates = vi.fn(async (name, content) => {
      if (assets.has(name)) throw new Error('already exists')
      assets.set(name, Buffer.from(content))
    })
    const adapter = {
      read: async (name) => assets.get(name) ?? null,
      create: creates,
    }
    const content = Buffer.from('immutable journal bytes')
    await expect(ensureExactAsset('00000001.json', content, adapter)).resolves.toMatchObject({
      created: true,
    })
    await expect(ensureExactAsset('00000001.json', content, adapter)).resolves.toMatchObject({
      created: false,
    })
    expect(creates).toHaveBeenCalledTimes(1)

    assets.set('00000001.json', Buffer.from('forked journal bytes'))
    await expect(ensureExactAsset('00000001.json', content, adapter)).rejects.toThrow(/fork/u)

    let raced = false
    const racingAdapter = {
      read: async () => (raced ? content : null),
      create: async () => {
        raced = true
        throw new Error('another runner created it first')
      },
    }
    await expect(ensureExactAsset('00000002.json', content, racingAdapter)).resolves.toMatchObject({
      created: false,
    })
  })

  it('distinguishes absent, byte-identical, conflicting, and unknown npm versions', async () => {
    const root = await temporaryRoot()
    const artifact = Buffer.from('immutable package bytes')
    await writeFile(join(root, 'package.tgz'), artifact)
    const record = {
      name: '@scope/example',
      version: '1.0.0',
      file: 'package.tgz',
      sha256: sha256(artifact),
    }
    const metadata = JSON.stringify({
      name: record.name,
      version: record.version,
      dist: { tarball: 'https://registry.npmjs.org/@scope/example/-/example-1.0.0.tgz' },
    })

    await expect(
      inspectNpmArtifactForTest(record, {
        artifacts: root,
        fetcher: async () => response(404),
      }),
    ).resolves.toMatchObject({ status: 'absent', simulated: true, trusted: false })

    const urls = []
    await expect(
      inspectNpmArtifactForTest(record, {
        artifacts: root,
        fetcher: async (url) => {
          urls.push(url)
          return urls.length === 1 ? response(200, metadata) : response(200, artifact)
        },
      }),
    ).resolves.toMatchObject({
      status: 'matching',
      trusted: false,
      simulated: true,
      registryTarballSha256: sha256(artifact),
    })
    expect(urls[0]).toBe('https://registry.npmjs.org/%40scope%2Fexample/1.0.0')

    let request = 0
    await expect(
      inspectNpmArtifactForTest(record, {
        artifacts: root,
        fetcher: async () =>
          request++ === 0 ? response(200, metadata) : response(200, 'different package bytes'),
      }),
    ).resolves.toMatchObject({ status: 'conflict' })
    await expect(
      inspectNpmArtifactForTest(record, {
        artifacts: root,
        fetcher: async () => {
          throw new Error('offline')
        },
      }),
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'metadata-request-failed',
      simulated: true,
      trusted: false,
    })
  })

  it('rejects test adapters at every production entry point', async () => {
    const adapter = async () => ({ status: 'absent' })
    await expect(
      inspectNpmArtifact(
        { name: 'example', version: '1.0.0', file: 'example.tgz', sha256: 'a'.repeat(64) },
        { artifacts: '.', fetcher: adapter },
      ),
    ).rejects.toThrow(/does not accept injected adapters/u)
    await expect(publishRelease({ fetcher: adapter })).rejects.toThrow(
      /does not accept injected adapters/u,
    )
    await expect(recoverRelease({ inspectGithub: adapter })).rejects.toThrow(
      /does not accept injected adapters/u,
    )
    await expect(verifyPublishedRelease({ inspectNpm: adapter })).rejects.toThrow(
      /does not accept injected adapters/u,
    )
  })

  it('binds publish authority to one tag-push workflow run identity', () => {
    const sha = 'a'.repeat(40)
    const environment = {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/tags/v1.0.0',
      GITHUB_REF_NAME: 'v1.0.0',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REPOSITORY: 'owner/repository',
      GITHUB_REPOSITORY_ID: '1234',
      GITHUB_REPOSITORY_OWNER_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_RUN_ID: '5678',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_SHA: sha,
      GITHUB_WORKFLOW_REF: 'owner/repository/.github/workflows/release.yml@refs/tags/v1.0.0',
      GITHUB_WORKFLOW_SHA: sha,
      GH_TOKEN: 'github-token',
      LUBAN_RELEASE_APPROVED: 'true',
      NODE_AUTH_TOKEN: 'npm-token',
      RUNNER_ENVIRONMENT: 'github-hosted',
    }
    expect(validateReleaseWorkflowIdentity(environment, '1.0.0')).toMatchObject({
      eventName: 'push',
      expectedRef: 'refs/tags/v1.0.0',
      expectedSha: sha,
      repository: 'owner/repository',
      runAttempt: '2',
      runId: '5678',
    })
    expect(() =>
      validateReleaseWorkflowIdentity(
        { ...environment, GITHUB_WORKFLOW_REF: 'owner/repository/other.yml@refs/tags/v1.0.0' },
        '1.0.0',
      ),
    ).toThrow(/workflow identity/u)
    expect(() =>
      validateReleaseWorkflowIdentity({ ...environment, GITHUB_RUN_ID: '' }, '1.0.0'),
    ).toThrow(/GITHUB_RUN_ID/u)
    expect(() =>
      validateReleaseWorkflowIdentity(
        { ...environment, GITHUB_EVENT_NAME: 'workflow_dispatch' },
        '1.0.0',
      ),
    ).toThrow(/tag push event/u)
  })

  it('rejects packed publishConfig registry drift before publishing', async () => {
    const fixture = await publishedFixture({
      publishConfig: { access: 'public', registry: 'https://packages.example.invalid/' },
    })
    await expect(
      verifyArtifactManifest(fixture.root, fixture.artifacts, ['dsh-luban-core']),
    ).rejects.toThrow(/publishConfig.*registry/u)
  })

  it('requires a cryptographically verified SLSA statement bound to this tag workflow', async () => {
    const root = await temporaryRoot()
    const artifact = Buffer.from('provenance-bound tarball')
    await writeFile(join(root, 'package.tgz'), artifact)
    const record = {
      name: '@scope/example',
      version: '1.0.0',
      file: 'package.tgz',
      sha256: sha256(artifact),
    }
    const provenance = {
      ...RELEASE_AUTHORITY,
      ...attemptAuthority('5678', '2'),
    }
    const attestationsUrl = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(`${record.name}@${record.version}`)}`
    const metadata = {
      name: record.name,
      version: record.version,
      dist: {
        tarball: 'https://registry.npmjs.org/@scope/example/-/example-1.0.0.tgz',
        attestations: {
          url: attestationsUrl,
          provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
        },
      },
    }
    const statement = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: 'pkg:npm/%40scope/example@1.0.0',
          digest: { sha512: createHash('sha512').update(artifact).digest('hex') },
        },
      ],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
          externalParameters: {
            workflow: {
              repository: 'https://github.com/owner/repository',
              path: '.github/workflows/release.yml',
              ref: 'refs/tags/v1.0.0',
            },
          },
          internalParameters: {
            github: {
              event_name: 'push',
              repository_id: '1234',
              repository_owner_id: '123',
            },
          },
          resolvedDependencies: [
            {
              uri: 'git+https://github.com/owner/repository@refs/tags/v1.0.0',
              digest: { gitCommit: 'a'.repeat(40) },
            },
          ],
        },
        runDetails: {
          builder: { id: 'https://github.com/actions/runner/github-hosted' },
          metadata: {
            invocationId: 'https://github.com/owner/repository/actions/runs/5678/attempts/2',
          },
        },
      },
    }
    const attestations = {
      attestations: [
        {
          predicateType: 'https://slsa.dev/provenance/v1',
          bundle: {
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
              signatures: [{ sig: 'signed' }],
            },
          },
        },
      ],
    }
    let verifiedBundle
    let verificationOptions
    const inspect = (expectedProvenance = provenance) => {
      const replies = [
        response(200, JSON.stringify(metadata)),
        response(200, artifact),
        response(200, JSON.stringify(attestations)),
      ]
      return inspectNpmArtifactForTest(record, {
        artifacts: root,
        provenance: expectedProvenance,
        verifyBundle: async (bundle, options) => {
          verifiedBundle = bundle
          verificationOptions = options
          return true
        },
        fetcher: async () => replies.shift(),
      })
    }
    await expect(inspect()).resolves.toMatchObject({
      status: 'matching',
      trusted: false,
      wouldTrust: true,
      simulated: true,
      provenance,
    })
    expect(verifiedBundle).toEqual(attestations.attestations[0].bundle)
    expect(verificationOptions).toMatchObject({ provenance })
    await expect(inspect({ ...provenance, commitSha: 'b'.repeat(40) })).resolves.toMatchObject({
      status: 'conflict',
      reason: 'provenance-expectation',
    })
    const wrongAttempt = JSON.parse(JSON.stringify(statement))
    wrongAttempt.predicate.runDetails.metadata.invocationId =
      'https://github.com/owner/repository/actions/runs/9999/attempts/2'
    attestations.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(wrongAttempt),
    ).toString('base64')
    await expect(inspect()).resolves.toMatchObject({
      status: 'conflict',
      reason: 'provenance-binding',
    })
    const mismatchedStatement = JSON.parse(JSON.stringify(statement))
    mismatchedStatement.subject[0].name = 'pkg:npm/other-package@1.0.0'
    mismatchedStatement.predicate.buildDefinition.internalParameters.github.event_name =
      'workflow_dispatch'
    attestations.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(mismatchedStatement),
    ).toString('base64')
    await expect(inspect()).resolves.toMatchObject({
      status: 'conflict',
      reason: 'provenance-binding',
    })
  })

  it('binds the workflow SHA, public GitHub assets, and exact npm tarballs before verification', async () => {
    const fixture = await publishedFixture()
    const expectedSha = 'a'.repeat(40)
    const github = async ({ repository, tag, assets }) => ({
      repository,
      tag,
      title: tag,
      body: RELEASE_NOTES,
      tagCommitSha: expectedSha,
      releaseId: 42,
      draft: false,
      prerelease: false,
      assets: assets.map(({ name, sha256: digest, content }) => ({
        name,
        sha256: digest,
        size: content.length,
      })),
    })
    const npm = async (record, options) => trustedNpm(record, options)

    await expect(
      simulatePublishedRelease(
        {
          root: fixture.root,
          artifacts: fixture.artifacts,
          ledger: fixture.ledger,
          repository: 'owner/repository',
          repositoryId: '1234',
          repositoryOwnerId: '123',
          expectedSha: 'b'.repeat(40),
        },
        { inspectGithub: github, inspectNpm: npm },
      ),
    ).rejects.toThrow(/immutable release artifacts/u)
    await expect(loadPublishLedger(fixture.ledger, fixture.releaseIdentity)).resolves.toMatchObject(
      {
        status: 'published',
      },
    )

    const result = await simulatePublishedRelease(
      {
        root: fixture.root,
        artifacts: fixture.artifacts,
        ledger: fixture.ledger,
        repository: 'owner/repository',
        repositoryId: '1234',
        repositoryOwnerId: '123',
        expectedSha,
      },
      { inspectGithub: github, inspectNpm: npm },
    )
    expect(result).toMatchObject({
      passed: false,
      wouldPass: true,
      simulated: true,
      tag: 'v1.0.0',
      expectedSha,
      githubReleaseId: 42,
      status: 'published',
    })
    await expect(loadPublishLedger(fixture.ledger, fixture.releaseIdentity)).resolves.toMatchObject(
      {
        status: 'published',
        verification: null,
      },
    )
  })

  it('resolves annotated GitHub tags and hashes the expected public Release assets', async () => {
    const expectedSha = 'a'.repeat(40)
    const tagObjectSha = 'b'.repeat(40)
    const manifest = Buffer.from('manifest bytes')
    const tarball = Buffer.from('tarball bytes')
    const replies = [
      response(200, JSON.stringify({ object: { type: 'tag', sha: tagObjectSha } })),
      response(200, JSON.stringify({ object: { type: 'commit', sha: expectedSha } })),
      response(
        200,
        JSON.stringify({
          id: 42,
          tag_name: 'v1.0.0',
          name: 'v1.0.0',
          body: RELEASE_NOTES,
          draft: false,
          prerelease: false,
        }),
      ),
      response(
        200,
        JSON.stringify([
          {
            id: 1,
            name: 'release-manifest.json',
            size: manifest.length,
            url: 'https://api.github.com/repos/owner/repository/releases/assets/1',
          },
          {
            id: 2,
            name: 'core.tgz',
            size: tarball.length,
            url: 'https://api.github.com/repos/owner/repository/releases/assets/2',
          },
        ]),
      ),
      response(200, manifest),
      response(200, tarball),
    ]
    const requests = []
    const result = await inspectGithubPublishedRelease(
      {
        repository: 'owner/repository',
        tag: 'v1.0.0',
        assets: [
          { name: 'release-manifest.json', content: manifest },
          { name: 'core.tgz', content: tarball },
        ],
      },
      {
        fetcher: async (url, options) => {
          requests.push({ url, options })
          const reply = replies.shift()
          if (reply === undefined) throw new Error('unexpected request')
          return reply
        },
      },
    )
    expect(result).toMatchObject({
      tag: 'v1.0.0',
      title: 'v1.0.0',
      body: RELEASE_NOTES,
      tagCommitSha: expectedSha,
      releaseId: 42,
      draft: false,
      assets: [
        { name: 'release-manifest.json', sha256: sha256(manifest), size: manifest.length },
        { name: 'core.tgz', sha256: sha256(tarball), size: tarball.length },
      ],
    })
    expect(requests).toHaveLength(6)
    expect(requests[4].options.headers.accept).toBe('application/octet-stream')
  })

  it('rejects non-public metadata, changed or extra assets, and conflicting npm bytes', async () => {
    const fixture = await publishedFixture()
    const expectedSha = 'a'.repeat(40)
    const baseGithub = async ({ repository, tag, assets }) => ({
      repository,
      tag,
      title: tag,
      body: RELEASE_NOTES,
      tagCommitSha: expectedSha,
      releaseId: 42,
      draft: false,
      prerelease: false,
      assets: assets.map(({ name, sha256: digest, content }) => ({
        name,
        sha256: digest,
        size: content.length,
      })),
    })
    const options = {
      root: fixture.root,
      artifacts: fixture.artifacts,
      ledger: fixture.ledger,
      repository: 'owner/repository',
      repositoryId: '1234',
      repositoryOwnerId: '123',
      expectedSha,
    }
    const inspectNpm = async (record, inspectionOptions) => trustedNpm(record, inspectionOptions)

    await expect(
      simulatePublishedRelease(options, {
        inspectGithub: async (input) => ({ ...(await baseGithub(input)), draft: true }),
        inspectNpm,
      }),
    ).rejects.toThrow(/still a draft/u)
    await expect(
      simulatePublishedRelease(options, {
        inspectGithub: async (input) => ({ ...(await baseGithub(input)), prerelease: true }),
        inspectNpm,
      }),
    ).rejects.toThrow(/prerelease/u)
    await expect(
      simulatePublishedRelease(options, {
        inspectGithub: async (input) => ({ ...(await baseGithub(input)), title: 'other' }),
        inspectNpm,
      }),
    ).rejects.toThrow(/title or body/u)
    await expect(
      simulatePublishedRelease(options, {
        inspectGithub: async (input) => ({ ...(await baseGithub(input)), body: 'changed' }),
        inspectNpm,
      }),
    ).rejects.toThrow(/title or body/u)
    await expect(
      simulatePublishedRelease(options, {
        inspectGithub: async (input) => {
          const result = await baseGithub(input)
          result.assets[0].sha256 = '0'.repeat(64)
          return result
        },
        inspectNpm,
      }),
    ).rejects.toThrow(/does not match/u)
    await expect(
      simulatePublishedRelease(options, {
        inspectGithub: async (input) => {
          const result = await baseGithub(input)
          result.assets.push({ name: 'unexpected.txt', sha256: '0'.repeat(64), size: 1 })
          return result
        },
        inspectNpm,
      }),
    ).rejects.toThrow(/exact expected asset set/u)
    await expect(
      simulatePublishedRelease(options, {
        inspectGithub: baseGithub,
        inspectNpm: async () => ({ status: 'conflict' }),
      }),
    ).rejects.toThrow(/npm tarball does not match/u)
  })

  it('restores a remote journal for draft resume and public post-verification reruns', async () => {
    const fixture = await publishedFixture()
    const expectedSha = 'a'.repeat(40)
    const view = await loadPublishLedger(fixture.ledger, fixture.releaseIdentity)
    const remoteAssets = [
      {
        name: 'release-manifest.json',
        content: await readFile(join(fixture.artifacts, 'release-manifest.json')),
      },
      { name: 'core.tgz', content: await readFile(join(fixture.artifacts, 'core.tgz')) },
      { name: 'publish-ledger.json', content: view.journal.initial.content },
      ...view.journal.events.map(({ name, content }) => ({ name, content })),
      ...view.journal.commits.map(({ name, content }) => ({ name, content })),
    ]
    await rm(view.eventDirectory, { recursive: true })
    await rm(fixture.ledger)
    const inspectGithub = (draft) => async () => ({
      tagCommitSha: expectedSha,
      release: {
        id: 42,
        tag: 'v1.0.0',
        title: 'v1.0.0',
        body: RELEASE_NOTES,
        draft,
        prerelease: false,
        assets: remoteAssets,
      },
    })

    await expect(
      simulateRecoverRelease(
        {
          root: fixture.root,
          artifacts: fixture.artifacts,
          repository: 'owner/repository',
          repositoryId: '1234',
          repositoryOwnerId: '123',
          expectedSha,
        },
        { inspectGithub: inspectGithub(true) },
      ),
    ).resolves.toMatchObject({
      mode: 'resume',
      draft: true,
      ledger: 'published',
      simulated: true,
    })
    await expect(
      simulateRecoverRelease(
        {
          root: fixture.root,
          artifacts: fixture.artifacts,
          repository: 'owner/repository',
          repositoryId: '1234',
          repositoryOwnerId: '123',
          expectedSha,
        },
        { inspectGithub: inspectGithub(false) },
      ),
    ).resolves.toMatchObject({
      mode: 'verify',
      draft: false,
      ledger: 'published',
      simulated: true,
    })

    const truncatedAssets = remoteAssets.filter(
      ({ name }) => name !== view.journal.events.at(-1).name,
    )
    await expect(
      simulateRecoverRelease(
        {
          root: fixture.root,
          artifacts: fixture.artifacts,
          repository: 'owner/repository',
          repositoryId: '1234',
          repositoryOwnerId: '123',
          expectedSha,
        },
        {
          inspectGithub: async () => ({
            tagCommitSha: expectedSha,
            release: {
              id: 42,
              tag: 'v1.0.0',
              title: 'v1.0.0',
              body: RELEASE_NOTES,
              draft: true,
              prerelease: false,
              assets: truncatedAssets,
            },
          }),
        },
      ),
    ).rejects.toThrow(/impossible commit|gap or fork/u)

    const tamperedAssets = remoteAssets.map((asset) =>
      asset.name === 'core.tgz' ? { ...asset, content: Buffer.from('tampered') } : asset,
    )
    await expect(
      simulateRecoverRelease(
        {
          root: fixture.root,
          artifacts: fixture.artifacts,
          repository: 'owner/repository',
          repositoryId: '1234',
          repositoryOwnerId: '123',
          expectedSha,
        },
        {
          inspectGithub: async () => ({
            tagCommitSha: expectedSha,
            release: {
              id: 42,
              tag: 'v1.0.0',
              title: 'v1.0.0',
              body: RELEASE_NOTES,
              draft: true,
              prerelease: false,
              assets: tamperedAssets,
            },
          }),
        },
      ),
    ).rejects.toThrow(/not immutable/u)
  })

  it('recovers only a single provable remote orphan tail and rejects gaps or forks', async () => {
    const fixture = await publishedFixture()
    const view = await loadPublishLedger(fixture.ledger, fixture.releaseIdentity)
    const expectedSha = RELEASE_AUTHORITY.commitSha
    const immutable = [
      {
        name: 'release-manifest.json',
        content: await readFile(join(fixture.artifacts, 'release-manifest.json')),
      },
      { name: 'core.tgz', content: await readFile(join(fixture.artifacts, 'core.tgz')) },
    ]
    const options = {
      root: fixture.root,
      artifacts: fixture.artifacts,
      repository: RELEASE_AUTHORITY.repository,
      repositoryId: RELEASE_AUTHORITY.repositoryId,
      repositoryOwnerId: RELEASE_AUTHORITY.repositoryOwnerId,
      expectedSha,
    }
    const inspectGithub =
      (assets, draft = true) =>
      async () => ({
        tagCommitSha: expectedSha,
        release: {
          id: 42,
          tag: 'v1.0.0',
          title: 'v1.0.0',
          body: RELEASE_NOTES,
          draft,
          prerelease: false,
          assets: [...immutable, ...assets],
        },
      })

    await expect(
      simulateRecoverRelease(options, {
        inspectGithub: inspectGithub([
          { name: 'publish-ledger.json', content: view.journal.initial.content },
        ]),
      }),
    ).resolves.toMatchObject({
      mode: 'resume',
      ledger: 'ready',
      orphanSequence: 0,
    })

    const eventTail = [
      { name: 'publish-ledger.json', content: view.journal.initial.content },
      {
        name: view.journal.events[0].name,
        content: view.journal.events[0].content,
      },
      {
        name: view.journal.commits[0].name,
        content: view.journal.commits[0].content,
      },
    ]
    await expect(
      simulateRecoverRelease(options, { inspectGithub: inspectGithub(eventTail) }),
    ).resolves.toMatchObject({
      mode: 'resume',
      ledger: 'reconcile-required',
      orphanSequence: 1,
    })
    await expect(
      simulateRecoverRelease(options, { inspectGithub: inspectGithub(eventTail, false) }),
    ).rejects.toThrow(/fully published remote ledger/u)

    const forkedCommit = eventTail.map((asset) =>
      asset.name === publishLedgerCommitName(0)
        ? { ...asset, content: Buffer.from('different commit bytes') }
        : asset,
    )
    await expect(
      simulateRecoverRelease(options, { inspectGithub: inspectGithub(forkedCommit) }),
    ).rejects.toThrow(/commit is a fork/u)

    const missingMiddle = [
      { name: 'publish-ledger.json', content: view.journal.initial.content },
      {
        name: view.journal.events[1].name,
        content: view.journal.events[1].content,
      },
      ...view.journal.commits.map(({ name, content }) => ({ name, content })),
    ]
    await expect(
      simulateRecoverRelease(options, { inspectGithub: inspectGithub(missingMiddle) }),
    ).rejects.toThrow(/event sequence has a gap or fork/u)

    const missingMiddleCommit = [
      { name: 'publish-ledger.json', content: view.journal.initial.content },
      ...view.journal.events.map(({ name, content }) => ({ name, content })),
      {
        name: view.journal.commits[0].name,
        content: view.journal.commits[0].content,
      },
      {
        name: view.journal.commits[2].name,
        content: view.journal.commits[2].content,
      },
    ]
    await expect(
      simulateRecoverRelease(options, { inspectGithub: inspectGithub(missingMiddleCommit) }),
    ).rejects.toThrow(/commit sequence has a gap or fork/u)

    const multipleOrphans = [
      { name: 'publish-ledger.json', content: view.journal.initial.content },
      ...view.journal.events.map(({ name, content }) => ({ name, content })),
    ]
    await expect(
      simulateRecoverRelease(options, { inspectGithub: inspectGithub(multipleOrphans) }),
    ).rejects.toThrow(/more than one orphan tail/u)
  })

  it('wires recovery, conditional resume, public verification, and final archival', async () => {
    const workflow = await readFile(join(REPOSITORY_ROOT, '.github/workflows/release.yml'), 'utf8')
    const recovery = workflow.indexOf('node scripts/release/recover-release.mjs')
    const draft = workflow.indexOf('gh release create "${GITHUB_REF_NAME}"')
    const publish = workflow.indexOf('node scripts/release/publish.mjs "${PUBLISH_ACTION}"')
    const publicRelease = workflow.indexOf('gh release edit "${GITHUB_REF_NAME}" --draft=false')
    const verify = workflow.indexOf('node scripts/release/verify-published-release.mjs')
    const preserve = workflow.indexOf('Preserve the append-only npm publish ledger')
    expect(recovery).toBeGreaterThan(0)
    expect(draft).toBeGreaterThan(recovery)
    expect(publish).toBeGreaterThan(draft)
    expect(publicRelease).toBeGreaterThan(publish)
    expect(verify).toBeGreaterThan(publicRelease)
    expect(preserve).toBeGreaterThan(verify)
    expect(workflow).toContain("steps.recovery.outputs.mode == 'resume'")
    expect(workflow).toContain("steps.recovery.outputs.mode != 'verify'")
    expect(workflow.slice(preserve)).toContain('if: always()')
    expect(workflow.slice(preserve)).toContain('publish-ledger.json.events/')
    expect(workflow.slice(preserve)).toContain('publish-ledger.json.commits/')
    expect(workflow.slice(preserve)).toContain('publish-ledger-head.json')
    expect(workflow).toContain(
      'group: release-publish-${{ github.repository_id }}-${{ github.ref_name }}',
    )
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain('--notes-file .release-artifacts/RELEASE_NOTES.md')

    const publisher = await readFile(join(REPOSITORY_ROOT, 'scripts/release/publish.mjs'), 'utf8')
    expect(publisher).toContain("const NPM_REGISTRY = 'https://registry.npmjs.org/'")
    expect(publisher).toContain('`--registry=${NPM_REGISTRY}`')
    expect(publisher).toContain('`--userconfig=${userConfig}`')
    expect(publisher).toContain("'--ignore-scripts'")
    expect(publisher).not.toContain('--clobber')
  })
})
