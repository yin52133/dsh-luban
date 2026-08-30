import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Actor, AuthService, SessionId, TakeoverResult } from 'dsh-luban-core'
import { describe, expect, it } from 'vitest'
import type { PeerConfig } from '../src/config.js'
import { SessionShareHttpApi } from '../src/http-api.js'
import { HttpPeerNetwork } from '../src/peer.js'
import { SharedSessionRegistry } from '../src/registry.js'
import type { PeerNetwork, PeerSessionSnapshot, SessionStreamEnvelope } from '../src/types.js'
import { host, session, user } from './helpers.js'

class InMemoryPeerNetwork implements PeerNetwork {
  readonly #registries = new Map<string, SharedSessionRegistry>()

  public register(name: string, registry: SharedSessionRegistry): void {
    this.#registries.set(name, registry)
  }

  public async list(peer: PeerConfig): Promise<readonly PeerSessionSnapshot[]> {
    return this.#required(peer).listViews()
  }

  public requestTakeover(peer: PeerConfig, id: SessionId, by: Actor): Promise<TakeoverResult> {
    return this.#required(peer).requestTakeover(id, by)
  }

  public release(peer: PeerConfig, id: SessionId, by: Actor): Promise<void> {
    return this.#required(peer).release(id, by)
  }

  public injectInput(peer: PeerConfig, id: SessionId, by: Actor, text: string): Promise<void> {
    return this.#required(peer).injectInput(id, { actor: by, accountRole: 'operator' }, text)
  }

  public stream(
    peer: PeerConfig,
    id: SessionId,
    lastEventId: number | undefined,
    signal: AbortSignal,
  ): AsyncIterable<SessionStreamEnvelope> {
    return this.#required(peer).stream(id, lastEventId, signal)
  }

  #required(peer: PeerConfig): SharedSessionRegistry {
    const registry = this.#registries.get(peer.name)
    if (registry === undefined) throw new Error(`Unknown in-memory peer ${peer.name}`)
    return registry
  }
}

const peer = (name: string): PeerConfig => ({
  name,
  baseUrl: `http://${name}.invalid`,
  credentialEnv: `TEST_${name.toUpperCase()}_COOKIE`,
})

function cookieValues(request: IncomingMessage): Readonly<Record<string, string>> {
  const cookie = request.headers.cookie
  if (cookie === undefined) return {}
  return Object.fromEntries(
    cookie.split(';').map((part): [string, string] => {
      const [name = '', value = ''] = part.trim().split('=', 2)
      return [name, value]
    }),
  )
}

function httpAuth(): AuthService {
  return {
    authenticateRequest(request: IncomingMessage) {
      const values = cookieValues(request)
      const id = values.user
      const role = values.role
      if (id === undefined || (role !== 'admin' && role !== 'operator' && role !== 'observer')) {
        return Promise.resolve({ ok: false as const, reason: 'invalid' as const })
      }
      return Promise.resolve({
        ok: true as const,
        actor: { kind: 'user' as const, id, displayName: id, role },
      })
    },
  } as unknown as AuthService
}

interface DeferredPeerServer {
  readonly baseUrl: string
  attach(api: SessionShareHttpApi): void
  close(): Promise<void>
}

async function startDeferredPeerServer(): Promise<DeferredPeerServer> {
  let api: SessionShareHttpApi | undefined
  const server = createServer((request, response): void => {
    if (request.url === '/luban-auth/session') {
      const id = cookieValues(request).user
      if (id === undefined) {
        response.writeHead(401).end()
        return
      }
      const body = JSON.stringify({ user: id })
      response
        .writeHead(200, {
          'content-length': Buffer.byteLength(body),
          'content-type': 'application/json; charset=utf-8',
        })
        .end(body)
      return
    }
    if (api === undefined) {
      response.writeHead(503).end()
      return
    }
    void api.handler(request, response)
  })
  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    attach(value): void {
      api = value
    },
    async close(): Promise<void> {
      api?.dispose()
      await new Promise<void>((resolve, reject): void => {
        server.close((error): void => (error === undefined ? resolve() : reject(error)))
      })
    },
  }
}

function peerConfig(name: string, baseUrl: string, credentialEnv: string): PeerConfig {
  return { name, baseUrl, credentialEnv }
}

