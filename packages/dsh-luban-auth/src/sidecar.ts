import {
  request as httpRequest,
  createServer,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { Transform, type Duplex, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import { asSessionId, type AccountId, type SessionId } from '@yin52133/dsh-luban-core'
import type { AuthManager } from './auth-manager.js'
import { DshEventScope, type DshEventChannel } from './dsh-event-scope.js'
import { dshMethodFromPath, dshRequestSessionIds } from './dsh-http-scope.js'
import { DshSessionOperationBarrier } from './dsh-session-operation-barrier.js'
import {
  AUTH_COOKIE_NAME,
  AUTH_ROOT,
  CSRF_COOKIE_NAME,
  type AuthGateway,
  type AuthGatewayStartResult,
  type AuthRole,
  type LubanAuthConfig,
} from './types.js'
import {
  HttpError,
  assertLoginOrigin,
  assertProxyBodySize,
  assertRequestOrigin,
  assertWebSocketOrigin,
  inspectRequestSecurity,
  isPublicStaticRequest,
  readBoundedForm,
  readBoundedJson,
  readCookie,
  safeReturnTo,
  sendJson,
  singleHeader,
  wantsHtml,
  type RequestSecurityContext,
} from './http-security.js'

const LOGIN_ROUTE = `${AUTH_ROOT}/login`
const LOGOUT_ROUTE = `${AUTH_ROOT}/logout`
const SESSION_ROUTE = `${AUTH_ROOT}/session`
const REVOKE_ALL_ROUTE = `${AUTH_ROOT}/revoke-all`
const USERS_ROUTE = `${AUTH_ROOT}/users`
const DSH_API_ROOT = '/api/'
const DSH_MUX_ROUTE = `${DSH_API_ROOT}events.mux`
const DSH_HOST_EVENTS_ROUTE = `${DSH_API_ROOT}events.host`
const DSH_RESPOND_ROUTE = `${DSH_API_ROOT}respond`
const DSH_FILTERED_UNARY_METHODS = new Set([
  'session.list',
  'session.search',
  'session.create',
  'session.fork',
  'sessionReferenceResolver/candidates',
  'dynamicCordisRunner/inventory',
  'subagent.list',
])
const SENSITIVE_COOKIE_NAMES = new Set([AUTH_COOKIE_NAME, CSRF_COOKIE_NAME])
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

interface SidecarOptions {
  readonly config: LubanAuthConfig
  readonly upstream: URL
  readonly manager: AuthManager
  readonly trustedHostnames: ReadonlySet<string>
  readonly onError?: (error: Error) => void
}

type ManagerAuthentication = NonNullable<Awaited<ReturnType<AuthManager['authenticateToken']>>>

interface SessionScopeDenial {
  readonly sessionId: string
  readonly reason: 'foreign' | 'unbound'
}

interface DshRequestContext {
  readonly accountId: AccountId
  readonly method: string | undefined
  readonly rpcId: string | undefined
}

interface BodyRewrite {
  readonly body: Buffer
  readonly changed: boolean
}

/** Global authentication gateway in front of the loopback-only DSH WebServer. */
export class AuthSidecar implements AuthGateway {
  readonly #config: LubanAuthConfig
  readonly #upstream: URL
  readonly #manager: AuthManager
  readonly #trustedHostnames: ReadonlySet<string>
  readonly #onError: (error: Error) => void
  readonly #dshEventScope: DshEventScope
  readonly #dshSessionOperations = new DshSessionOperationBarrier()
  readonly #sockets = new Set<Duplex>()
  readonly #upstreamRequests = new Set<ClientRequest>()
  #server: Server | undefined
  #listenPort: number | undefined

  public constructor(options: SidecarOptions) {
    this.#config = options.config
    this.#upstream = options.upstream
    this.#manager = options.manager
    this.#trustedHostnames = options.trustedHostnames
    this.#onError = options.onError ?? (() => undefined)
    this.#dshEventScope = new DshEventScope((accountId, sessionId) =>
      this.#dshSessionOwnerAfterOperations(accountId, sessionId),
    )
  }

  public get port(): number | undefined {
    return this.#listenPort
  }

  public async start(): Promise<AuthGatewayStartResult> {
    if (this.#server !== undefined) throw new Error('luban-auth: sidecar already started')
    const server = createServer((request, response): void => {
      this.#handleHttp(request, response).catch((error: unknown): void => {
        this.#handleHttpError(error, response)
      })
    })
    this.#server = server
    server.requestTimeout = 5 * 60_000
    server.headersTimeout = 30_000
    server.keepAliveTimeout = 5_000
    server.maxHeadersCount = 100
    server.on('connection', (socket): void => {
      this.#sockets.add(socket)
      socket.once('close', (): void => {
        this.#sockets.delete(socket)
      })
    })
    server.on('upgrade', (request, socket, head): void => {
      this.#handleUpgrade(request, socket, head).catch((error: unknown): void => {
        this.#writeSocketError(socket, error)
      })
    })

    try {
      await new Promise<void>((resolve, reject): void => {
        const onError = (error: Error): void => reject(error)
        server.once('error', onError)
        server.listen(this.#config.port, this.#config.host, (): void => {
          server.off('error', onError)
          const address = server.address()
          if (address === null || typeof address === 'string') {
            reject(new Error('luban-auth: unable to determine sidecar listen port'))
            return
          }
          this.#listenPort = address.port
          server.on('error', (error): void => this.#onError(error))
          resolve()
        })
      })
    } catch (error: unknown) {
      this.#server = undefined
      server.closeAllConnections()
      throw error
    }
    return {
      publicUrl: `http://${this.#config.host}:${String(this.#listenPort)}`,
      upstreamUrl: this.#upstream.origin,
    }
  }

  public async stop(): Promise<void> {
    const server = this.#server
    if (server === undefined) return
    this.#server = undefined
    this.#listenPort = undefined
    for (const request of this.#upstreamRequests) request.destroy()
    this.#upstreamRequests.clear()
    server.closeAllConnections()
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
    await new Promise<void>((resolve): void => {
      server.close((): void => resolve())
    })
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const security = inspectRequestSecurity(request, this.#config, this.#trustedHostnames)
    const target = requestTarget(request)

    if (target.pathname === LOGIN_ROUTE) {
      await this.#handleLogin(request, response, target, security)
      return
    }
    if (isPublicStaticRequest(request.method, target.pathname)) {
      assertProxyBodySize(request, this.#config.maxProxyBodyBytes)
      await this.#proxyHttp(request, response, target, security)
      return
    }

    const authenticated = await this.#authenticate(request)
    if (authenticated === null) {
      this.#denyUnauthenticated(request, response, target)
      return
    }
    const csrfHeader = singleHeader(request, 'x-luban-csrf')
    const csrfValid = this.#manager.verifyCsrf(authenticated.csrfHash, csrfHeader)

    if (target.pathname === SESSION_ROUTE) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        this.#methodNotAllowed(response, 'GET, HEAD')
        return
      }
      const csrfCookie = readCookie(request.headers.cookie, CSRF_COOKIE_NAME)
      const body: Record<string, unknown> = {
        user: authenticated.session.user,
        role: authenticated.session.role,
        issuedAt: authenticated.session.issuedAt,
        expiresAt: authenticated.session.expiresAt,
      }
      if (this.#manager.verifyCsrf(authenticated.csrfHash, csrfCookie)) body.csrfToken = csrfCookie
      sendJson(response, 200, body)
      return
    }
    if (target.pathname === LOGOUT_ROUTE) {
      if (request.method !== 'POST') {
        this.#methodNotAllowed(response, 'POST')
        return
      }
      assertRequestOrigin(request, security, csrfValid)
      await this.#manager.revoke(authenticated.session.id)
      sendJson(
        response,
        200,
        { ok: true },
        { 'set-cookie': clearAuthCookies(this.#cookieIsSecure(security)) },
      )
      return
    }
    if (target.pathname === REVOKE_ALL_ROUTE) {
      await this.#handleRevokeAll(request, response, security, authenticated, csrfValid)
      return
    }
    if (target.pathname === USERS_ROUTE) {
      await this.#handleUserProvision(request, response, security, authenticated, csrfValid)
      return
    }
    if (target.pathname.startsWith(`${AUTH_ROOT}/`)) {
      throw new HttpError(404, 'E_NOT_FOUND', 'Authentication route not found')
    }

    assertRequestOrigin(request, security, csrfValid)
    assertProxyBodySize(request, this.#config.maxProxyBodyBytes)
    const queryDenial = await this.#firstSessionScopeDenial(
      authenticated.session.accountId,
      sessionIdsFromSearchParams(target.searchParams),
    )
    if (queryDenial !== null) throw accountScopeHttpError(queryDenial)
    if (
      request.method === 'GET' &&
      (target.pathname === DSH_MUX_ROUTE || target.pathname === DSH_HOST_EVENTS_ROUTE)
    ) {
      await this.#proxyDshEventStream(
        request,
        response,
        target,
        security,
        authenticated.session.accountId,
      )
      return
    }
    if (request.method === 'POST' && target.pathname.startsWith(DSH_API_ROOT)) {
      await this.#proxyDshApi(request, response, target, security, authenticated.session.accountId)
      return
    }
    await this.#proxyHttp(request, response, target, security)
  }

  async #handleLogin(
    request: IncomingMessage,
    response: ServerResponse,
    target: URL,
    security: RequestSecurityContext,
  ): Promise<void> {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const initialized = await this.#manager.hasUsers()
      const html = renderLoginPage(
        safeReturnTo(target.searchParams.get('returnTo')),
        initialized,
        '',
        this.#config.bootstrapAdminPasswordEnv,
      )
      const payload = Buffer.from(html, 'utf8')
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(payload.length),
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      })
      response.end(request.method === 'HEAD' ? undefined : payload)
      return
    }
    if (request.method !== 'POST') {
      this.#methodNotAllowed(response, 'GET, HEAD, POST')
      return
    }
    assertLoginOrigin(request, security)
    const contentType = singleHeader(request, 'content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase()
    const body =
      contentType === 'application/x-www-form-urlencoded'
        ? await readBoundedForm(request, this.#config.maxAuthBodyBytes)
        : await readBoundedJson(request, this.#config.maxAuthBodyBytes)
    const username = body.user
    const password = body.password
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new HttpError(400, 'E_INVALID_INPUT', 'user and password are required')
    }
    const result = await this.#manager.verify(username, password, security.sourceIp)
    if (!result.ok) {
      const status = result.reason === 'locked' ? 429 : 401
      const headers =
        result.retryAfterSec === undefined ? {} : { 'retry-after': String(result.retryAfterSec) }
      if (contentType === 'application/x-www-form-urlencoded' || wantsHtml(request)) {
        const payload = Buffer.from(
          renderLoginPage(
            safeReturnTo(body.returnTo),
            true,
            'Invalid credentials or account temporarily unavailable.',
            this.#config.bootstrapAdminPasswordEnv,
          ),
          'utf8',
        )
        response.writeHead(status, {
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(payload.length),
          ...headers,
        })
        response.end(payload)
      } else {
        sendJson(
          response,
          status,
          { error: 'E_BAD_CREDENTIALS', message: 'Invalid credentials' },
          headers,
        )
      }
      return
    }
    const issued = await this.#manager.issueBrowserSession(username, security.sourceIp)
    const returnTo = safeReturnTo(body.returnTo)
    const cookies = issueAuthCookies(
      issued.cookieToken,
      issued.csrfToken,
      Math.max(1, Math.floor((issued.session.expiresAt - issued.session.issuedAt) / 1_000)),
      this.#cookieIsSecure(security),
    )
    if (contentType === 'application/x-www-form-urlencoded' || wantsHtml(request)) {
      response.writeHead(303, {
        'cache-control': 'no-store',
        location: returnTo,
        'set-cookie': cookies,
      })
      response.end()
      return
    }
    sendJson(
      response,
      200,
      {
        ok: true,
        user: issued.session.user,
        role: issued.session.role,
        expiresAt: issued.session.expiresAt,
      },
      { 'set-cookie': cookies },
    )
  }

  async #handleRevokeAll(
    request: IncomingMessage,
    response: ServerResponse,
    security: RequestSecurityContext,
    authenticated: ManagerAuthentication,
    csrfValid: boolean,
  ): Promise<void> {
    if (request.method !== 'POST') {
      this.#methodNotAllowed(response, 'POST')
      return
    }
    if (authenticated.session.role !== 'admin') {
      throw new HttpError(403, 'E_FORBIDDEN', 'Administrator role is required')
    }
    assertRequestOrigin(request, security, csrfValid)
    const body = await readBoundedJson(request, this.#config.maxAuthBodyBytes)
    const user = body.user ?? authenticated.session.user
    if (typeof user !== 'string')
      throw new HttpError(400, 'E_INVALID_INPUT', 'user must be a string')
    try {
      await this.#manager.revokeAllFor(user)
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        throw new HttpError(400, 'E_INVALID_INPUT', 'user is invalid')
      }
      throw error
    }
    const clearCurrent = user.trim().toLowerCase() === authenticated.session.user
    sendJson(
      response,
      200,
      { ok: true, user: user.trim().toLowerCase() },
      clearCurrent ? { 'set-cookie': clearAuthCookies(this.#cookieIsSecure(security)) } : {},
    )
  }

  async #handleUserProvision(
    request: IncomingMessage,
    response: ServerResponse,
    security: RequestSecurityContext,
    authenticated: ManagerAuthentication,
    csrfValid: boolean,
  ): Promise<void> {
    if (request.method !== 'POST') {
      this.#methodNotAllowed(response, 'POST')
      return
    }
    if (authenticated.session.role !== 'admin') {
      throw new HttpError(403, 'E_FORBIDDEN', 'Administrator role is required')
    }
    assertRequestOrigin(request, security, csrfValid)
    const body = await readBoundedJson(request, this.#config.maxAuthBodyBytes)
    if (
      typeof body.user !== 'string' ||
      typeof body.password !== 'string' ||
      !isAuthRole(body.role)
    ) {
      throw new HttpError(400, 'E_INVALID_INPUT', 'user, password, and role are required')
    }
    let account: Awaited<ReturnType<AuthManager['provisionUser']>>
    try {
      account = await this.#manager.provisionUser(
        authenticated.session.id,
        body.user,
        body.password,
        body.role,
      )
    } catch (error: unknown) {
      if (error instanceof TypeError) {
        throw new HttpError(400, 'E_INVALID_INPUT', 'user or password is invalid')
      }
      if (error instanceof Error && error.message.includes('already exists')) {
        throw new HttpError(409, 'E_CONFLICT', 'user already exists')
      }
      if (error instanceof Error && error.message.includes('administrator session')) {
        throw new HttpError(403, 'E_FORBIDDEN', 'Administrator session is no longer active')
      }
      throw error
    }
    sendJson(response, 201, {
      user: account.username,
      role: account.role,
      createdAt: account.createdAt,
    })
  }

  async #authenticate(
    request: IncomingMessage,
  ): Promise<Awaited<ReturnType<AuthManager['authenticateToken']>>> {
    return this.#manager.authenticateToken(readCookie(request.headers.cookie, AUTH_COOKIE_NAME))
  }

  #denyUnauthenticated(request: IncomingMessage, response: ServerResponse, target: URL): void {
    if ((request.method === 'GET' || request.method === 'HEAD') && wantsHtml(request)) {
      const returnTo = `${target.pathname}${target.search}`
      response.writeHead(302, {
        'cache-control': 'no-store',
        location: `${LOGIN_ROUTE}?returnTo=${encodeURIComponent(returnTo)}`,
      })
      response.end()
      return
    }
    sendJson(response, 401, { error: 'E_AUTH_REQUIRED', message: 'Authentication required' })
  }

  #methodNotAllowed(response: ServerResponse, allowed: string): void {
    sendJson(
      response,
      405,
      { error: 'E_METHOD_NOT_ALLOWED', message: 'Method not allowed' },
      { allow: allowed },
    )
  }

  #cookieIsSecure(security: RequestSecurityContext): boolean {
    if (this.#config.secureCookies === 'always') return true
    if (this.#config.secureCookies === 'never') return false
    return security.protocol === 'https'
  }

  async #firstSessionScopeDenial(
    accountId: AccountId,
    sessionIds: Iterable<string>,
  ): Promise<SessionScopeDenial | null> {
    for (const sessionId of new Set(sessionIds)) {
      const owner = await this.#manager.dshSessionOwner(asSessionId(sessionId))
      if (owner === accountId) continue
      return { sessionId, reason: owner === null ? 'unbound' : 'foreign' }
    }
    return null
  }

  async #dshSessionOwnerAfterOperations(
    accountId: AccountId,
    sessionId: SessionId,
  ): Promise<AccountId | null> {
    let owner = await this.#manager.dshSessionOwner(sessionId)
    while (owner === null && (await this.#dshSessionOperations.waitForChange(accountId))) {
      owner = await this.#manager.dshSessionOwner(sessionId)
    }
    return owner
  }

  async #proxyDshApi(
    request: IncomingMessage,
    response: ServerResponse,
    target: URL,
    security: RequestSecurityContext,
    accountId: AccountId,
  ): Promise<void> {
    const body = await readBoundedBody(request, this.#config.maxProxyBodyBytes)
    const message = parseJsonRecord(body)
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : undefined
    const method = dshMethodFromPath(target.pathname)
    const sessionIds = dshRequestSessionIds(method, message)
    const denial = await this.#firstSessionScopeDenial(accountId, sessionIds)
    if (denial !== null) {
      if (target.pathname === DSH_RESPOND_ROUTE) {
        sendDshRespondDenied(response)
        return
      }
      if (rpcId === undefined) throw accountScopeHttpError(denial)
      sendDshScopeError(response, rpcId, denial)
      return
    }
    if (
      target.pathname === DSH_RESPOND_ROUTE &&
      sessionIds.length === 0 &&
      isQuestionCancellation(message) &&
      (rpcId === undefined || this.#dshEventScope.ownerOfQuestionRpc(rpcId) !== accountId)
    ) {
      sendDshRespondDenied(response)
      return
    }
    if (rpcId !== undefined) {
      if (this.#denyDshRelationRequest(response, accountId, method, message, rpcId)) return
    }
    const settleOperation =
      method === 'session.create' || method === 'session.fork'
        ? this.#dshSessionOperations.begin(accountId)
        : undefined
    try {
      await this.#proxyBufferedDshRequest(request, response, target, security, body, {
        accountId,
        method,
        rpcId,
      })
    } finally {
      settleOperation?.()
    }
  }

  #denyDshRelationRequest(
    response: ServerResponse,
    accountId: AccountId,
    method: string | undefined,
    message: Readonly<Record<string, unknown>> | null,
    rpcId: string,
  ): boolean {
    const args = asRecord(asRecord(message?.payload)?.args)
    if (method === 'dynamicCordisRunner/invoke' && typeof args?.pluginId === 'string') {
      if (this.#dshEventScope.ownerOfPlugin(args.pluginId) === accountId) return false
      sendDshRpcValue(response, rpcId, {
        ok: false,
        code: 'plugin-not-running',
        message: 'Dynamic plugin is not running',
      })
      return true
    }
    if (method === 'dynamicCordisRunner/resolveRequestRun' && typeof args?.requestId === 'string') {
      if (this.#dshEventScope.ownerOfRunRequest(args.requestId) === accountId) return false
      sendDshRpcValue(response, rpcId, { accepted: false })
      return true
    }
    return false
  }

  async #proxyBufferedDshRequest(
    request: IncomingMessage,
    response: ServerResponse,
    target: URL,
    security: RequestSecurityContext,
    body: Buffer,
    context: DshRequestContext,
  ): Promise<void> {
    const headers = buildProxyHeaders(request.headers, security, this.#upstream, false)
    headers['accept-encoding'] = 'identity'
    headers['content-length'] = String(body.length)
    const rewriteResponse =
      context.method !== undefined &&
      (DSH_FILTERED_UNARY_METHODS.has(context.method) || context.method.startsWith('workspace.'))
    await this.#proxyUpstream(
      request,
      target,
      headers,
      (upstreamRequest): void => {
        upstreamRequest.end(body)
      },
      async (upstreamResponse): Promise<void> => {
        if (!rewriteResponse) {
          writeProxyResponseHead(response, upstreamResponse, this.#upstream, security)
          await pipeline(upstreamResponse, response)
          return
        }
        const upstreamBody = await readBoundedBody(upstreamResponse, this.#config.maxProxyBodyBytes)
        const rewritten = await this.#rewriteDshUnaryResponse(context, upstreamBody)
        const responseHeaders = filterResponseHeaders(upstreamResponse.headers)
        responseHeaders['content-length'] = String(rewritten.body.length)
        if (rewritten.changed) {
          delete responseHeaders['content-encoding']
          delete responseHeaders.etag
          delete responseHeaders['content-md5']
        }
        if (upstreamResponse.statusMessage === undefined) {
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
        } else {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            upstreamResponse.statusMessage,
            responseHeaders,
          )
        }
        response.end(rewritten.body)
      },
    )
  }

  async #rewriteDshUnaryResponse(context: DshRequestContext, body: Buffer): Promise<BodyRewrite> {
    const message = parseJsonRecord(body)
    if (
      message?.type !== 'server-response' ||
      typeof message.rpcId !== 'string' ||
      message.rpcId !== context.rpcId
    ) {
      return { body, changed: false }
    }
    const result = asRecord(message.result)
    if (result === null) return { body, changed: false }
    const method = context.method
    if ((method === 'session.create' || method === 'session.fork') && result.ok === false) {
      const error = asRecord(result.error)
      const details = asRecord(error?.details)
      if (error?.code === 'workspace-attach-failed' && typeof details?.sessionId === 'string') {
        const denial = await this.#bindCreatedSession(context.accountId, details.sessionId)
        if (denial !== null) {
          return { body: dshScopeErrorBody(message.rpcId, denial), changed: true }
        }
      }
      return { body, changed: false }
    }
    if (result.ok !== true) return { body, changed: false }

    if (method === 'sessionReferenceResolver/candidates') {
      const candidates = result.value
      if (!Array.isArray(candidates)) return { body, changed: false }
      const filtered = await this.#filterOwnedSessionRows(context.accountId, candidates)
      return filtered.length === candidates.length
        ? { body, changed: false }
        : rewriteDshResponseValue(message, result, filtered)
    }

    if (method === 'dynamicCordisRunner/inventory') {
      const inventory = result.value
      if (!Array.isArray(inventory)) return { body, changed: false }
      const filtered: unknown[] = []
      for (const item of inventory) {
        const row = asRecord(item)
        if (typeof row?.agentId !== 'string' || typeof row.pluginId !== 'string') continue
        const owner = await this.#manager.dshSessionOwner(asSessionId(row.agentId))
        if (owner !== context.accountId) continue
        const latestRun = asRecord(row.latestRun)
        const approvalRequestId =
          typeof latestRun?.approvalRequestId === 'string' ? latestRun.approvalRequestId : undefined
        this.#dshEventScope.rememberPluginOwner(row.pluginId, context.accountId, approvalRequestId)
        filtered.push(item)
      }
      return filtered.length === inventory.length
        ? { body, changed: false }
        : rewriteDshResponseValue(message, result, filtered)
    }

    const value = asRecord(result.value)
    if (value === null) return { body, changed: false }

    if (method === 'subagent.list') {
      if (!Array.isArray(value.entries)) return { body, changed: false }
      for (const entry of value.entries) {
        const childId = asRecord(entry)?.id
        if (typeof childId !== 'string') continue
        const childDenial = await this.#bindCreatedSession(context.accountId, childId)
        if (childDenial !== null) {
          return { body: dshScopeErrorBody(message.rpcId, childDenial), changed: true }
        }
      }
      return { body, changed: false }
    }

    if (method === 'session.create' || method === 'session.fork') {
      if (typeof value.sessionId !== 'string') return { body, changed: false }
      const denial = await this.#bindCreatedSession(context.accountId, value.sessionId)
      return denial === null
        ? { body, changed: false }
        : { body: dshScopeErrorBody(message.rpcId, denial), changed: true }
    }

    if (method === 'session.list' || method === 'session.search') {
      if (!Array.isArray(value.items)) return { body, changed: false }
      const items = await this.#filterOwnedSessionRows(context.accountId, value.items)
      if (items.length === value.items.length) return { body, changed: false }
      return rewriteDshResponseValue(message, result, { ...value, items })
    }

    if (method?.startsWith('workspace.') === true) {
      const rewrittenValue = await rewriteSessionIdArrays(
        value,
        async (sessionId): Promise<boolean> => {
          return (await this.#manager.dshSessionOwner(asSessionId(sessionId))) === context.accountId
        },
      )
      if (!rewrittenValue.changed) return { body, changed: false }
      return {
        body: Buffer.from(
          JSON.stringify({ ...message, result: { ...result, value: rewrittenValue.value } }),
          'utf8',
        ),
        changed: true,
      }
    }
    return { body, changed: false }
  }

  async #filterOwnedSessionRows(
    accountId: AccountId,
    rows: readonly unknown[],
  ): Promise<unknown[]> {
    const keep = await Promise.all(
      rows.map(async (row): Promise<boolean> => {
        const sessionId = asRecord(row)?.sessionId
        return (
          typeof sessionId === 'string' &&
          (await this.#manager.dshSessionOwner(asSessionId(sessionId))) === accountId
        )
      }),
    )
    return rows.filter((_row, index) => keep[index] === true)
  }

  async #bindCreatedSession(
    accountId: AccountId,
    sessionId: string,
  ): Promise<SessionScopeDenial | null> {
    const owner = await this.#manager.dshSessionOwner(asSessionId(sessionId))
    if (owner === accountId) return null
    if (owner !== null) return { sessionId, reason: 'foreign' }
    try {
      await this.#manager.bindDshSession(accountId, asSessionId(sessionId))
      return null
    } catch (error: unknown) {
      if (errorCode(error) === 'E_ACCOUNT_SCOPE_MISMATCH') {
        return { sessionId, reason: 'foreign' }
      }
      throw error
    }
  }

  async #proxyDshEventStream(
    request: IncomingMessage,
    response: ServerResponse,
    target: URL,
    security: RequestSecurityContext,
    accountId: AccountId,
  ): Promise<void> {
    const channel: DshEventChannel = target.pathname === DSH_MUX_ROUTE ? 'mux' : 'host'
    const headers = buildProxyHeaders(request.headers, security, this.#upstream, false)
    headers['accept-encoding'] = 'identity'
    await this.#proxyUpstream(
      request,
      target,
      headers,
      (upstreamRequest): void => {
        upstreamRequest.end()
      },
      async (upstreamResponse): Promise<void> => {
        writeProxyResponseHead(response, upstreamResponse, this.#upstream, security)
        const filter = new DshSseFilter((block): Promise<string | null> =>
          this.#filterDshEventBlock(accountId, channel, block),
        )
        await pipeline(upstreamResponse, filter, response)
      },
      'luban-auth: upstream event proxy failed',
    )
  }

  async #filterDshEventBlock(
    accountId: AccountId,
    channel: DshEventChannel,
    block: string,
  ): Promise<string | null> {
    const data = sseData(block)
    if (data === null) return block
    const serialized = Buffer.from(data, 'utf8')
    const filtered = await this.#dshEventScope.filter(accountId, channel, serialized)
    if (filtered === null) return null
    return filtered === serialized ? block : `data: ${filtered.toString('utf8')}`
  }

  async #proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    target: URL,
    security: RequestSecurityContext,
  ): Promise<void> {
    const headers = buildProxyHeaders(request.headers, security, this.#upstream, false)
    const limiter = new BodyLimitTransform(this.#config.maxProxyBodyBytes)
    await this.#proxyUpstream(
      request,
      target,
      headers,
      (upstreamRequest, fail): void => {
        pipeline(request, limiter, upstreamRequest).catch(fail)
      },
      async (upstreamResponse): Promise<void> => {
        writeProxyResponseHead(response, upstreamResponse, this.#upstream, security)
        await pipeline(upstreamResponse, response)
      },
    )
  }

  async #proxyUpstream(
    request: IncomingMessage,
    target: URL,
    headers: OutgoingHttpHeaders,
    send: (request: ClientRequest, fail: (error: unknown) => void) => void,
    receive: (response: IncomingMessage) => Promise<void>,
    failureMessage = 'luban-auth: upstream proxy failed',
  ): Promise<void> {
    const transport = this.#upstream.protocol === 'https:' ? httpsRequest : httpRequest
    await new Promise<void>((resolve, reject): void => {
      let settled = false
      const settle = (error?: unknown): void => {
        if (settled) return
        settled = true
        this.#upstreamRequests.delete(upstreamRequest)
        if (error === undefined) resolve()
        else reject(error instanceof Error ? error : new Error(failureMessage, { cause: error }))
      }
      const upstreamRequest = transport(
        {
          protocol: this.#upstream.protocol,
          hostname: this.#upstream.hostname,
          port: upstreamPort(this.#upstream),
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers,
          agent: false,
        },
        (upstreamResponse): void => {
          void receive(upstreamResponse).then(
            (): void => settle(),
            (error: unknown): void => settle(error),
          )
        },
      )
      this.#upstreamRequests.add(upstreamRequest)
      upstreamRequest.once('error', settle)
      try {
        send(upstreamRequest, settle)
      } catch (error: unknown) {
        settle(error)
      }
    })
  }

  async #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const security = inspectRequestSecurity(request, this.#config, this.#trustedHostnames)
    const target = requestTarget(request)
    const authenticated = await this.#authenticate(request)
    if (authenticated === null)
      throw new HttpError(401, 'E_AUTH_REQUIRED', 'Authentication required')
    assertWebSocketOrigin(request, security)
    const headers = buildProxyHeaders(request.headers, security, this.#upstream, true)
    const upstreamSocket = await connectUpstream(this.#upstream)
    this.#sockets.add(upstreamSocket)
    upstreamSocket.once('close', (): void => {
      this.#sockets.delete(upstreamSocket)
    })
    const requestLine = `${request.method ?? 'GET'} ${target.pathname}${target.search} HTTP/${request.httpVersion}\r\n`
    upstreamSocket.write(requestLine)
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) {
        upstreamSocket.write(`${name}: ${String(item)}\r\n`)
      }
    }
    upstreamSocket.write('\r\n')
    if (head.length > 0) upstreamSocket.write(head)
    socket.once('close', (): void => {
      upstreamSocket.destroy()
    })
    upstreamSocket.once('close', (): void => {
      socket.destroy()
    })
    socket.once('error', (): void => {
      upstreamSocket.destroy()
    })
    upstreamSocket.once('error', (): void => {
      socket.destroy()
    })
    socket.pipe(upstreamSocket).pipe(socket)
  }

  #handleHttpError(error: unknown, response: ServerResponse): void {
    const normalized = error instanceof Error ? error : new Error(String(error))
    if (!(error instanceof HttpError)) this.#onError(normalized)
    if (response.headersSent) {
      response.destroy(normalized)
      return
    }
    const status = error instanceof HttpError ? error.status : 502
    const code = error instanceof HttpError ? error.code : 'E_UPSTREAM_UNAVAILABLE'
    const message = error instanceof HttpError ? error.message : 'Upstream unavailable'
    sendJson(response, status, { error: code, message })
  }

  #writeSocketError(socket: Duplex, error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error))
    if (!(error instanceof HttpError)) this.#onError(normalized)
    if (!socket.destroyed && socket.writable) {
      const status = error instanceof HttpError ? error.status : 502
      const phrase = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Gateway'
      socket.end(
        `HTTP/1.1 ${String(status)} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      )
      return
    }
    socket.destroy()
  }
}

class DshSseFilter extends Transform {
  readonly #decoder = new StringDecoder('utf8')
  readonly #filter: (block: string) => Promise<string | null>
  #buffer = ''

  public constructor(filter: (block: string) => Promise<string | null>) {
    super()
    this.#filter = filter
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.#buffer += this.#decoder.write(chunk)
    this.#drainCompleteBlocks().then(
      (): void => callback(),
      (error: unknown): void => callback(error instanceof Error ? error : new Error(String(error))),
    )
  }

  public override _flush(callback: TransformCallback): void {
    this.#buffer += this.#decoder.end()
    void (async (): Promise<void> => {
      await this.#drainCompleteBlocks()
      if (this.#buffer === '') return
      const filtered = await this.#filter(this.#buffer)
      this.#buffer = ''
      if (filtered !== null) this.push(filtered)
    })().then(
      (): void => callback(),
      (error: unknown): void => callback(error instanceof Error ? error : new Error(String(error))),
    )
  }

  async #drainCompleteBlocks(): Promise<void> {
    let boundary = /\r?\n\r?\n/u.exec(this.#buffer)
    while (boundary !== null) {
      const block = this.#buffer.slice(0, boundary.index)
      this.#buffer = this.#buffer.slice(boundary.index + boundary[0].length)
      const filtered = await this.#filter(block)
      if (filtered !== null) this.push(`${filtered}\n\n`)
      boundary = /\r?\n\r?\n/u.exec(this.#buffer)
    }
  }
}

class BodyLimitTransform extends Transform {
  readonly #maximumBytes: number
  #receivedBytes = 0

  public constructor(maximumBytes: number) {
    super()
    this.#maximumBytes = maximumBytes
  }

  public override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.#receivedBytes += chunk.length
    if (this.#receivedBytes > this.#maximumBytes) {
      callback(new HttpError(413, 'E_BODY_TOO_LARGE', 'Request body exceeds the configured limit'))
      return
    }
    callback(undefined, chunk)
  }
}

function requestTarget(request: IncomingMessage): URL {
  try {
    return new URL(request.url ?? '/', 'http://sidecar.invalid')
  } catch {
    throw new HttpError(400, 'E_INVALID_URL', 'Invalid request target')
  }
}

async function readBoundedBody(
  stream: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let receivedBytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk)
    receivedBytes += buffer.length
    if (receivedBytes > maximumBytes) {
      throw new HttpError(413, 'E_BODY_TOO_LARGE', 'Request body exceeds the configured limit')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, receivedBytes)
}

function parseJsonRecord(body: Buffer): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(body.toString('utf8')) as unknown)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isQuestionCancellation(message: Readonly<Record<string, unknown>> | null): boolean {
  if (message?.type !== 'client-response') return false
  const result = asRecord(message.result)
  const error = asRecord(result?.error)
  return result?.ok === false && error?.code === 'cancelled'
}

function sessionIdsFromSearchParams(params: URLSearchParams): string[] {
  const ids: string[] = []
  for (const [key, value] of params) {
    if (/sessionids?$/iu.test(key) && value !== '') ids.push(value)
  }
  return ids
}

async function rewriteSessionIdArrays(
  value: unknown,
  keep: (sessionId: string) => Promise<boolean>,
): Promise<{ readonly value: unknown; readonly changed: boolean }> {
  if (Array.isArray(value)) {
    const rewritten = await Promise.all(value.map((item) => rewriteSessionIdArrays(item, keep)))
    const changed = rewritten.some((item) => item.changed)
    return { value: changed ? rewritten.map((item) => item.value) : value, changed }
  }
  const record = asRecord(value)
  if (record === null) return { value, changed: false }
  let changed = false
  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(record)) {
    if (/sessionids$/iu.test(key) && Array.isArray(nested)) {
      const decisions = await Promise.all(
        nested.map(
          async (item): Promise<boolean> => typeof item !== 'string' || (await keep(item)),
        ),
      )
      const filtered = nested.filter((_item, index) => decisions[index] === true)
      result[key] = filtered
      changed ||= filtered.length !== nested.length
      continue
    }
    const rewritten = await rewriteSessionIdArrays(nested, keep)
    result[key] = rewritten.value
    changed ||= rewritten.changed
  }
  return { value: changed ? result : value, changed }
}

function sseData(block: string): string | null {
  const parts = block
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
  return parts.length === 0 ? null : parts.join('')
}

function accountScopeHttpError(denial: SessionScopeDenial): HttpError {
  return new HttpError(404, 'E_ACCOUNT_SCOPE_MISMATCH', accountScopeMessage(denial))
}

function accountScopeMessage(denial: SessionScopeDenial): string {
  return denial.reason === 'unbound'
    ? `DSH session ${JSON.stringify(denial.sessionId)} has no account owner`
    : `DSH session ${JSON.stringify(denial.sessionId)} belongs to another account`
}

function dshScopeErrorBody(rpcId: string, denial: SessionScopeDenial): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: 'server-response',
      rpcId,
      result: {
        ok: false,
        error: {
          code: 'session-not-found',
          message: `E_ACCOUNT_SCOPE_MISMATCH: ${accountScopeMessage(denial)}`,
          details: { sessionId: denial.sessionId },
        },
      },
    }),
    'utf8',
  )
}

function sendDshScopeError(
  response: ServerResponse,
  rpcId: string,
  denial: SessionScopeDenial,
): void {
  const body = dshScopeErrorBody(rpcId, denial)
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  })
  response.end(body)
}

function sendDshRespondDenied(response: ServerResponse): void {
  sendJson(response, 200, { accepted: false, reason: 'not-pending' })
}

function sendDshRpcValue(response: ServerResponse, rpcId: string, value: unknown): void {
  const body = Buffer.from(
    JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }),
    'utf8',
  )
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  })
  response.end(body)
}

function rewriteDshResponseValue(
  message: Readonly<Record<string, unknown>>,
  result: Readonly<Record<string, unknown>>,
  value: unknown,
): BodyRewrite {
  return {
    body: Buffer.from(JSON.stringify({ ...message, result: { ...result, value } }), 'utf8'),
    changed: true,
  }
}

function errorCode(error: unknown): string | undefined {
  const record = asRecord(error)
  return typeof record?.code === 'string' ? record.code : undefined
}

function writeProxyResponseHead(
  response: ServerResponse,
  upstreamResponse: IncomingMessage,
  upstream: URL,
  security: RequestSecurityContext,
): void {
  const responseHeaders = filterResponseHeaders(upstreamResponse.headers)
  const location = responseHeaders.location
  if (typeof location === 'string') {
    responseHeaders.location = rewriteUpstreamLocation(location, upstream, security)
  }
  if (upstreamResponse.statusMessage === undefined) {
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
  } else {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      responseHeaders,
    )
  }
}

function buildProxyHeaders(
  source: IncomingHttpHeaders,
  security: RequestSecurityContext,
  upstream: URL,
  upgrade: boolean,
): OutgoingHttpHeaders {
  const connectionTokens = new Set(
    typeof source.connection === 'string'
      ? source.connection.split(',').map((value) => value.trim().toLowerCase())
      : [],
  )
  const result: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase()
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower))
      continue
    if (lower === 'host' || lower.startsWith('x-forwarded-')) continue
    result[lower] = value
  }
  result.host = upstream.host
  result['x-forwarded-for'] = security.sourceIp
  result['x-forwarded-host'] = security.authority
  result['x-forwarded-proto'] = security.protocol
  if (typeof source.origin === 'string') {
    result.origin = rewriteExternalOrigin(source.origin, upstream, security)
  }
  if (upgrade) {
    result.connection = 'Upgrade'
    result.upgrade = typeof source.upgrade === 'string' ? source.upgrade : 'websocket'
  }
  return result
}

function filterResponseHeaders(source: IncomingHttpHeaders): OutgoingHttpHeaders {
  const connectionTokens = new Set(
    typeof source.connection === 'string'
      ? source.connection.split(',').map((value) => value.trim().toLowerCase())
      : [],
  )
  const result: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase()
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower))
      continue
    result[lower] = value
  }
  return result
}

function issueAuthCookies(
  token: string,
  csrfToken: string,
  maxAgeSeconds: number,
  secure: boolean,
): string[] {
  const secureAttribute = secure ? '; Secure' : ''
  return [
    `${AUTH_COOKIE_NAME}=${token}; Path=/; Max-Age=${String(maxAgeSeconds)}; HttpOnly; SameSite=Lax${secureAttribute}`,
    `${CSRF_COOKIE_NAME}=${csrfToken}; Path=/; Max-Age=${String(maxAgeSeconds)}; SameSite=Lax${secureAttribute}`,
  ]
}

function clearAuthCookies(secure: boolean): string[] {
  const secureAttribute = secure ? '; Secure' : ''
  return [...SENSITIVE_COOKIE_NAMES].map(
    (name) =>
      `${name}=; Path=/; Max-Age=0; SameSite=Lax${name === AUTH_COOKIE_NAME ? '; HttpOnly' : ''}${secureAttribute}`,
  )
}

function renderLoginPage(
  returnTo: string,
  initialized: boolean,
  error = '',
  passwordEnvironment = 'LUBAN_ADMIN_PASSWORD',
): string {
  const escapedReturnTo = escapeHtml(returnTo)
  const state = initialized
    ? `<form method="post" action="${LOGIN_ROUTE}">
        <input type="hidden" name="returnTo" value="${escapedReturnTo}">
        <label>Username<input name="user" autocomplete="username" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" minlength="8" required></label>
        <button type="submit">Sign in</button>
      </form>`
    : `<p class="notice">No administrator exists. Set <code>${escapeHtml(passwordEnvironment)}</code>, restart DSH once, then remove the environment variable.</p>`
  const errorMarkup = error === '' ? '' : `<p class="error" role="alert">${escapeHtml(error)}</p>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Luban sign in</title><style>
body{font:16px system-ui;background:#10151d;color:#edf3fa;display:grid;place-items:center;min-height:100vh;margin:0}
main{width:min(24rem,calc(100% - 2rem));background:#18222e;padding:2rem;border-radius:1rem;box-shadow:0 1rem 3rem #0008}
label{display:grid;gap:.4rem;margin:1rem 0}input,button{font:inherit;padding:.7rem;border-radius:.45rem;border:1px solid #65758b}
button{width:100%;background:#4e9df5;color:#07111e;border:0;font-weight:700}.error{color:#ffb2b2}.notice{line-height:1.5}code{color:#9dccff}
</style></head><body><main><h1>Luban</h1>${errorMarkup}${state}</main></body></html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function isAuthRole(value: unknown): value is AuthRole {
  return value === 'admin' || value === 'operator' || value === 'observer'
}

function upstreamPort(url: URL): number {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

function rewriteExternalOrigin(
  origin: string,
  upstream: URL,
  security: RequestSecurityContext,
): string {
  try {
    const candidate = new URL(origin)
    const external = new URL(`${security.protocol}://${security.authority}`)
    return candidate.origin === external.origin ? upstream.origin : origin
  } catch {
    return origin
  }
}

function rewriteUpstreamLocation(
  location: string,
  upstream: URL,
  security: RequestSecurityContext,
): string {
  let candidate: URL
  try {
    candidate = new URL(location)
  } catch {
    return location
  }
  if (candidate.origin !== upstream.origin) return location
  return `${security.protocol}://${security.authority}${candidate.pathname}${candidate.search}${candidate.hash}`
}

async function connectUpstream(url: URL): Promise<Socket> {
  const port = upstreamPort(url)
  return new Promise<Socket>((resolve, reject): void => {
    const socket =
      url.protocol === 'https:'
        ? tlsConnect({
            host: url.hostname,
            port,
            ...(isIP(url.hostname) === 0 ? { servername: url.hostname } : {}),
          })
        : netConnect({ host: url.hostname, port })
    const event = url.protocol === 'https:' ? 'secureConnect' : 'connect'
    socket.once('error', reject)
    socket.once(event, (): void => {
      socket.off('error', reject)
      socket.on('error', (): void => {
        socket.destroy()
      })
      resolve(socket)
    })
  })
}
