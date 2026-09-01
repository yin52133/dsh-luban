import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AccountContext, AccountId, AuthService } from 'dsh-luban-core'
import { LubanError, isLubanError, modulePrefix } from 'dsh-luban-core'
import type { DefaultTelemetryAggregator } from './aggregator.js'
import { HudKeepaliveHealthStore } from './keepalive-health.js'
import { HUD_TELEMETRY_EVENT } from './types.js'
import type { HudPublicConfig, HudSnapshotResponse, HudTelemetryEnvelope } from './types.js'

const PREFIX = modulePrefix('hud')

interface StreamClient {
  readonly accountId: AccountId
  readonly response: ServerResponse
  readonly close: () => void
}

interface HudStreamFrame {
  readonly id: number
  readonly envelope: HudSnapshotResponse
}

const REPLAY_LIMIT = 256

function securityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  response.statusCode = status
  securityHeaders(response)
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', String(body.byteLength))
  response.end(body)
}

function errorStatus(error: LubanError): number {
  if (error.code === 'E_AUTH_REQUIRED') return 401
  if (error.code === 'E_NOT_FOUND') return 404
  if (error.code === 'E_INVALID_INPUT') return 400
  if (error.code === 'E_UNAVAILABLE') return 503
  return 500
}

function sourceIp(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown'
}

async function requireAuth(request: IncomingMessage, auth: AuthService): Promise<AccountContext> {
  const decision = await auth.middleware()({
    path: request.url ?? PREFIX,
    method: request.method ?? 'GET',
    accept: request.headers.accept,
    cookie: request.headers.cookie,
    sourceIp: sourceIp(request),
  })
  if (!decision.allowed || decision.account === undefined) {
    throw new LubanError('E_AUTH_REQUIRED', 'Authentication is required')
  }
  return decision.account
}

/** One bounded SSE fan-out for immutable HUD envelopes. */
export class HudEventStream {
  readonly #clients = new Map<AccountId, Set<StreamClient>>()
  readonly #events = new Map<AccountId, HudStreamFrame[]>()
  readonly #sequences = new Map<AccountId, number>()
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #disposed = false

  #startHeartbeat(): void {
    if (this.#heartbeat !== undefined) return
    this.#heartbeat = setInterval((): void => {
      for (const clients of this.#clients.values()) {
        for (const client of [...clients]) {
          if (client.response.destroyed) client.close()
          else if (!this.#writeRaw(client.response, ': keepalive\n\n')) client.close()
        }
      }
    }, 15_000)
    this.#heartbeat.unref()
  }

  public connect(
    accountId: AccountId,
    request: IncomingMessage,
    response: ServerResponse,
    baseline: HudSnapshotResponse,
  ): void {
    this.#assertAvailable()
    const events = this.#events.get(accountId) ?? []
    const sequence = this.#sequences.get(accountId) ?? 0
    const requested = this.#lastEventId(request)
    const oldest = events.at(0)?.id ?? sequence
    const needsBaseline = requested === undefined || requested < oldest - 1 || requested > sequence
    const pending: readonly HudStreamFrame[] = needsBaseline
      ? [{ id: sequence, envelope: baseline }]
      : events.filter((frame): boolean => frame.id > requested)
    response.statusCode = 200
    securityHeaders(response)
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('connection', 'keep-alive')
    response.setHeader('x-accel-buffering', 'no')
    response.flushHeaders()
    let closed = false
    const clients = this.#clients.get(accountId) ?? new Set<StreamClient>()
    this.#clients.set(accountId, clients)
    const client: StreamClient = {
      accountId,
      response,
      close: (): void => {
        if (closed) return
        closed = true
        clients.delete(client)
        if (clients.size === 0) this.#clients.delete(accountId)
        if (!response.destroyed && !response.writableEnded) {
          try {
            response.end()
          } catch {
            // The socket is already unusable; removing it is sufficient.
          }
        }
        this.#stopHeartbeatWhenIdle()
      },
    }
    clients.add(client)
    request.once('close', client.close)
    response.once('error', client.close)
    this.#startHeartbeat()
    for (const frame of pending) {
      if (!this.#write(response, frame)) {
        client.close()
        break
      }
    }
  }

  public publish(accountId: AccountId, envelope: HudSnapshotResponse): void {
    if (this.#disposed) return
    const sequence = (this.#sequences.get(accountId) ?? 0) + 1
    this.#sequences.set(accountId, sequence)
    const frame: HudStreamFrame = { id: sequence, envelope }
    const events = this.#events.get(accountId) ?? []
    events.push(frame)
    this.#events.set(accountId, events)
    if (events.length > REPLAY_LIMIT) events.shift()
    for (const client of [...(this.#clients.get(accountId) ?? [])]) {
      if (client.response.destroyed) client.close()
      else if (!this.#write(client.response, frame)) client.close()
    }
  }

  public dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const clients of this.#clients.values()) {
      for (const client of [...clients]) client.close()
    }
    this.#clients.clear()
    this.#events.clear()
    this.#sequences.clear()
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
  }

  #lastEventId(request: IncomingMessage): number | undefined {
    const raw = request.headers['last-event-id']
    const value = Array.isArray(raw) ? raw.at(0) : raw
    if (value === undefined || !/^\d+$/u.test(value.trim())) return undefined
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) ? parsed : undefined
  }

  #write(response: ServerResponse, frame: HudStreamFrame): boolean {
    return this.#writeRaw(
      response,
      `id: ${String(frame.id)}\nevent: ${HUD_TELEMETRY_EVENT}\ndata: ${JSON.stringify(frame.envelope)}\n\n`,
    )
  }

  #writeRaw(response: ServerResponse, value: string): boolean {
    try {
      return response.write(value)
    } catch {
      return false
    }
  }

  #stopHeartbeatWhenIdle(): void {
    if (this.#clients.size > 0 || this.#heartbeat === undefined) return
    clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new LubanError('E_UNAVAILABLE', 'HUD event stream is disposed')
  }
}

