import type { Actor, SessionEvent, SessionId, SessionRole, TakeoverResult } from 'dsh-luban-core'
import { LubanError, asAccountId, asActorId, asHostId, asSessionId, asTaskId } from 'dsh-luban-core'
import type { PeerConfig } from './config.js'
import type {
  PeerNetwork,
  PeerSessionSnapshot,
  SessionStreamEnvelope,
  SessionView,
} from './types.js'

const MAX_SSE_BUFFER_CHARS = 1_048_576

interface HttpPeerNetworkOptions {
  readonly timeoutMs: number
  readonly readEnvironment?: (name: string) => string | undefined
  readonly fetch?: typeof fetch
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LubanError('E_UNAVAILABLE', `Peer returned invalid ${label}`)
  }
  return value as Readonly<Record<string, unknown>>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new LubanError('E_UNAVAILABLE', `Peer returned invalid ${label}`)
  }
  return value
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LubanError('E_UNAVAILABLE', `Peer returned invalid ${label}`)
  }
  return value
}

function actor(value: unknown, label: string): Actor {
  const row = record(value, label)
  if (row.kind !== 'user' && row.kind !== 'agent') {
    throw new LubanError('E_UNAVAILABLE', `Peer returned invalid ${label}.kind`)
  }
  return {
    kind: row.kind,
    id: asActorId(string(row.id, `${label}.id`)),
    ...(typeof row.accountId === 'string' ? { accountId: asAccountId(row.accountId) } : {}),
    ...(typeof row.displayName === 'string' ? { displayName: row.displayName } : {}),
  }
}

function roleMap(value: unknown): Readonly<Record<ReturnType<typeof asActorId>, SessionRole>> {
  const row = record(value, 'session roles')
  const roles = Object.create(null) as Record<ReturnType<typeof asActorId>, SessionRole>
  for (const [id, role] of Object.entries(row)) {
    if (role !== 'owner' && role !== 'operator' && role !== 'observer') {
      throw new LubanError('E_UNAVAILABLE', 'Peer returned invalid session role')
    }
    roles[asActorId(id)] = role
  }
  return roles
}

export function decodePeerSession(value: unknown): PeerSessionSnapshot {
  const row = record(value, 'session')
  if (typeof row.healthy !== 'boolean') {
    throw new LubanError('E_UNAVAILABLE', 'Peer returned invalid session.healthy')
  }
  const lockHolder = row.lockHolder
  if (typeof row.accountId !== 'string') {
    throw new LubanError('E_UNAVAILABLE', 'Peer session has no account ownership')
  }
  const accountId = asAccountId(row.accountId)
  const owner = actor(row.owner, 'session.owner')
  if (owner.accountId !== accountId) {
    throw new LubanError('E_UNAVAILABLE', 'Peer session owner account does not match')
  }
  const parsedLockHolder =
    lockHolder === null
      ? null
      : lockHolder === undefined
        ? undefined
        : actor(lockHolder, 'session.lockHolder')
  if (
    parsedLockHolder !== undefined &&
    parsedLockHolder !== null &&
    parsedLockHolder.accountId !== accountId
  ) {
    throw new LubanError('E_UNAVAILABLE', 'Peer session lock holder account does not match')
  }
  const parsed: SessionView = {
    accountId,
    id: asSessionId(string(row.id, 'session.id')),
    host: asHostId(string(row.host, 'session.host')),
    ...(typeof row.ownerTaskId === 'string' ? { ownerTaskId: asTaskId(row.ownerTaskId) } : {}),
    ...(parsedLockHolder === null
      ? { lockHolder: null }
      : parsedLockHolder === undefined
        ? {}
        : { lockHolder: parsedLockHolder }),
    roles: roleMap(row.roles),
    healthy: row.healthy,
    owner,
    status: string(row.status, 'session.status'),
    version: integer(row.version, 'session.version'),
    updatedAt: integer(row.updatedAt, 'session.updatedAt'),
  }
  if (parsed.version < 1)
    throw new LubanError('E_UNAVAILABLE', 'Peer returned invalid session.version')
  if (parsed.roles[parsed.owner.id] === undefined) {
    throw new LubanError('E_UNAVAILABLE', 'Peer session owner is missing from its role bindings')
  }
  if (
    parsed.lockHolder !== undefined &&
    parsed.lockHolder !== null &&
    parsed.roles[parsed.lockHolder.id] !== 'owner' &&
    parsed.roles[parsed.lockHolder.id] !== 'operator'
  ) {
    throw new LubanError('E_UNAVAILABLE', 'Peer session lock holder has no control role')
  }
  return parsed
}

