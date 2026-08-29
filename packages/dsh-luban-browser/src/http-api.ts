import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthService, BrowserTaskSpec, BrowserTemplate } from '@luban/core'
import { BrowserError } from './errors.js'
import { authRequest } from './security.js'
import type {
  BrowserJobEvent,
  BrowserJobRequest,
  BrowserJobSnapshot,
  BrowserQueue,
} from './types.js'

const PREFIX = '/luban-browser'
const MAX_BODY_BYTES = 256 * 1024
const EVENT_HISTORY_SIZE = 256

interface TemplateSource {
  templates(): Promise<readonly BrowserTemplate[]>
}

export class BrowserHttpApi {
  readonly #queue: BrowserQueue
  readonly #templates: TemplateSource
  readonly #auth: AuthService
  readonly #events: BrowserJobEvent[] = []
  readonly #clients = new Set<ServerResponse>()
  readonly #unsubscribe: () => void

  public constructor(queue: BrowserQueue, templates: TemplateSource, auth: AuthService) {
    this.#queue = queue
    this.#templates = templates
    this.#auth = auth
    this.#unsubscribe = queue.subscribe((event): void => this.#broadcast(event))
  }

  public readonly handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!(await this.#authenticate(req, res))) return
      const url = new URL(req.url ?? PREFIX, `http://${req.headers.host ?? 'localhost'}`)
      const path = normalizePath(url.pathname)
      const method = req.method ?? 'GET'

      if (method === 'GET' && (path === '' || path === '/status')) {
        const jobs = this.#queue.list()
        sendJson(res, 200, {
          status: 'ok',
          queue: {
            queued: jobs.filter((job) => job.status === 'queued').length,
            running: jobs.filter((job) => job.status === 'running').length,
          },
        })
        return
      }
      if (method === 'GET' && path === '/templates') {
        sendJson(res, 200, { templates: await this.#templates.templates() })
        return
      }
      if (method === 'GET' && path === '/jobs') {
        sendJson(res, 200, { jobs: this.#queue.list() })
        return
      }
      if (method === 'POST' && path === '/jobs') {
        const body = await readJson(req)
        const job = this.#queue.enqueue(decodeJobRequest(body))
        sendJson(res, 202, { job })
        return
      }
      if (method === 'GET' && path === '/events') {
        this.#openEvents(req, res)
        return
      }
      const match = /^\/jobs\/([0-9a-f-]+)(\/cancel)?$/u.exec(path)
      if (match !== null) {
        const id = match[1]
        if (id === undefined)
          throw new BrowserError('E_BROWSER_NOT_FOUND', 'Browser job was not found')
        if (method === 'GET' && match[2] === undefined) {
          const job = this.#queue.get(id)
          if (job === null)
            throw new BrowserError('E_BROWSER_NOT_FOUND', 'Browser job was not found')
          sendJson(res, 200, { job })
          return
        }
        if (method === 'POST' && match[2] === '/cancel') {
          const cancelled = await this.#queue.cancel(id)
          if (!cancelled && this.#queue.get(id) === null) {
            throw new BrowserError('E_BROWSER_NOT_FOUND', 'Browser job was not found')
          }
          sendJson(res, 200, { cancelled, job: this.#queue.get(id) })
          return
        }
      }
      if (
        path === '/jobs' ||
        path === '/templates' ||
        path === '/events' ||
        path === '/status' ||
        path.startsWith('/jobs/')
      ) {
        res.writeHead(405, { Allow: allowedMethods(path) })
        res.end()
        return
      }
      sendJson(res, 404, { error: { code: 'E_BROWSER_NOT_FOUND', message: 'Route not found' } })
    } catch (error: unknown) {
      const failure =
        error instanceof BrowserError
          ? error
          : new BrowserError('E_BROWSER_RUN', 'Browser API request failed')
      sendJson(res, statusFor(failure), { error: failure.toJSON() })
    }
  }

  public close(): void {
    this.#unsubscribe()
    for (const response of this.#clients) response.end()
    this.#clients.clear()
  }

  async #authenticate(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const decision = await this.#auth.middleware()(authRequest(req))
    if (decision.allowed) return true
    if (decision.redirectTo !== undefined) {
      res.writeHead(decision.status, { Location: decision.redirectTo, 'Cache-Control': 'no-store' })
      res.end()
    } else {
      sendJson(res, decision.status, {
        error: {
          code: decision.status === 429 ? 'E_AUTH_LOCKED' : 'E_AUTH_REQUIRED',
          message:
            decision.status === 429
              ? 'Authentication is temporarily locked'
              : 'Authentication required',
        },
      })
    }
    return false
  }

  #openEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    const lastId = Number(req.headers['last-event-id'] ?? 0)
    if (Number.isSafeInteger(lastId) && lastId >= 0) {
      for (const event of this.#events) {
        if (event.sequence > lastId) writeEvent(res, event)
      }
    }
    this.#clients.add(res)
    res.once('close', (): void => {
      this.#clients.delete(res)
    })
  }

  #broadcast(event: BrowserJobEvent): void {
    this.#events.push(event)
    if (this.#events.length > EVENT_HISTORY_SIZE) this.#events.shift()
    for (const response of [...this.#clients]) {
      if (!response.destroyed) writeEvent(response, event)
      else this.#clients.delete(response)
    }
  }
}

function decodeJobRequest(value: unknown): BrowserJobRequest {
  if (!isRecord(value) || !isRecord(value.task)) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'Request body must contain task')
  }
  const source = value.task
  const goal = source.goal
  const templateId = source.templateId
  const startUrl = source.startUrl
  if (typeof goal !== 'string' || goal.length > 100_000) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'task.goal must be a bounded string')
  }
  if (templateId !== undefined && typeof templateId !== 'string') {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'task.templateId must be a string')
  }
  if (startUrl !== undefined && typeof startUrl !== 'string') {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'task.startUrl must be a string')
  }
  const constraints = decodeConstraints(source.constraints)
  const task: BrowserTaskSpec = {
    ...(templateId === undefined ? {} : { templateId }),
    goal,
    ...(startUrl === undefined ? {} : { startUrl }),
    ...(constraints === undefined ? {} : { constraints }),
  }
  const params = decodeParameters(value.params)
  return {
    task,
    ...(params === undefined ? {} : { params }),
    automatic: false,
  }
}

