import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Actor, AuthService, PlanSections, PlanStatus } from 'dsh-luban-core'
import {
  LubanError,
  asActorId,
  asPlanId,
  asSessionId,
  asTaskId,
  isLubanError,
  modulePrefix,
} from 'dsh-luban-core'
import type { PlanFeedbackEvent, PlanServiceWithFeedback } from './service.js'
import { bundledTemplate } from './template.js'

const PREFIX = modulePrefix('plan')
const MAX_BODY_BYTES = 1_048_576
const PLAN_STATUSES = new Set<PlanStatus>([
  'draft',
  'in-review',
  'approved',
  'executing',
  'completed',
  'rejected',
  'revising',
])

function record(value: unknown, label = 'request body'): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LubanError('E_INVALID_INPUT', `${label} must be a non-empty string`)
  }
  return value.trim()
}

function expectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new LubanError('E_INVALID_INPUT', 'expectedVersion must be a positive integer')
  }
  return value
}

function sections(value: unknown): PlanSections {
  const row = record(value, 'sections')
  return {
    background: requiredString(row.background, 'sections.background'),
    impact: requiredString(row.impact, 'sections.impact'),
    changes: requiredString(row.changes, 'sections.changes'),
    verification: requiredString(row.verification, 'sections.verification'),
  }
}

function draftSections(value: unknown): PlanSections {
  const row = record(value, 'sections')
  return {
    background: typeof row.background === 'string' ? row.background : '',
    impact: typeof row.impact === 'string' ? row.impact : '',
    changes: typeof row.changes === 'string' ? row.changes : '',
    verification: typeof row.verification === 'string' ? row.verification : '',
  }
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new LubanError('E_INVALID_INPUT', 'Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const raw of request as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.from(raw)
    total += chunk.byteLength
    if (total > MAX_BODY_BYTES) throw new LubanError('E_INVALID_INPUT', 'Request body is too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error: unknown) {
    throw new LubanError('E_INVALID_INPUT', 'Request body is not valid JSON', { cause: error })
  }
}

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
    case 'E_VERSION_CONFLICT':
      return 409
    case 'E_INVALID_TRANSITION':
      return 422
    case 'E_INVALID_INPUT':
      return 400
    case 'E_UNAVAILABLE':
      return 503
    default:
      return 500
  }
}

async function requireActor(
  request: IncomingMessage,
  path: string,
  auth: AuthService,
): Promise<Actor> {
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
  return { kind: 'user', id: asActorId(decision.user), displayName: decision.user }
}

interface EventEnvelope {
  readonly id: number
  readonly event: PlanFeedbackEvent
}

/** Bounded plan feedback stream used by the review page and reconnecting agents. */
export class PlanEventStream {
  readonly #clients = new Set<ServerResponse>()
  readonly #events: EventEnvelope[] = []
  readonly #unsubscribe: () => void
  readonly #heartbeat: ReturnType<typeof setInterval>
  #sequence = 0

