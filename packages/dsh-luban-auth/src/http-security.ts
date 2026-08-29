import { isIP } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LubanAuthConfig } from './types.js'

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const PUBLIC_STATIC_PREFIXES = ['/assets', '/plugins'] as const

export class HttpError extends Error {
  public readonly status: number
  public readonly code: string

  public constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

export interface RequestSecurityContext {
  readonly sourceIp: string
  readonly authority: string
  readonly protocol: 'http' | 'https'
  readonly trustedProxy: boolean
}

export function inspectRequestSecurity(
  request: IncomingMessage,
  config: LubanAuthConfig,
  trustedHostnames: ReadonlySet<string>,
): RequestSecurityContext {
  const socketIp = normalizeIp(request.socket.remoteAddress ?? '')
  const trustedProxy = config.trustProxy && isIpAllowed(socketIp, config.trustedProxyNetworks)
  const hostHeader = singleHeader(request, 'host')
  if (hostHeader === undefined || parseAuthority(hostHeader) === undefined) {
    throw new HttpError(400, 'E_INVALID_HOST', 'A valid Host header is required')
  }
  assertTrustedHost(hostHeader, trustedHostnames)

  const forwardedHost = trustedProxy ? singleHeader(request, 'x-forwarded-host') : undefined
  const authority = forwardedHost ?? hostHeader
  if (forwardedHost !== undefined) assertTrustedHost(forwardedHost, trustedHostnames)

  let protocol: 'http' | 'https' = isEncrypted(request) ? 'https' : 'http'
  if (trustedProxy) {
    const forwardedProtocol = singleHeader(request, 'x-forwarded-proto')
    if (forwardedProtocol !== undefined) {
      if (forwardedProtocol !== 'http' && forwardedProtocol !== 'https') {
        throw new HttpError(400, 'E_INVALID_PROXY_HEADER', 'Invalid forwarded protocol')
      }
      protocol = forwardedProtocol
    }
  }

  let sourceIp = socketIp
  if (trustedProxy) {
    const forwardedFor = singleHeader(request, 'x-forwarded-for')
    if (forwardedFor !== undefined) {
      const first = forwardedFor.split(',')[0]?.trim() ?? ''
      if (isIP(first) === 0) {
        throw new HttpError(400, 'E_INVALID_PROXY_HEADER', 'Invalid forwarded client address')
      }
      sourceIp = normalizeIp(first)
    }
  }
  if (sourceIp === '' || isIP(sourceIp) === 0) {
    throw new HttpError(400, 'E_INVALID_SOURCE', 'Unable to determine client address')
  }
  if (!isIpAllowed(sourceIp, config.allowedNetworks)) {
    throw new HttpError(403, 'E_NETWORK_DENIED', 'Client network is not allowed')
  }
  return { sourceIp, authority, protocol, trustedProxy }
}

export function assertRequestOrigin(
  request: IncomingMessage,
  context: RequestSecurityContext,
  csrfValid: boolean,
): void {
  const method = request.method?.toUpperCase() ?? 'GET'
  if (!STATE_CHANGING_METHODS.has(method)) return
  const origin = singleHeader(request, 'origin')
  if (origin !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new HttpError(403, 'E_CSRF', 'Invalid request origin')
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      normalizedOrigin(parsed) !==
        `${context.protocol}://${normalizeAuthority(context.authority, context.protocol)}`
    ) {
      throw new HttpError(403, 'E_CSRF', 'Cross-origin mutation denied')
    }
    return
  }

  const fetchSite = singleHeader(request, 'sec-fetch-site')
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HttpError(403, 'E_CSRF', 'Cross-site mutation denied')
  }
  if (!csrfValid) {
    throw new HttpError(403, 'E_CSRF', 'CSRF token is required when Origin is absent')
  }
}

export function assertLoginOrigin(request: IncomingMessage, context: RequestSecurityContext): void {
  const origin = singleHeader(request, 'origin')
  if (origin !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new HttpError(403, 'E_CSRF', 'Invalid login origin')
    }
    if (
      normalizedOrigin(parsed) !==
      `${context.protocol}://${normalizeAuthority(context.authority, context.protocol)}`
    ) {
      throw new HttpError(403, 'E_CSRF', 'Cross-origin login denied')
    }
  }
  const fetchSite = singleHeader(request, 'sec-fetch-site')
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new HttpError(403, 'E_CSRF', 'Cross-site login denied')
  }
}

