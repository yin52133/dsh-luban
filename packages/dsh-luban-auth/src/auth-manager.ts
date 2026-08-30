import { createHash, randomBytes as systemRandomBytes, timingSafeEqual } from 'node:crypto'
import { argon2id, hash as argonHash, verify as argonVerify } from 'argon2'
import {
  AtomicJsonStore,
  LubanError,
  asAccountId,
  type AuthEvent,
  type AccountId,
  type IssuedSession,
  type SessionId,
  type VerifyResult,
} from 'dsh-luban-core'
import { authStateCodec, initialAuthState } from './state.js'
import type {
  AccountRecord,
  AuthManagerOptions,
  AuthRole,
  AuthState,
  AuthenticatedSession,
  BrowserSessionIssue,
  PasswordHasher,
  PersistentSession,
} from './types.js'

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/u
const PASSWORD_MIN_LENGTH = 8
const PASSWORD_MAX_LENGTH = 1_024
const RATE_WINDOW_MS = 60_000

const defaultPasswordHasher: PasswordHasher = Object.freeze({
  hash: async (password: string): Promise<string> =>
    argonHash(password, {
      type: argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
    }),
  verify: async (encodedHash: string, password: string): Promise<boolean> =>
    argonVerify(encodedHash, password),
})

/** Persistence-backed authentication state machine, independent from HTTP and Cordis. */
export class AuthManager {
  readonly #store: AtomicJsonStore<AuthState>
  readonly #options: AuthManagerOptions
  readonly #passwordHasher: PasswordHasher
  readonly #randomBytes: (size: number) => Buffer
  readonly #listeners = new Set<(event: AuthEvent) => void>()
  readonly #attemptsByIp = new Map<string, number[]>()
  #dummyHash = ''

