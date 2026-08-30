import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AuthService } from 'dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import { SessionShareHttpApi } from '../src/http-api.js'
import { SharedSessionRegistry } from '../src/registry.js'
import { host, session, user } from './helpers.js'

function testAuth(): AuthService {
  return {
    authenticateRequest(request: IncomingMessage) {
      const cookie = request.headers.cookie
      if (cookie === undefined) {
        return Promise.resolve({ ok: false as const, reason: 'missing' as const })
      }
      const values = Object.fromEntries(
        cookie.split(';').map((part): [string, string] => {
          const [name = '', value = ''] = part.trim().split('=', 2)
          return [name, value]
        }),
      )
      const id = values.user
      const accountId = values.account ?? id
      const role = values.role
      if (id === undefined || (role !== 'admin' && role !== 'operator' && role !== 'observer')) {
        return Promise.resolve({ ok: false as const, reason: 'invalid' as const })
      }
      return Promise.resolve({
        ok: true as const,
        actor: { kind: 'user' as const, id, accountId, displayName: id, role },
      })
    },
  } as unknown as AuthService
}

function headers(
  userId: string,
  role: 'admin' | 'operator' | 'observer',
  accountId = userId,
): HeadersInit {
  return {
    cookie: `user=${userId}; account=${accountId}; role=${role}`,
    'content-type': 'application/json',
  }
}

async function readSseUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  let content = ''
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const next = await reader.read()
    if (next.done) throw new Error(`SSE ended before ${expected}`)
    content += new TextDecoder().decode(next.value)
    if (content.includes(expected)) return content
  }
  throw new Error(`SSE did not contain ${expected}`)
}

