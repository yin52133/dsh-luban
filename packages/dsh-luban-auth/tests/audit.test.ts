import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlAuditLogger } from '../src/audit.js'
import { AuthManager } from '../src/auth-manager.js'
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

  it('keeps plaintext passwords and browser secrets out of persisted state and audit JSONL', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-luban-audit-secret-test-'))
    const clock = new MutableClock(Date.UTC(2026, 7, 30, 12))
    const usersFile = join(directory, 'users.json')
    const auditDirectory = join(directory, 'audit')
    const manager = new AuthManager({
      filePath: usersFile,
      audit: new JsonlAuditLogger(auditDirectory, clock, 30),
      clock,
      sessionTtlMs: 60_000,
      maxFailures: 5,
      lockoutMs: 60_000,
      loginRateLimit: 10,
    })
    const password = 'audit-secret-password'
    await manager.initialize({ username: 'admin', password })
    await manager.verify('admin', 'wrong-audit-password', '127.0.0.1')
    await manager.verify('admin', password, '127.0.0.1')
    const issued = await manager.issueBrowserSession('admin', '127.0.0.1')
    await manager.close()

    const persisted = [
      await readFile(usersFile, 'utf8'),
      await readFile(join(auditDirectory, 'auth-2026-08-30.jsonl'), 'utf8'),
    ].join('\n')
    expect(persisted).not.toContain(password)
    expect(persisted).not.toContain('wrong-audit-password')
    expect(persisted).not.toContain(issued.cookieToken)
    expect(persisted).not.toContain(issued.csrfToken)
    expect(persisted).toContain('$argon2id$')
    expect(persisted).toContain('bad-credentials')
  }, 30_000)
})