  public constructor(options: AuthManagerOptions) {
    if (options.maxFailures < 1 || options.loginRateLimit < 1) {
      throw new RangeError('luban-auth: failure and rate thresholds must be positive')
    }
    this.#options = options
    this.#passwordHasher = options.passwordHasher ?? defaultPasswordHasher
    this.#randomBytes = options.randomBytes ?? systemRandomBytes
    this.#store = new AtomicJsonStore<AuthState>({
      filePath: options.filePath,
      codec: authStateCodec,
      initial: initialAuthState,
      backupCount: 7,
    })
  }

  public async initialize(bootstrap?: {
    readonly username: string
    readonly password: string
  }): Promise<void> {
    this.#dummyHash = await this.#passwordHasher.hash(this.#randomBytes(32).toString('base64url'))
    await this.#store.read()
    await this.#pruneExpiredSessions()
    if (bootstrap !== undefined) {
      await this.createInitialAdmin(bootstrap.username, bootstrap.password)
    }
  }

  public async hasUsers(): Promise<boolean> {
    return Object.keys((await this.#store.read()).users).length > 0
  }

  public async createInitialAdmin(username: string, password: string): Promise<boolean> {
    const normalized = normalizeUsername(username)
    assertPassword(password)
    const passwordHash = await this.#passwordHasher.hash(password)
    const now = this.#options.clock.now()
    let created = false
    await this.#store.update((state): AuthState => {
      if (Object.keys(state.users).length > 0) return state
      created = true
      const account: AccountRecord = {
        username: normalized,
        passwordHash,
        role: 'admin',
        createdAt: now,
        updatedAt: now,
        failedCount: 0,
      }
      return { ...state, users: { ...state.users, [normalized]: account } }
    })
    return created
  }

  public async provisionUser(
    administratorSessionId: string,
    username: string,
    password: string,
    role: AuthRole,
  ): Promise<AccountRecord> {
    const normalized = normalizeUsername(username)
    assertPassword(password)
    const now = this.#options.clock.now()
    await this.#assertAdministratorSession(administratorSessionId, now)
    const passwordHash = await this.#passwordHasher.hash(password)
    let created: AccountRecord | undefined
    await this.#store.update((state): AuthState => {
      const administrator = state.sessions[administratorSessionId]
      if (
        administrator === undefined ||
        administrator.expiresAt <= now ||
        administrator.role !== 'admin'
      ) {
        throw new Error('luban-auth: an active administrator session is required')
      }
      if (state.users[normalized] !== undefined) {
        throw new Error('luban-auth: user already exists')
      }
      created = {
        username: normalized,
        passwordHash,
        role,
        createdAt: now,
        updatedAt: now,
        failedCount: 0,
      }
      return { ...state, users: { ...state.users, [normalized]: created } }
    })
    if (created === undefined) throw new Error('luban-auth: unable to create user')
    return created
  }

  public async verify(user: string, password: string, sourceIp: string): Promise<VerifyResult> {
    const now = this.#options.clock.now()
    const rateLimitRetry = this.#consumeLoginAttempt(sourceIp, now)
    const auditUser = user.slice(0, 128)
    if (rateLimitRetry !== undefined) {
      await this.#options.audit.record({
        time: now,
        user: auditUser,
        sourceIp,
        result: 'failure',
        reason: 'rate-limit',
      })
      return { ok: false, reason: 'locked', retryAfterSec: rateLimitRetry }
    }

    const normalized = tryNormalizeUsername(user)
    const state = await this.#store.read()
    const account = normalized === undefined ? undefined : state.users[normalized]
    const accountLocked = account?.lockedUntil !== undefined && account.lockedUntil > now
    const validPasswordLength =
      passwordLength(password) >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH
    const selectedHash =
      account === undefined || accountLocked || !validPasswordLength
        ? this.#dummyHash
        : account.passwordHash
    const hashMatches = await this.#passwordHasher.verify(
      selectedHash,
      password.slice(0, PASSWORD_MAX_LENGTH),
    )

    if (accountLocked) {
      const retryAfterSec = Math.max(1, Math.ceil((account.lockedUntil - now) / 1_000))
      await this.#auditFailure(auditUser, sourceIp, 'locked', now)
      return { ok: false, reason: 'locked', retryAfterSec }
    }
    if (account === undefined || normalized === undefined) {
      await this.#auditFailure(auditUser, sourceIp, 'unknown-user', now)
      return { ok: false, reason: 'unknown-user' }
    }
    if (!hashMatches || !validPasswordLength) {
      let lockedUntil: number | undefined
      await this.#store.update((current): AuthState => {
        const latest = current.users[normalized]
        if (latest === undefined) return current
        const previousFailures =
          latest.lockedUntil !== undefined && latest.lockedUntil <= now ? 0 : latest.failedCount
        const failedCount = previousFailures + 1
        lockedUntil =
          failedCount >= this.#options.maxFailures ? now + this.#options.lockoutMs : undefined
        const updated = updateAccountLock(latest, failedCount, now, lockedUntil)
        return { ...current, users: { ...current.users, [normalized]: updated } }
      })
      if (lockedUntil !== undefined) this.#emit({ type: 'lockout', user: normalized, sourceIp })
      await this.#auditFailure(auditUser, sourceIp, 'bad-credentials', now)
      return lockedUntil === undefined
        ? { ok: false, reason: 'bad-credentials' }
        : {
            ok: false,
            reason: 'locked',
            retryAfterSec: Math.max(1, Math.ceil((lockedUntil - now) / 1_000)),
          }
    }

    await this.#store.update((current): AuthState => {
      const latest = current.users[normalized]
      if (latest === undefined) return current
      const updated = updateAccountLock(latest, 0, now)
      return { ...current, users: { ...current.users, [normalized]: updated } }
    })
    await this.#options.audit.record({
      time: now,
      user: normalized,
      sourceIp,
      result: 'success',
      reason: 'verified',
    })
    return { ok: true }
  }

  public async issueSession(user: string, sourceIp: string): Promise<IssuedSession> {
    return (await this.issueBrowserSession(user, sourceIp)).session
  }

  public async issueBrowserSession(user: string, sourceIp: string): Promise<BrowserSessionIssue> {
    const normalized = normalizeUsername(user)
    const now = this.#options.clock.now()
    const id = this.#randomBytes(16).toString('hex')
    const tokenSecret = this.#randomBytes(32).toString('base64url')
    const csrfToken = this.#randomBytes(32).toString('base64url')
    let session: PersistentSession | undefined
    await this.#store.update((state): AuthState => {
      const account = state.users[normalized]
      if (account === undefined)
        throw new Error('luban-auth: cannot issue a session for an unknown user')
      session = {
        id,
        user: normalized,
        role: account.role,
        tokenHash: sha256(tokenSecret),
        csrfHash: sha256(csrfToken),
        issuedAt: now,
        expiresAt: now + this.#options.sessionTtlMs,
        sourceIp,
      }
      return { ...state, sessions: { ...state.sessions, [id]: session } }
    })
    if (session === undefined) throw new Error('luban-auth: unable to issue session')
    const publicSession = toAuthenticatedSession(session)
    await this.#options.audit.record({
      time: now,
      user: normalized,
      sourceIp,
      result: 'success',
      reason: 'session-issued',
    })
    this.#emit({ type: 'login', user: normalized, sourceIp })
    return { session: publicSession, cookieToken: `${id}.${tokenSecret}`, csrfToken }
  }

  public async authenticateToken(
    token: string | undefined,
  ): Promise<{ readonly session: AuthenticatedSession; readonly csrfHash: string } | null> {
    if (token === undefined) return null
    const match = /^([a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/u.exec(token)
    if (match === null) return null
    const id = match[1]
    const secret = match[2]
    if (id === undefined || secret === undefined) return null
    const state = await this.#store.read()
    const session = state.sessions[id]
    if (session === undefined) return null
    const now = this.#options.clock.now()
    if (session.expiresAt <= now) {
      await this.revoke(id)
      return null
    }
    if (!safeHashEquals(session.tokenHash, sha256(secret))) return null
    return { session: toAuthenticatedSession(session), csrfHash: session.csrfHash }
  }

  /** Persist a DSH session owner. Existing ownership can only be reaffirmed. */
  public async bindDshSession(accountId: AccountId, sessionId: SessionId): Promise<void> {
    const account = normalizeUsername(accountId)
    const contextSessionId = normalizeContextSessionId(sessionId)
    await this.#store.update((state): AuthState => {
      if (state.users[account] === undefined) {
        throw new LubanError('E_AUTH_REQUIRED', 'The account no longer exists')
      }
      const current = state.sessionOwners[contextSessionId]
      if (current === account) return state
      if (current !== undefined) {
        throw new LubanError(
          'E_ACCOUNT_SCOPE_MISMATCH',
          'The DSH session belongs to another account',
        )
      }
      return {
        ...state,
        sessionOwners: { ...state.sessionOwners, [contextSessionId]: account },
      }
    })
  }

  public async dshSessionOwner(sessionId: SessionId): Promise<AccountId | null> {
    const owner = (await this.#store.read()).sessionOwners[normalizeContextSessionId(sessionId)]
    return owner === undefined ? null : asAccountId(owner)
  }

  public verifyCsrf(expectedHash: string, token: string | undefined): boolean {
    return (
      token !== undefined &&
      /^[A-Za-z0-9_-]{43}$/u.test(token) &&
      safeHashEquals(expectedHash, sha256(token))
    )
  }

  public async revoke(sessionId: string): Promise<void> {
    const now = this.#options.clock.now()
    let revoked: PersistentSession | undefined
    await this.#store.update((state): AuthState => {
      revoked = state.sessions[sessionId]
      if (revoked === undefined) return state
      const sessions = Object.fromEntries(
        Object.entries(state.sessions).filter(([id]) => id !== sessionId),
      )
      return { ...state, sessions }
    })
    if (revoked === undefined) return
    await this.#options.audit.record({
      time: now,
      user: revoked.user,
      sourceIp: revoked.sourceIp,
      result: 'success',
      reason: 'logout',
    })
    this.#emit({ type: 'logout', user: revoked.user })
  }

  public async revokeAllFor(user: string): Promise<void> {
    const normalized = normalizeUsername(user)
    const now = this.#options.clock.now()
    let revokedCount = 0
    await this.#store.update((state): AuthState => {
      const sessions: Record<string, PersistentSession> = {}
      for (const [id, session] of Object.entries(state.sessions)) {
        if (session.user === normalized) revokedCount += 1
        else sessions[id] = session
      }
      return revokedCount === 0 ? state : { ...state, sessions }
    })
    if (revokedCount === 0) return
    await this.#options.audit.record({
      time: now,
      user: normalized,
      sourceIp: 'local',
      result: 'success',
      reason: 'revoke-all',
    })
    this.#emit({ type: 'logout', user: normalized })
  }

  public onChange(listener: (event: AuthEvent) => void): () => void {
    this.#listeners.add(listener)
    return (): void => {
      this.#listeners.delete(listener)
    }
  }

  public async close(): Promise<void> {
    this.#listeners.clear()
    this.#attemptsByIp.clear()
    await this.#options.audit.close()
  }

  async #assertAdministratorSession(sessionId: string, now: number): Promise<void> {
    const session = (await this.#store.read()).sessions[sessionId]
    if (session === undefined || session.expiresAt <= now || session.role !== 'admin') {
      throw new Error('luban-auth: an active administrator session is required')
    }
  }

  async #pruneExpiredSessions(): Promise<void> {
    const now = this.#options.clock.now()
    await this.#store.update((state): AuthState => {
      const sessions = Object.fromEntries(
        Object.entries(state.sessions).filter(([, session]) => session.expiresAt > now),
      )
      return Object.keys(sessions).length === Object.keys(state.sessions).length
        ? state
        : { ...state, sessions }
    })
  }

  #consumeLoginAttempt(sourceIp: string, now: number): number | undefined {
    const key = sourceIp === '' ? 'unknown' : sourceIp
    const windowStart = now - RATE_WINDOW_MS
    const recent = (this.#attemptsByIp.get(key) ?? []).filter(
      (timestamp) => timestamp > windowStart,
    )
    if (recent.length >= this.#options.loginRateLimit) {
      this.#attemptsByIp.set(key, recent)
      const oldest = recent[0] ?? now
      return Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1_000))
    }
    recent.push(now)
    this.#attemptsByIp.set(key, recent)
    return undefined
  }

  async #auditFailure(
    user: string,
    sourceIp: string,
    reason: 'bad-credentials' | 'unknown-user' | 'locked',
    time: number,
  ): Promise<void> {
    await this.#options.audit.record({ time, user, sourceIp, result: 'failure', reason })
  }

  #emit(event: AuthEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch {
        // Authentication must not fail because an observer callback failed.
      }
    }
  }
}

