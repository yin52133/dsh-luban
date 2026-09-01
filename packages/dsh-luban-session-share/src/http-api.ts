import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AccountId, AuthService, SessionId } from '@yin52133/dsh-luban-core'
import {
  LubanError,
  asAccountId,
  asActorId,
  asHostId,
  asSessionId,
  asTaskId,
  isLubanError,
  modulePrefix,
  objectRecord as record,
  readJsonBody,
  sendJson,
  sendNoContent,
  setPrivateResponseHeaders as securityHeaders,
} from '@yin52133/dsh-luban-core'
import type { SharedSessionRegistry } from './registry.js'
import type {
  AccountRole,
  AuthenticatedActor,
  SessionShareEvent,
  SessionStreamEnvelope,
} from './types.js'

const PREFIX = modulePrefix('session-share')
const MAX_BODY_BYTES = 65_536
const MAX_INPUT_CHARS = 65_536

interface DetailedAuthService extends AuthService {
  authenticateRequest?(request: IncomingMessage): Promise<
    | {
        readonly ok: true
        readonly actor: {
          readonly kind: 'user'
          readonly id: string
          readonly accountId?: string
          readonly displayName?: string
          readonly role: 'admin' | 'operator' | 'observer'
        }
      }
    | { readonly ok: false; readonly reason: string }
  >
}

interface StreamEnvelope {
  readonly id: number
  readonly event: 'registry' | 'baseline'
  readonly accountId: AccountId
  readonly data: unknown
}

interface RegistryStreamClient {
  readonly accountId: AccountId
  readonly pending: StreamEnvelope[]
  ready: boolean
  overflowed: boolean
}

function pendingEventsOverflowed(client: RegistryStreamClient): boolean {
  return client.overflowed
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LubanError('E_INVALID_INPUT', `${label} must be a non-empty string`)
  }
  if (value.length > MAX_INPUT_CHARS) {
    throw new LubanError('E_INVALID_INPUT', `${label} is too large`)
  }
  return value
}

function expectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new LubanError('E_INVALID_INPUT', 'expectedVersion must be a positive integer')
  }
  return value
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  return readJsonBody(request, MAX_BODY_BYTES, true)
}

function forbidden(message: string): LubanError {
  return new LubanError('E_AUTH_REQUIRED', message, { details: { status: 403 } })
}

function errorStatus(error: LubanError): number {
  switch (error.code) {
    case 'E_AUTH_REQUIRED':
      return error.details?.status === 403 ? 403 : 401
    case 'E_NOT_FOUND':
      return 404
    case 'E_VERSION_CONFLICT':
      return 409
    case 'E_INVALID_TRANSITION':
      return 422
    case 'E_TIMEOUT':
      return 408
    case 'E_INVALID_INPUT':
      return 400
    case 'E_UNAVAILABLE':
      return 503
    default:
      return 500
  }
}

function decodedId(value: string): SessionId {
  try {
    return asSessionId(decodeURIComponent(value))
  } catch (error: unknown) {
    throw new LubanError('E_INVALID_INPUT', 'Session id is not valid URL encoding', {
      cause: error,
    })
  }
}

async function requireIdentity(
  request: IncomingMessage,
  path: string,
  auth: DetailedAuthService,
): Promise<AuthenticatedActor> {
  if (auth.authenticateRequest !== undefined) {
    const result = await auth.authenticateRequest(request)
    if (!result.ok) throw new LubanError('E_AUTH_REQUIRED', 'Authentication is required')
    return {
      actor: {
        kind: 'user',
        id: asActorId(result.actor.id),
        accountId: asAccountId(result.actor.accountId ?? result.actor.id),
        ...(result.actor.displayName === undefined
          ? {}
          : { displayName: result.actor.displayName }),
      },
      accountId: asAccountId(result.actor.accountId ?? result.actor.id),
      accountRole: result.actor.role,
    }
  }
  const decision = await auth.middleware()({
    path,
    method: request.method ?? 'GET',
    accept: request.headers.accept,
    cookie: request.headers.cookie,
    sourceIp: request.socket.remoteAddress ?? 'unknown',
  })
  if (!decision.allowed || decision.user === undefined) {
    throw new LubanError('E_AUTH_REQUIRED', 'Authentication is required', {
      details: { status: decision.status },
    })
  }
  const accountId = decision.account?.accountId ?? asAccountId(decision.user)
  return {
    actor: {
      kind: 'user',
      id: asActorId(decision.user),
      accountId,
      displayName: decision.user,
    },
    accountId,
    accountRole: decision.account?.role ?? 'unknown',
  }
}

