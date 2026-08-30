import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthService, SessionId } from '@luban/core'
import { LubanError, asSessionId, isLubanError, modulePrefix } from '@luban/core'
import { normalizeDeclaredMime } from './image-format.js'
import {
  downgradeVisualAcceptanceEvidence,
  MountedVisualAcceptanceService,
  type MountedVisualAcceptanceOptions,
  type VisualAcceptanceEvidence,
} from './live-visual-acceptance.js'
import type { FileImageIngestService } from './service.js'
import type { ImageSource, InjectStyle, StoredImage } from './types.js'

const PREFIX = modulePrefix('image-paste')
const MAX_JSON_BYTES = 64 * 1024
type ProductionVisualAcceptanceRun = (
  this: MountedVisualAcceptanceService,
  options: MountedVisualAcceptanceOptions,
) => Promise<VisualAcceptanceEvidence>

function captureProductionVisualAcceptanceRun(): ProductionVisualAcceptanceRun {
  const candidate = Object.getOwnPropertyDescriptor(MountedVisualAcceptanceService.prototype, 'run')
    ?.value as unknown
  if (typeof candidate !== 'function') {
    throw new Error('Mounted visual acceptance production runner is unavailable')
  }
  return candidate as ProductionVisualAcceptanceRun
}
const productionVisualAcceptanceRun = captureProductionVisualAcceptanceRun()

export interface MountedVisualAcceptanceRunner {
  run(options: MountedVisualAcceptanceOptions): Promise<VisualAcceptanceEvidence>
}

function record(value: unknown, label = 'request body'): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
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

function sendImage(response: ServerResponse, image: StoredImage, bytes: Uint8Array): void {
  const extension =
    image.mime === 'image/png' ? 'png' : image.mime === 'image/jpeg' ? 'jpg' : 'webp'
  const utf8Name = encodeURIComponent(`${image.originalName}.${extension}`).replace(
    /['()*]/gu,
    (character): string => `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? '3F'}`,
  )
  response.statusCode = 200
  securityHeaders(response)
  response.setHeader('content-security-policy', "default-src 'none'; sandbox")
  response.setHeader('content-type', image.mime)
  response.setHeader('content-length', String(bytes.byteLength))
  response.setHeader(
    'content-disposition',
    `inline; filename="image.${extension}"; filename*=UTF-8''${utf8Name}`,
  )
  response.setHeader('etag', `"sha256-${image.sha256}"`)
  response.end(Buffer.from(bytes))
}

function errorStatus(error: LubanError): number {
  switch (error.code) {
    case 'E_AUTH_REQUIRED':
      return 401
    case 'E_NOT_FOUND':
      return 404
    case 'E_INVALID_TRANSITION':
      return 409
    case 'E_INVALID_INPUT':
      return 400
    case 'E_TIMEOUT':
      return 504
    case 'E_UNAVAILABLE':
      return 503
    default:
      return 500
  }
}

async function requireAuthentication(
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
  if (!decision.allowed || decision.user === undefined) {
    throw new LubanError('E_AUTH_REQUIRED', 'Authentication is required', {
      details: { status: decision.status },
    })
  }
}

async function readBody(request: IncomingMessage, maximum: number): Promise<Uint8Array> {
  const declaredLength = Number.parseInt(request.headers['content-length'] ?? '', 10)
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw new LubanError('E_INVALID_INPUT', 'Request body is too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const raw of request as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.from(raw)
    total += chunk.byteLength
    if (total > maximum) throw new LubanError('E_INVALID_INPUT', 'Request body is too large')
    chunks.push(chunk)
  }
  if (total === 0) throw new LubanError('E_INVALID_INPUT', 'Request body is required')
  return new Uint8Array(Buffer.concat(chunks))
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const mime = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mime !== 'application/json') {
    throw new LubanError('E_INVALID_INPUT', 'Content-Type must be application/json')
  }
  const bytes = await readBody(request, MAX_JSON_BYTES)
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
  } catch (error: unknown) {
    throw new LubanError('E_INVALID_INPUT', 'Request body is not valid JSON', { cause: error })
  }
}

function source(value: string | null): ImageSource {
  if (value === 'paste' || value === 'drop' || value === 'clipboard-cli') return value
  throw new LubanError('E_INVALID_INPUT', 'source must be paste, drop, or clipboard-cli')
}

function style(value: unknown, fallback: InjectStyle): InjectStyle {
  if (value === undefined || value === null) return fallback
  if (value === 'markdown' || value === 'path') return value
  throw new LubanError('E_INVALID_INPUT', 'style must be markdown or path')
}

function sessionId(value: unknown): SessionId {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
    throw new LubanError('E_INVALID_INPUT', 'sessionId is invalid')
  }
  return asSessionId(value)
}

function imageJson(image: StoredImage): Readonly<Record<string, unknown>> {
  return {
    ...image,
    previewUrl: `${PREFIX}/images/${encodeURIComponent(image.id)}/content`,
  }
}