export function assertWebSocketOrigin(
  request: IncomingMessage,
  context: RequestSecurityContext,
): void {
  const origin = singleHeader(request, 'origin')
  if (origin === undefined) return
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new HttpError(403, 'E_CSRF', 'Invalid WebSocket origin')
  }
  if (
    normalizedOrigin(parsed) !==
    `${context.protocol}://${normalizeAuthority(context.authority, context.protocol)}`
  ) {
    throw new HttpError(403, 'E_CSRF', 'Cross-origin WebSocket denied')
  }
}

export async function readBoundedJson(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Record<string, unknown>> {
  const contentType = singleHeader(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'E_CONTENT_TYPE', 'Content-Type must be application/json')
  }
  const body = await readBoundedBody(request, maximumBytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'E_INVALID_JSON', 'Request body must be valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'E_INVALID_JSON', 'Request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

export async function readBoundedForm(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Record<string, string>> {
  const contentType = singleHeader(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/x-www-form-urlencoded') {
    throw new HttpError(
      415,
      'E_CONTENT_TYPE',
      'Content-Type must be application/x-www-form-urlencoded',
    )
  }
  const params = new URLSearchParams(
    (await readBoundedBody(request, maximumBytes)).toString('utf8'),
  )
  const result: Record<string, string> = {}
  for (const [key, value] of params) {
    if (key in result) throw new HttpError(400, 'E_DUPLICATE_FIELD', `Duplicate form field ${key}`)
    result[key] = value
  }
  return result
}

export function assertProxyBodySize(request: IncomingMessage, maximumBytes: number): void {
  const length = parseContentLength(request)
  if (length !== undefined && length > maximumBytes) {
    throw new HttpError(413, 'E_BODY_TOO_LARGE', 'Request body exceeds the configured limit')
  }
}

export function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    if (value.length !== 1 || value[0] === undefined) {
      throw new HttpError(400, 'E_DUPLICATE_HEADER', `Header ${name} must occur once`)
    }
    return value[0].trim()
  }
  if (value.includes('\r') || value.includes('\n')) {
    throw new HttpError(400, 'E_INVALID_HEADER', `Header ${name} is invalid`)
  }
  return value.trim()
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  let result: string | undefined
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=')
    if (separator <= 0) continue
    const key = pair.slice(0, separator).trim()
    if (key !== name) continue
    if (result !== undefined) return undefined
    result = pair.slice(separator + 1).trim()
  }
  return result
}

export function stripCookie(
  header: string | undefined,
  names: ReadonlySet<string>,
): string | undefined {
  if (header === undefined) return undefined
  const kept = header.split(';').filter((pair) => {
    const separator = pair.indexOf('=')
    return separator <= 0 || !names.has(pair.slice(0, separator).trim())
  })
  const value = kept.join(';').trim()
  return value === '' ? undefined : value
}

export function safeReturnTo(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return fallback
  if (value.includes('\r') || value.includes('\n') || value.length > 2_048) return fallback
  return value
}

