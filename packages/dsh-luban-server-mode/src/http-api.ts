import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { AccountId, AuthService, BuildJobInput } from '@yin52133/dsh-luban-core'
import { asAccountId, isLubanError, LubanError, modulePrefix } from '@yin52133/dsh-luban-core'
import { type ArtifactLinkSigner, type ArtifactManager, attachmentName } from './artifacts.js'
import type { BuildQueueEvent } from './queue.js'
import type { DefaultServerModeService } from './service.js'

const PREFIX = modulePrefix('server-mode')
const MAX_BODY_BYTES = 64 * 1024

interface AuthCarrier {
  middleware(): ReturnType<AuthService['middleware']>
}

interface EventEnvelope {
  readonly id: number
  readonly event: 'build' | 'resource' | 'baseline'
  readonly data: unknown
}

class AuthRejected extends Error {
  public constructor(public readonly status: number) {
    super('Authentication required')
  }
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.statusCode = status
  securityHeaders(response)
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', Buffer.byteLength(body))
  response.end(body)
}

function sourceIp(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown'
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') return value
  const first: unknown = value?.[0]
  return typeof first === 'string' ? first : undefined
}

function bodyChunk(value: unknown): Buffer {
  if (typeof value === 'string' || value instanceof Uint8Array) return Buffer.from(value)
  throw new LubanError('E_INVALID_INPUT', 'request body is invalid')
}

async function authenticate(
  request: IncomingMessage,
  path: string,
  auth: AuthCarrier,
): Promise<AccountId> {
  const decision = await auth.middleware()({
    path,
    method: request.method ?? 'GET',
    accept: firstHeader(request.headers.accept),
    cookie: firstHeader(request.headers.cookie),
    sourceIp: sourceIp(request),
  })
  if (!decision.allowed || decision.user === undefined) throw new AuthRejected(decision.status)
  return decision.account?.accountId ?? asAccountId(decision.user)
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of request) {
    const value: unknown = raw
    const chunk = bodyChunk(value)
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) throw new LubanError('E_INVALID_INPUT', 'request body is too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error: unknown) {
    throw new LubanError('E_INVALID_INPUT', 'request body must be JSON', { cause: error })
  }
}