  public constructor(service: PlanServiceWithFeedback) {
    this.#unsubscribe = service.subscribeFeedback(undefined, (event): void => this.publish(event))
    this.#heartbeat = setInterval((): void => {
      for (const response of [...this.#clients]) {
        if (!response.write(': heartbeat\n\n')) this.#remove(response)
      }
    }, 15_000)
    this.#heartbeat.unref()
  }

  public publish(event: PlanFeedbackEvent): void {
    const envelope = { id: ++this.#sequence, event }
    this.#events.push(envelope)
    if (this.#events.length > 256) this.#events.shift()
    for (const response of [...this.#clients]) this.#write(response, envelope)
  }

  public connect(request: IncomingMessage, response: ServerResponse): void {
    const header = request.headers['last-event-id']
    const requested = Number.parseInt(
      Array.isArray(header) ? (header[0] ?? '') : (header ?? ''),
      10,
    )
    response.statusCode = 200
    securityHeaders(response)
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    response.setHeader('connection', 'keep-alive')
    response.setHeader('x-accel-buffering', 'no')
    response.flushHeaders()
    response.write('retry: 2000\n\n')
    this.#clients.add(response)
    response.once('close', (): void => this.#remove(response))
    for (const envelope of this.#events.filter(
      (item): boolean => !Number.isSafeInteger(requested) || item.id > requested,
    )) {
      this.#write(response, envelope)
    }
  }

  public dispose(): void {
    clearInterval(this.#heartbeat)
    this.#unsubscribe()
    for (const response of [...this.#clients]) response.end()
    this.#clients.clear()
  }

  #write(response: ServerResponse, envelope: EventEnvelope): void {
    const data = JSON.stringify(envelope.event).replaceAll('\n', '\\n')
    if (!response.write(`id: ${String(envelope.id)}\nevent: plan\ndata: ${data}\n\n`))
      this.#remove(response)
  }

  #remove(response: ServerResponse): void {
    this.#clients.delete(response)
    if (!response.writableEnded) response.end()
  }
}

export class PlanHttpApi {
  readonly #service: PlanServiceWithFeedback
  readonly #auth: AuthService
  readonly #events: PlanEventStream

  public constructor(service: PlanServiceWithFeedback, auth: AuthService) {
    this.#service = service
    this.#auth = auth
    this.#events = new PlanEventStream(service)
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
      const actor = await requireActor(request, url.pathname, this.#auth)
      const path = url.pathname.slice(PREFIX.length) || '/'
      const method = request.method ?? 'GET'
      if (method === 'GET' && path === '/events') {
        this.#events.connect(request, response)
        return
      }
      if (method === 'GET' && path === '/template') {
        sendText(response, 200, bundledTemplate())
        return
      }
      if (method === 'GET' && path === '/plans') {
        const taskId = url.searchParams.get('taskId')
        sendJson(response, 200, {
          plans: await this.#service.listFor(taskId === null ? undefined : asTaskId(taskId)),
        })
        return
      }
      if (method === 'POST' && path === '/plans') {
        const body = record(await jsonBody(request))
        sendJson(response, 201, {
          plan: await this.#service.submit({
            workspace: requiredString(body.workspace, 'workspace'),
            slug: requiredString(body.slug, 'slug'),
            sections: sections(body.sections),
            ...(typeof body.taskId === 'string' ? { taskId: asTaskId(body.taskId) } : {}),
            ...(typeof body.sessionId === 'string'
              ? { sessionId: asSessionId(body.sessionId) }
              : {}),
          }),
        })
        return
      }
      if (method === 'POST' && path === '/drafts') {
        const body = record(await jsonBody(request))
        sendJson(response, 201, {
          plan: await this.#service.saveDraft({
            workspace: requiredString(body.workspace, 'workspace'),
            slug: requiredString(body.slug, 'slug'),
            sections: draftSections(body.sections),
            ...(typeof body.taskId === 'string' ? { taskId: asTaskId(body.taskId) } : {}),
            ...(typeof body.sessionId === 'string'
              ? { sessionId: asSessionId(body.sessionId) }
              : {}),
          }),
        })
        return
      }
      const match = /^\/plans\/([^/]+)(?:\/(decision|transition|revise|document))?$/u.exec(path)
      if (match?.[1] === undefined) throw new LubanError('E_NOT_FOUND', 'Route not found')
      const id = asPlanId(decodeURIComponent(match[1]))
      const action = match[2]
      if (method === 'GET' && action === undefined) {
        const plan = await this.#service.get(id)
        if (plan === null) throw new LubanError('E_NOT_FOUND', `Plan ${id} was not found`)
        sendJson(response, 200, { plan })
        return
      }
      if (method === 'GET' && action === 'document') {
        sendText(response, 200, await this.#service.getDocument(id))
        return
      }
      const body = record(await jsonBody(request))
      if (method === 'POST' && action === 'decision') {
        if (body.decision !== 'approve' && body.decision !== 'reject') {
          throw new LubanError('E_INVALID_INPUT', 'decision must be approve or reject')
        }
        sendJson(response, 200, {
          plan: await this.#service.decide(
            id,
            {
              decision: body.decision,
              ...(typeof body.comment === 'string' ? { comment: body.comment } : {}),
              expectedVersion: expectedVersion(body.expectedVersion),
            },
            actor,
          ),
        })
        return
      }
      if (method === 'POST' && action === 'transition') {
        const to = requiredString(body.to, 'to') as PlanStatus
        if (!PLAN_STATUSES.has(to)) throw new LubanError('E_INVALID_INPUT', 'to status is invalid')
        sendJson(response, 200, {
          plan: await this.#service.transition(id, to, expectedVersion(body.expectedVersion)),
        })
        return
      }
      if (method === 'POST' && action === 'revise') {
        sendJson(response, 200, {
          plan: await this.#service.revise(
            id,
            sections(body.sections),
            expectedVersion(body.expectedVersion),
          ),
        })
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
        : new LubanError('E_IO', 'Plan request failed', { cause: error })
      sendJson(response, errorStatus(normalized), { error: normalized.toJSON() })
    }
  }

  public dispose(): void {
    this.#events.dispose()
  }
}
