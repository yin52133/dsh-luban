import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { localHostnames, parseUpstream, resolveAuthConfig } from '../src/config.js'
import { AuthSidecar } from '../src/sidecar.js'
import type { LubanAuthConfig } from '../src/types.js'
import { createManagerFixture, type ManagerFixture } from './helpers.js'

interface IntegrationHarness {
  readonly fixture: ManagerFixture
  readonly upstream: Server
  readonly sidecar: AuthSidecar
  readonly baseUrl: string
  readonly publicPort: number
  close(): Promise<void>
}

const upstreamUpgradeSockets = new WeakMap<Server, Set<Duplex>>()

describe('AuthSidecar integration', () => {
  let harness: IntegrationHarness | undefined

  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  it('guards business routes, proxies static/HTTP/SSE, and enforces request security', async () => {
    harness = await createHarness()
    const { baseUrl } = harness

    const navigation = await fetch(`${baseUrl}/business?tab=one`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    })
    expect(navigation.status).toBe(302)
    expect(navigation.headers.get('location')).toContain('/luban-auth/login?returnTo=')

    const api = await fetch(`${baseUrl}/api/private`)
    expect(api.status).toBe(401)
    const loginPage = await fetch(
      `${baseUrl}/luban-auth/login?returnTo=${encodeURIComponent('/tasks?<unsafe>')}`,
    )
    expect(loginPage.status).toBe(200)
    expect(await loginPage.text()).toContain('/tasks?&lt;unsafe&gt;')
    expect((await fetch(`${baseUrl}/luban-auth/login`, { method: 'HEAD' })).status).toBe(200)
    expect((await fetch(`${baseUrl}/luban-auth/login`, { method: 'PUT' })).status).toBe(405)
    const asset = await fetch(`${baseUrl}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(await asset.text()).toBe('static asset')

    const hostileHost = await rawHttpRequest(harness.publicPort, '/api/private', {
      host: 'attacker.invalid',
    })
    expect(hostileHost.status).toBe(403)

    const crossOriginLogin = await fetch(`${baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.invalid' },
      body: JSON.stringify({ user: 'admin', password: 'correct horse' }),
    })
    expect(crossOriginLogin.status).toBe(403)

    const oversized = await fetch(`${baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin', password: 'x'.repeat(2_000) }),
    })
    expect(oversized.status).toBe(413)

    const invalidJsonLogin = await fetch(`${baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'admin', password: 'wrong pass' }),
    })
    expect(invalidJsonLogin.status).toBe(401)
    const invalidFormLogin = await fetch(`${baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
        origin: baseUrl,
      },
      body: new URLSearchParams({ user: 'admin', password: 'wrong pass', returnTo: '/' }),
    })
    expect(invalidFormLogin.status).toBe(401)
    expect(await invalidFormLogin.text()).toContain('Invalid credentials')

    const login = await fetch(`${baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'admin', password: 'correct horse' }),
    })
    expect(login.status).toBe(200)
    const setCookies = splitSetCookie(login.headers.get('set-cookie'))
    expect(setCookies.find((value) => value.startsWith('luban_session='))).toMatch(
      /HttpOnly; SameSite=Lax/u,
    )
    expect(setCookies.find((value) => value.startsWith('luban_csrf='))).toMatch(/SameSite=Lax/u)
    const cookie = cookieHeader(setCookies)
    const csrf = cookieValue(cookie, 'luban_csrf')

    const proxied = await fetch(`${baseUrl}/business`, { headers: { cookie } })
    expect(proxied.status).toBe(200)
    const proxyBody = (await proxied.json()) as { path: string; cookie: string }
    expect(proxyBody.path).toBe('/business')
    expect(proxyBody.cookie).toContain('luban_session=')

    const missingCsrf = await fetch(`${baseUrl}/business`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: 'mutation',
    })
    expect(missingCsrf.status).toBe(403)
    const crossOriginMutation = await fetch(`${baseUrl}/business`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain', origin: 'http://attacker.invalid' },
      body: 'mutation',
    })
    expect(crossOriginMutation.status).toBe(403)
    const csrfMutation = await fetch(`${baseUrl}/business`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain', 'x-luban-csrf': csrf },
      body: 'mutation',
    })
    expect(csrfMutation.status).toBe(200)

    const session = await fetch(`${baseUrl}/luban-auth/session`, { headers: { cookie } })
    expect(await session.json()).toMatchObject({ user: 'admin', role: 'admin', csrfToken: csrf })
    expect(
      (
        await fetch(`${baseUrl}/luban-auth/session`, {
          method: 'POST',
          headers: { cookie, origin: baseUrl },
        })
      ).status,
    ).toBe(405)
    expect((await fetch(`${baseUrl}/luban-auth/logout`, { headers: { cookie } })).status).toBe(405)
    expect((await fetch(`${baseUrl}/luban-auth/unknown`, { headers: { cookie } })).status).toBe(404)

    const invalidUser = await fetch(`${baseUrl}/luban-auth/users`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'operator', password: 'operator pass', role: 'owner' }),
    })
    expect(invalidUser.status).toBe(400)
    const provision = await fetch(`${baseUrl}/luban-auth/users`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'operator', password: 'operator pass', role: 'operator' }),
    })
    expect(provision.status).toBe(201)
    const duplicateUser = await fetch(`${baseUrl}/luban-auth/users`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'operator', password: 'operator pass', role: 'operator' }),
    })
    expect(duplicateUser.status).toBe(409)
    expect((await fetch(`${baseUrl}/luban-auth/users`, { headers: { cookie } })).status).toBe(405)

    const operatorLogin = await fetch(`${baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'operator', password: 'operator pass' }),
    })
    const operatorCookie = cookieHeader(splitSetCookie(operatorLogin.headers.get('set-cookie')))
    const operatorDenied = await fetch(`${baseUrl}/luban-auth/users`, {
      method: 'POST',
      headers: { cookie: operatorCookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'other', password: 'other password', role: 'observer' }),
    })
    expect(operatorDenied.status).toBe(403)
    const operatorRevokeDenied = await fetch(`${baseUrl}/luban-auth/revoke-all`, {
      method: 'POST',
      headers: { cookie: operatorCookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'admin' }),
    })
    expect(operatorRevokeDenied.status).toBe(403)
    const invalidRevoke = await fetch(`${baseUrl}/luban-auth/revoke-all`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 42 }),
    })
    expect(invalidRevoke.status).toBe(400)
    const malformedRevoke = await fetch(`${baseUrl}/luban-auth/revoke-all`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: '!!!' }),
    })
    expect(malformedRevoke.status).toBe(400)
    const revokeOperator = await fetch(`${baseUrl}/luban-auth/revoke-all`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ user: 'operator' }),
    })
    expect(revokeOperator.status).toBe(200)
    expect(
      (await fetch(`${baseUrl}/api/private`, { headers: { cookie: operatorCookie } })).status,
    ).toBe(401)

    const redirect = await fetch(`${baseUrl}/redirect`, {
      headers: { cookie },
      redirect: 'manual',
    })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe(`${baseUrl}/target`)

    const startedAt = Date.now()
    const events = await fetch(`${baseUrl}/events`, { headers: { cookie } })
    const reader = events.body?.getReader()
    expect(reader).toBeDefined()
    const firstChunk = await reader?.read()
    expect(new TextDecoder().decode(firstChunk?.value)).toContain('data: first')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    await reader?.cancel()

    const logout = await fetch(`${baseUrl}/luban-auth/logout`, {
      method: 'POST',
      headers: { cookie, origin: baseUrl },
    })
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await fetch(`${baseUrl}/api/private`, { headers: { cookie } })).status).toBe(401)
  })

  it('protects and tunnels WebSocket upgrades and closes upgraded resources', async () => {
    harness = await createHarness()
    const unauthorized = await openUpgrade(harness.publicPort)
    expect(unauthorized.head).toContain('401 Unauthorized')
    unauthorized.socket.destroy()

    const login = await fetch(`${harness.baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: harness.baseUrl },
      body: JSON.stringify({ user: 'admin', password: 'correct horse' }),
    })
    const cookie = cookieHeader(splitSetCookie(login.headers.get('set-cookie')))
    const hostile = await openUpgrade(harness.publicPort, cookie, 'http://attacker.invalid')
    expect(hostile.head).toContain('403 Forbidden')
    hostile.socket.destroy()

    const upgraded = await openUpgrade(harness.publicPort, cookie, harness.baseUrl)
    expect(upgraded.head).toContain('101 Switching Protocols')
    const echo = new Promise<string>((resolve) => {
      upgraded.socket.once('data', (chunk): void => resolve(chunk.toString('utf8')))
    })
    upgraded.socket.write('ping-through-sidecar')
    await expect(echo).resolves.toBe('ping-through-sidecar')

    const closed = new Promise<void>((resolve) => {
      upgraded.socket.once('close', (): void => resolve())
    })
    await harness.sidecar.stop()
    await expect(closed).resolves.toBeUndefined()
  })

  it('honors trusted proxy scheme/host and emits Secure cookies', async () => {
    harness = await createHarness({
      trustProxy: true,
      trustedHosts: ['proxy.example.test'],
    })
    const login = await fetch(`${harness.baseUrl}/luban-auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: '127.0.0.1',
        origin: 'https://proxy.example.test',
        'x-forwarded-host': 'proxy.example.test',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ user: 'admin', password: 'correct horse' }),
    })
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).toMatch(/; Secure/u)
    const cookie = cookieHeader(splitSetCookie(login.headers.get('set-cookie')))
    const redirect = await fetch(`${harness.baseUrl}/redirect`, {
      headers: {
        cookie,
        host: '127.0.0.1',
        origin: 'https://proxy.example.test',
        'x-forwarded-host': 'proxy.example.test',
        'x-forwarded-proto': 'https',
      },
      redirect: 'manual',
    })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe('https://proxy.example.test/target')
  })
})

async function createHarness(
  overrides: Partial<LubanAuthConfig> = {},
): Promise<IntegrationHarness> {
  const fixture = await createManagerFixture()
  await fixture.manager.createInitialAdmin('admin', 'correct horse')
  const upstream = createUpstreamServer()
  await listen(upstream)
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('test upstream has no port')
  const config = resolveAuthConfig({
    host: '127.0.0.1',
    port: 0,
    upstream: `http://127.0.0.1:${String(address.port)}`,
    usersFile: fixture.filePath,
    auditDirectory: fixture.directory,
    maxAuthBodyBytes: 1_024,
    ...overrides,
  })
  const sidecar = new AuthSidecar({
    config,
    upstream: parseUpstream(config.upstream),
    manager: fixture.manager,
    trustedHostnames: localHostnames(config.trustedHosts),
  })
  await sidecar.start()
  const publicPort = sidecar.port
  if (publicPort === undefined) throw new Error('test sidecar has no port')
  let closed = false
  return {
    fixture,
    upstream,
    sidecar,
    publicPort,
    baseUrl: `http://127.0.0.1:${String(publicPort)}`,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await sidecar.stop()
      await closeServer(upstream)
      await fixture.cleanup()
    },
  }
}

