import { describe, expect, it, vi } from 'vitest'
import type { PeerConfig } from '../src/config.js'
import { HttpPeerNetwork, decodePeerSession } from '../src/peer.js'
import { session, user } from './helpers.js'

const peer: PeerConfig = {
  name: 'ubuntu',
  baseUrl: 'https://ubuntu.example.test:42600',
  credentialEnv: 'TEST_UBUNTU_COOKIE',
}

const snapshot = {
  id: 'S-peer',
  host: 'ubuntu',
  lockHolder: { kind: 'user', id: 'owner', displayName: 'owner' },
  roles: { owner: 'owner' },
  healthy: true,
  owner: { kind: 'user', id: 'owner', displayName: 'owner' },
  status: 'idle',
  version: 1,
  updatedAt: 123,
}

describe('HttpPeerNetwork', (): void => {
  it('reads M01 cookie and CSRF values only from the environment boundary', async (): Promise<void> => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = []
    const fetchStub: typeof fetch = (input, init): Promise<Response> => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      requests.push({ url, init })
      if (url.endsWith('/luban-auth/session')) {
        return Promise.resolve(Response.json({ user: 'operator', role: 'operator' }))
      }
      if (url.endsWith('/sessions')) {
        return Promise.resolve(Response.json({ sessions: [snapshot] }))
      }
      if (url.endsWith('/takeover')) {
        return Promise.resolve(Response.json({ result: { status: 'pending', requestId: 'R-1' } }))
      }
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    const network = new HttpPeerNetwork({
      timeoutMs: 1_000,
      fetch: fetchStub,
      readEnvironment: (name): string | undefined =>
        name === peer.credentialEnv
          ? 'luban_session=top-secret; luban_csrf=csrf-secret'
          : undefined,
    })

    await expect(network.list(peer)).resolves.toMatchObject([{ id: 'S-peer', host: 'ubuntu' }])
    await expect(
      network.requestTakeover(peer, session('S-peer'), user('operator')),
    ).resolves.toEqual({ status: 'pending', requestId: 'R-1' })
    await network.injectInput(peer, session('S-peer'), user('operator'), 'continue')

    expect(requests.map((request) => request.url)).toEqual([
      'https://ubuntu.example.test:42600/luban-session-share/sessions',
      'https://ubuntu.example.test:42600/luban-auth/session',
      'https://ubuntu.example.test:42600/luban-session-share/sessions/S-peer/takeover',
      'https://ubuntu.example.test:42600/luban-auth/session',
      'https://ubuntu.example.test:42600/luban-session-share/sessions/S-peer/input',
    ])
    expect(new Headers(requests[0]?.init?.headers).get('cookie')).toBe(
      'luban_session=top-secret; luban_csrf=csrf-secret',
    )
    expect(new Headers(requests[2]?.init?.headers).get('x-luban-csrf')).toBe('csrf-secret')
    expect(JSON.stringify(peer)).not.toContain('top-secret')
  })

  it('fails closed when the peer credential belongs to a different actor', async (): Promise<void> => {
    const requests: string[] = []
    const network = new HttpPeerNetwork({
      timeoutMs: 1_000,
      fetch: (input): Promise<Response> => {
        const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
        requests.push(url)
        if (url.endsWith('/luban-auth/session')) {
          return Promise.resolve(Response.json({ user: 'service-account', role: 'operator' }))
        }
        return Promise.resolve(Response.json({ result: { status: 'pending', requestId: 'R-1' } }))
      },
      readEnvironment: (): string => 'luban_session=session; luban_csrf=csrf',
    })

    await expect(
      network.requestTakeover(peer, session('S-peer'), user('operator')),
    ).rejects.toMatchObject({ code: 'E_AUTH_REQUIRED', details: { status: 403 } })
    expect(requests).toEqual(['https://ubuntu.example.test:42600/luban-auth/session'])
  })

  it('parses peer SSE while redacting a second time at the trust boundary', async (): Promise<void> => {
    const fetchStub: typeof fetch = (): Promise<Response> =>
      Promise.resolve(
        new Response(
          'id: 4\nevent: session\ndata: {"type":"output","seq":4,"text":"token=secret-value","at":123}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )
    const network = new HttpPeerNetwork({
      timeoutMs: 1_000,
      fetch: fetchStub,
      readEnvironment: (): string => 'luban_session=session; luban_csrf=csrf',
    })
    const controller = new AbortController()
    const iterator = network
      .stream(peer, session('S-peer'), 3, controller.signal)
      [Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: 4, event: 'session', data: { text: 'token=[REDACTED]' } },
    })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('times out a stalled peer SSE connection', async (): Promise<void> => {
    vi.useFakeTimers()
    try {
      const network = new HttpPeerNetwork({
        timeoutMs: 25,
        fetch: (_input, init): Promise<Response> =>
          new Promise<Response>((_resolve, reject): void => {
            const signal = init?.signal
            if (!(signal instanceof AbortSignal)) return
            const rejection = (): Error =>
              signal.reason instanceof Error ? signal.reason : new Error('peer request aborted')
            if (signal.aborted) reject(rejection())
            else {
              signal.addEventListener('abort', (): void => reject(rejection()), { once: true })
            }
          }),
        readEnvironment: (): string => 'luban_session=session; luban_csrf=csrf',
      })
      const iterator = network
        .stream(peer, session('S-peer'), undefined, new AbortController().signal)
        [Symbol.asyncIterator]()
      const pending = iterator.next()
      const rejected = expect(pending).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })

      await vi.advanceTimersByTimeAsync(25)

      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the connection timeout after peer SSE headers arrive', async (): Promise<void> => {
    vi.useFakeTimers()
    try {
      const encoder = new TextEncoder()
      let accept: string | null = null
      const network = new HttpPeerNetwork({
        timeoutMs: 25,
        fetch: (_input, init): Promise<Response> => {
          accept = new Headers(init?.headers).get('accept')
          const body = new ReadableStream<Uint8Array>({
            start(controller): void {
              setTimeout((): void => {
                controller.enqueue(
                  encoder.encode(
                    'id: 1\nevent: session\ndata: {"type":"status","seq":1,"status":"running","at":123}\n\n',
                  ),
                )
                controller.close()
              }, 50)
            },
          })
          return Promise.resolve(new Response(body))
        },
        readEnvironment: (): string => 'luban_session=session; luban_csrf=csrf',
      })
      const iterator = network
        .stream(peer, session('S-peer'), undefined, new AbortController().signal)
        [Symbol.asyncIterator]()
      const pending = iterator.next()
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(50)

      await expect(pending).resolves.toMatchObject({
        done: false,
        value: { id: 1, event: 'session', data: { type: 'status', status: 'running' } },
      })
      expect(accept).toBe('text/event-stream')
      await iterator.return(undefined)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an unterminated peer SSE frame above the parser bound', async (): Promise<void> => {
    const network = new HttpPeerNetwork({
      timeoutMs: 1_000,
      fetch: (): Promise<Response> => Promise.resolve(new Response('x'.repeat(1_048_577))),
      readEnvironment: (): string => 'luban_session=session; luban_csrf=csrf',
    })
    const iterator = network
      .stream(peer, session('S-peer'), undefined, new AbortController().signal)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
  })

  it('never includes credential values in transport errors', async (): Promise<void> => {
    const network = new HttpPeerNetwork({
      timeoutMs: 1_000,
      fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 403 })),
      readEnvironment: (): string => 'luban_session=do-not-leak; luban_csrf=also-secret',
    })
    let message = ''
    try {
      await network.list(peer)
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('status 403')
    expect(message).not.toContain('do-not-leak')
    expect(message).not.toContain('also-secret')
  })
})

describe('decodePeerSession', (): void => {
  it('rejects invalid role and version data', (): void => {
    expect(() => decodePeerSession({ ...snapshot, roles: { owner: 'root' } })).toThrow(
      'invalid session role',
    )
    expect(() => decodePeerSession({ ...snapshot, version: 0 })).toThrow('session.version')
  })
})
