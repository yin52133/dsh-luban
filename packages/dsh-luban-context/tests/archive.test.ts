import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CompactionAuditRecord } from 'dsh-luban-core'
import { asSessionId } from 'dsh-luban-core'
import { ContextArchiveRepository } from '../src/archive.js'
import { parseConfig } from '../src/config.js'
import { ALICE, BOB } from './account-sessions.js'

describe('ContextArchiveRepository', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'luban-context-archive-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('writes searchable, exact, checksum-verified virtual files', async () => {
    const repository = new ContextArchiveRepository({
      workspace: directory,
      archiveDir: '.luban/context-archive',
      accountId: ALICE,
      sessionId: asSessionId('session/unsafe'),
      clock: { now: (): number => 123 },
    })
    const path = await repository.archive(
      { startSeq: 1, endSeq: 3, estTokens: 30, topic: 'credentials' },
      'Decision: keep API token=super-secret and constraint A',
    )
    expect(path).toMatch(/^\.luban\/context-archive\/alice\/session_unsafe-[a-f0-9]{8}\/seg-/u)
    const replay = await repository.replay(1, 3)
    expect(replay).toContain('constraint A')
    expect(replay).toContain('token=super-secret')
    expect(await repository.entries()).toHaveLength(1)

    await writeFile(join(directory, path), 'tampered', 'utf8')
    await expect(repository.replay(1, 3)).rejects.toMatchObject({ code: 'E_IO' })
  })

  it('rejects an archive directory that escapes its workspace', () => {
    expect(() => parseConfig({ archiveDir: '.' })).toThrow(/inside each session workspace/u)
    expect(
      () =>
        new ContextArchiveRepository({
          workspace: directory,
          archiveDir: '../outside',
          accountId: ALICE,
          sessionId: asSessionId('session'),
          clock: { now: (): number => 1 },
        }),
    ).toThrow(/inside the workspace/u)
  })

  it('rejects a symlink or Windows junction before creating an archive outside the workspace', async () => {
    const workspace = join(directory, 'workspace')
    const outside = join(directory, 'outside')
    await Promise.all([mkdir(join(workspace, '.luban'), { recursive: true }), mkdir(outside)])
    await symlink(
      outside,
      join(workspace, '.luban', 'context-archive'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const repository = new ContextArchiveRepository({
      workspace,
      archiveDir: '.luban/context-archive',
      accountId: ALICE,
      sessionId: asSessionId('linked-root'),
      clock: { now: (): number => 1 },
    })

    await expect(
      repository.archive({ startSeq: 0, endSeq: 0, estTokens: 1 }, 'must stay inside'),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    await expect(readdir(outside)).resolves.toEqual([])
  })

  it('fails closed when the canonical session directory identity is replaced', async () => {
    const workspace = join(directory, 'workspace')
    const outside = join(directory, 'outside')
    await Promise.all([mkdir(workspace), mkdir(outside)])
    const repository = new ContextArchiveRepository({
      workspace,
      archiveDir: '.luban/context-archive',
      accountId: ALICE,
      sessionId: asSessionId('identity-change'),
      clock: { now: (): number => 1 },
    })
    await expect(repository.entries()).resolves.toEqual([])
    const sessionDirectory = join(
      workspace,
      '.luban',
      'context-archive',
      'alice',
      'identity-change',
    )
    await rename(sessionDirectory, `${sessionDirectory}-original`)
    await symlink(outside, sessionDirectory, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(
      repository.archive({ startSeq: 0, endSeq: 0, estTokens: 1 }, 'must stay inside'),
    ).rejects.toMatchObject({ code: 'E_IO' })
    await expect(readdir(outside)).resolves.toEqual([])
  })

  it('preserves distinct generations that reuse a surface range and retries idempotently', async () => {
    const repository = new ContextArchiveRepository({
      workspace: directory,
      archiveDir: '.luban/context-archive',
      accountId: ALICE,
      sessionId: asSessionId('multi-round'),
      clock: { now: (): number => 123 },
    })
    const segment = { startSeq: 0, endSeq: 1, estTokens: 20 } as const
    const firstPath = await repository.archive(segment, 'Decision: retain generation one')
    expect(await repository.archive(segment, 'Decision: retain generation one')).toBe(firstPath)
    const secondPath = await repository.archive(segment, 'Decision: retain generation two')

    expect(secondPath).not.toBe(firstPath)
    expect(await repository.entries()).toHaveLength(2)
    expect(await repository.replayPath(firstPath)).toContain('generation one')
    expect(await repository.replay(0, 1)).toContain('generation two')
    await expect(repository.replayPath('../outside.md')).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
  })

  it('persists captured surface indexes and explicitly decodes older audits as legacy', async () => {
    const sessionId = asSessionId('audit-codec')
    const options = {
      workspace: directory,
      archiveDir: '.luban/context-archive',
      accountId: ALICE,
      sessionId,
      clock: { now: (): number => 123 },
    } as const
    const captured: CompactionAuditRecord = {
      accountId: ALICE,
      sessionId,
      at: 123,
      strategyId: 'custom',
      beforeTokens: 20,
      afterTokens: 8,
      archiveFiles: [],
      plan: {
        keep: [{ startSeq: 1, endSeq: 1, estTokens: 10 }],
        summarize: [{ startSeq: 0, endSeq: 0, estTokens: 10 }],
        archive: [],
        budgetTokens: 10,
        strategyId: 'custom',
      },
      surfaceSnapshots: {
        kind: 'captured',
        before: {
          totalTokens: 20,
          entries: [
            { eventSeq: 10, segment: { startSeq: 0, endSeq: 0, estTokens: 10 } },
            { eventSeq: 11, segment: { startSeq: 1, endSeq: 1, estTokens: 10 } },
          ],
        },
        after: {
          totalTokens: 8,
          entries: [{ eventSeq: 12, segment: { startSeq: 0, endSeq: 0, estTokens: 8 } }],
        },
      },
    }
    const repository = new ContextArchiveRepository(options)
    await repository.recordAudit(captured)
    await expect(new ContextArchiveRepository(options).audit()).resolves.toEqual([captured])

    const legacyRecord = {
      accountId: ALICE,
      sessionId,
      at: 100,
      strategyId: 'legacy-strategy',
      beforeTokens: 30,
      afterTokens: 10,
      archiveFiles: [],
      plan: {
        keep: [{ startSeq: 2, endSeq: 2, estTokens: 10 }],
        summarize: [{ startSeq: 0, endSeq: 1, estTokens: 20 }],
        archive: [],
        budgetTokens: 10,
        strategyId: 'legacy-strategy',
      },
    }
    const auditPath = join(
      directory,
      '.luban',
      'context-archive',
      'alice',
      String(sessionId),
      'audit.json',
    )
    await writeFile(auditPath, JSON.stringify([legacyRecord]), 'utf8')
    const legacyRepository = new ContextArchiveRepository(options)
    const [decodedLegacy] = await legacyRepository.audit()
    expect(decodedLegacy?.surfaceSnapshots).toEqual({ kind: 'legacy' })
    expect(decodedLegacy?.surfaceSnapshots).not.toHaveProperty('after')

    await legacyRepository.recordAudit(captured)
    const persisted = JSON.parse(await readFile(auditPath, 'utf8')) as unknown
    expect(persisted).toMatchObject([
      { surfaceSnapshots: { kind: 'legacy' } },
      { surfaceSnapshots: { kind: 'captured' } },
    ])
  })

  it('partitions identical workspace/session paths by account and refuses cross-account replay', async () => {
    const sessionId = asSessionId('shared-session-name')
    const alice = new ContextArchiveRepository({
      workspace: directory,
      archiveDir: '.luban/context-archive',
      accountId: ALICE,
      sessionId,
      clock: { now: (): number => 1 },
    })
    const bob = new ContextArchiveRepository({
      workspace: directory,
      archiveDir: '.luban/context-archive',
      accountId: BOB,
      sessionId,
      clock: { now: (): number => 2 },
    })

    const alicePath = await alice.archive(
      { startSeq: 0, endSeq: 0, estTokens: 1 },
      'alice-only context',
    )
    const bobPath = await bob.archive({ startSeq: 0, endSeq: 0, estTokens: 1 }, 'bob-only context')

    expect(alicePath).toContain('/alice/shared-session-name/')
    expect(bobPath).toContain('/bob/shared-session-name/')
    expect(await alice.replayPath(alicePath)).toContain('alice-only')
    expect(await bob.replayPath(bobPath)).toContain('bob-only')
    await expect(bob.replayPath(alicePath)).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    expect((await alice.entries()).every((entry) => entry.accountId === ALICE)).toBe(true)
    expect((await bob.entries()).every((entry) => entry.accountId === BOB)).toBe(true)
  })

  it('does not auto-assign legacy index or audit rows that lack accountId', async () => {
    const sessionId = asSessionId('unowned-legacy')
    const sessionDirectory = join(
      directory,
      '.luban',
      'context-archive',
      'alice',
      String(sessionId),
    )
    await mkdir(sessionDirectory, { recursive: true })
    await writeFile(
      join(sessionDirectory, 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            startSeq: 0,
            endSeq: 0,
            estTokens: 1,
            path: '.luban/context-archive/alice/unowned-legacy/seg.md',
            sha256: 'legacy',
            createdAt: 1,
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      join(sessionDirectory, 'audit.json'),
      JSON.stringify([
        {
          sessionId,
          at: 1,
          strategyId: 'legacy',
          beforeTokens: 1,
          afterTokens: 1,
          archiveFiles: [],
          plan: {
            keep: [],
            summarize: [],
            archive: [],
            budgetTokens: 1,
            strategyId: 'legacy',
          },
        },
      ]),
      'utf8',
    )

    const repository = new ContextArchiveRepository({
      workspace: directory,
      archiveDir: '.luban/context-archive',
      accountId: ALICE,
      sessionId,
      clock: { now: (): number => 2 },
    })
    await expect(repository.entries()).resolves.toEqual([])
    await expect(repository.audit()).resolves.toEqual([])
  })
})