describe('SessionShareHttpApi', (): void => {
  it('isolates list, direct access, mutations, live events, and replay by account', async (): Promise<void> => {
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 30_000,
      replayLimit: 16,
    })
    registry.registerLocal({
      id: session('S-alice'),
      host: host('ubuntu'),
      owner: user('alice'),
      healthy: true,
      status: 'idle',
    })
    registry.registerLocal({
      id: session('S-bob'),
      host: host('ubuntu'),
      owner: user('bob'),
      healthy: true,
      status: 'idle',
    })
    const api = new SessionShareHttpApi(registry, testAuth(), 16)
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const base = `http://127.0.0.1:${String(address.port)}/luban-session-share`

    try {
      const aliceList = await fetch(`${base}/sessions`, { headers: headers('alice', 'admin') })
      const bobList = await fetch(`${base}/sessions`, { headers: headers('bob', 'admin') })
      expect(await aliceList.json()).toMatchObject({ sessions: [{ id: 'S-alice' }] })
      expect(await bobList.json()).toMatchObject({ sessions: [{ id: 'S-bob' }] })

      expect(
        (await fetch(`${base}/sessions/S-alice`, { headers: headers('bob', 'admin') })).status,
      ).toBe(404)
      for (const action of ['takeover', 'release', 'input'] as const) {
        const response = await fetch(`${base}/sessions/S-alice/${action}`, {
          method: 'POST',
          headers: headers('bob', 'admin'),
          body: JSON.stringify(
            action === 'input' ? { accountId: 'alice', text: 'spoofed input' } : {},
          ),
        })
        expect(response.status).toBe(404)
      }
      expect(
        (
          await fetch(`${base}/sessions/S-alice/events`, {
            headers: { cookie: 'user=bob; role=admin' },
          })
        ).status,
      ).toBe(404)

      const aliceStream = await fetch(`${base}/events`, {
        headers: { cookie: 'user=alice; role=admin' },
      })
      const bobStream = await fetch(`${base}/events`, {
        headers: { cookie: 'user=bob; role=admin' },
      })
      if (aliceStream.body === null || bobStream.body === null) {
        throw new Error('registry stream has no body')
      }
      const aliceReader = aliceStream.body.getReader()
      const bobReader = bobStream.body.getReader()
      const aliceBaseline = await readSseUntil(aliceReader, 'event: baseline')
      const bobBaseline = await readSseUntil(bobReader, 'event: baseline')
      expect(aliceBaseline).toContain('S-alice')
      expect(aliceBaseline).not.toContain('S-bob')
      expect(bobBaseline).toContain('S-bob')
      expect(bobBaseline).not.toContain('S-alice')

      registry.updateLocal(session('S-alice'), { status: 'running' })
      registry.updateLocal(session('S-bob'), { status: 'running' })
      const aliceLive = await readSseUntil(aliceReader, 'event: registry')
      const bobLive = await readSseUntil(bobReader, 'event: registry')
      expect(aliceLive).toContain('S-alice')
      expect(aliceLive).not.toContain('S-bob')
      expect(bobLive).toContain('S-bob')
      expect(bobLive).not.toContain('S-alice')
      await aliceReader.cancel()
      await bobReader.cancel()

      const replay = await fetch(`${base}/events`, {
        headers: { cookie: 'user=alice; role=admin', 'last-event-id': '0' },
      })
      if (replay.body === null) throw new Error('registry replay stream has no body')
      const replayReader = replay.body.getReader()
      const replayed = await readSseUntil(replayReader, 'event: registry')
      expect(replayed).toContain('S-alice')
      expect(replayed).not.toContain('S-bob')
      await replayReader.cancel()
    } finally {
      api.dispose()
      await new Promise<void>((resolve, reject): void => {
        server.close((error): void => (error === undefined ? resolve() : reject(error)))
      })
    }
  })

  it('authenticates every route and enforces owner/operator/observer input rights', async (): Promise<void> => {
    const inputs: string[] = []
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 30_000,
      replayLimit: 16,
      input: {
        inject(_id, text): Promise<void> {
          inputs.push(text)
          return Promise.resolve()
        },
      },
    })
    registry.registerLocal({
      id: session('S-http'),
      host: host('ubuntu'),
      owner: user('alice'),
      healthy: true,
      status: 'idle',
    })
    const api = new SessionShareHttpApi(registry, testAuth(), 16)
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const base = `http://127.0.0.1:${String(address.port)}/luban-session-share`

    try {
      expect((await fetch(`${base}/sessions`)).status).toBe(401)
      const observerList = await fetch(`${base}/sessions`, {
        headers: headers('eve', 'observer', 'alice'),
      })
      expect(await observerList.json()).toMatchObject({
        sessions: [{ id: 'S-http', role: 'observer' }],
      })
      const observerTakeover = await fetch(`${base}/sessions/S-http/takeover`, {
        method: 'POST',
        headers: headers('eve', 'observer', 'alice'),
        body: '{}',
      })
      expect(observerTakeover.status).toBe(403)

      const takeover = await fetch(`${base}/sessions/S-http/takeover`, {
        method: 'POST',
        headers: headers('bob', 'operator', 'alice'),
        body: '{}',
      })
      expect(takeover.status).toBe(202)
      const takeoverBody = (await takeover.json()) as {
        readonly result: { readonly status: string; readonly requestId: string }
      }
      expect(takeoverBody.result.status).toBe('pending')
      const request = registry.takeoversFor(user('alice'))[0]
      if (request === undefined) throw new Error('takeover request is missing')

      const wrongApprover = await fetch(
        `${base}/takeovers/${encodeURIComponent(takeoverBody.result.requestId)}/decision`,
        {
          method: 'POST',
          headers: headers('bob', 'operator', 'alice'),
          body: JSON.stringify({ decision: 'approve', expectedVersion: request.sessionVersion }),
        },
      )
      expect(wrongApprover.status).toBe(403)
      const approval = await fetch(
        `${base}/takeovers/${encodeURIComponent(takeoverBody.result.requestId)}/decision`,
        {
          method: 'POST',
          headers: headers('alice', 'admin'),
          body: JSON.stringify({ decision: 'approve', expectedVersion: request.sessionVersion }),
        },
      )
      expect(approval.status).toBe(200)
      expect(await approval.json()).toMatchObject({
        result: { status: 'granted', session: { lockHolder: { id: 'bob' } } },
      })

      const deniedInput = await fetch(`${base}/sessions/S-http/input`, {
        method: 'POST',
        headers: headers('eve', 'observer', 'alice'),
        body: JSON.stringify({ text: 'not allowed' }),
      })
      expect(deniedInput.status).toBe(403)
      const input = await fetch(`${base}/sessions/S-http/input`, {
        method: 'POST',
        headers: headers('bob', 'operator', 'alice'),
        body: JSON.stringify({ text: 'continue safely' }),
      })
      expect(input.status).toBe(204)
      expect(inputs).toEqual(['continue safely'])

      registry.publishOutput(session('S-http'), 'password=hunter2')
      const stream = await fetch(`${base}/sessions/S-http/events`, {
        headers: { cookie: 'user=bob; account=alice; role=operator' },
      })
      expect(stream.status).toBe(200)
      if (stream.body === null) throw new Error('session stream has no body')
      const reader = stream.body.getReader()
      const baseline = new TextDecoder().decode((await reader.read()).value)
      expect(baseline).toContain('event: baseline')
      expect(baseline).toContain('password=hunter2')
      await reader.cancel()

      const replay = await fetch(`${base}/sessions/S-http/events`, {
        headers: {
          cookie: 'user=bob; account=alice; role=operator',
          'last-event-id': '0',
        },
      })
      if (replay.body === null) throw new Error('replay stream has no body')
      const replayReader = replay.body.getReader()
      const replayed = new TextDecoder().decode((await replayReader.read()).value)
      expect(replayed).toContain('event: session')
      expect(replayed).toContain('password=hunter2')
      await replayReader.cancel()

      const registryStream = await fetch(`${base}/events`, {
        headers: { cookie: 'user=alice; role=admin' },
      })
      if (registryStream.body === null) throw new Error('registry stream has no body')
      const registryReader = registryStream.body.getReader()
      expect(new TextDecoder().decode((await registryReader.read()).value)).toContain(
        'event: baseline',
      )
      await registryReader.cancel()
    } finally {
      api.dispose()
      await new Promise<void>((resolve, reject): void => {
        server.close((error): void => (error === undefined ? resolve() : reject(error)))
      })
    }
  })

  it('closes active per-session streams when the plugin API is disposed', async (): Promise<void> => {
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    registry.registerLocal({
      id: session('S-api-dispose'),
      host: host('ubuntu'),
      owner: user('alice'),
      healthy: true,
      status: 'idle',
    })
    const api = new SessionShareHttpApi(registry, testAuth(), 16)
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const url = `http://127.0.0.1:${String(address.port)}/luban-session-share/sessions/S-api-dispose/events`

    try {
      const response = await fetch(url, { headers: { cookie: 'user=alice; role=admin' } })
      if (response.body === null) throw new Error('session stream has no body')
      const reader = response.body.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: baseline')

      api.dispose()

      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
    } finally {
      api.dispose()
      await new Promise<void>((resolve, reject): void => {
        server.close((error): void => (error === undefined ? resolve() : reject(error)))
      })
    }
  })

  it('keeps the public AuthService middleware fallback read-only', async (): Promise<void> => {
    const auth = {
      middleware(): ReturnType<AuthService['middleware']> {
        return () => Promise.resolve({ allowed: true, status: 200, user: 'fallback' })
      },
    } as AuthService
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    registry.registerLocal({
      id: session('S-fallback'),
      host: host('ubuntu'),
      owner: user('fallback'),
      healthy: true,
      status: 'idle',
    })
    const api = new SessionShareHttpApi(registry, auth, 16)
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const base = `http://127.0.0.1:${String(address.port)}/luban-session-share`

    try {
      const list = await fetch(`${base}/sessions`)
      expect(await list.json()).toMatchObject({
        sessions: [{ id: 'S-fallback', role: 'observer' }],
      })
      const takeover = await fetch(`${base}/sessions/S-fallback/takeover`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect(takeover.status).toBe(403)
    } finally {
      api.dispose()
      await new Promise<void>((resolve, reject): void => {
        server.close((error): void => (error === undefined ? resolve() : reject(error)))
      })
    }
  })

  it('fails closed when disposal races with asynchronous authentication', async (): Promise<void> => {
    let finishAuthentication:
      | ((result: {
          readonly ok: true
          readonly actor: {
            readonly kind: 'user'
            readonly id: string
            readonly role: 'operator'
          }
        }) => void)
      | undefined
    let authenticationStarted: (() => void) | undefined
    const started = new Promise<void>((resolve): void => {
      authenticationStarted = resolve
    })
    const auth = {
      authenticateRequest(): Promise<{
        readonly ok: true
        readonly actor: {
          readonly kind: 'user'
          readonly id: string
          readonly role: 'operator'
        }
      }> {
        authenticationStarted?.()
        return new Promise((resolve): void => {
          finishAuthentication = resolve
        })
      },
    } as unknown as AuthService
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    registry.registerLocal({
      id: session('S-auth-race'),
      host: host('ubuntu'),
      owner: user('alice'),
      healthy: true,
      status: 'idle',
    })
    const api = new SessionShareHttpApi(registry, auth, 16)
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo

    try {
      const pending = fetch(
        `http://127.0.0.1:${String(address.port)}/luban-session-share/sessions/S-auth-race/takeover`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      )
      await started
      api.dispose()
      if (finishAuthentication === undefined) throw new Error('authentication did not start')
      finishAuthentication({
        ok: true,
        actor: { kind: 'user', id: 'bob', role: 'operator' },
      })

      expect((await pending).status).toBe(503)
      expect(registry.takeoversFor(user('bob'))).toEqual([])
    } finally {
      api.dispose()
      await new Promise<void>((resolve, reject): void => {
        server.close((error): void => (error === undefined ? resolve() : reject(error)))
      })
    }
  })

  it('queues account events published while an SSE baseline is loading', async (): Promise<void> => {
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    registry.registerLocal({
      id: session('S-baseline-race'),
      host: host('ubuntu'),
      owner: user('alice'),
      healthy: true,
      status: 'idle',
    })
    const originalList = registry.listFor.bind(registry)
    let finishList: (() => void) | undefined
    let listStarted: (() => void) | undefined
    const started = new Promise<void>((resolve): void => {
      listStarted = resolve
    })
    vi.spyOn(registry, 'listFor').mockImplementation(async (actor, role, filter) => {
      listStarted?.()
      await new Promise<void>((resolve): void => {
        finishList = resolve
      })
      return await originalList(actor, role, filter)
    })
    const api = new SessionShareHttpApi(registry, testAuth(), 16)
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo

    try {
      const pending = fetch(`http://127.0.0.1:${String(address.port)}/luban-session-share/events`, {
        headers: { cookie: 'user=alice; role=admin' },
      })
      await started
      registry.updateLocal(session('S-baseline-race'), { status: 'running' })
      if (finishList === undefined) throw new Error('registry baseline did not start')
      finishList()

      const stream = await pending
      if (stream.body === null) throw new Error('registry stream has no body')
      const reader = stream.body.getReader()
      const content = await readSseUntil(reader, 'event: registry')
      expect(content).toContain('event: baseline')
      expect(content).toContain('S-baseline-race')
      expect(content).toContain('running')
      await reader.cancel()
    } finally {
      api.dispose()
      await new Promise<void>((resolve, reject): void => {
        server.close((error): void => (error === undefined ? resolve() : reject(error)))
      })
    }
  })

  it('does not attach a registry stream after disposal during baseline loading', async (): Promise<void> => {
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    let finishList: (() => void) | undefined
    let listStarted: (() => void) | undefined
    const started = new Promise<void>((resolve): void => {
      listStarted = resolve
    })
    vi.spyOn(registry, 'listFor').mockImplementation(() => {
      listStarted?.()
      return new Promise((resolve): void => {
        finishList = (): void => resolve([])
      })
    })
    const api = new SessionShareHttpApi(registry, testAuth(), 16)
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo

    try {
      const pending = fetch(`http://127.0.0.1:${String(address.port)}/luban-session-share/events`, {
        headers: { cookie: 'user=alice; role=admin' },
      })
      await started
      api.dispose()
      if (finishList === undefined) throw new Error('registry baseline did not start')
      finishList()

      expect((await pending).status).toBe(503)
    } finally {
      api.dispose()
      await new Promise<void>((resolve, reject): void => {
        server.close((error): void => (error === undefined ? resolve() : reject(error)))
      })
    }
  })
})
