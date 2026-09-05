import { describe, expect, it } from 'vitest'
import { normalizeUsername } from '../src/username.js'
import { validateAuthInput } from '../src/auth-page.js'
import { createManagerFixture } from './helpers.js'

describe('usernames', () => {
  it.each(['王', '测试 用户', 'a', '12', '.name', '_name', 'café', '中文'.repeat(32)])(
    'accepts %s consistently in forms and authentication',
    async (user) => {
      expect(validateAuthInput({ user, password: 'valid password' }, true)).toEqual({})
      const fixture = await createManagerFixture()
      try {
        expect(await fixture.manager.createInitialAdmin(user, 'valid password')).toBe(true)
        expect(await fixture.manager.verify(` ${user} `, 'valid password', '127.0.0.1')).toEqual({
          ok: true,
        })
        const session = await fixture.manager.issueBrowserSession(user, '127.0.0.1')
        expect(await fixture.manager.authenticateToken(session.cookieToken)).not.toBeNull()
      } finally {
        await fixture.cleanup()
      }
    },
  )

  it('normalizes Unicode and existing ASCII names without splitting identities', () => {
    expect(normalizeUsername(' Admin ')).toBe('admin')
    expect(normalizeUsername(' CAFE\u0301 ')).toBe('café')
  })

  it.each([
    '',
    '   ',
    '../admin',
    'a/b',
    'a\\b',
    'a\nb',
    'a\tb',
    'a\u202eb',
    'a\u0000b',
    '.',
    '..',
    '__proto__',
    'constructor',
    'toString',
    '中'.repeat(65),
  ])('rejects unsafe or invalid identity %j', (user) => {
    expect(() => normalizeUsername(user)).toThrow()
    expect(validateAuthInput({ user, password: 'valid password' }, true)).toHaveProperty('user')
  })
})