function decodeConstraints(value: unknown): BrowserTaskSpec['constraints'] | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value))
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'constraints must be an object')
  const maxSteps = optionalInteger(value.maxSteps, 'maxSteps')
  const timeoutSec = optionalInteger(value.timeoutSec, 'timeoutSec')
  const allowDomains = value.allowDomains
  if (
    allowDomains !== undefined &&
    (!Array.isArray(allowDomains) || allowDomains.some((item) => typeof item !== 'string'))
  ) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'allowDomains must be a string array')
  }
  return {
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(timeoutSec === undefined ? {} : { timeoutSec }),
    ...(allowDomains === undefined ? {} : { allowDomains: allowDomains as string[] }),
  }
}

function decodeParameters(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new BrowserError('E_BROWSER_INVALID_TASK', 'params must be an object')
  const output: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, parameter] of Object.entries(value)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]*$/u.test(key) ||
      typeof parameter !== 'string' ||
      parameter.length > 16_384
    ) {
      throw new BrowserError('E_BROWSER_INVALID_TASK', 'params contains an invalid entry')
    }
    output[key] = parameter
  }
  return Object.freeze(output)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type']
  if (
    typeof contentType !== 'string' ||
    !contentType.toLowerCase().startsWith('application/json')
  ) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) {
      throw new BrowserError('E_BROWSER_INVALID_TASK', 'Request body is too large')
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new BrowserError('E_BROWSER_INVALID_TASK', 'Request body is not valid JSON')
  }
}

function normalizePath(path: string): string {
  if (path === PREFIX) return ''
  if (!path.startsWith(`${PREFIX}/`)) return '/__not_found__'
  const suffix = path.slice(PREFIX.length)
  return suffix.length > 1 ? suffix.replace(/\/+$/u, '') : suffix
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return
  const encoded = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(encoded)
}

function writeEvent(res: ServerResponse, event: BrowserJobEvent): void {
  res.write(`id: ${String(event.sequence)}\nevent: browser-job\ndata: ${JSON.stringify(event)}\n\n`)
}

function allowedMethods(path: string): string {
  if (path === '/jobs') return 'GET, POST'
  if (path.endsWith('/cancel')) return 'POST'
  return 'GET'
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value)) {
    throw new BrowserError('E_BROWSER_INVALID_TASK', `${name} must be an integer`)
  }
  return value as number
}

function statusFor(error: BrowserError): number {
  if (error.code === 'E_BROWSER_NOT_FOUND') return 404
  if (error.code === 'E_BROWSER_POLICY') return 403
  if (error.code === 'E_BROWSER_QUEUE_FULL') return 429
  if (error.code === 'E_BROWSER_UNAVAILABLE' || error.code === 'E_BROWSER_CLOSED') return 503
  if (error.code === 'E_BROWSER_INVALID_TASK' || error.code === 'E_BROWSER_INVALID_PROFILE')
    return 400
  return 500
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type { BrowserJobSnapshot }
