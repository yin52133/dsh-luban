import type { Actor, SessionId, TakeoverResult } from '@luban/core'
import { describe, expect, it } from 'vitest'
import type { PeerConfig } from '../src/config.js'
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
