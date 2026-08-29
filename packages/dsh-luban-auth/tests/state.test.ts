import { describe, expect, it } from 'vitest'
import { authStateCodec, initialAuthState } from '../src/state.js'

const validState = {
  version: 1,
  users: {
    admin: {
      username: 'admin',
      passwordHash: '$argon2id$valid',
      role: 'admin',
      createdAt: 1,
      updatedAt: 2,
      failedCount: 0,
      lockedUntil: 10,
    },
  },
  sessions: {
    abc: {
      id: 'abc',
      user: 'admin',
      role: 'admin',
      tokenHash: 'a'.repeat(64),
      csrfHash: 'b'.repeat(64),
      issuedAt: 1,
      expiresAt: 2,
      sourceIp: '127.0.0.1',
    },
  },
} as const

describe('auth state codec', () => {
  it('decodes valid locked and unlocked account forms', () => {
    expect(authStateCodec.decode(validState)).toEqual(validState)
    const unlocked = structuredClone(validState) as Record<string, unknown>
    const users = unlocked.users as Record<string, Record<string, unknown>>
    delete users.admin?.lockedUntil
    expect(authStateCodec.decode(unlocked).users.admin?.lockedUntil).toBeUndefined()
    expect(authStateCodec.encode(initialAuthState())).toEqual(initialAuthState())
  })

  it.each([
    ['root type', null],
    ['version', { ...validState, version: 2 }],
    ['users type', { ...validState, users: [] }],
    ['user key', { ...validState, users: { other: validState.users.admin } }],
    [
      'hash type',
      {
        ...validState,
        users: { admin: { ...validState.users.admin, passwordHash: 'plaintext' } },
      },
    ],
    ['role', { ...validState, users: { admin: { ...validState.users.admin, role: 'owner' } } }],
    ['timestamp', { ...validState, users: { admin: { ...validState.users.admin, createdAt: 0 } } }],
    [
      'natural',
      { ...validState, users: { admin: { ...validState.users.admin, failedCount: -1 } } },
    ],
    ['session key', { ...validState, sessions: { other: validState.sessions.abc } }],
    [
      'session hash',
      { ...validState, sessions: { abc: { ...validState.sessions.abc, tokenHash: 'bad' } } },
    ],
  ])('rejects malformed %s state', (_name, value) => {
    expect(() => authStateCodec.decode(value)).toThrow(/luban-auth/u)
  })
})