function decodeSessionEvent(value: unknown): SessionEvent {
  const row = record(value, 'session event')
  const seq = integer(row.seq, 'session event sequence')
  const at = integer(row.at, 'session event timestamp')
  if (row.type === 'output') {
    return { type: 'output', seq, text: string(row.text, 'session output'), at }
  }
  if (row.type === 'status') {
    return { type: 'status', seq, status: string(row.status, 'session status'), at }
  }
  throw new LubanError('E_UNAVAILABLE', 'Peer returned unknown session event')
}

function decodeStreamEnvelope(id: number, event: string, value: unknown): SessionStreamEnvelope {
  if (event === 'session') return { id, event, data: decodeSessionEvent(value) }
  if (event === 'baseline') {
    const row = record(value, 'session baseline')
    if (!Array.isArray(row.recent)) {
      throw new LubanError('E_UNAVAILABLE', 'Peer returned invalid session baseline')
    }
    return {
      id,
      event,
      data: {
        session: decodePeerSession(row.session),
        recent: row.recent.map(decodeSessionEvent),
      },
    }
  }
  throw new LubanError('E_UNAVAILABLE', 'Peer returned unknown SSE event')
}

function csrfFromCookie(cookie: string): string | undefined {
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0 || part.slice(0, separator).trim() !== 'luban_csrf') continue
    const value = part.slice(separator + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

function joinUrl(peer: PeerConfig, path: string): string {
  return `${peer.baseUrl}/luban-session-share${path}`
}

/** Environment-credentialed M01 HTTP transport. Secret values never enter config or errors. */
export class HttpPeerNetwork implements PeerNetwork {
  readonly #timeoutMs: number
  readonly #readEnvironment: (name: string) => string | undefined
  readonly #fetch: typeof fetch

  public constructor(options: HttpPeerNetworkOptions) {
    this.#timeoutMs = options.timeoutMs
    this.#readEnvironment =
      options.readEnvironment ?? ((name): string | undefined => process.env[name])
    this.#fetch = options.fetch ?? fetch
  }

  public async list(peer: PeerConfig): Promise<readonly PeerSessionSnapshot[]> {
    const response = await this.#request(peer, '/sessions', { method: 'GET' })
    const body = record(await this.#json(peer, response), 'session list')
    if (!Array.isArray(body.sessions)) {
      throw new LubanError('E_UNAVAILABLE', `Peer ${peer.name} returned an invalid session list`)
    }
    return body.sessions.map(decodePeerSession)
  }

  public async requestTakeover(
    peer: PeerConfig,
    id: SessionId,
    by: Actor,
  ): Promise<TakeoverResult> {
    const response = await this.#request(peer, `/sessions/${encodeURIComponent(id)}/takeover`, {
      method: 'POST',
      body: '{}',
      actor: by,
    })
    const row = record(await this.#json(peer, response), 'takeover result')
    const result = record(row.result, 'takeover result')
    if (result.status === 'pending') {
      return { status: 'pending', requestId: string(result.requestId, 'takeover request id') }
    }
    if (result.status === 'denied') {
      return { status: 'denied', reason: string(result.reason, 'takeover denial') }
    }
    if (result.status === 'granted') {
      return { status: 'granted', session: decodePeerSession(result.session) }
    }
    throw new LubanError('E_UNAVAILABLE', `Peer ${peer.name} returned an invalid takeover result`)
  }

  public async release(peer: PeerConfig, id: SessionId, by: Actor): Promise<void> {
    await this.#request(peer, `/sessions/${encodeURIComponent(id)}/release`, {
      method: 'POST',
      body: '{}',
      actor: by,
    })
  }

  public async injectInput(
    peer: PeerConfig,
    id: SessionId,
    by: Actor,
    text: string,
  ): Promise<void> {
    await this.#request(peer, `/sessions/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      body: JSON.stringify({ text }),
      actor: by,
    })
  }

  public async *stream(
    peer: PeerConfig,
    id: SessionId,
    lastEventId: number | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<SessionStreamEnvelope> {
    const controller = new AbortController()
    const relayAbort = (): void => controller.abort(signal.reason)
    if (signal.aborted) relayAbort()
    else signal.addEventListener('abort', relayAbort, { once: true })
    const connectTimeout = setTimeout((): void => {
      controller.abort(new Error(`Peer ${peer.name} event stream connection timed out`))
    }, this.#timeoutMs)
    connectTimeout.unref()
    try {
      const response = await this.#request(
        peer,
        `/sessions/${encodeURIComponent(id)}/events`,
        {
          method: 'GET',
          accept: 'text/event-stream',
          ...(lastEventId === undefined ? {} : { lastEventId }),
        },
        controller.signal,
      )
      clearTimeout(connectTimeout)
      if (response.body === null) {
        throw new LubanError('E_UNAVAILABLE', `Peer ${peer.name} returned an empty event stream`)
      }
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        buffer = buffer.replaceAll('\r\n', '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          if (boundary > MAX_SSE_BUFFER_CHARS) {
            throw new LubanError(
              'E_UNAVAILABLE',
              `Peer ${peer.name} returned an oversized SSE frame`,
            )
          }
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = this.#parseFrame(frame)
          if (parsed !== undefined) yield parsed
          boundary = buffer.indexOf('\n\n')
        }
        if (buffer.length > MAX_SSE_BUFFER_CHARS) {
          throw new LubanError('E_UNAVAILABLE', `Peer ${peer.name} returned an oversized SSE frame`)
        }
      }
    } finally {
      clearTimeout(connectTimeout)
      signal.removeEventListener('abort', relayAbort)
      if (!controller.signal.aborted) controller.abort()
    }
  }

  async #request(
    peer: PeerConfig,
    path: string,
    options: {
      readonly method: 'GET' | 'POST'
      readonly body?: string
      readonly lastEventId?: number
      readonly actor?: Actor
      readonly accept?: 'application/json' | 'text/event-stream'
    },
    outerSignal?: AbortSignal,
  ): Promise<Response> {
    const cookie = this.#readEnvironment(peer.credentialEnv)
    if (cookie === undefined || cookie.trim() === '') {
      throw new LubanError(
        'E_UNAVAILABLE',
        `Peer ${peer.name} credential environment variable is not set`,
      )
    }
    const signal = outerSignal ?? AbortSignal.timeout(this.#timeoutMs)
    try {
      if (options.actor !== undefined) {
        await this.#assertCredentialActor(peer, cookie, options.actor, signal)
      }
      const headers = new Headers({ accept: options.accept ?? 'application/json', cookie })
      if (options.body !== undefined) {
        const csrf = csrfFromCookie(cookie)
        if (csrf === undefined) {
          throw new LubanError(
            'E_UNAVAILABLE',
            `Peer ${peer.name} credential is missing its CSRF cookie`,
          )
        }
        headers.set('content-type', 'application/json')
        headers.set('x-luban-csrf', csrf)
      }
      if (options.lastEventId !== undefined) {
        headers.set('last-event-id', String(options.lastEventId))
      }
      const response = await this.#fetch(joinUrl(peer, path), {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: 'manual',
        signal,
      })
      if (!response.ok) {
        throw new LubanError(
          response.status === 401 || response.status === 403 ? 'E_AUTH_REQUIRED' : 'E_UNAVAILABLE',
          `Peer ${peer.name} request failed with status ${String(response.status)}`,
          response.status === 403 ? { details: { status: 403 } } : {},
        )
      }
      return response
    } catch (error: unknown) {
      if (error instanceof LubanError) throw error
      throw new LubanError('E_UNAVAILABLE', `Peer ${peer.name} request failed`, {
        retriable: true,
        cause: error,
      })
    }
  }

  async #assertCredentialActor(
    peer: PeerConfig,
    cookie: string,
    expected: Actor,
    signal: AbortSignal,
  ): Promise<void> {
    if (expected.kind !== 'user') {
      throw new LubanError('E_AUTH_REQUIRED', 'Peer mutations require a user identity', {
        details: { status: 403 },
      })
    }
    const response = await this.#fetch(`${peer.baseUrl}/luban-auth/session`, {
      method: 'GET',
      headers: new Headers({ accept: 'application/json', cookie }),
      redirect: 'manual',
      signal,
    })
    if (!response.ok) {
      throw new LubanError(
        response.status === 401 || response.status === 403 ? 'E_AUTH_REQUIRED' : 'E_UNAVAILABLE',
        `Peer ${peer.name} identity check failed with status ${String(response.status)}`,
        response.status === 403 ? { details: { status: 403 } } : {},
      )
    }
    const row = record(await this.#json(peer, response), 'authentication session')
    const authenticatedUser = string(row.user, 'authentication session user')
    if (authenticatedUser !== expected.id) {
      throw new LubanError(
        'E_AUTH_REQUIRED',
        `Peer ${peer.name} credential identity does not match the local actor`,
        { details: { status: 403 } },
      )
    }
  }

  async #json(peer: PeerConfig, response: Response): Promise<unknown> {
    try {
      return (await response.json()) as unknown
    } catch (error: unknown) {
      throw new LubanError('E_UNAVAILABLE', `Peer ${peer.name} returned invalid JSON`, {
        cause: error,
      })
    }
  }

  #parseFrame(frame: string): SessionStreamEnvelope | undefined {
    let id: number | undefined
    let event = 'message'
    const data: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('id:')) id = Number.parseInt(line.slice(3).trim(), 10)
      else if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (data.length === 0) return undefined
    if (id === undefined || !Number.isSafeInteger(id) || id < 0) {
      throw new LubanError('E_UNAVAILABLE', 'Peer returned invalid SSE event id')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data.join('\n')) as unknown
    } catch (error: unknown) {
      throw new LubanError('E_UNAVAILABLE', 'Peer returned invalid SSE JSON', { cause: error })
    }
    return decodeStreamEnvelope(id, event, parsed)
  }
}