describe('dual-host in-memory federation', (): void => {
  it('mirrors both hosts, relays replay, and preserves the remote exclusive lock', async (): Promise<void> => {
    const network = new InMemoryPeerNetwork()
    const ubuntuInput: string[] = []
    const windows = new SharedSessionRegistry({
      localHost: host('windows'),
      takeoverTimeoutMs: 10_000,
      replayLimit: 16,
      peers: [peer('ubuntu')],
      network,
    })
    const ubuntu = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 10_000,
      replayLimit: 16,
      peers: [peer('windows')],
      network,
      input: {
        inject(_id, text): Promise<void> {
          ubuntuInput.push(text)
          return Promise.resolve()
        },
      },
    })
    network.register('windows', windows)
    network.register('ubuntu', ubuntu)
    windows.registerLocal({
      id: session('S-win'),
      host: host('windows'),
      owner: user('win-owner'),
      healthy: true,
      status: 'idle',
    })
    ubuntu.registerLocal({
      id: session('S-ubuntu'),
      host: host('ubuntu'),
      owner: user('ubuntu-owner'),
      healthy: true,
      status: 'running',
    })

    expect(await windows.refreshPeers()).toEqual([])
    expect(await ubuntu.refreshPeers()).toEqual([])
    expect((await windows.listViews()).map((view): string => `${view.host}/${view.id}`)).toEqual([
      'ubuntu/S-ubuntu',
      'windows/S-win',
    ])
    expect((await ubuntu.listViews()).map((view): string => `${view.host}/${view.id}`)).toEqual([
      'ubuntu/S-ubuntu',
      'windows/S-win',
    ])

    const operator = user('win-operator')
    const requested = await windows.requestTakeover(session('S-ubuntu'), operator)
    expect(requested.status).toBe('pending')
    const request = ubuntu.takeoversFor(user('ubuntu-owner'))[0]
    if (request === undefined) throw new Error('remote request did not arrive')
    await ubuntu.decideTakeover(request.id, 'approve', user('ubuntu-owner'), request.sessionVersion)
    await windows.refreshPeers()
    expect(windows.getView(session('S-ubuntu'))).toMatchObject({
      lockHolder: { id: 'win-operator' },
      roles: { 'ubuntu-owner': 'observer', 'win-operator': 'operator' },
    })

    await windows.injectInput(
      session('S-ubuntu'),
      { actor: operator, accountRole: 'operator' },
      'run the check',
    )
    expect(ubuntuInput).toEqual(['run the check'])

    ubuntu.publishOutput(session('S-ubuntu'), 'remote output')
    const controller = new AbortController()
    const stream = windows.stream(session('S-ubuntu'), 0, controller.signal)[Symbol.asyncIterator]()
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { event: 'session', data: { text: 'remote output' } },
    })
    controller.abort()
    await stream.return?.()

    await windows.release(session('S-ubuntu'), operator)
    await windows.refreshPeers()
    expect(windows.getView(session('S-ubuntu'))).toMatchObject({
      lockHolder: { id: 'ubuntu-owner' },
      roles: { 'ubuntu-owner': 'owner', 'win-operator': 'observer' },
    })
  })
})