function createUpstreamServer(): Server {
  const upgradeSockets = new Set<Duplex>()
  const server = createServer((request, response): void => {
    handleUpstreamRequest(request, response).catch((error: unknown): void => {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  server.on('upgrade', (_request, socket): void => {
    upgradeSockets.add(socket)
    socket.once('close', (): void => {
      upgradeSockets.delete(socket)
    })
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    )
    socket.on('data', (chunk): void => {
      socket.write(chunk)
    })
  })
  upstreamUpgradeSockets.set(server, upgradeSockets)
  return server
}

async function handleUpstreamRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const target = new URL(request.url ?? '/', 'http://upstream.test')
  if (target.pathname === '/assets/app.js') {
    response.writeHead(200, { 'content-type': 'application/javascript' })
    response.end('static asset')
    return
  }
  if (target.pathname === '/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    response.write('data: first\n\n')
    const timer = setTimeout((): void => {
      response.end('data: second\n\n')
    }, 50)
    timer.unref()
    request.once('close', (): void => {
      clearTimeout(timer)
    })
    return
  }
  if (target.pathname === '/redirect') {
    response.writeHead(302, { location: `http://${request.headers.host ?? '127.0.0.1'}/target` })
    response.end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      path: `${target.pathname}${target.search}`,
      method: request.method,
      body: Buffer.concat(chunks).toString('utf8'),
      cookie: request.headers.cookie ?? '',
    }),
  )
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', (): void => {
      server.off('error', reject)
      resolve()
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  for (const socket of upstreamUpgradeSockets.get(server) ?? []) socket.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve): void => {
    server.close((): void => resolve())
  })
}