/** Bounded registry/takeover SSE with actor-specific baseline recovery. */
export class RegistryEventStream {
  readonly #registry: SharedSessionRegistry
  readonly #clients = new Map<ServerResponse, RegistryStreamClient>()
  readonly #events: StreamEnvelope[] = []
  readonly #unsubscribe: () => void
  readonly #heartbeat: ReturnType<typeof setInterval>
  readonly #limit: number
  #sequence = 0
  #disposed = false

  public constructor(registry: SharedSessionRegistry, limit: number) {
    this.#registry = registry
    this.#limit = limit
    this.#unsubscribe = registry.onEvent((event): void => this.publish(event))
    this.#heartbeat = setInterval((): void => {
      for (const [response, client] of [...this.#clients]) {
        if (client.ready && !response.write(': heartbeat\n\n')) this.#remove(response)
      }
    }, 15_000)
    this.#heartbeat.unref()
  }

  public publish(event: SessionShareEvent): void {
    if (this.#disposed) return
    const accountId =
      event.type === 'registry'
        ? event.accountId
        : this.#registry.getView(event.request.sessionId)?.accountId
    if (accountId === undefined) return
    const envelope: StreamEnvelope = {
      id: ++this.#sequence,
      event: 'registry',
      accountId,
      data: event.type === 'takeover' ? { type: 'takeover' } : event,
    }
    this.#events.push(envelope)
    if (this.#events.length > this.#limit) this.#events.shift()
    for (const [response, client] of [...this.#clients]) {
      if (client.accountId !== accountId) continue
      if (client.ready) this.#write(response, envelope)
      else {
        if (client.overflowed) continue
        if (client.pending.length >= this.#limit) {
          client.pending.length = 0
          client.overflowed = true
          continue
        }
        client.pending.push(envelope)
      }
    }
  }

  public async connect(
    request: IncomingMessage,
    response: ServerResponse,
    identity: AuthenticatedActor,
  ): Promise<void> {
    this.#assertAvailable()
    const raw = request.headers['last-event-id']
    const requested = Number.parseInt(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''), 10)
    const visibleEvents = this.#events.filter(
      (event): boolean => event.accountId === identity.accountId,
    )
    const oldest = visibleEvents[0]?.id ?? this.#sequence
    let baselineSequence = this.#sequence
    const baselineRequired =
      !Number.isSafeInteger(requested) || requested < oldest - 1 || requested > this.#sequence
    const client: RegistryStreamClient = {
      accountId: identity.accountId,
      pending: [],
      ready: false,
      overflowed: false,
    }
    const close = (): void => this.#remove(response)
    this.#clients.set(response, client)
    response.once('close', close)
    try {
      let pending: readonly StreamEnvelope[] = baselineRequired
        ? [
            {
              id: baselineSequence,
              event: 'baseline',
              accountId: identity.accountId,
              data: {
                sessions: await this.#registry.listFor(identity.actor, identity.accountRole),
                takeovers: this.#registry.takeoversFor(identity.actor),
              },
            },
          ]
        : visibleEvents.filter((event): boolean => event.id > requested)

      if (client.overflowed) {
        client.pending.length = 0
        client.overflowed = false
        baselineSequence = this.#sequence
        pending = [
          {
            id: baselineSequence,
            event: 'baseline',
            accountId: identity.accountId,
            data: {
              sessions: await this.#registry.listFor(identity.actor, identity.accountRole),
              takeovers: this.#registry.takeoversFor(identity.actor),
            },
          },
        ]
        if (pendingEventsOverflowed(client)) {
          throw new LubanError(
            'E_UNAVAILABLE',
            'Registry changed faster than its baseline could be rebuilt; reconnect the event stream',
            { retriable: true },
          )
        }
      }

      this.#assertAvailable()
      if (this.#clients.get(response) !== client) return
      response.statusCode = 200
      securityHeaders(response)
      response.setHeader('content-type', 'text/event-stream; charset=utf-8')
      response.setHeader('connection', 'keep-alive')
      response.setHeader('x-accel-buffering', 'no')
      response.flushHeaders()
      response.write('retry: 2000\n\n')
      for (const envelope of pending) this.#write(response, envelope)
      for (const envelope of client.pending) {
        if (envelope.id > baselineSequence) this.#write(response, envelope)
      }
      client.pending.length = 0
      client.ready = true
    } catch (error: unknown) {
      this.#clients.delete(response)
      response.off('close', close)
      throw error
    }
  }

  public dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    clearInterval(this.#heartbeat)
    this.#unsubscribe()
    for (const [response, client] of [...this.#clients]) {
      if (client.ready) response.end()
    }
    this.#clients.clear()
  }

  #write(response: ServerResponse, envelope: StreamEnvelope): void {
    const data = JSON.stringify(envelope.data).replaceAll('\n', '\\n')
    if (
      !response.write(`id: ${String(envelope.id)}\nevent: ${envelope.event}\ndata: ${data}\n\n`)
    ) {
      this.#remove(response)
    }
  }

  #remove(response: ServerResponse): void {
    this.#clients.delete(response)
    if (!response.writableEnded) response.end()
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new LubanError('E_UNAVAILABLE', 'Session share API is disposed')
  }
}

