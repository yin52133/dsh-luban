import type { JsonCodec } from 'dsh-luban-core'
import type { AccountRecord, AuthRole, AuthState, PersistentSession } from './types.js'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u

export const initialAuthState = (): AuthState => ({
  version: 1,
  users: {},
  sessions: {},
  sessionOwners: {},
})

export const authStateCodec: JsonCodec<AuthState> = {
  decode(value: unknown): AuthState {
    const root = expectRecord(value, 'auth state')
    if (root.version !== 1) throw new TypeError('luban-auth: unsupported auth state version')
    const usersValue = expectRecord(root.users, 'auth users')
    const sessionsValue = expectRecord(root.sessions, 'auth sessions')
    const ownersValue =
      root.sessionOwners === undefined ? {} : expectRecord(root.sessionOwners, 'session owners')
    const users: Record<string, AccountRecord> = {}
    const sessions: Record<string, PersistentSession> = {}
    const sessionOwners: Record<string, string> = {}

    for (const [key, user] of Object.entries(usersValue)) {
      const record = decodeAccount(user)
      if (key !== record.username)
        throw new TypeError('luban-auth: user key does not match username')
      users[key] = record
    }
    for (const [key, session] of Object.entries(sessionsValue)) {
      const record = decodeSession(session)
      if (key !== record.id) throw new TypeError('luban-auth: session key does not match id')
      sessions[key] = record
    }
    for (const [sessionId, account] of Object.entries(ownersValue)) {
      if (sessionId === '') throw new TypeError('luban-auth: owned session id must not be empty')
      sessionOwners[sessionId] = expectString(account, `sessionOwners.${sessionId}`)
    }
    return { version: 1, users, sessions, sessionOwners }
  },
  encode(value: AuthState): unknown {
    return value
  },
}

function decodeAccount(value: unknown): AccountRecord {
  const record = expectRecord(value, 'account')
  const username = expectString(record.username, 'account.username')
  const passwordHash = expectString(record.passwordHash, 'account.passwordHash')
  if (!passwordHash.startsWith('$argon2id$')) {
    throw new TypeError('luban-auth: account password hash must use Argon2id')
  }
  const role = expectRole(record.role)
  const createdAt = expectTimestamp(record.createdAt, 'account.createdAt')
  const updatedAt = expectTimestamp(record.updatedAt, 'account.updatedAt')
  const failedCount = expectNatural(record.failedCount, 'account.failedCount')
  if (record.lockedUntil === undefined) {
    return { username, passwordHash, role, createdAt, updatedAt, failedCount }
  }
  return {
    username,
    passwordHash,
    role,
    createdAt,
    updatedAt,
    failedCount,
    lockedUntil: expectTimestamp(record.lockedUntil, 'account.lockedUntil'),
  }
}

function decodeSession(value: unknown): PersistentSession {
  const record = expectRecord(value, 'session')
  const tokenHash = expectString(record.tokenHash, 'session.tokenHash')
  const csrfHash = expectString(record.csrfHash, 'session.csrfHash')
  if (!SHA256_PATTERN.test(tokenHash) || !SHA256_PATTERN.test(csrfHash)) {
    throw new TypeError('luban-auth: session hashes must be SHA-256 hex strings')
  }
  return {
    id: expectString(record.id, 'session.id'),
    user: expectString(record.user, 'session.user'),
    role: expectRole(record.role),
    tokenHash,
    csrfHash,
    issuedAt: expectTimestamp(record.issuedAt, 'session.issuedAt'),
    expiresAt: expectTimestamp(record.expiresAt, 'session.expiresAt'),
    sourceIp: expectString(record.sourceIp, 'session.sourceIp'),
  }
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`luban-auth: ${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`luban-auth: ${field} must be a non-empty string`)
  }
  return value
}

function expectNatural(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`luban-auth: ${field} must be a natural number`)
  }
  return value
}

function expectTimestamp(value: unknown, field: string): number {
  const timestamp = expectNatural(value, field)
  if (timestamp === 0) throw new TypeError(`luban-auth: ${field} must be a positive timestamp`)
  return timestamp
}

function expectRole(value: unknown): AuthRole {
  if (value === 'admin' || value === 'operator' || value === 'observer') return value
  throw new TypeError('luban-auth: account role is invalid')
}