describe('dual-host loopback HTTP federation', (): void => {
  it('discovers both peers, serializes takeover, and replays after reconnect', async (): Promise<void> => {
    const [windowsServer, ubuntuServer] = await Promise.all([
      startDeferredPeerServer(),
      startDeferredPeerServer(),
    ])
    const credentials: Readonly<Record<string, string>> = {
      WINDOWS_TO_UBUNTU: 'user=win-operator; role=operator; luban_csrf=windows-csrf',
      UBUNTU_TO_WINDOWS: 'user=ubuntu-operator; role=operator; luban_csrf=ubuntu-csrf',
    }
    const readEnvironment = (name: string): string | undefined => credentials[name]
    const windowsInput: string[] = []
    const ubuntuInput: string[] = []
    const windows = new SharedSessionRegistry({
      localHost: host('windows'),
      takeoverTimeoutMs: 10_000,
      replayLimit: 16,
      peers: [peerConfig('ubuntu', ubuntuServer.baseUrl, 'WINDOWS_TO_UBUNTU')],
      network: new HttpPeerNetwork({ timeoutMs: 2_000, readEnvironment }),
      input: {
        inject(_id, text): Promise<void> {
          windowsInput.push(text)
          return Promise.resolve()
        },
      },
    })
    const ubuntu = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 10_000,
      replayLimit: 16,
      peers: [peerConfig('windows', windowsServer.baseUrl, 'UBUNTU_TO_WINDOWS')],
      network: new HttpPeerNetwork({ timeoutMs: 2_000, readEnvironment }),
      input: {
        inject(_id, text): Promise<void> {
          ubuntuInput.push(text)
          return Promise.resolve()
        },
      },
    })
    const windowsApi = new SessionShareHttpApi(windows, httpAuth(), 16)
    const ubuntuApi = new SessionShareHttpApi(ubuntu, httpAuth(), 16)
    windowsServer.attach(windowsApi)
    ubuntuServer.attach(ubuntuApi)
    windows.registerLocal({
      id: session('S-win-http'),
      host: host('windows'),
      owner: user('win-owner'),
      healthy: true,
      status: 'idle',
    })
    ubuntu.registerLocal({
      id: session('S-ubuntu-http'),
      host: host('ubuntu'),
      owner: user('ubuntu-owner'),
      healthy: true,
      status: 'running',
    })

    try {
      await expect(Promise.all([windows.refreshPeers(), ubuntu.refreshPeers()])).resolves.toEqual([
        [],
        [],
      ])
      expect((await windows.listViews()).map((view): string => `${view.host}/${view.id}`)).toEqual([
        'ubuntu/S-ubuntu-http',
        'windows/S-win-http',
      ])
      expect((await ubuntu.listViews()).map((view): string => `${view.host}/${view.id}`)).toEqual([
        'ubuntu/S-ubuntu-http',
        'windows/S-win-http',
      ])

      const operator = user('win-operator')
      const [firstRequest, repeatedRequest] = await Promise.all([
        windows.requestTakeover(session('S-ubuntu-http'), operator),
        windows.requestTakeover(session('S-ubuntu-http'), operator),
      ])
      expect(firstRequest).toMatchObject({ status: 'pending' })
      expect(repeatedRequest).toEqual(firstRequest)
      expect(ubuntu.takeoversFor(user('ubuntu-owner'))).toHaveLength(1)
      const request = ubuntu.takeoversFor(user('ubuntu-owner'))[0]
      if (request === undefined) throw new Error('remote HTTP request did not arrive')
      await ubuntu.decideTakeover(
        request.id,
        'approve',
        user('ubuntu-owner'),
        request.sessionVersion,
      )
      await windows.refreshPeers()
      expect(windows.getView(session('S-ubuntu-http'))).toMatchObject({
        lockHolder: { id: 'win-operator' },
      })

      await windows.injectInput(
        session('S-ubuntu-http'),
        { actor: operator, accountRole: 'operator' },
        'continue over HTTP',
      )
      expect(ubuntuInput).toEqual(['continue over HTTP'])
      expect(windowsInput).toEqual([])

      ubuntu.publishOutput(session('S-ubuntu-http'), 'first remote output')
      const firstController = new AbortController()
      const firstStream = windows
        .stream(session('S-ubuntu-http'), 0, firstController.signal)
        [Symbol.asyncIterator]()
      const first = await firstStream.next()
      expect(first).toMatchObject({
        done: false,
        value: { event: 'session', data: { text: 'first remote output' } },
      })
      if (first.done !== false) throw new Error('first HTTP stream ended unexpectedly')
      await firstStream.return?.()

      ubuntu.publishOutput(session('S-ubuntu-http'), 'replayed after reconnect')
      const replayController = new AbortController()
      const replayStream = windows
        .stream(session('S-ubuntu-http'), first.value.id, replayController.signal)
        [Symbol.asyncIterator]()
      await expect(replayStream.next()).resolves.toMatchObject({
        done: false,
        value: { event: 'session', data: { text: 'replayed after reconnect' } },
      })
      await replayStream.return?.()

      await windows.release(session('S-ubuntu-http'), operator)
      await windows.refreshPeers()
      expect(windows.getView(session('S-ubuntu-http'))).toMatchObject({
        lockHolder: { id: 'ubuntu-owner' },
      })
    } finally {
      await Promise.allSettled([windowsServer.close(), ubuntuServer.close()])
    }
  }, 30_000)
})