export function isPublicStaticRequest(method: string | undefined, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  if (pathname === '/favicon.ico' || pathname === '/manifest.webmanifest') return true
  return PUBLIC_STATIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

export function wantsHtml(request: IncomingMessage): boolean {
  return singleHeader(request, 'accept')?.toLowerCase().includes('text/html') ?? false
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string | string[]>> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  response.end(payload)
}

export function isIpAllowed(ip: string, networks: readonly string[]): boolean {
  if (networks.length === 0) return true
  return networks.some((network) => ipMatchesNetwork(ip, network))
}

function assertTrustedHost(authority: string, trustedHostnames: ReadonlySet<string>): void {
  const parsed = parseAuthority(authority)
  if (parsed === undefined || !trustedHostnames.has(parsed.hostname)) {
    throw new HttpError(403, 'E_HOST_DENIED', 'Host is not trusted')
  }
}

function parseAuthority(
  value: string,
): { readonly hostname: string; readonly authority: string } | undefined {
  if (value === '' || /[\s,@/\\]/u.test(value)) return undefined
  try {
    const url = new URL(`http://${value}`)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/') return undefined
    return {
      hostname: url.hostname.replace(/^\[|\]$/gu, '').toLowerCase(),
      authority: url.host.toLowerCase(),
    }
  } catch {
    return undefined
  }
}

function normalizeAuthority(authority: string, protocol: 'http' | 'https'): string {
  const parsed = new URL(`${protocol}://${authority}`)
  return parsed.host.toLowerCase()
}

function normalizedOrigin(url: URL): string {
  return `${url.protocol}//${url.host.toLowerCase()}`
}

function isEncrypted(request: IncomingMessage): boolean {
  return Reflect.get(request.socket, 'encrypted') === true
}

function parseContentLength(request: IncomingMessage): number | undefined {
  const value = singleHeader(request, 'content-length')
  if (value === undefined) return undefined
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new HttpError(400, 'E_CONTENT_LENGTH', 'Invalid Content-Length')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length)) {
    throw new HttpError(413, 'E_BODY_TOO_LARGE', 'Request body is too large')
  }
  return length
}

async function readBoundedBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const declaredLength = parseContentLength(request)
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    throw new HttpError(413, 'E_BODY_TOO_LARGE', 'Request body exceeds the configured limit')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > maximumBytes) {
      request.resume()
      throw new HttpError(413, 'E_BODY_TOO_LARGE', 'Request body exceeds the configured limit')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function normalizeIp(ip: string): string {
  const zoneIndex = ip.indexOf('%')
  const withoutZone = zoneIndex === -1 ? ip : ip.slice(0, zoneIndex)
  return withoutZone.startsWith('::ffff:') ? withoutZone.slice(7) : withoutZone
}

function ipMatchesNetwork(ipValue: string, networkValue: string): boolean {
  const [networkIpRaw, prefixRaw] = networkValue.trim().split('/')
  if (networkIpRaw === undefined || networkIpRaw === '') return false
  const networkIp = normalizeIp(networkIpRaw)
  const ip = normalizeIp(ipValue)
  const version = isIP(ip)
  if (version === 0 || isIP(networkIp) !== version) return false
  const maximumBits = version === 4 ? 32 : 128
  const prefix = prefixRaw === undefined ? maximumBits : Number(prefixRaw)
  if (!Number.isSafeInteger(prefix) || prefix < 0 || prefix > maximumBits) return false
  const left = version === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip)
  const right = version === 4 ? ipv4ToBigInt(networkIp) : ipv6ToBigInt(networkIp)
  if (left === undefined || right === undefined) return false
  const shift = BigInt(maximumBits - prefix)
  return left >> shift === right >> shift
}

function ipv4ToBigInt(value: string): bigint | undefined {
  const parts = value.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined
  }
  return parts.reduce((result, part) => (result << 8n) | BigInt(part), 0n)
}

function ipv6ToBigInt(value: string): bigint | undefined {
  let normalized = value.toLowerCase()
  const ipv4Tail = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1]
  if (ipv4Tail !== undefined) {
    const ipv4 = ipv4ToBigInt(ipv4Tail)
    if (ipv4 === undefined) return undefined
    const high = Number((ipv4 >> 16n) & 0xffffn).toString(16)
    const low = Number(ipv4 & 0xffffn).toString(16)
    normalized = `${normalized.slice(0, -ipv4Tail.length)}${high}:${low}`
  }
  if ((normalized.match(/::/gu) ?? []).length > 1) return undefined
  const sides = normalized.split('::')
  const left = sides[0] === '' ? [] : (sides[0]?.split(':') ?? [])
  const right = sides.length === 1 || sides[1] === '' ? [] : (sides[1]?.split(':') ?? [])
  const missing = 8 - left.length - right.length
  if ((sides.length === 1 && missing !== 0) || missing < 0) return undefined
  const groups =
    sides.length === 1 ? left : [...left, ...Array<string>(missing).fill('0'), ...right]
  if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/u.test(group)))
    return undefined
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n)
}
