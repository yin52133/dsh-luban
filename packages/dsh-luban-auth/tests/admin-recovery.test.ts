import { chmod, link, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { asAccountId, asSessionId } from '@yin52133/dsh-luban-core'
import {
  assertRecoveryAccess,
  inspectRecoveryTarget,
  readRecoveryState,
  recoverAdministrator,
  resetAdministratorState,
  type RecoveryService,
} from '../src/admin-recovery.js'
import { defaultPasswordHasher } from '../src/auth-manager.js'
import { parseRecoveryArguments } from '../src/recovery-cli.js'
import { askNewPassword, type RecoveryPrompts } from '../src/recovery-prompts.js'
import { createManagerFixture, type ManagerFixture } from './helpers.js'

describe('local recovery authorization', () => {
  it.each([
    ['linux', 1000, true],
    ['linux', undefined, true],
    ['linux', 0, false],
    ['win32', 0, true],
    ['darwin', 0, true],
  ] as const)('rejects platform=%s uid=%s tty=%s', (platform, uid, interactive) => {
    expect(() => assertRecoveryAccess(platform, uid, interactive)).toThrow()
  })
  it('accepts only an interactive Linux administrator', () => {
    expect(() => assertRecoveryAccess('linux', 0, true)).not.toThrow()
  })
  it('requires an explicit file and normalizes service names', () => {
    expect(parseRecoveryArguments(['reset-admin', '--users-file', '/private/users.json'])).toEqual({
      file: '/private/users.json',
      service: 'dsh-luban.service',
    })
    expect(
      parseRecoveryArguments([
        'reset-admin',
        '--service',
        'review.service',
        '--users-file',
        '/private/users.json',
      ]).service,
    ).toBe('review.service')
  })
  it.each([
    [],
    ['reset-admin'],
    ['reset-admin', '--password', 'secret'],
    ['reset-admin', '--users-file'],
    ['reset-admin', '--users-file', '/one', '--users-file', '/two'],
    ['reset-admin', '--users-file', '/one', '--service', '../../sshd'],
    ['reset-admin', '--users-file', '/one', '--force'],
    ['reset-admin', '--users-file', '/one', '--service', '-bad'],
  ])('rejects unsupported arguments %j', (...args) => {
    expect(() => parseRecoveryArguments(args)).toThrow()
  })
  it('retries short and mismatched passwords without echoing them', async () => {
    const answers = ['short', 'first password', 'mismatch', 'new password', 'new password']
    const write = vi.fn<(message: string) => void>()
    const ask = vi
      .fn<RecoveryPrompts['ask']>()
      .mockImplementation(() => Promise.resolve(answers.shift() ?? ''))
    expect(await askNewPassword({ ask, write })).toBe('new password')
    expect(write).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(write.mock.calls)).not.toContain('first password')
    expect(ask.mock.calls.every(([, secret]) => secret === true)).toBe(true)
  })
})

describe('administrator state transition', () => {
  let fixture: ManagerFixture | undefined
  afterEach(async () => {
    await fixture?.cleanup()
    fixture = undefined
  })
  it('preserves other users and ownership while unlocking and revoking the selected administrator', async () => {
    fixture = await createManagerFixture()
    await fixture.manager.createInitialAdmin('管理员', 'old password')
    const admin = await fixture.manager.issueBrowserSession('管理员', '127.0.0.1')
    await fixture.manager.provisionUser(admin.session.id, '用户', 'user password', 'operator')
    const other = await fixture.manager.issueBrowserSession('用户', '127.0.0.1')
    await fixture.manager.bindDshSession(asAccountId('管理员'), asSessionId('owned'))
    const state = await readRecoveryState(fixture.filePath)
    const result = resetAdministratorState(state, '管理员', '$scrypt$new', Date.now())
    expect(result.revokedSessions).toBe(1)
    expect(result.state.sessions[admin.session.id]).toBeUndefined()
    expect(result.state.sessions[other.session.id]).toEqual(state.sessions[other.session.id])
    expect(result.state.users['用户']).toEqual(state.users['用户'])
    expect(result.state.sessionOwners).toEqual(state.sessionOwners)
    expect(state.users['管理员']?.passwordHash).not.toBe('$scrypt$new')
    expect(() => resetAdministratorState(state, '用户', '$scrypt$new', Date.now())).toThrow(
      '只能复位已有管理员',
    )
    expect(() => resetAdministratorState(state, 'missing', '$scrypt$new', Date.now())).toThrow()
  })
})

