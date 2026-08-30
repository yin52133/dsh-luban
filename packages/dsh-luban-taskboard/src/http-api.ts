import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  AccountId,
  Actor,
  AuthService,
  Task,
  TaskEvent,
  TaskId,
  TaskPatch,
  TaskStatus,
} from 'dsh-luban-core'
import {
  LubanError,
  asAccountId,
  asActorId,
  asHostId,
  asSessionId,
  asTaskId,
  isLubanError,
  modulePrefix,
} from 'dsh-luban-core'
import type { DefaultAgentClaimService } from './claim-service.js'
import type { DefaultNightScheduler } from './night-scheduler.js'
import type { ImportTask, JsonTaskStore } from './task-store.js'

const PREFIX = modulePrefix('taskboard')
const MAX_BODY_BYTES = 1_048_576
const TASK_STATUSES = new Set<TaskStatus>(['backlog', 'todo', 'doing', 'review', 'done', 'dropped'])

interface EventEnvelope {
  readonly id: number
  readonly event: 'task' | 'baseline'
  readonly data: unknown
}

interface AuthCarrier {
  readonly middleware: AuthService['middleware']
  readonly accountSessions: AuthService['accountSessions']
}

type ScopedActor = Actor & { readonly accountId: AccountId }

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
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string')
    throw new LubanError('E_INVALID_INPUT', `${label} must be a string`)
  return value
}

function stringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be a string array`)
  }
  return value
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
  if (chunks.length === 0) throw new LubanError('E_INVALID_INPUT', 'Request body is required')
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

function sendNoContent(response: ServerResponse): void {
  response.statusCode = 204
  securityHeaders(response)
  response.end()
}

function errorStatus(error: LubanError): number {
  switch (error.code) {
    case 'E_AUTH_REQUIRED':
      return 401
    case 'E_NOT_FOUND':
    case 'E_ACCOUNT_SCOPE_MISMATCH':
      return 404
    case 'E_VERSION_CONFLICT':
      return 409
    case 'E_INVALID_TRANSITION':
    case 'E_ACCEPTANCE_REQUIRED':
      return 422
    case 'E_QUOTA_EXCEEDED':
      return 429
    case 'E_UNAVAILABLE':
      return 503
    case 'E_INVALID_INPUT':
      return 400
    default:
      return 500
  }
}

function sourceIp(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown'
}

async function requireActor(
  request: IncomingMessage,
  path: string,
  auth: AuthCarrier | undefined,
): Promise<ScopedActor> {
  if (auth === undefined)
    throw new LubanError('E_UNAVAILABLE', 'Luban authentication service is unavailable')
  const decision = await auth.middleware()({
    path,
    method: request.method ?? 'GET',
    accept: request.headers.accept,
    cookie: request.headers.cookie,
    sourceIp: sourceIp(request),
  })
  if (!decision.allowed || decision.user === undefined) {
    throw new LubanError('E_AUTH_REQUIRED', 'Authentication is required', {
      details: { status: decision.status },
    })
  }
  const accountId = decision.account?.accountId ?? asAccountId(decision.user)
  return {
    kind: 'user',
    id: asActorId(accountId),
    accountId,
    displayName: decision.user,
  }
}

async function requireOwnedTask(
  store: JsonTaskStore,
  id: TaskId,
  accountId: AccountId,
): Promise<Task> {
  const task = await store.get(id)
  if (task?.accountId !== accountId) {
    throw new LubanError('E_NOT_FOUND', `Task ${id} was not found`)
  }
  return task
}

function taskInput(
  body: Readonly<Record<string, unknown>>,
): Parameters<JsonTaskStore['create']>[0] {
  const hostScope = body.hostScope
  if (hostScope !== 'win' && hostScope !== 'ubuntu' && hostScope !== 'any') {
    throw new LubanError('E_INVALID_INPUT', 'hostScope must be win, ubuntu, or any')
  }
  const priority = body.priority
  if (priority !== 'P0' && priority !== 'P1' && priority !== 'P2' && priority !== 'P3') {
    throw new LubanError('E_INVALID_INPUT', 'priority must be P0, P1, P2, or P3')
  }
  const status = body.status
  if (status !== undefined && status !== 'backlog' && status !== 'todo') {
    throw new LubanError('E_INVALID_INPUT', 'new task status must be backlog or todo')
  }
  const tags = stringArray(body.tags, 'tags')
  return {
    title: requiredString(body.title, 'title'),
    hostScope,
    priority,
    ...(typeof body.description === 'string' ? { description: body.description } : {}),
    ...(status === undefined ? {} : { status }),
    ...(typeof body.workspace === 'string' ? { workspace: body.workspace } : {}),
    ...(typeof body.acceptance === 'string' ? { acceptance: body.acceptance } : {}),
    ...(tags === undefined ? {} : { tags }),
  }
}

function taskPatch(body: Readonly<Record<string, unknown>>): TaskPatch {
  const priority = body.priority
  if (
    priority !== undefined &&
    priority !== 'P0' &&
    priority !== 'P1' &&
    priority !== 'P2' &&
    priority !== 'P3'
  )
    throw new LubanError('E_INVALID_INPUT', 'priority must be P0, P1, P2, or P3')
  const workspace = body.workspace
  if (workspace !== undefined && workspace !== null && typeof workspace !== 'string') {
    throw new LubanError('E_INVALID_INPUT', 'workspace must be a string or null')
  }
  const acceptance = body.acceptance
  if (acceptance !== undefined && acceptance !== null && typeof acceptance !== 'string') {
    throw new LubanError('E_INVALID_INPUT', 'acceptance must be a string or null')
  }
  return {
    ...(optionalString(body.title, 'title') === undefined ? {} : { title: body.title as string }),
    ...(optionalString(body.description, 'description') === undefined
      ? {}
      : { description: body.description as string }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(priority === undefined ? {} : { priority }),
    ...(acceptance === undefined ? {} : { acceptance }),
    ...(stringArray(body.tags, 'tags') === undefined
      ? {}
      : { tags: body.tags as readonly string[] }),
  }
}

function expectedVersion(body: Readonly<Record<string, unknown>>): number {
  if (typeof body.expectedVersion !== 'number' || !Number.isSafeInteger(body.expectedVersion)) {
    throw new LubanError('E_INVALID_INPUT', 'expectedVersion must be an integer')
  }
  return body.expectedVersion
}

function importedTasks(value: unknown): readonly ImportTask[] {
  const root = Array.isArray(value) ? value : record(value)
  const rows = Array.isArray(root) ? root : root.tasks
  if (!Array.isArray(rows))
    throw new LubanError('E_INVALID_INPUT', 'import must contain a tasks array')
  return rows.map((raw, index): ImportTask => {
    const row = record(raw, `tasks[${String(index)}]`)
    const title = row.title ?? row.name ?? row.summary
    const rawStatus = row.status
    const status = rawStatus === 'todo' || rawStatus === 'backlog' ? rawStatus : 'backlog'
    const rawHost = row.hostScope ?? row.host
    const hostScope =
      rawHost === 'win' || rawHost === 'ubuntu' || rawHost === 'any' ? rawHost : 'any'
    const rawPriority = row.priority
    const priority =
      rawPriority === 'P0' || rawPriority === 'P1' || rawPriority === 'P2' || rawPriority === 'P3'
        ? rawPriority
        : 'P2'
    return {
      title: requiredString(title, `tasks[${String(index)}].title`),
      ...(typeof row.description === 'string'
        ? { description: row.description }
        : typeof row.detail === 'string'
          ? { description: row.detail }
          : {}),
      status,
      hostScope,
      priority,
      ...(typeof row.workspace === 'string'
        ? { workspace: row.workspace }
        : typeof row.project === 'string'
          ? { workspace: row.project }
          : {}),
      ...(typeof row.acceptance === 'string'
        ? { acceptance: row.acceptance }
        : typeof row.acceptanceCriteria === 'string'
          ? { acceptance: row.acceptanceCriteria }
          : {}),
      ...(stringArray(row.tags, `tasks[${String(index)}].tags`) === undefined
        ? {}
        : { tags: row.tags as readonly string[] }),
    }
  })
}

/** Bounded SSE broadcaster with baseline recovery after an event gap. */
export class TaskEventStream {
  readonly #store: JsonTaskStore
  readonly #clients = new Map<ServerResponse, AccountId>()
  readonly #events: EventEnvelope[] = []
  readonly #unsubscribe: () => void
  readonly #heartbeat: ReturnType<typeof setInterval>
  #sequence = 0

  public constructor(store: JsonTaskStore) {
    this.#store = store
    this.#unsubscribe = store.subscribe((event): void => this.publish(event))
    this.#heartbeat = setInterval((): void => {
      for (const response of this.#clients.keys()) {
        if (!response.write(': heartbeat\n\n')) this.#remove(response)
      }
    }, 15_000)
    this.#heartbeat.unref()
  }

  public publish(event: TaskEvent): void {
    const envelope: EventEnvelope = { id: ++this.#sequence, event: 'task', data: event }
    this.#events.push(envelope)
    if (this.#events.length > 256) this.#events.shift()
    for (const [response, accountId] of this.#clients) {
      if (event.task.accountId === accountId) this.#write(response, envelope)
    }
  }

  public async connect(
    request: IncomingMessage,
    response: ServerResponse,
    accountId: AccountId,
  ): Promise<void> {
    const lastEventId = request.headers['last-event-id']
    const requested = Number.parseInt(
      Array.isArray(lastEventId) ? (lastEventId[0] ?? '') : (lastEventId ?? ''),
      10,
    )
    const oldest = this.#events[0]?.id ?? this.#sequence
    const baselineRequired =
      !Number.isSafeInteger(requested) || requested < oldest - 1 || requested > this.#sequence
    const pending = baselineRequired
      ? [
          {
            id: this.#sequence,
            event: 'baseline' as const,
            data: await this.#store.query({ accountId }),
          },
        ]
      : this.#events.filter(
          (event): boolean =>
            event.id > requested &&
            event.event === 'task' &&
            (event.data as TaskEvent).task.accountId === accountId,
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
    for (const envelope of pending) this.#write(response, envelope)
  }

  public dispose(): void {
    clearInterval(this.#heartbeat)
    this.#unsubscribe()
    for (const response of this.#clients.keys()) response.end()
    this.#clients.clear()
  }

  #write(response: ServerResponse, envelope: EventEnvelope): void {
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
}

export interface TaskboardHttpApiOptions {
  readonly store: JsonTaskStore
  readonly claims: DefaultAgentClaimService
  readonly scheduler: DefaultNightScheduler
  readonly auth: AuthCarrier
}

export class TaskboardHttpApi {
  readonly #store: JsonTaskStore
  readonly #claims: DefaultAgentClaimService
  readonly #scheduler: DefaultNightScheduler
  readonly #auth: AuthCarrier
  readonly #events: TaskEventStream

  public constructor(options: TaskboardHttpApiOptions) {
    this.#store = options.store
    this.#claims = options.claims
    this.#scheduler = options.scheduler
    this.#auth = options.auth
    this.#events = new TaskEventStream(options.store)
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
        await this.#events.connect(request, response, actor.accountId)
        return
      }
      if (method === 'GET' && path === '/tasks') {
        const statuses = url.searchParams.getAll('status')
        if (
          !statuses.every((status): status is TaskStatus => TASK_STATUSES.has(status as TaskStatus))
        ) {
          throw new LubanError('E_INVALID_INPUT', 'status filter is invalid')
        }
        const host = url.searchParams.get('hostScope')
        if (host !== null && host !== 'win' && host !== 'ubuntu' && host !== 'any') {
          throw new LubanError('E_INVALID_INPUT', 'hostScope filter is invalid')
        }
        const tasks = await this.#store.query({
          accountId: actor.accountId,
          ...(statuses.length === 0 ? {} : { statuses }),
          ...(host === null ? {} : { hostScope: host }),
          ...(url.searchParams.has('workspace')
            ? { workspace: url.searchParams.get('workspace') ?? '' }
            : {}),
          ...(url.searchParams.getAll('tag').length === 0
            ? {}
            : { tags: url.searchParams.getAll('tag') }),
        })
        sendJson(response, 200, { tasks })
        return
      }
      if (method === 'POST' && path === '/tasks') {
        sendJson(response, 201, {
          task: await this.#store.create({
            ...taskInput(record(await jsonBody(request))),
            accountId: actor.accountId,
          }),
        })
        return
      }
      if (method === 'POST' && path === '/claim') {
        const body = record(await jsonBody(request))
        const sessionId = asSessionId(requiredString(body.sessionId, 'sessionId'))
        await this.#auth.accountSessions.bind(actor.accountId, sessionId)
        const result = await this.#claims.claim(
          {
            accountId: actor.accountId,
            statuses: ['todo'],
            ...(typeof body.workspace === 'string' ? { workspace: body.workspace } : {}),
            ...(stringArray(body.tags, 'tags') === undefined
              ? {}
              : { tags: body.tags as readonly string[] }),
            requireAcceptance: body.requireAcceptance !== false,
          },
          {
            actor: {
              kind: 'agent',
              id: asActorId(sessionId),
              accountId: actor.accountId,
              ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
            },
            sessionId,
            host: asHostId(typeof body.host === 'string' ? body.host : 'local'),
          },
        )
        sendJson(response, result.ok ? 200 : 409, result)
        return
      }
      if (method === 'POST' && path === '/import') {
        sendJson(response, 200, {
          report: await this.#store.import(importedTasks(await jsonBody(request)), actor.accountId),
        })
        return
      }
      if (method === 'GET' && path === '/scheduler/status') {
        sendJson(response, 200, this.#scheduler.status())
        return
      }
      if (method === 'POST' && path === '/scheduler/trigger') {
        await this.#scheduler.triggerOnce()
        sendJson(response, 202, this.#scheduler.status())
        return
      }

      const match = /^\/tasks\/([^/]+)(?:\/(transition|progress|complete|fail))?$/u.exec(path)
      if (match === null) throw new LubanError('E_NOT_FOUND', 'Route not found')
      const encodedId = match[1]
      if (encodedId === undefined) throw new LubanError('E_INVALID_INPUT', 'Task id is missing')
      const id = asTaskId(decodeURIComponent(encodedId))
      const action = match[2]
      const ownedTask = await requireOwnedTask(this.#store, id, actor.accountId)
      if (method === 'GET' && action === undefined) {
        sendJson(response, 200, { task: ownedTask })
        return
      }
      if (method === 'PATCH' && action === undefined) {
        const body = record(await jsonBody(request))
        sendJson(response, 200, {
          task: await this.#store.update(id, taskPatch(body), expectedVersion(body)),
        })
        return
      }
      if (method === 'DELETE' && action === undefined) {
        const body = record(await jsonBody(request))
        sendJson(response, 200, {
          task: await this.#store.transitionWithVersion(
            id,
            'dropped',
            actor,
            expectedVersion(body),
            optionalString(body.note, 'note'),
          ),
        })
        return
      }
      if (method === 'POST' && action === 'transition') {
        const body = record(await jsonBody(request))
        const to = requiredString(body.to, 'to') as TaskStatus
        if (!TASK_STATUSES.has(to)) throw new LubanError('E_INVALID_INPUT', 'to status is invalid')
        sendJson(response, 200, {
          task: await this.#store.transitionWithVersion(
            id,
            to,
            actor,
            expectedVersion(body),
            optionalString(body.note, 'note'),
          ),
        })
        return
      }
      if (method === 'POST' && action === 'progress') {
        const body = record(await jsonBody(request))
        await this.#claims.reportProgress(id, {
          summary: requiredString(body.summary, 'summary'),
          ...(typeof body.percent === 'number' ? { percent: body.percent } : {}),
        })
        sendNoContent(response)
        return
      }
      if (method === 'POST' && action === 'complete') {
        const body = record(await jsonBody(request))
        if (ownedTask.claim === undefined || ownedTask.claim === null) {
          throw new LubanError('E_INVALID_TRANSITION', 'Task is not claimed')
        }
        const kind = body.kind
        if (kind !== 'note' && kind !== 'commit' && kind !== 'artifact' && kind !== 'link') {
          throw new LubanError('E_INVALID_INPUT', 'output kind is invalid')
        }
        sendJson(response, 200, {
          task: await this.#claims.complete(
            id,
            {
              kind,
              ref: requiredString(body.ref, 'ref'),
              summary: requiredString(body.summary, 'summary'),
              at: Date.now(),
              by: ownedTask.claim.actor,
            },
            { autoDone: body.autoDone === true },
          ),
        })
        return
      }
      if (method === 'POST' && action === 'fail') {
        const body = record(await jsonBody(request))
        await this.#claims.fail(id, requiredString(body.reason, 'reason'))
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
        : new LubanError('E_IO', 'Taskboard request failed', { cause: error })
      sendJson(response, errorStatus(normalized), { error: normalized.toJSON() })
    }
  }

  public dispose(): void {
    this.#events.dispose()
  }
}