export interface HudHttpApiOptions {
  readonly telemetry: DefaultTelemetryAggregator
  readonly auth: AuthService
  readonly config: HudPublicConfig
  readonly keepalive?: HudKeepaliveHealthStore
  readonly onError?: (error: unknown) => void
}

/** Authenticated snapshot/history/SSE API under the canonical `/luban-hud` prefix. */
export class HudHttpApi {
  readonly #telemetry: DefaultTelemetryAggregator
  readonly #auth: AuthService
  readonly #config: HudPublicConfig
  readonly #keepalive: HudKeepaliveHealthStore
  readonly #ownsKeepalive: boolean
  readonly #onError: (error: unknown) => void
  readonly #stream = new HudEventStream()
  readonly #unsubscribeTelemetry: () => void
  readonly #unsubscribeKeepalive: () => void
  #disposed = false

  public constructor(options: HudHttpApiOptions) {
    this.#telemetry = options.telemetry
    this.#auth = options.auth
    this.#config = options.config
    this.#keepalive = options.keepalive ?? new HudKeepaliveHealthStore()
    this.#ownsKeepalive = options.keepalive === undefined
    this.#onError = options.onError ?? ((): void => undefined)
    this.#unsubscribeTelemetry = this.#telemetry.subscribeAccounts((accountId): void =>
      this.#publishLatest(accountId),
    )
    this.#unsubscribeKeepalive = this.#keepalive.subscribe((accountId): void => {
      if (accountId !== undefined) this.#publishLatest(accountId)
    })
  }

  public readonly handler = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      const account = await requireAuth(request, this.#auth)
      this.#assertAvailable()
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET')
        sendJson(response, 405, { error: 'method_not_allowed' })
        return
      }
      const url = new URL(request.url ?? PREFIX, 'http://127.0.0.1')
      if (url.pathname === `${PREFIX}/snapshot`) {
        const envelope = await this.#telemetry.envelopeForAccount(account.accountId)
        this.#assertAvailable()
        sendJson(response, 200, this.#response(account.accountId, envelope))
        return
      }
      if (url.pathname === `${PREFIX}/history`) {
        sendJson(response, 200, {
          snapshots: this.#telemetry.historyForAccount(account.accountId),
        })
        return
      }
      if (url.pathname === `${PREFIX}/events`) {
        const envelope = await this.#telemetry.envelopeForAccount(account.accountId)
        this.#assertAvailable()
        this.#stream.connect(
          account.accountId,
          request,
          response,
          this.#response(account.accountId, envelope),
        )
        return
      }
      throw new LubanError('E_NOT_FOUND', 'HUD endpoint not found')
    } catch (error: unknown) {
      if (response.headersSent) {
        if (!response.destroyed) response.end()
        return
      }
      if (isLubanError(error)) {
        sendJson(response, errorStatus(error), { error: error.code, message: error.message })
      } else {
        sendJson(response, 500, { error: 'E_INTERNAL', message: 'Internal server error' })
      }
    }
  }

  public dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribeKeepalive()
    this.#unsubscribeTelemetry()
    this.#stream.dispose()
    if (this.#ownsKeepalive) this.#keepalive.dispose()
  }

  #response(accountId: AccountId, envelope: HudTelemetryEnvelope): HudSnapshotResponse {
    return Object.freeze({
      ...envelope,
      config: this.#config,
      keepalive: this.#keepalive.snapshot(accountId),
    })
  }

  #publishLatest(accountId: AccountId): void {
    if (this.#disposed) return
    void this.#telemetry
      .envelopeForAccount(accountId)
      .then((envelope): void => {
        if (!this.#disposed) {
          this.#stream.publish(accountId, this.#response(accountId, envelope))
        }
      })
      .catch((error: unknown): void => {
        try {
          this.#onError(error)
        } catch {
          // Diagnostics cannot restore a failed refresh and must not leak a rejection.
        }
      })
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new LubanError('E_UNAVAILABLE', 'HUD API is disposed')
  }
}
