import { describe, expect, it, vi } from 'vitest'
import { asAccountId } from 'dsh-luban-core'
import type { PeerConfig } from '../src/config.js'
import { SharedSessionRegistry } from '../src/registry.js'
import type { PeerNetwork, PeerSessionSnapshot } from '../src/types.js'
import { MutableClock, host, session, user } from './helpers.js'

describe('SharedSessionRegistry', (): void => {
  it('filters sessions and rejects guessed identifiers across account contexts', async (): Promise<void> => {
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 5_000,
      replayLimit: 16,
    })
    const alice = { ...user('alice'), accountId: asAccountId('alice') }
    const aliceHelper = { ...user('alice-helper'), accountId: asAccountId('alice') }
    const bob = { ...user('bob'), accountId: asAccountId('bob') }
    expect((): void => {
      registry.registerLocal({
        id: session('S-legacy'),
        host: host('ubuntu'),
        owner: { kind: 'user', id: alice.id, displayName: 'legacy' },
        healthy: true,
        status: 'idle',
      })
    }).toThrow('no account ownership')
    registry.registerLocal({
      id: session('S-alice'),
      host: host('ubuntu'),
      owner: alice,
      healthy: true,
      status: 'idle',
    })
    registry.registerLocal({
      id: session('S-bob'),
      host: host('ubuntu'),
      owner: bob,
      healthy: true,
      status: 'idle',
    })

    await expect(registry.listFor(alice, 'admin')).resolves.toMatchObject([{ id: 'S-alice' }])
    await expect(registry.listFor(bob, 'admin')).resolves.toMatchObject([{ id: 'S-bob' }])
    await expect(registry.list(asAccountId('alice'))).resolves.toMatchObject([{ id: 'S-alice' }])
    expect(registry.getViewFor(session('S-alice'), asAccountId('bob'))).toBeUndefined()
    expect((): void => {
      registry.subscribe(session('S-alice'), asAccountId('bob'), 'observer')
    }).toThrow('was not found')
    expect((): void => {
      registry.roleFor(session('S-alice'), bob, 'admin')
    }).toThrow('was not found')
    await expect(registry.requestTakeover(session('S-alice'), bob)).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
    await expect(registry.release(session('S-alice'), bob)).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })

    const pending = await registry.requestTakeover(session('S-alice'), aliceHelper)
    if (pending.status !== 'pending') throw new Error('same-account takeover was not pending')
    const request = registry.takeoversFor(alice)[0]
    if (request === undefined) throw new Error('same-account takeover request is missing')
    expect(registry.takeoversFor(bob)).toEqual([])
    await expect(
      registry.decideTakeover(request.id, 'approve', bob, request.sessionVersion),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
  })

  it('rechecks account ownership after a takeover waits for its session mutex', async (): Promise<void> => {
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 5_000,
      replayLimit: 16,
    })
    const id = session('S-reused')
    const alice = user('alice')
    const aliceHelper = user('alice-helper', 'alice')
    const bob = user('bob')
    registry.registerLocal({
      id,
      host: host('ubuntu'),
      owner: alice,
      healthy: true,
      status: 'idle',
    })

    const takeover = registry.requestTakeover(id, aliceHelper)
    registry.removeLocal(id)
    registry.registerLocal({
      id,
      host: host('ubuntu'),
      owner: bob,
      healthy: true,
      status: 'idle',
    })

    await expect(takeover).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    expect(registry.getView(id)).toMatchObject({
      accountId: 'bob',
      owner: { id: 'bob' },
      lockHolder: { id: 'bob' },
    })
    expect(registry.takeoversFor(bob)).toEqual([])
  })

  it('requires two distinct actors and a versioned CAS for exclusive takeover', async (): Promise<void> => {
    const clock = new MutableClock()
    const injected: string[] = []
    const locks: string[] = []
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 5_000,
      replayLimit: 16,
      clock,
      input: {
        inject(_id, text): Promise<void> {
          injected.push(text)
          return Promise.resolve()
        },
      },
      publishLock: (view, role): void => {
        locks.push(`${view.lockHolder?.id ?? 'none'}:${role}`)
      },
    })
    const owner = user('alice')
    const requester = user('bob', 'alice')
    const competitor = user('carol', 'alice')
    registry.registerLocal({
      id: session('S-1'),
      host: host('ubuntu'),
      owner,
      healthy: true,
      status: 'idle',
    })

    const [first, concurrent] = await Promise.all([
      registry.requestTakeover(session('S-1'), requester),
      registry.requestTakeover(session('S-1'), competitor),
    ])
    expect(first).toMatchObject({ status: 'pending' })
    expect(concurrent).toEqual({ status: 'denied', reason: 'Another takeover request is pending' })
    if (first.status !== 'pending') throw new Error('request was not pending')
    const request = registry.takeoversFor(owner)[0]
    expect(request).toMatchObject({
      id: first.requestId,
      requestedBy: { id: 'bob' },
      status: 'pending',
      sessionVersion: 2,
    })
    if (request === undefined) throw new Error('request is missing')

    await expect(
      registry.decideTakeover(request.id, 'approve', competitor, request.sessionVersion),
    ).rejects.toMatchObject({ code: 'E_AUTH_REQUIRED', details: { status: 403 } })
    await expect(
      registry.decideTakeover(request.id, 'approve', owner, request.sessionVersion + 1),
    ).rejects.toMatchObject({ code: 'E_VERSION_CONFLICT' })

    const granted = await registry.decideTakeover(
      request.id,
      'approve',
      owner,
      request.sessionVersion,
    )
    expect(granted).toMatchObject({
      status: 'granted',
      session: {
        lockHolder: { id: 'bob' },
        roles: { alice: 'observer', bob: 'operator' },
        version: 3,
      },
    })
    expect(registry.roleFor(session('S-1'), owner, 'admin')).toBe('observer')
    expect(registry.roleFor(session('S-1'), requester, 'operator')).toBe('operator')

    await expect(
      registry.injectInput(session('S-1'), { actor: competitor, accountRole: 'operator' }, 'no'),
    ).rejects.toMatchObject({ code: 'E_AUTH_REQUIRED', details: { status: 403 } })
    await expect(
      registry.injectInput(session('S-1'), { actor: requester, accountRole: 'observer' }, 'no'),
    ).rejects.toMatchObject({ code: 'E_AUTH_REQUIRED', details: { status: 403 } })
    await registry.injectInput(
      session('S-1'),
      { actor: requester, accountRole: 'operator' },
      'continue',
    )
    expect(injected).toEqual(['continue'])

    await registry.release(session('S-1'), requester)
    expect(registry.getView(session('S-1'))).toMatchObject({
      lockHolder: { id: 'alice' },
      roles: { alice: 'owner', bob: 'observer' },
      version: 4,
    })
    expect(locks).toEqual(['bob:operator', 'alice:owner'])
  })

  it('expires unanswered requests without granting and accepts a later requester', async (): Promise<void> => {
    const clock = new MutableClock()
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
      clock,
    })
    registry.registerLocal({
      id: session('S-timeout'),
      host: host('ubuntu'),
      owner: user('owner'),
      healthy: true,
      status: 'idle',
    })
    const pending = await registry.requestTakeover(session('S-timeout'), user('first', 'owner'))
    expect(pending.status).toBe('pending')
    clock.advance(1_001)
    registry.sweepExpired()
    expect(registry.takeoversFor(user('first', 'owner'))[0]).toMatchObject({
      status: 'expired',
      reason: 'Takeover approval timed out',
    })
    expect(registry.getView(session('S-timeout'))?.lockHolder).toMatchObject({ id: 'owner' })
    await expect(
      registry.requestTakeover(session('S-timeout'), user('second', 'owner')),
    ).resolves.toMatchObject({ status: 'pending' })
  })

  it('coalesces concurrent peer refreshes so stale responses cannot overwrite newer state', async (): Promise<void> => {
    const configuredPeer: PeerConfig = {
      name: 'windows',
      baseUrl: 'https://windows.example.test',
      credentialEnv: 'TEST_WINDOWS_COOKIE',
    }
    const owner = user('remote-owner')
    const snapshot: PeerSessionSnapshot = {
      id: session('S-remote'),
      host: host('windows'),
      lockHolder: owner,
      roles: { [owner.id]: 'owner' },
      healthy: true,
      owner,
      status: 'running',
      version: 1,
      updatedAt: 100,
    }
    let resolveList: ((sessions: readonly PeerSessionSnapshot[]) => void) | undefined
    const list = vi.fn<PeerNetwork['list']>(
      () =>
        new Promise<readonly PeerSessionSnapshot[]>((resolve): void => {
          resolveList = resolve
        }),
    )
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
      peers: [configuredPeer],
      network: { list } as unknown as PeerNetwork,
    })

    const first = registry.refreshPeers()
    const concurrent = registry.refreshPeers()
    expect(list).toHaveBeenCalledTimes(1)
    if (resolveList === undefined) throw new Error('peer refresh did not start')
    resolveList([snapshot])
    await expect(Promise.all([first, concurrent])).resolves.toEqual([[], []])
    expect(registry.getView(session('S-remote'))).toMatchObject({ status: 'running', version: 1 })

    list.mockResolvedValueOnce([{ ...snapshot, status: 'idle', version: 2, updatedAt: 200 }])
    await expect(registry.refreshPeers()).resolves.toEqual([])
    expect(list).toHaveBeenCalledTimes(2)
    expect(registry.getView(session('S-remote'))).toMatchObject({ status: 'idle', version: 2 })
  })

  it('fails closed when a peer session id collides with a local registry origin', async (): Promise<void> => {
    const configuredPeer: PeerConfig = {
      name: 'windows',
      baseUrl: 'https://windows.example.test',
      credentialEnv: 'TEST_WINDOWS_COOKIE',
    }
    const remoteOwner = user('remote-owner')
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
      peers: [configuredPeer],
      network: {
        list: (): Promise<readonly PeerSessionSnapshot[]> =>
          Promise.resolve([
            {
              id: session('S-collision'),
              host: host('windows'),
              lockHolder: remoteOwner,
              roles: { [remoteOwner.id]: 'owner' },
              healthy: true,
              owner: remoteOwner,
              status: 'running',
              version: 1,
              updatedAt: 100,
            },
          ]),
      } as unknown as PeerNetwork,
    })
    registry.registerLocal({
      id: session('S-collision'),
      host: host('ubuntu'),
      owner: user('local-owner'),
      healthy: true,
      status: 'idle',
    })

    await expect(registry.refreshPeers()).resolves.toEqual(['windows: session-id-collision'])
    expect(registry.getView(session('S-collision'))).toMatchObject({
      host: 'ubuntu',
      owner: { id: 'local-owner' },
      status: 'idle',
    })

    const remoteFirst = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
      peers: [configuredPeer],
      network: {
        list: (): Promise<readonly PeerSessionSnapshot[]> =>
          Promise.resolve([
            {
              id: session('S-collision'),
              host: host('windows'),
              lockHolder: remoteOwner,
              roles: { [remoteOwner.id]: 'owner' },
              healthy: true,
              owner: remoteOwner,
              status: 'running',
              version: 1,
              updatedAt: 100,
            },
          ]),
      } as unknown as PeerNetwork,
    })
    await expect(remoteFirst.refreshPeers()).resolves.toEqual([])
    expect((): void => {
      remoteFirst.registerLocal({
        id: session('S-collision'),
        host: host('ubuntu'),
        owner: user('local-owner'),
        healthy: true,
        status: 'idle',
      })
    }).toThrow('collides with a peer registry origin')
    expect(remoteFirst.getView(session('S-collision'))).toMatchObject({
      host: 'windows',
      owner: { id: 'remote-owner' },
      status: 'running',
    })
  })

  it('redacts event output and selects replay or baseline based on the bounded gap', async (): Promise<void> => {
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    registry.registerLocal({
      id: session('S-events'),
      host: host('ubuntu'),
      owner: user('owner'),
      healthy: true,
      status: 'idle',
    })
    const secret = registry.publishOutput(session('S-events'), 'token=super-secret')
    expect(secret).toMatchObject({ type: 'output', text: 'token=[REDACTED]' })

    const controller = new AbortController()
    const replay = registry
      .stream(session('S-events'), 0, controller.signal)
      [Symbol.asyncIterator]()
    await expect(replay.next()).resolves.toMatchObject({
      done: false,
      value: { event: 'session', data: { text: 'token=[REDACTED]' } },
    })
    controller.abort()
    await replay.return?.()

    for (let index = 0; index < 20; index += 1) {
      registry.publishOutput(session('S-events'), `line-${String(index)}`)
    }
    const gapController = new AbortController()
    const gap = registry
      .stream(session('S-events'), 1, gapController.signal)
      [Symbol.asyncIterator]()
    const recovered = await gap.next()
    expect(recovered).toMatchObject({ done: false, value: { event: 'baseline' } })
    if (recovered.done === true || recovered.value.event !== 'baseline') {
      throw new Error('expected a baseline')
    }
    const data = recovered.value.data
    expect(data.recent).toHaveLength(16)
    expect(JSON.stringify(data)).not.toContain('super-secret')
    gapController.abort()
    await gap.return?.()
  })

  it('ends active event streams after the local session is disposed', async (): Promise<void> => {
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    registry.registerLocal({
      id: session('S-dispose'),
      host: host('ubuntu'),
      owner: user('owner'),
      healthy: true,
      status: 'idle',
    })
    const stream = registry
      .stream(session('S-dispose'), undefined, new AbortController().signal)
      [Symbol.asyncIterator]()
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { event: 'baseline' },
    })

    registry.removeLocal(session('S-dispose'))

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { event: 'session', data: { type: 'status', status: 'disposed' } },
    })
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('closes a slow subscriber when its live backlog exceeds the replay bound', async (): Promise<void> => {
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    registry.registerLocal({
      id: session('S-slow'),
      host: host('ubuntu'),
      owner: user('owner'),
      healthy: true,
      status: 'running',
    })
    const stream = registry
      .stream(session('S-slow'), undefined, new AbortController().signal)
      [Symbol.asyncIterator]()
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { event: 'baseline' },
    })

    for (let index = 0; index < 17; index += 1) {
      registry.publishOutput(session('S-slow'), `burst-${String(index)}`)
    }

    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined })
    const recoveryController = new AbortController()
    const recovery = registry
      .stream(session('S-slow'), 0, recoveryController.signal)
      [Symbol.asyncIterator]()
    const recovered = await recovery.next()
    expect(recovered).toMatchObject({ done: false, value: { event: 'baseline' } })
    if (recovered.done === true || recovered.value.event !== 'baseline') {
      throw new Error('expected a recovery baseline')
    }
    expect(recovered.value.data.recent).toHaveLength(16)
    recoveryController.abort()
    await recovery.return?.()
  })

  it('notifies registry observers through the core contract', (): void => {
    const registry = new SharedSessionRegistry({
      localHost: host('ubuntu'),
      takeoverTimeoutMs: 1_000,
      replayLimit: 16,
    })
    const listener = vi.fn()
    const unsubscribe = registry.onRegistryChange(asAccountId('owner'), listener)
    registry.registerLocal({
      id: session('S-observer'),
      host: host('ubuntu'),
      owner: user('owner'),
      healthy: true,
      status: 'running',
    })
    registry.removeLocal(session('S-observer'))
    unsubscribe()
    expect(listener.mock.calls.map((call): unknown => call[0])).toMatchObject([
      { type: 'registered' },
      { type: 'removed' },
    ])
  })
})