function toAuthenticatedSession(session: PersistentSession): AuthenticatedSession {
  return {
    id: session.id,
    accountId: asAccountId(session.user),
    user: session.user,
    role: session.role,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    sourceIp: session.sourceIp,
  }
}

function normalizeContextSessionId(value: SessionId): string {
  const normalized = value.trim()
  if (normalized === '' || normalized.length > 256) {
    throw new TypeError('luban-auth: DSH session id must contain 1-256 characters')
  }
  return normalized
}

function normalizeUsername(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new TypeError(
      'luban-auth: username must be 3-64 lowercase letters, digits, dot, dash, or underscore',
    )
  }
  return normalized
}

function tryNormalizeUsername(value: string): string | undefined {
  try {
    return normalizeUsername(value)
  } catch {
    return undefined
  }
}

function assertPassword(password: string): void {
  const length = passwordLength(password)
  if (length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new TypeError(
      `luban-auth: password must contain ${String(PASSWORD_MIN_LENGTH)}-${String(PASSWORD_MAX_LENGTH)} characters`,
    )
  }
}

function passwordLength(value: string): number {
  return Array.from(value).length
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function safeHashEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex')
  const rightBytes = Buffer.from(right, 'hex')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function updateAccountLock(
  account: AccountRecord,
  failedCount: number,
  updatedAt: number,
  lockedUntil?: number,
): AccountRecord {
  const updated: AccountRecord = {
    username: account.username,
    passwordHash: account.passwordHash,
    role: account.role,
    createdAt: account.createdAt,
    updatedAt,
    failedCount,
    ...(lockedUntil === undefined ? {} : { lockedUntil }),
  }
  return updated
}
