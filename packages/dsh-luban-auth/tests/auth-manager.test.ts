import { readFile } from 'node:fs/promises'
import { asAccountId, asSessionId } from 'dsh-luban-core'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthManager } from '../src/auth-manager.js'
import { createManagerFixture, type ManagerFixture, MemoryAudit, MutableClock } from './helpers.js'

describe('AuthManager', () => {
  let fixture: ManagerFixture | undefined

  afterEach(async () => {
    await fixture?.cleanup()
    fixture = undefined
  })

  it('bootstraps exactly one administrator and applies failure lockout', async () => {
    fixture = await createManagerFixture({ maxFailures: 2 })
    const { manager, clock, audit } = fixture
    expect(await manager.createInitialAdmin('Admin', 'correct horse')).toBe(true)
    expect(await manager.createInitialAdmin('other', 'another pass')).toBe(false)

    expect(await manager.verify('admin', 'wrong pass', '192.0.2.10')).toEqual({
      ok: false,
      reason: 'bad-credentials',
    })
    const locked = await manager.verify('admin', 'wrong pass', '192.0.2.10')
    expect(locked).toMatchObject({ ok: false, reason: 'locked', retryAfterSec: 30 })
    expect(await manager.verify('admin', 'correct horse', '192.0.2.10')).toMatchObject({
      ok: false,
      reason: 'locked',
    })

    clock.advance(30_001)
    expect(await manager.verify('admin', 'wrong pass', '192.0.2.10')).toEqual({
      ok: false,
      reason: 'bad-credentials',
    })
    expect(await manager.verify('admin', 'wrong pass', '192.0.2.10')).toMatchObject({
      ok: false,
      reason: 'locked',
    })
    clock.advance(30_001)
    expect(await manager.verify('admin', 'correct horse', '192.0.2.10')).toEqual({ ok: true })
    expect(audit.entries.map((entry) => entry.reason)).toContain('bad-credentials')
  })

  it('uses a dummy hash for unknown accounts and enforces the IP rate budget', async () => {
    fixture = await createManagerFixture({ loginRateLimit: 2 })
    const { manager, hasher } = fixture
    await manager.createInitialAdmin('admin', 'correct horse')
    const before = hasher.verifyCount
    await manager.verify('missing', 'correct horse', '198.51.100.4')
    expect(hasher.verifyCount).toBe(before + 1)
    await manager.verify('admin', 'wrong pass', '198.51.100.4')
    const limited = await manager.verify('admin', 'correct horse', '198.51.100.4')
    expect(limited).toMatchObject({ ok: false, reason: 'locked', retryAfterSec: 60 })
  })

  it('stores only token hashes, validates CSRF, expiry, logout, and revoke-all', async () => {
    fixture = await createManagerFixture({ sessionTtlMs: 10_000 })
    const { manager, filePath, clock } = fixture
    await manager.createInitialAdmin('admin', 'correct horse')
    expect(await manager.verify('admin', 'correct horse', '203.0.113.2')).toEqual({ ok: true })
    const first = await manager.issueBrowserSession('admin', '203.0.113.2')
    const persisted = await readFile(filePath, 'utf8')
    expect(persisted).not.toContain('correct horse')
    expect(persisted).not.toContain(first.cookieToken)
    expect(persisted).not.toContain(first.csrfToken)

    const authenticated = await manager.authenticateToken(first.cookieToken)
    expect(authenticated?.session).toMatchObject({ user: 'admin', role: 'admin' })
    expect(manager.verifyCsrf(authenticated?.csrfHash ?? '', first.csrfToken)).toBe(true)
    expect(manager.verifyCsrf(authenticated?.csrfHash ?? '', 'x'.repeat(43))).toBe(false)

    await manager.revoke(first.session.id)
    expect(await manager.authenticateToken(first.cookieToken)).toBeNull()
    const second = await manager.issueBrowserSession('admin', '203.0.113.2')
    await manager.revokeAllFor('admin')
    expect(await manager.authenticateToken(second.cookieToken)).toBeNull()

    const third = await manager.issueBrowserSession('admin', '203.0.113.2')
    clock.advance(10_001)
    expect(await manager.authenticateToken(third.cookieToken)).toBeNull()
  })

  it('allows only an active administrator session to provision role accounts', async () => {
    fixture = await createManagerFixture()
    const { manager } = fixture
    await manager.createInitialAdmin('admin', 'correct horse')
    const admin = await manager.issueBrowserSession('admin', '127.0.0.1')
    const operator = await manager.provisionUser(
      admin.session.id,
      'Build.Operator',
      'operator pass',
      'operator',
    )
    expect(operator).toMatchObject({ username: 'build.operator', role: 'operator' })
    const hashesBeforeDeniedRequest = fixture.hasher.hashCount
    await expect(
      manager.provisionUser('forged', 'observer', 'observer pass', 'observer'),
    ).rejects.toThrow(/administrator session/u)
    expect(fixture.hasher.hashCount).toBe(hashesBeforeDeniedRequest)
  })

  it('persists DSH session ownership and rejects cross-account rebinding', async () => {
    fixture = await createManagerFixture()
    const { manager } = fixture
    await manager.createInitialAdmin('admin', 'correct horse')
    const admin = await manager.issueBrowserSession('admin', '127.0.0.1')
    await manager.provisionUser(admin.session.id, 'operator', 'operator pass', 'operator')

    const sessionId = asSessionId('shared-context')
    await manager.bindDshSession(asAccountId('admin'), sessionId)
    await manager.bindDshSession(asAccountId('admin'), sessionId)
    expect(await manager.dshSessionOwner(sessionId)).toBe('admin')
    await expect(manager.bindDshSession(asAccountId('operator'), sessionId)).rejects.toMatchObject({
      code: 'E_ACCOUNT_SCOPE_MISMATCH',
    })

    const restarted = new AuthManager({
      filePath: fixture.filePath,
      audit: new MemoryAudit(),
      clock: fixture.clock,
      sessionTtlMs: 60_000,
      maxFailures: 3,
      lockoutMs: 30_000,
      loginRateLimit: 10,
      passwordHasher: fixture.hasher,
    })
    try {
      await restarted.initialize()
      expect(await restarted.dshSessionOwner(sessionId)).toBe('admin')
    } finally {
      await restarted.close()
    }
  })
})

describe('production Argon2id hashing', () => {
  it('writes an encoded Argon2id hash and no plaintext password', async () => {
    const fixture = await createManagerFixture()
    const { directory, filePath } = fixture
    await fixture.cleanup()
    const clock = new MutableClock()
    const audit = new MemoryAudit()
    const manager = new AuthManager({
      filePath,
      audit,
      clock,
      sessionTtlMs: 60_000,
      maxFailures: 3,
      lockoutMs: 30_000,
      loginRateLimit: 10,
    })
    try {
      await manager.initialize({ username: 'admin', password: 'argon secret' })
      const persisted = await readFile(filePath, 'utf8')
      expect(persisted).toContain('$argon2id$')
      expect(persisted).not.toContain('argon secret')
      expect(await manager.verify('admin', 'argon secret', '127.0.0.1')).toEqual({ ok: true })
    } finally {
      await manager.close()
      const { rm } = await import('node:fs/promises')
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
