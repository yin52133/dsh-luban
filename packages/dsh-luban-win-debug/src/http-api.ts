import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AccountId, AuthService, ChannelKind, SessionId } from '@yin52133/dsh-luban-core'
import {
  LubanError,
  asSessionId,
  isLubanError,
  modulePrefix,
  objectRecord as record,
  readJsonBody,
  sendJson,
  setPrivateResponseHeaders as securityHeaders,
} from '@yin52133/dsh-luban-core'
import type { DefaultWinDebugService } from './service.js'
import type { WinDebugEvent } from './types.js'

const PREFIX = modulePrefix('win-debug')
const MAX_BODY_BYTES = 512 * 1024
const CHANNEL_KINDS = new Set<ChannelKind>([
  'serial',
  'adb',
  'fastboot',
  'gdb',
  'ssh',
  'telnet',
  'tcp-serial',
])

interface EventEnvelope {
  readonly id: number
  readonly data: WinDebugEvent
}

interface AccountEventStream {
  sequence: number
  readonly events: EventEnvelope[]
}

export function eventVisibleToAccount(event: WinDebugEvent, accountId: AccountId): boolean {
  switch (event.type) {
    case 'endpoints-changed':
      return true
    case 'line':
      return event.line.accountId === accountId
    case 'channel-status':
    case 'resync':
      return event.accountId === accountId
  }
}

function requiredString(value: unknown, label: string, maximum = 16_384): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be a bounded non-empty string`)
  }
  return value
}

function optionalString(value: unknown, label: string, maximum = 16_384): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be a bounded string`)
  }
  return value
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be an integer in range`)
  }
  return value as number
}

function stringArray(value: unknown, label: string, maximum = 256): readonly string[] {
  if (
    value === undefined ||
    !Array.isArray(value) ||
    value.length > maximum ||
    !value.every((item): item is string => typeof item === 'string' && item.length <= 4096)
  ) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be a bounded string array`)
  }
  return value
}

function stringMap(value: unknown, label: string): Readonly<Record<string, string>> {
  const source = record(value, label)
  const output: Record<string, string> = Object.create(null) as Record<string, string>
  if (Object.keys(source).length > 128)
    throw new LubanError('E_INVALID_INPUT', `${label} is too large`)
  for (const [key, item] of Object.entries(source)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key) || typeof item !== 'string' || item.length > 4096) {
      throw new LubanError('E_INVALID_INPUT', `${label} has an invalid entry`)
    }
    output[key] = item
  }
  return Object.freeze(output)
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  return readJsonBody(request, MAX_BODY_BYTES)
}

function sourceIp(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown'
}

async function authenticate(
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthService,
  path: string,
): Promise<AccountId | null> {
  const decision = await auth.middleware()({
    path,
    method: request.method ?? 'GET',
    accept: request.headers.accept,
    cookie: request.headers.cookie,
    sourceIp: sourceIp(request),
  })
  if (decision.allowed && decision.account !== undefined) return decision.account.accountId
  if (decision.allowed) {
    sendJson(response, 401, {
      error: { code: 'E_AUTH_REQUIRED', message: 'Authentication required' },
    })
    return null
  }
  if (decision.redirectTo !== undefined) {
    response.writeHead(decision.status, {
      location: decision.redirectTo,
      'cache-control': 'no-store',
    })
    response.end()
  } else {
    sendJson(response, decision.status, {
      error: {
        code: decision.status === 429 ? 'E_AUTH_LOCKED' : 'E_AUTH_REQUIRED',
        message: 'Authentication required',
      },
    })
  }
  return null
}

async function requireOwnedSession(
  auth: AuthService,
  accountId: AccountId,
  sessionId: SessionId,
): Promise<void> {
  if ((await auth.accountSessions.ownerOf(sessionId)) !== accountId) {
    throw new LubanError('E_NOT_FOUND', `Session ${sessionId} was not found`)
  }
}

function errorStatus(error: LubanError): number {
  switch (error.code) {
    case 'E_AUTH_REQUIRED':
      return 401
    case 'E_ACCOUNT_SCOPE_MISMATCH':
      return 403
    case 'E_NOT_FOUND':
      return 404
    case 'E_INVALID_INPUT':
      return 400
    case 'E_INVALID_TRANSITION':
      return 409
    case 'E_TIMEOUT':
      return 504
    case 'E_CHANNEL_UNAVAILABLE':
    case 'E_UNAVAILABLE':
      return 503
    case 'E_PLATFORM_UNSUPPORTED':
      return 501
    default:
      return 500
  }
}