function accountMayOperate(role: AccountRole): boolean {
  return role === 'admin' || role === 'operator'
}

export class SessionShareHttpApi {
  readonly #registry: SharedSessionRegistry
  readonly #auth: DetailedAuthService
  readonly #events: RegistryEventStream
  readonly #sessionStreams = new Map<ServerResponse, AbortController>()
  #disposed = false

  public constructor(registry: SharedSessionRegistry, auth: AuthService, replayLimit: number) {
    this.#registry = registry
    this.#auth = auth
    this.#events = new RegistryEventStream(registry, replayLimit)
  }

  public readonly handler = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
        throw new LubanError('E_NOT_FOUND', 'Route not found')
      }
      const identity = await requireIdentity(request, url.pathname, this.#auth)
      this.#assertAvailable()
      const path = url.pathname.slice(PREFIX.length) || '/'
      const method = request.method ?? 'GET'

      if (method === 'GET' && path === '/events') {
        await this.#events.connect(request, response, identity)
        return
      }
      if (method === 'GET' && path === '/sessions') {
        const host = url.searchParams.get('host')
        const taskId = url.searchParams.get('taskId')
        sendJson(response, 200, {
          sessions: await this.#registry.listFor(identity.actor, identity.accountRole, {
            ...(host === null ? {} : { host: asHostId(host) }),
            ...(taskId === null ? {} : { taskId: asTaskId(taskId) }),
          }),
        })
        return
      }
      if (method === 'GET' && path === '/takeovers') {
        sendJson(response, 200, { requests: this.#registry.takeoversFor(identity.actor) })
        return
      }

      const decisionMatch = /^\/takeovers\/([^/]+)\/decision$/u.exec(path)
      if (method === 'POST' && decisionMatch?.[1] !== undefined) {
        if (!accountMayOperate(identity.accountRole)) {
          throw forbidden('Observer account cannot approve session takeover')
        }
        const body = record(await jsonBody(request))
        this.#assertAvailable()
        if (body.decision !== 'approve' && body.decision !== 'deny') {
          throw new LubanError('E_INVALID_INPUT', 'decision must be approve or deny')
        }
        sendJson(response, 200, {
          result: await this.#registry.decideTakeover(
            this.#decodedRequestId(decisionMatch[1]),
            body.decision,
            identity.actor,
            expectedVersion(body.expectedVersion),
          ),
        })
        return
      }

      const match = /^\/sessions\/([^/]+)(?:\/(takeover|release|input|events))?$/u.exec(path)
      if (match?.[1] === undefined) throw new LubanError('E_NOT_FOUND', 'Route not found')
      const id = decodedId(match[1])
      const action = match[2]
      if (method === 'GET' && action === undefined) {
        const session = this.#registry.getViewFor(id, identity.accountId)
        if (session === undefined)
          throw new LubanError('E_NOT_FOUND', `Session ${id} was not found`)
        sendJson(response, 200, {
          session: {
            ...session,
            role: this.#registry.roleFor(id, identity.actor, identity.accountRole),
          },
        })
        return
      }
      if (method === 'GET' && action === 'events') {
        this.#registry.roleFor(id, identity.actor, identity.accountRole)
        await this.#connectSessionEvents(request, response, id)
        return
      }
      if (method === 'POST' && action === 'takeover') {
        if (!accountMayOperate(identity.accountRole)) {
          throw forbidden('Observer account cannot request session takeover')
        }
        record(await jsonBody(request))
        this.#assertAvailable()
        sendJson(response, 202, {
          result: await this.#registry.requestTakeover(id, identity.actor),
        })
        return
      }
      if (method === 'POST' && action === 'release') {
        if (!accountMayOperate(identity.accountRole)) {
          throw forbidden('Observer account cannot release session control')
        }
        record(await jsonBody(request))
        this.#assertAvailable()
        await this.#registry.release(id, identity.actor)
        sendNoContent(response)
        return
      }
      if (method === 'POST' && action === 'input') {
        const body = record(await jsonBody(request))
        this.#assertAvailable()
        await this.#registry.injectInput(id, identity, requiredText(body.text, 'text'))
        sendNoContent(response)
        return
      }
      throw new LubanError('E_NOT_FOUND', 'Route not found')
    } catch (error: unknown) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined)
        return
      }
      const normalized = isLubanError(error)
        ? error
        : new LubanError('E_IO', 'Session share request failed', { cause: error })
      sendJson(response, errorStatus(normalized), { error: normalized.toJSON() })
    }
  }

  public dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#events.dispose()
    for (const [response, controller] of this.#sessionStreams) {
      controller.abort()
      if (!response.writableEnded && !response.destroyed) response.end()
    }
    this.#sessionStreams.clear()
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new LubanError('E_UNAVAILABLE', 'Session share API is disposed')
  }

  #decodedRequestId(value: string): string {
    try {
      return decodeURIComponent(value)
    } catch (error: unknown) {
      throw new LubanError('E_INVALID_INPUT', 'Takeover id is not valid URL encoding', {
        cause: error,
      })
    }
  }

  async #connectSessionEvents(
    request: IncomingMessage,
    response: ServerResponse,
    id: SessionId,
  ): Promise<void> {
    if (this.#disposed) throw new LubanError('E_UNAVAILABLE', 'Session share API is disposed')
    const raw = request.headers['last-event-id']
    const requested = Number.parseInt(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''), 10)
    const lastEventId = Number.isSafeInteger(requested) && requested >= 0 ? requested : undefined
    const controller = new AbortController()
    const close = (): void => {
      controller.abort()
      this.#sessionStreams.delete(response)
    }
    this.#sessionStreams.set(response, controller)
    response.once('close', close)
    response.statusCode = 200
    securityHeaders(response)
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('connection', 'keep-alive')
    response.setHeader('x-accel-buffering', 'no')
    response.flushHeaders()
    response.write('retry: 2000\n\n')
    const heartbeat = setInterval((): void => {
      if (!response.write(': heartbeat\n\n')) controller.abort()
    }, 15_000)
    heartbeat.unref()
    try {
      for await (const envelope of this.#registry.stream(id, lastEventId, controller.signal)) {
        if (!this.#writeSessionEvent(response, envelope)) {
          controller.abort()
          break
        }
      }
    } finally {
      clearInterval(heartbeat)
      controller.abort()
      response.off('close', close)
      this.#sessionStreams.delete(response)
    }
    if (!response.writableEnded && !response.destroyed) response.end()
  }

  #writeSessionEvent(response: ServerResponse, envelope: SessionStreamEnvelope): boolean {
    const data = JSON.stringify(envelope.data).replaceAll('\n', '\\n')
    return response.write(`id: ${String(envelope.id)}\nevent: ${envelope.event}\ndata: ${data}\n\n`)
  }
}
