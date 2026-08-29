import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthService } from '@luban/core'
import { LubanError, asSessionId, isLubanError, modulePrefix } from '@luban/core'
import type { CompactionEngineWithReplay } from './engine.js'

const PREFIX = modulePrefix('context')

function securityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')
  response.statusCode = status
  securityHeaders(response)
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', String(encoded.byteLength))
  response.end(encoded)
}

function sendText(response: ServerResponse, status: number, body: string): void {
  const encoded = Buffer.from(body, 'utf8')
  response.statusCode = status
  securityHeaders(response)
  response.setHeader('content-type', 'text/markdown; charset=utf-8')
  response.setHeader('content-length', String(encoded.byteLength))
  response.end(encoded)
}

function errorStatus(error: LubanError): number {
  switch (error.code) {
    case 'E_AUTH_REQUIRED':
      return 401
    case 'E_NOT_FOUND':
      return 404
    case 'E_INVALID_INPUT':
      return 400
    case 'E_INVALID_TRANSITION':
      return 409
    case 'E_UNAVAILABLE':
      return 503
    default:
      return 500
  }
}

function safeInteger(value: string | null, label: string): number {
  if (value === null || !/^\d+$/u.test(value)) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be a non-negative integer`)
  }
  const result = Number(value)
  if (!Number.isSafeInteger(result))
    throw new LubanError('E_INVALID_INPUT', `${label} is too large`)
  return result
}

async function requireAuth(
  request: IncomingMessage,
  path: string,
  auth: AuthService,
): Promise<void> {
  const decision = await auth.middleware()({
    path,
    method: request.method ?? 'GET',
    accept: request.headers.accept,
    cookie: request.headers.cookie,
    sourceIp: request.socket.remoteAddress ?? 'unknown',
  })
  if (!decision.allowed) {
    throw new LubanError('E_AUTH_REQUIRED', 'Authentication is required', {
      details: { status: decision.status },
    })
  }
}

export class ContextHttpApi {
  readonly #engine: CompactionEngineWithReplay
  readonly #auth: AuthService
  #disposed = false

  public constructor(engine: CompactionEngineWithReplay, auth: AuthService) {
    this.#engine = engine
    this.#auth = auth
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
      await requireAuth(request, url.pathname, this.#auth)
      this.#assertAvailable()
      const path = url.pathname.slice(PREFIX.length) || '/'
      const method = request.method ?? 'GET'
      if (method === 'GET' && path === '/profiles') {
        sendJson(response, 200, {
          day: this.#engine.profile('day'),
          night: this.#engine.profile('night'),
        })
        return
      }
      const match = /^\/sessions\/([^/]+)\/(audit|archives|replay|scope)$/u.exec(path)
      if (match?.[1] === undefined || match[2] === undefined) {
        throw new LubanError('E_NOT_FOUND', 'Route not found')
      }
      const sessionId = asSessionId(decodeURIComponent(match[1]))
      if (method === 'GET' && match[2] === 'audit') {
        const records = await this.#engine.audit(sessionId)
        this.#assertAvailable()
        sendJson(response, 200, { records })
        return
      }
      if (method === 'GET' && match[2] === 'archives') {
        const entries = await this.#engine.archives(sessionId)
        this.#assertAvailable()
        sendJson(response, 200, { entries })
        return
      }
      if (method === 'GET' && match[2] === 'replay') {
        const archivePath = url.searchParams.get('path')
        const body =
          archivePath === null
            ? await this.#engine.replay(
                sessionId,
                safeInteger(url.searchParams.get('startSeq'), 'startSeq'),
                safeInteger(url.searchParams.get('endSeq'), 'endSeq'),
              )
            : await this.#engine.replayFile(sessionId, archivePath)
        this.#assertAvailable()
        sendText(response, 200, body)
        return
      }
      if (method === 'POST' && match[2] === 'scope') {
        const scope = url.searchParams.get('value')
        if (scope !== 'day' && scope !== 'night') {
          throw new LubanError('E_INVALID_INPUT', 'scope value must be day or night')
        }
        this.#engine.markScope(sessionId, scope)
        response.statusCode = 204
        securityHeaders(response)
        response.end()
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
        : new LubanError('E_IO', 'Context request failed', { cause: error })
      sendJson(response, errorStatus(normalized), { error: normalized.toJSON() })
    }
  }

  public dispose(): void {
    this.#disposed = true
  }

  #assertAvailable(): void {
    if (this.#disposed) throw new LubanError('E_UNAVAILABLE', 'Context API is disposed')
  }
}
