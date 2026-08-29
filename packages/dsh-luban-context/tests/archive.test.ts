import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asSessionId } from '@luban/core'
import { ContextArchiveRepository } from '../src/archive.js'
import { parseConfig } from '../src/config.js'

describe('ContextArchiveRepository', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'luban-context-archive-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('writes searchable, redacted, checksum-verified virtual files', async () => {
    const repository = new ContextArchiveRepository({
      workspace: directory,
      archiveDir: '.luban/context-archive',
      sessionId: asSessionId('session/unsafe'),
      clock: { now: (): number => 123 },
    })
    const path = await repository.archive(
      { startSeq: 1, endSeq: 3, estTokens: 30, topic: 'credentials' },
      'Decision: keep API token=super-secret and constraint A',
    )
    expect(path).toMatch(/^\.luban\/context-archive\/session_unsafe-[a-f0-9]{8}\/seg-/u)
    const replay = await repository.replay(1, 3)
    expect(replay).toContain('constraint A')
    expect(replay).not.toContain('super-secret')
    expect(replay).toContain('token=[REDACTED]')
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
          sessionId: asSessionId('session'),
          clock: { now: (): number => 1 },
        }),
    ).toThrow(/inside the workspace/u)
  })

  it('preserves distinct generations that reuse a surface range and retries idempotently', async () => {
    const repository = new ContextArchiveRepository({
      workspace: directory,
      archiveDir: '.luban/context-archive',
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
})
