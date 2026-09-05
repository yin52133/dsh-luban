import type { IncomingHttpHeaders } from 'node:http'

/** Public DSH Connection methods used by the authenticated loopback gateway. */
interface WebConnection {
  authenticatedUrl(baseUrl: string): string
  authorizeIndex(
    request: {
      readonly method: string
      readonly url: string
      readonly headers: IncomingHttpHeaders
    },
    response: {
      writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
      end(): unknown
    },
  ): boolean
}

function isWebConnection(value: unknown): value is WebConnection {
  if (typeof value !== 'object' || value === null) return false
  const face = value as Readonly<Record<string, unknown>>
  return typeof face.authenticatedUrl === 'function' && typeof face.authorizeIndex === 'function'
}

/** Exchange DSH's process token in memory; never send its credential to the browser. */
export function createUpstreamAuthCookie(
  resolveConnection: () => unknown,
  upstream: URL,
): () => string {
  let previousUrl: string | undefined
  let cookie: string | undefined
  let renewAt = 0
  return (): string => {
    const connection = resolveConnection()
    if (!isWebConnection(connection)) throw new Error('DSH Connection is not ready')
    const url = connection.authenticatedUrl(upstream.origin)
    if (url === previousUrl && cookie !== undefined && Date.now() < renewAt) return cookie
    let issued: string | undefined
    connection.authorizeIndex(
      { method: 'GET', url, headers: { host: upstream.host } },
      {
        writeHead(status, headers): void {
          if (status === 303) issued = headers?.['set-cookie']?.split(';', 1)[0]
        },
        end(): void {
          /* The exchange is in memory, so there is no browser response to end. */
        },
      },
    )
    if (issued === undefined || !/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/u.test(issued)) {
      throw new Error('DSH Connection did not issue an upstream session')
    }
    previousUrl = url
    cookie = issued
    renewAt = Date.now() + 60 * 60 * 1_000
    return cookie
  }
}

/** Ignore browser-supplied DSH credentials and attach only the gateway-owned session. */
export function withUpstreamCookie(existing: string | undefined, cookie: string): string {
  const retained = (existing ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith('dsh-auth-'))
  return [...retained, cookie].join('; ')
}
