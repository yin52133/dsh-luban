import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlAuditLogger } from '../src/audit.js'
import { MutableClock } from './helpers.js'

describe('JsonlAuditLogger', () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('serializes JSONL and removes only expired audit files', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-luban-audit-test-'))
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'auth-2026-06-01.jsonl'), '{}\n', 'utf8')
    await writeFile(join(directory, 'keep.txt'), 'do not delete', 'utf8')
    const clock = new MutableClock(Date.UTC(2026, 7, 30, 12))
    const logger = new JsonlAuditLogger(directory, clock, 30)
    await Promise.all([
      logger.record({
        time: clock.now(),
        user: 'admin',
        sourceIp: '127.0.0.1',
        result: 'success',
        reason: 'verified',
      }),
      logger.record({
        time: clock.now(),
        user: 'admin',
        sourceIp: '127.0.0.1',
        result: 'success',
        reason: 'session-issued',
      }),
    ])
    await logger.close()

    await expect(readFile(join(directory, 'auth-2026-06-01.jsonl'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('do not delete')
    const lines = (await readFile(join(directory, 'auth-2026-08-30.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { reason: string })
    expect(lines.map((entry) => entry.reason)).toEqual(['verified', 'session-issued'])
  })
})