function splitSetCookie(header: string | null): string[] {
  if (header === null) return []
  return header.split(/,\s*(?=luban_(?:session|csrf)=)/u)
}

function cookieHeader(setCookies: readonly string[]): string {
  return setCookies.map((value) => value.split(';', 1)[0]).join('; ')
}

function cookieValue(cookie: string, name: string): string {
  const found = cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
  if (found === undefined) throw new Error(`cookie ${name} is missing`)
  return found.slice(name.length + 1)
}

async function rawHttpRequest(
  port: number,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject): void => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers }, (response): void => {
      const chunks: Buffer[] = []
      response.on('data', (chunk): void => {
        chunks.push(Buffer.from(chunk as Uint8Array))
      })
      response.once('end', (): void => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.once('error', reject)
    request.end()
  })
}

async function openUpgrade(
  port: number,
  cookie?: string,
  origin?: string,
): Promise<{ readonly socket: Socket; readonly head: string }> {
  return new Promise((resolve, reject): void => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('error', reject)
    socket.once('connect', (): void => {
      const headers = [
        'GET /socket HTTP/1.1',
        `Host: 127.0.0.1:${String(port)}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: dGVzdC1rZXk=',
        'Sec-WebSocket-Version: 13',
        ...(cookie === undefined ? [] : [`Cookie: ${cookie}`]),
        ...(origin === undefined ? [] : [`Origin: ${origin}`]),
        '',
        '',
      ]
      socket.write(headers.join('\r\n'))
      let head = ''
      const onData = (chunk: Buffer): void => {
        head += chunk.toString('utf8')
        if (!head.includes('\r\n\r\n')) return
        socket.off('data', onData)
        socket.off('error', reject)
        resolve({ socket, head })
      }
      socket.on('data', onData)
    })
  })
}
