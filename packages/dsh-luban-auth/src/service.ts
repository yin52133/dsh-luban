import type { IncomingMessage } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  AccountId,
  AccountSessionRegistry,
  AuthEvent,
  AuthMiddleware,
  AuthMiddlewareDecision,
  AuthMiddlewareRequest,
  AuthService,
  IssuedSession,
  SessionId,
  VerifyResult,
} from 'dsh-luban-core'
import { asAccountId, asActorId } from 'dsh-luban-core'
import type { AuthManager } from './auth-manager.js'
import {
  AUTH_COOKIE_NAME,
  AUTH_ROOT,
  type AccountRecord,
  type AuthRole,
  type RequestAuthentication,
} from './types.js'
import { isPublicStaticRequest, readCookie } from './http-security.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanAuth: LubanAuthService
  }
}

/** Cordis L2 service shared by the sidecar and other Luban plugins. */
export class LubanAuthService extends Service implements AuthService {
  private readonly manager: AuthManager
  public readonly accountSessions: AccountSessionRegistry

  public constructor(ctx: Context, manager: AuthManager) {
    super(ctx, 'lubanAuth')
    this.manager = manager
    this.accountSessions = Object.freeze({
      bind: (accountId: AccountId, sessionId: SessionId): Promise<void> =>
        this.manager.bindDshSession(accountId, sessionId),
      ownerOf: (sessionId: SessionId): ReturnType<AuthManager['dshSessionOwner']> =>
        this.manager.dshSessionOwner(sessionId),
    })
  }

  public verify(user: string, password: string, sourceIp: string): Promise<VerifyResult> {
    return this.manager.verify(user, password, sourceIp)
  }

  public issueSession(user: string, sourceIp: string): Promise<IssuedSession> {
    return this.manager.issueSession(user, sourceIp)
  }

  public revoke(sessionId: string): Promise<void> {
    return this.manager.revoke(sessionId)
  }

  public revokeAllFor(user: string): Promise<void> {
    return this.manager.revokeAllFor(user)
  }

  public onChange(listener: (event: AuthEvent) => void): () => void {
    return this.manager.onChange(listener)
  }

  public middleware(): AuthMiddleware {
    return async (request: AuthMiddlewareRequest): Promise<AuthMiddlewareDecision> => {
      if (
        request.path === `${AUTH_ROOT}/login` ||
        isPublicStaticRequest(request.method, request.path)
      ) {
        return { allowed: true, status: 200 }
      }
      const token = readCookie(request.cookie, AUTH_COOKIE_NAME)
      const authenticated = await this.manager.authenticateToken(token)
      if (authenticated !== null) {
        const { session } = authenticated
        return {
          allowed: true,
          status: 200,
          user: session.user,
          account: {
            accountId: session.accountId,
            username: session.user,
            role: session.role,
          },
        }
      }
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        request.accept?.includes('text/html')
      ) {
        return {
          allowed: false,
          status: 302,
          redirectTo: `${AUTH_ROOT}/login?returnTo=${encodeURIComponent(request.path)}`,
        }
      }
      return { allowed: false, status: 401 }
    }
  }

  /** Authenticate a Node request for issue-scoped plugins sharing this Cordis context. */
  public async authenticateRequest(request: IncomingMessage): Promise<RequestAuthentication> {
    const token = readCookie(request.headers.cookie, AUTH_COOKIE_NAME)
    if (token === undefined) return { ok: false, reason: 'missing' }
    const authenticated = await this.manager.authenticateToken(token)
    if (authenticated === null) return { ok: false, reason: 'invalid' }
    const { session } = authenticated
    return {
      ok: true,
      actor: {
        kind: 'user',
        id: asActorId(session.user),
        accountId: asAccountId(session.user),
        displayName: session.user,
        username: session.user,
        role: session.role,
      },
      session,
    }
  }

  public hasUsers(): Promise<boolean> {
    return this.manager.hasUsers()
  }

  public provisionUser(
    administratorSessionId: string,
    username: string,
    password: string,
    role: AuthRole,
  ): Promise<AccountRecord> {
    return this.manager.provisionUser(administratorSessionId, username, password, role)
  }
}
