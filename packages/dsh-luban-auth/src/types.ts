import type { AccountId, ActorId, Clock } from 'dsh-luban-core'

export const AUTH_COOKIE_NAME = 'luban_session'
export const CSRF_COOKIE_NAME = 'luban_csrf'
export const AUTH_ROOT = '/luban-auth'

export type AuthRole = 'admin' | 'operator' | 'observer'

export interface AccountRecord {
  readonly username: string
  readonly passwordHash: string
  readonly role: AuthRole
  readonly createdAt: number
  readonly updatedAt: number
  readonly failedCount: number
  readonly lockedUntil?: number
}

export interface PersistentSession {
  readonly id: string
  readonly user: string
  readonly role: AuthRole
  readonly tokenHash: string
  readonly csrfHash: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly sourceIp: string
}

export interface AuthState {
  readonly version: 1
  readonly users: Readonly<Record<string, AccountRecord>>
  readonly sessions: Readonly<Record<string, PersistentSession>>
  /** DSH context/session ownership introduced by M01-F008. */
  readonly sessionOwners: Readonly<Record<string, string>>
}

export interface AuthenticatedActor {
  readonly kind: 'user'
  readonly id: ActorId
  readonly accountId: AccountId
  readonly displayName: string
  readonly username: string
  readonly role: AuthRole
}

export interface AuthenticatedSession {
  readonly id: string
  readonly accountId: AccountId
  readonly user: string
  readonly role: AuthRole
  readonly issuedAt: number
  readonly expiresAt: number
  readonly sourceIp: string
}

export type RequestAuthentication =
  | {
      readonly ok: true
      readonly actor: AuthenticatedActor
      readonly session: AuthenticatedSession
    }
  | {
      readonly ok: false
      readonly reason: 'missing' | 'invalid' | 'expired'
    }

export interface BrowserSessionIssue {
  readonly session: AuthenticatedSession
  readonly cookieToken: string
  readonly csrfToken: string
}

export interface AuditRecord {
  readonly time: number
  readonly user: string
  readonly sourceIp: string
  readonly result: 'success' | 'failure'
  readonly reason:
    | 'verified'
    | 'bad-credentials'
    | 'unknown-user'
    | 'locked'
    | 'rate-limit'
    | 'session-issued'
    | 'logout'
    | 'revoke-all'
}

export interface AuditSink {
  record(entry: AuditRecord): Promise<void>
  close(): Promise<void>
}

export interface PasswordHasher {
  hash(password: string): Promise<string>
  verify(encodedHash: string, password: string): Promise<boolean>
}

export interface AuthManagerOptions {
  readonly filePath: string
  readonly audit: AuditSink
  readonly clock: Clock
  readonly sessionTtlMs: number
  readonly maxFailures: number
  readonly lockoutMs: number
  readonly loginRateLimit: number
  readonly passwordHasher?: PasswordHasher
  readonly randomBytes?: (size: number) => Buffer
}

export interface LubanAuthConfig {
  readonly host: '127.0.0.1' | '0.0.0.0'
  readonly port: number
  readonly upstream: string
  readonly sessionTtlHours: number
  readonly maxFailures: number
  readonly lockoutMinutes: number
  readonly loginRateLimitPerMinute: number
  readonly usersFile: string
  readonly auditDirectory: string
  readonly trustedHosts: readonly string[]
  readonly allowedNetworks: readonly string[]
  readonly trustProxy: boolean
  readonly trustedProxyNetworks: readonly string[]
  readonly secureCookies: 'auto' | 'always' | 'never'
  readonly maxAuthBodyBytes: number
  readonly maxProxyBodyBytes: number
  readonly bootstrapAdminUser: string
  readonly bootstrapAdminPasswordEnv: string
}

export interface AuthGatewayStartResult {
  readonly publicUrl: string
  readonly upstreamUrl: string
}

export interface AuthGateway {
  start(): Promise<AuthGatewayStartResult>
  stop(): Promise<void>
}
