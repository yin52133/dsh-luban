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
import type { AuthManager } from './auth-manager.js'
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

/** Global authentication gateway in front of the loopback-only DSH WebServer. */
export class AuthSidecar implements AuthGateway {
  readonly #config: LubanAuthConfig
  readonly #upstream: URL
  readonly #manager: AuthManager
  readonly #trustedHostnames: ReadonlySet<string>
  readonly #onError: (error: Error) => void
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

  async #proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    target: URL,
    security: RequestSecurityContext,
  ): Promise<void> {
    const headers = buildProxyHeaders(request.headers, security, this.#upstream, false)
    const transport = this.#upstream.protocol === 'https:' ? httpsRequest : httpRequest
    await new Promise<void>((resolve, reject): void => {
      let settled = false
      const settle = (error?: unknown): void => {
        if (settled) return
        settled = true
        this.#upstreamRequests.delete(upstreamRequest)
        if (error === undefined) resolve()
        else
          reject(
            error instanceof Error
              ? error
              : new Error('luban-auth: upstream proxy failed', { cause: error }),
          )
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
          const responseHeaders = filterResponseHeaders(upstreamResponse.headers)
          const location = responseHeaders.location
          if (typeof location === 'string') {
            responseHeaders.location = rewriteUpstreamLocation(location, this.#upstream, security)
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
          upstreamResponse.once('error', settle)
          upstreamResponse.once('end', (): void => settle())
          upstreamResponse.pipe(response)
        },
      )
      this.#upstreamRequests.add(upstreamRequest)
      upstreamRequest.once('error', settle)
      const limiter = new BodyLimitTransform(this.#config.maxProxyBodyBytes)
      pipeline(request, limiter, upstreamRequest).catch((error: unknown): void => {
        upstreamRequest.destroy()
        settle(error)
      })
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