/** Authenticated upload, preview, injection, deletion, and TTL cleanup API. */
export class ImagePasteHttpApi {
  readonly #service: FileImageIngestService
  readonly #auth: AuthService
  readonly #visualAcceptance: MountedVisualAcceptanceRunner | undefined
  readonly #productionVisualAcceptance: MountedVisualAcceptanceService | undefined

  public constructor(
    service: FileImageIngestService,
    auth: AuthService,
    visualAcceptance?: MountedVisualAcceptanceRunner,
  ) {
    this.#service = service
    this.#auth = auth
    this.#visualAcceptance = visualAcceptance
    this.#productionVisualAcceptance =
      visualAcceptance instanceof MountedVisualAcceptanceService &&
      Object.getPrototypeOf(visualAcceptance) === MountedVisualAcceptanceService.prototype &&
      MountedVisualAcceptanceService.prototype.run === productionVisualAcceptanceRun &&
      visualAcceptance.run === productionVisualAcceptanceRun
        ? visualAcceptance
        : undefined
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
      await requireAuthentication(request, url.pathname, this.#auth)
      const path = url.pathname.slice(PREFIX.length) || '/'
      const method = request.method ?? 'GET'

      if (method === 'GET' && path === '/images') {
        const rawSession = url.searchParams.get('sessionId')
        const images = await this.#service.listRecords(
          rawSession === null ? undefined : sessionId(rawSession),
        )
        sendJson(response, 200, { images: images.map(imageJson) })
        return
      }
      if (method === 'POST' && path === '/images') {
        const declaredMime = request.headers['content-type'] ?? ''
        normalizeDeclaredMime(declaredMime)
        const bytes = await readBody(request, this.#service.maxBytes)
        const nameHint = url.searchParams.get('name')
        const image = await this.#service.fromBlobWithSource(
          new Blob([Uint8Array.from(bytes)], { type: declaredMime }),
          {
            source: source(url.searchParams.get('source')),
            declaredMime,
            ...(nameHint === null ? {} : { nameHint }),
          },
        )
        sendJson(response, 201, { image: imageJson(image) })
        return
      }
      if (method === 'POST' && path === '/cleanup') {
        const body = record(await jsonBody(request))
        if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
          throw new LubanError('E_INVALID_INPUT', 'dryRun must be a boolean')
        }
        sendJson(response, 200, {
          report: await this.#service.cleanup(body.dryRun === true),
        })
        return
      }
      if (method === 'POST' && path === '/visual-acceptance') {
        if (this.#visualAcceptance === undefined) {
          throw new LubanError('E_UNAVAILABLE', 'Mounted visual acceptance is unavailable')
        }
        const body = record(await jsonBody(request))
        if (
          Object.keys(body).some(
            (key): boolean => !['live', 'sessionId', 'timeoutMs'].includes(key),
          ) ||
          body.live !== true
        ) {
          throw new LubanError(
            'E_INVALID_INPUT',
            'visual acceptance requires an explicit live=true request',
          )
        }
        if (
          body.timeoutMs !== undefined &&
          (typeof body.timeoutMs !== 'number' ||
            !Number.isSafeInteger(body.timeoutMs) ||
            body.timeoutMs < 10_000 ||
            body.timeoutMs > 10 * 60_000)
        ) {
          throw new LubanError('E_INVALID_INPUT', 'timeoutMs is outside the allowed live range')
        }
        const requestedSession = sessionId(body.sessionId)
        const options = {
          live: true,
          sessionId: requestedSession,
          ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
        } satisfies MountedVisualAcceptanceOptions
        const observed =
          this.#productionVisualAcceptance === undefined
            ? await this.#visualAcceptance.run(options)
            : await productionVisualAcceptanceRun.call(this.#productionVisualAcceptance, options)
        const evidence =
          this.#productionVisualAcceptance === undefined
            ? downgradeVisualAcceptanceEvidence(observed)
            : observed
        sendJson(response, 200, { evidence })
        return
      }

      const match = /^\/images\/([^/]+)(?:\/(content|inject))?$/u.exec(path)
      if (match?.[1] === undefined) throw new LubanError('E_NOT_FOUND', 'Route not found')
      let id: string
      try {
        id = decodeURIComponent(match[1])
      } catch (error: unknown) {
        throw new LubanError('E_INVALID_INPUT', 'Image id is invalid', { cause: error })
      }
      if (!/^[A-Za-z0-9-]{1,128}$/u.test(id)) {
        throw new LubanError('E_INVALID_INPUT', 'Image id is invalid')
      }
      const action = match[2]
      if (method === 'GET' && action === 'content') {
        const content = await this.#service.content(id)
        sendImage(response, content.image, content.bytes)
        return
      }
      if (method === 'POST' && action === 'inject') {
        const body = record(await jsonBody(request))
        const image = await this.#service.injectById(
          sessionId(body.sessionId),
          id,
          style(body.style, this.#service.defaultInjectStyle),
        )
        sendJson(response, 200, { image: imageJson(image) })
        return
      }
      if (method === 'DELETE' && action === undefined) {
        await this.#service.delete(id)
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
        : new LubanError('E_IO', 'Image request failed', { cause: error })
      sendJson(response, errorStatus(normalized), { error: normalized.toJSON() })
    }
  }
}