function record(value: unknown, name = 'body'): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LubanError('E_INVALID_INPUT', `${name} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function buildInput(value: unknown): BuildJobInput {
  const body = record(value)
  if (typeof body.templateId !== 'string' || body.templateId === '') {
    throw new LubanError('E_INVALID_INPUT', 'templateId is required')
  }
  const rawParams = record(body.params, 'params')
  if (!Object.values(rawParams).every((item): item is string => typeof item === 'string')) {
    throw new LubanError('E_INVALID_INPUT', 'params values must be strings')
  }
  return {
    templateId: body.templateId,
    params: { ...rawParams } as Readonly<Record<string, string>>,
  }
}

function errorStatus(error: LubanError): number {
  if (error.code === 'E_NOT_FOUND') return 404
  if (error.code === 'E_INVALID_INPUT') return 400
  if (error.code === 'E_QUOTA_EXCEEDED') return 429
  if (error.code === 'E_PLATFORM_UNSUPPORTED') return 409
  return 500
}

class BuildEventStream {
  readonly #service: DefaultServerModeService
  readonly #clients = new Map<ServerResponse, AccountId>()
  readonly #events: EventEnvelope[] = []
  readonly #unsubscribe: () => void
  readonly #heartbeat: ReturnType<typeof setInterval>
  #sequence = 0

  public constructor(service: DefaultServerModeService) {
    this.#service = service
    this.#unsubscribe = service.subscribe((event): void => this.publish(event))
    this.#heartbeat = setInterval((): void => {
      for (const response of this.#clients.keys()) {
        if (!response.write(': heartbeat\n\n')) this.#remove(response)
      }
    }, 15_000)
    this.#heartbeat.unref()
  }

  public publish(event: BuildQueueEvent): void {
    const envelope: EventEnvelope = {
      id: ++this.#sequence,
      event: event.type === 'job' ? 'build' : 'resource',
      data: event,
    }
    this.#events.push(envelope)
    if (this.#events.length > 256) this.#events.shift()
    for (const [response, accountId] of this.#clients) {
      if (event.type === 'resource' || event.job.accountId === accountId) {
        this.#write(response, envelope)
      }
    }
  }

  public async connect(
    request: IncomingMessage,
    response: ServerResponse,
    accountId: AccountId,
  ): Promise<void> {
    const header = request.headers['last-event-id']
    const requested = Number.parseInt(
      Array.isArray(header) ? (header[0] ?? '') : (header ?? ''),
      10,
    )
    const oldest = this.#events[0]?.id ?? this.#sequence
    const pending =
      !Number.isSafeInteger(requested) || requested < oldest - 1 || requested > this.#sequence
        ? [
            {
              id: this.#sequence,
              event: 'baseline' as const,
              data: {
                jobs: await this.#service.queue(accountId),
                resource: await this.#service.resourceReport(accountId),
              },
            },
          ]
        : this.#events.filter(
            (event): boolean =>
              event.id > requested &&
              (event.event === 'resource' ||
                ((event.data as BuildQueueEvent).type === 'job' &&
                  (event.data as Extract<BuildQueueEvent, { readonly type: 'job' }>).job
                    .accountId === accountId)),
          )
    response.statusCode = 200
    securityHeaders(response)
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('connection', 'keep-alive')
    response.setHeader('x-accel-buffering', 'no')
    response.flushHeaders()
    this.#clients.set(response, accountId)
    response.once('close', (): void => this.#remove(response))
    response.write('retry: 2000\n\n')
    for (const event of pending) this.#write(response, event)
  }

  public dispose(): void {
    clearInterval(this.#heartbeat)
    this.#unsubscribe()
    for (const response of this.#clients.keys()) response.end()
    this.#clients.clear()
  }

  #write(response: ServerResponse, envelope: EventEnvelope): void {
    const data = JSON.stringify(envelope.data).replaceAll('\n', '\\n')
    if (!response.write(`id: ${String(envelope.id)}\nevent: ${envelope.event}\ndata: ${data}\n\n`))
      this.#remove(response)
  }

  #remove(response: ServerResponse): void {
    this.#clients.delete(response)
    if (!response.writableEnded) response.end()
  }
}

export interface ServerModeHttpApiOptions {
  readonly service: DefaultServerModeService
  readonly auth: AuthCarrier
  readonly artifacts: ArtifactManager
  readonly signer: ArtifactLinkSigner
}

export class ServerModeHttpApi {
  readonly #service: DefaultServerModeService
  readonly #auth: AuthCarrier
  readonly #artifacts: ArtifactManager
  readonly #signer: ArtifactLinkSigner
  readonly #events: BuildEventStream

  public constructor(options: ServerModeHttpApiOptions) {
    this.#service = options.service
    this.#auth = options.auth
    this.#artifacts = options.artifacts
    this.#signer = options.signer
    this.#events = new BuildEventStream(options.service)
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
      const accountId = await authenticate(request, url.pathname, this.#auth)
      const path = url.pathname.slice(PREFIX.length) || '/'
      const method = request.method ?? 'GET'
      if (method === 'GET' && path === '/events') {
        await this.#events.connect(request, response, accountId)
        return
      }
      if (method === 'GET' && path === '/templates') {
        sendJson(response, 200, { templates: this.#service.templates() })
        return
      }
      if (method === 'GET' && path === '/jobs') {
        sendJson(response, 200, { jobs: await this.#service.queue(accountId) })
        return
      }
      if (method === 'POST' && path === '/jobs') {
        sendJson(response, 202, {
          job: await this.#service.enqueue({
            ...buildInput(await jsonBody(request)),
            accountId,
          }),
        })
        return
      }
      if (method === 'GET' && path === '/resources') {
        sendJson(response, 200, await this.#service.resourceReport(accountId))
        return
      }
      const match = /^\/jobs\/([^/]+)(?:\/(artifacts|error-log)(?:\/(.+))?)?$/u.exec(path)
      if (match === null) throw new LubanError('E_NOT_FOUND', 'Route not found')
      const encodedId = match[1]
      if (encodedId === undefined) throw new LubanError('E_INVALID_INPUT', 'job id is missing')
      const jobId = decodeURIComponent(encodedId)
      const action = match[2]
      const encodedName = match[3]
      if (method === 'GET' && action === undefined) {
        sendJson(response, 200, { job: await this.#service.get(jobId, accountId) })
        return
      }
      if (method === 'GET' && action === 'error-log' && encodedName === undefined) {
        sendJson(response, 200, { excerpt: await this.#service.errorExcerpt(jobId, accountId) })
        return
      }
      const artifacts = await this.#service.artifacts(jobId, accountId)
      if (method === 'GET' && action === 'artifacts' && encodedName === undefined) {
        sendJson(response, 200, {
          artifacts: artifacts.map((artifact) => {
            const signed = this.#signer.sign(jobId, artifact.name)
            return {
              name: artifact.name,
              sizeBytes: artifact.sizeBytes,
              downloadUrl: `${PREFIX}/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifact.name)}?expires=${String(signed.expires)}&signature=${encodeURIComponent(signed.signature)}`,
            }
          }),
        })
        return
      }
      if (method !== 'GET' || action !== 'artifacts' || encodedName === undefined) {
        throw new LubanError('E_NOT_FOUND', 'Route not found')
      }
      const name = decodeURIComponent(encodedName)
      const expires = Number.parseInt(url.searchParams.get('expires') ?? '', 10)
      const signature = url.searchParams.get('signature') ?? ''
      if (!this.#signer.verify(jobId, name, expires, signature)) {
        throw new LubanError('E_AUTH_REQUIRED', 'artifact link is invalid or expired')
      }
      const artifact = artifacts.find((candidate): boolean => candidate.name === name)
      if (artifact === undefined) throw new LubanError('E_NOT_FOUND', 'artifact was not found')
      const file = await this.#artifacts.secureFile(jobId, artifact)
      response.statusCode = 200
      securityHeaders(response)
      response.setHeader('content-type', 'application/octet-stream')
      response.setHeader('content-length', file.sizeBytes)
      response.setHeader('content-disposition', `attachment; filename="${attachmentName(name)}"`)
      await pipeline(createReadStream(file.path), response)
    } catch (error: unknown) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined)
        return
      }
      if (error instanceof AuthRejected) {
        sendJson(response, error.status, {
          error: { code: 'E_AUTH_REQUIRED', message: error.message },
        })
        return
      }
      const normalized = isLubanError(error)
        ? error
        : new LubanError('E_IO', 'Server mode request failed', { cause: error })
      const status = normalized.code === 'E_AUTH_REQUIRED' ? 403 : errorStatus(normalized)
      sendJson(response, status, { error: normalized.toJSON() })
    }
  }

  public dispose(): void {
    this.#events.dispose()
  }
}