async function withDisconnectSignal<Value>(
  response: ServerResponse,
  operation: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> {
  const controller = new AbortController()
  const abort = (): void => {
    if (!response.writableEnded) controller.abort()
  }
  response.once('close', abort)
  try {
    return await operation(controller.signal)
  } finally {
    response.off('close', abort)
  }
}

/** Authenticated REST/SSE boundary consumed by the generic channel UI. */
export class WinDebugHttpApi {
  readonly #service: DefaultWinDebugService
  readonly #auth: AuthService
  readonly #streams = new Map<AccountId, AccountEventStream>()
  readonly #clients = new Map<ServerResponse, AccountId>()
  readonly #unsubscribe: () => void
  readonly #heartbeat: ReturnType<typeof setInterval>

  public constructor(service: DefaultWinDebugService, auth: AuthService) {
    this.#service = service
    this.#auth = auth
    this.#unsubscribe = service.subscribe((event): void => this.#publish(event))
    this.#heartbeat = setInterval((): void => {
      for (const response of [...this.#clients.keys()]) {
        if (!response.write(': heartbeat\n\n')) this.#removeClient(response)
      }
    }, 15_000)
    this.#heartbeat.unref()
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
      const accountId = await authenticate(request, response, this.#auth, url.pathname)
      if (accountId === null) return
      const path = url.pathname.slice(PREFIX.length) || '/'
      const method = request.method ?? 'GET'

      if (method === 'GET' && (path === '/' || path === '/status')) {
        sendJson(response, 200, {
          status: 'ok',
          platform: 'win32',
          active: this.#service.activeChannels(accountId).map((channel) => ({
            accountId: channel.accountId,
            id: channel.id,
            endpoint: channel.endpoint,
            openedAt: channel.openedAt,
          })),
          adapterErrors: this.#service.endpointErrors(),
          gdb: this.#service.gdbStatus(accountId),
          desktopMcp: this.#service.desktopMcpStatus(accountId),
        })
        return
      }
      if (method === 'GET' && path === '/endpoints') {
        const rawKind = url.searchParams.get('kind')
        const kind = rawKind === null ? undefined : (rawKind as ChannelKind)
        if (kind !== undefined && !CHANNEL_KINDS.has(kind)) {
          throw new LubanError('E_INVALID_INPUT', 'Channel kind is invalid')
        }
        sendJson(response, 200, {
          endpoints: await this.#service.listEndpoints(kind),
          errors: this.#service.endpointErrors(),
        })
        return
      }
      if (method === 'GET' && path === '/channels') {
        sendJson(response, 200, {
          channels: this.#service.activeChannels(accountId).map((channel) => ({
            accountId: channel.accountId,
            id: channel.id,
            endpoint: channel.endpoint,
            openedAt: channel.openedAt,
          })),
        })
        return
      }
      if (method === 'POST' && path === '/channels/open') {
        const body = record(await jsonBody(request))
        const baudRate =
          body.baudRate === undefined
            ? undefined
            : integer(body.baudRate, 'baudRate', 50, 12_000_000)
        const timeoutMs =
          body.timeoutMs === undefined
            ? undefined
            : integer(body.timeoutMs, 'timeoutMs', 100, 300_000)
        const channel = await withDisconnectSignal(response, async (signal) =>
          this.#service.open(accountId, requiredString(body.endpointId, 'endpointId', 512), {
            ...(baudRate === undefined ? {} : { baudRate }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            signal,
          }),
        )
        sendJson(response, 201, {
          channel: {
            accountId: channel.accountId,
            id: channel.id,
            endpoint: channel.endpoint,
            openedAt: channel.openedAt,
          },
        })
        return
      }
      if (method === 'GET' && path === '/events') {
        this.#connectEvents(request, response, accountId)
        return
      }
      if (method === 'GET' && path === '/templates') {
        sendJson(response, 200, { templates: this.#service.templates() })
        return
      }
      if (method === 'GET' && path === '/android/devices') {
        sendJson(response, 200, { devices: await this.#service.androidDevices() })
        return
      }
      if (method === 'GET' && path === '/gdb') {
        sendJson(response, 200, this.#service.gdbStatus(accountId))
        return
      }
      if (method === 'POST' && path === '/gdb/start') {
        const body = record(await jsonBody(request))
        const status = await withDisconnectSignal(response, async (signal) =>
          this.#service.gdbStart(
            accountId,
            {
              interfaceConfig: requiredString(body.interfaceConfig, 'interfaceConfig', 4096),
              targetConfig: requiredString(body.targetConfig, 'targetConfig', 4096),
              ...(body.gdbPort === undefined
                ? {}
                : { gdbPort: integer(body.gdbPort, 'gdbPort', 1, 65_535) }),
            },
            signal,
          ),
        )
        sendJson(response, 202, status)
        return
      }
      if (method === 'POST' && path === '/gdb/snapshot') {
        const body = record(await jsonBody(request))
        const breakpoints =
          body.breakpoints === undefined
            ? undefined
            : stringArray(body.breakpoints, 'breakpoints', 128)
        const variables =
          body.variables === undefined ? undefined : stringArray(body.variables, 'variables', 256)
        const rawSessionId = optionalString(body.sessionId, 'sessionId', 512)
        const sessionId = rawSessionId === undefined ? undefined : asSessionId(rawSessionId)
        if (sessionId !== undefined) {
          await requireOwnedSession(this.#auth, accountId, sessionId)
        }
        const snapshot = await withDisconnectSignal(response, async (signal) =>
          this.#service.gdbSnapshot(
            accountId,
            {
              executable: requiredString(body.executable, 'executable', 4096),
              ...(breakpoints === undefined ? {} : { breakpoints }),
              ...(variables === undefined ? {} : { variables }),
              ...(body.registers === undefined ? {} : { registers: body.registers === true }),
              signal,
            },
            sessionId,
          ),
        )
        sendJson(response, 201, { snapshot })
        return
      }
      if (method === 'POST' && path === '/gdb/stop') {
        sendJson(response, 200, await this.#service.gdbStop(accountId))
        return
      }
      if (method === 'GET' && path === '/desktop-mcp') {
        const descriptor = this.#service.desktopMcpDescriptor()
        sendJson(response, 200, {
          status: this.#service.desktopMcpStatus(accountId),
          descriptor:
            descriptor === null
              ? null
              : {
                  transport: descriptor.transport,
                  commandConfigured: descriptor.command !== '',
                  allowedTools: descriptor.allowedTools,
                },
        })
        return
      }
      if (method === 'POST' && path === '/desktop-mcp/start') {
        const status = await withDisconnectSignal(response, async (signal) =>
          this.#service.desktopMcpStart(accountId, signal),
        )
        sendJson(response, 202, status)
        return
      }
      if (method === 'POST' && path === '/desktop-mcp/stop') {
        sendJson(response, 200, await this.#service.desktopMcpStop(accountId))
        return
      }

      const templateMatch = /^\/templates\/([^/]+)\/run$/u.exec(path)
      if (method === 'POST' && templateMatch !== null) {
        const templateId = templateMatch[1]
        if (templateId === undefined)
          throw new LubanError('E_INVALID_INPUT', 'Template id is missing')
        const body = record(await jsonBody(request))
        const rawSessionId = optionalString(body.sessionId, 'sessionId', 512)
        const sessionId = rawSessionId === undefined ? undefined : asSessionId(rawSessionId)
        if (sessionId !== undefined) {
          await requireOwnedSession(this.#auth, accountId, sessionId)
        }
        const artifact = await withDisconnectSignal(response, async (signal) =>
          this.#service.runTemplateArtifact(
            accountId,
            decodeURIComponent(templateId),
            stringMap(body.params, 'params'),
            optionalString(body.confirmation, 'confirmation', 128),
            sessionId,
            signal,
          ),
        )
        sendJson(response, 200, artifact)
        return
      }

      const channelMatch = /^\/channels\/([^/]+)\/(close|write|exec|logs|capture)$/u.exec(path)
      if (channelMatch !== null) {
        const encodedId = channelMatch[1]
        const action = channelMatch[2]
        if (encodedId === undefined || action === undefined)
          throw new LubanError('E_INVALID_INPUT', 'Channel route is invalid')
        const id = decodeURIComponent(encodedId)
        if (method === 'GET' && action === 'logs') {
          sendJson(response, 200, {
            lines: this.#service.lines(accountId, id, {
              ...(url.searchParams.has('q') ? { query: url.searchParams.get('q') ?? '' } : {}),
              regex: url.searchParams.get('regex') === 'true',
              caseSensitive: url.searchParams.get('caseSensitive') === 'true',
            }),
          })
          return
        }
        if (method === 'POST' && action === 'close') {
          await this.#service.close(accountId, id)
          sendJson(response, 200, { closed: true })
          return
        }
        if (method === 'POST' && action === 'write') {
          const body = record(await jsonBody(request))
          await this.#service.write(accountId, id, requiredString(body.data, 'data', 64 * 1024))
          sendJson(response, 200, { written: true })
          return
        }
        if (method === 'POST' && action === 'exec') {
          const body = record(await jsonBody(request))
          const result = await withDisconnectSignal(response, async (signal) =>
            this.#service.exec(accountId, id, requiredString(body.command, 'command'), signal),
          )
          sendJson(response, 200, {
            result,
          })
          return
        }
        if (method === 'POST' && action === 'capture') {
          const body = record(await jsonBody(request))
          const rawSessionId = optionalString(body.sessionId, 'sessionId', 512)
          const sessionId = rawSessionId === undefined ? undefined : asSessionId(rawSessionId)
          if (sessionId !== undefined) {
            await requireOwnedSession(this.#auth, accountId, sessionId)
          }
          const snippet = await this.#service.captureAndInject(
            accountId,
            id,
            {
              from: integer(body.from, 'from', 1, Number.MAX_SAFE_INTEGER),
              to: integer(body.to, 'to', 1, Number.MAX_SAFE_INTEGER),
            },
            sessionId,
          )
          sendJson(response, 201, { snippet, injected: sessionId !== undefined })
          return
        }
      }
      throw new LubanError('E_NOT_FOUND', 'Route not found')
    } catch (error: unknown) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined)
        return
      }
      const normalized = isLubanError(error)
        ? error
        : new LubanError('E_UNAVAILABLE', 'Windows debug request failed', { cause: error })
      sendJson(response, errorStatus(normalized), { error: normalized.toJSON() })
    }
  }

  public dispose(): void {
    clearInterval(this.#heartbeat)
    this.#unsubscribe()
    for (const response of [...this.#clients.keys()]) response.end()
    this.#clients.clear()
  }

  #connectEvents(request: IncomingMessage, response: ServerResponse, accountId: AccountId): void {
    response.statusCode = 200
    securityHeaders(response)
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('connection', 'keep-alive')
    response.setHeader('x-accel-buffering', 'no')
    response.flushHeaders()
    const stream = this.#streamFor(accountId)
    const rawId = request.headers['last-event-id']
    const requested = Number.parseInt(Array.isArray(rawId) ? (rawId[0] ?? '') : (rawId ?? ''), 10)
    const oldest = stream.events[0]?.id ?? stream.sequence + 1
    const resyncRequired =
      !Number.isSafeInteger(requested) || requested < oldest - 1 || requested > stream.sequence
    this.#clients.set(response, accountId)
    response.once('close', (): void => this.#removeClient(response))
    response.write('retry: 2000\n\n')
    if (resyncRequired) {
      this.#writeEvent(response, {
        id: stream.sequence,
        data: { type: 'resync', accountId },
      })
      return
    }
    for (const event of stream.events) {
      if (event.id > requested) this.#writeEvent(response, event)
    }
  }

  #publish(data: WinDebugEvent): void {
    if (data.type === 'endpoints-changed') {
      for (const accountId of this.#streams.keys()) this.#publishFor(accountId, data)
      return
    }
    const accountId = data.type === 'line' ? data.line.accountId : data.accountId
    this.#publishFor(accountId, data)
  }

  #publishFor(accountId: AccountId, data: WinDebugEvent): void {
    const stream = this.#streamFor(accountId)
    const event: EventEnvelope = { id: ++stream.sequence, data }
    stream.events.push(event)
    if (stream.events.length > 512) stream.events.shift()
    for (const [response, clientAccountId] of [...this.#clients]) {
      if (clientAccountId === accountId) this.#writeEvent(response, event)
    }
  }

  #streamFor(accountId: AccountId): AccountEventStream {
    const existing = this.#streams.get(accountId)
    if (existing !== undefined) return existing
    const created: AccountEventStream = { sequence: 0, events: [] }
    this.#streams.set(accountId, created)
    return created
  }

  #writeEvent(response: ServerResponse, event: EventEnvelope): void {
    if (
      !response.write(
        `id: ${String(event.id)}\nevent: win-debug\ndata: ${JSON.stringify(event.data)}\n\n`,
      )
    ) {
      this.#removeClient(response)
    }
  }

  #removeClient(response: ServerResponse): void {
    this.#clients.delete(response)
    if (!response.writableEnded) response.end()
  }
}