describe.skipIf(process.platform !== 'linux')('private Linux file recovery', () => {
  let fixture: ManagerFixture | undefined
  afterEach(async () => {
    await fixture?.cleanup()
    fixture = undefined
  })
  async function setup(): Promise<ManagerFixture> {
    fixture = await createManagerFixture({ maxFailures: 1 })
    await fixture.manager.createInitialAdmin('admin', 'old password')
    return fixture
  }
  function service(): RecoveryService & {
    start: ReturnType<typeof vi.fn<() => Promise<void>>>
    stop: ReturnType<typeof vi.fn<() => Promise<void>>>
  } {
    let active = true
    return {
      running: () => Promise.resolve(active),
      stop: vi.fn(() => {
        active = false
        return Promise.resolve()
      }),
      start: vi.fn(() => {
        active = true
        return Promise.resolve()
      }),
    }
  }
  it('backs up, resets, preserves owner/mode, invalidates tokens and restarts the service', async () => {
    const { manager, filePath } = await setup()
    const session = await manager.issueBrowserSession('admin', '127.0.0.1')
    await manager.verify('admin', 'wrong password', '127.0.0.1')
    const before = await readFile(filePath, 'utf8')
    const metadata = await stat(filePath)
    const runtime = service()
    const result = await recoverAdministrator(
      await inspectRecoveryTarget(filePath),
      'admin',
      'new password',
      runtime,
    )
    expect(await readFile(result.backup, 'utf8')).toBe(before)
    const state = await readRecoveryState(filePath)
    expect(
      await defaultPasswordHasher.verify(state.users.admin?.passwordHash ?? '', 'new password'),
    ).toBe(true)
    expect(
      await defaultPasswordHasher.verify(state.users.admin?.passwordHash ?? '', 'old password'),
    ).toBe(false)
    expect(state.users.admin?.lockedUntil).toBeUndefined()
    expect(state.users.admin?.failedCount).toBe(0)
    expect(await manager.authenticateToken(session.cookieToken)).toBeNull()
    expect(result.revokedSessions).toBe(1)
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(runtime.start).toHaveBeenCalledOnce()
    expect(await stat(filePath)).toMatchObject({
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode,
    })
    expect((await stat(result.backup)).mode & 0o777).toBe(0o600)
    const audit = await readFile(`${result.backup}.audit.json`, 'utf8')
    expect(audit).not.toContain('passwordHash')
    expect(audit).not.toContain('new password')
  })
  it('refuses a service that remains active without writing or backing up data', async () => {
    const { filePath, directory } = await setup()
    const before = await readFile(filePath, 'utf8')
    const runtime = {
      running: () => Promise.resolve(true),
      stop: vi.fn(() => Promise.resolve()),
      start: vi.fn(() => Promise.resolve()),
    }
    await expect(
      recoverAdministrator(await inspectRecoveryTarget(filePath), 'admin', 'new password', runtime),
    ).rejects.toThrow('服务仍在运行')
    expect(await readFile(filePath, 'utf8')).toBe(before)
    expect((await readdir(directory)).filter((name) => name.includes('.recovery-'))).toEqual([])
    expect(runtime.start).toHaveBeenCalledOnce()
  })
  it('restores the service on corrupt state without replacing the file', async () => {
    const { filePath } = await setup()
    const target = await inspectRecoveryTarget(filePath)
    await writeFile(filePath, 'corrupt', 'utf8')
    const runtime = service()
    await expect(recoverAdministrator(target, 'admin', 'new password', runtime)).rejects.toThrow()
    expect(await readFile(filePath, 'utf8')).toBe('corrupt')
    expect(runtime.start).toHaveBeenCalledOnce()
  })
  it('reports a completed reset separately from a failed service restart', async () => {
    const { filePath } = await setup()
    const runtime = service()
    runtime.start.mockRejectedValue(new Error('unavailable'))
    await expect(
      recoverAdministrator(await inspectRecoveryTarget(filePath), 'admin', 'new password', runtime),
    ).rejects.toThrow('密码已复位，但服务启动失败')
    expect(
      await defaultPasswordHasher.verify(
        (await readRecoveryState(filePath)).users.admin?.passwordHash ?? '',
        'new password',
      ),
    ).toBe(true)
  })
  it('leaves an originally stopped service stopped', async () => {
    const { filePath } = await setup()
    const runtime = {
      running: () => Promise.resolve(false),
      stop: vi.fn(() => Promise.resolve()),
      start: vi.fn(() => Promise.resolve()),
    }
    await recoverAdministrator(
      await inspectRecoveryTarget(filePath),
      'admin',
      'new password',
      runtime,
    )
    expect(runtime.stop).not.toHaveBeenCalled()
    expect(runtime.start).not.toHaveBeenCalled()
  })
  it('rejects relative, missing, shared, symbolic and hard-linked files', async () => {
    const { filePath, directory } = await setup()
    await expect(inspectRecoveryTarget('users.json')).rejects.toThrow('绝对路径')
    await expect(inspectRecoveryTarget(join(directory, 'missing.json'))).rejects.toThrow()
    const symbolic = join(directory, 'symbolic.json')
    await symlink(filePath, symbolic)
    await expect(inspectRecoveryTarget(symbolic)).rejects.toThrow('符号链接')
    await chmod(filePath, 0o644)
    await expect(inspectRecoveryTarget(filePath)).rejects.toThrow('仅所属用户')
    await chmod(filePath, 0o600)
    await link(filePath, join(directory, 'hard.json'))
    await expect(inspectRecoveryTarget(filePath)).rejects.toThrow('硬链接')
  })
})
