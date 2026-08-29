import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { AuthService } from '@luban/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DefaultTelemetryAggregator } from '../src/aggregator.js'
import { runCli } from '../src/cli.js'
import { apply as applyClient } from '../src/client/index.js'
import { HudEventStream, HudHttpApi } from '../src/http-api.js'
import { HUD_TELEMETRY_EVENT, type HudSnapshotResponse } from '../src/types.js'

class MockResponse extends EventEmitter {
  public statusCode = 200
  public headersSent = false
  public destroyed = false
  public writableEnded = false
  public body = ''
  public readonly headers = new Map<string, string>()

  public setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value)
  }

  public end(value?: Uint8Array | string): void {
    if (value !== undefined) this.body += Buffer.from(value).toString('utf8')
    this.headersSent = true
    this.writableEnded = true
    this.emit('finish')
  }

  public write(value: Uint8Array | string): boolean {
    this.body += Buffer.from(value).toString('utf8')
    this.headersSent = true
    return true
  }

  public flushHeaders(): void {
    this.headersSent = true
  }
}

function request(
  path: string,
  cookie?: string,
  headers: Readonly<Record<string, string>> = {},
): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage
  Object.assign(emitter, {
    method: 'GET',
    url: path,
    headers: {
      accept: 'application/json',
      ...headers,
      ...(cookie === undefined ? {} : { cookie }),
    },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return emitter
}

function auth(): AuthService {
  return {
    middleware: () => (input) =>
      Promise.resolve(
        input.cookie === 'luban_session=ok'
          ? { allowed: true, status: 200, user: 'owner' }
          : { allowed: false, status: 401 },
      ),
  } as AuthService
}

const publicConfig = {
  thresholds: { warn: 0.7, danger: 0.85, critical: 0.95 },
  display: {
    fields: ['context', 'workspace', 'model', 'thinking', 'tpm', 'rpm'] as const,
    compact: false,
  },
}

function streamEnvelope(at: number): HudSnapshotResponse {
  return {
    snapshot: {
      context: { used: at, max: 100, ratio: at / 100 },
      workspace: { name: 'firmware' },
      model: { name: 'deepseek-chat', thinkingDepth: 'high' },
      rates: { tpm1m: at, tpm5m: at / 5, rpm1m: 1, rpm5m: 0.2 },
      at,
    },
    advisory: { level: 'normal', message: 'Context usage is normal', compactionSuggested: false },
    sources: {},
    failures: [],
    config: publicConfig,
  }
}

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('HUD API, CLI, and rc2 client seat', (): void => {
  it('authenticates the snapshot route and returns one shared envelope shape', async (): Promise<void> => {
    const telemetry = new DefaultTelemetryAggregator({ refreshMs: 1_000, providerTimeoutMs: 100 })
    const api = new HudHttpApi({ telemetry, auth: auth(), config: publicConfig })
    const denied = new MockResponse()
    await api.handler(request('/luban-hud/snapshot'), denied as unknown as ServerResponse)
    expect(denied.statusCode).toBe(401)

    const allowed = new MockResponse()
    await api.handler(
      request('/luban-hud/snapshot', 'luban_session=ok'),
      allowed as unknown as ServerResponse,
    )
    expect(allowed.statusCode).toBe(200)
    expect(JSON.parse(allowed.body)).toMatchObject({
      snapshot: { context: { used: 'unknown' } },
      advisory: { level: 'unknown' },
      config: publicConfig,
    })
    api.dispose()
  })

  it('renders the API snapshot as the CLI first line and keeps auth out of argv', async (): Promise<void> => {
    const fetchMock = vi.fn((_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            snapshot: {
              context: { used: 75, max: 100, ratio: 0.75 },
              workspace: { name: 'firmware\nforged\u001b[31m' },
              model: { name: 'deep\rseek-chat', thinkingDepth: 'high\tmode' },
              rates: { tpm1m: 120, tpm5m: 80, rpm1m: 2, rpm5m: 1.2 },
              at: 10,
            },
            advisory: {
              level: 'warn',
              message: 'Context usage is elevated',
              compactionSuggested: false,
            },
            sources: {},
            failures: [],
            config: publicConfig,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const line = await runCli([], {
      LUBAN_URL: 'http://127.0.0.1:42600',
      LUBAN_SESSION_COOKIE: 'luban_session=secret',
    })
    expect(line).toContain('Luban HUD [WARN] | ctx 75/100 (75.0%)')
    expect(line.split('\n')).toHaveLength(1)
    expect(line).not.toMatch(/\p{Cc}/u)
    expect(line).toContain('workspace firmware forged [31m')
    expect(line).toContain('model deep seek-chat')
    const call = fetchMock.mock.calls.at(0)
    expect(call?.[0]).toEqual(new URL('http://127.0.0.1:42600/luban-hud/snapshot'))
    expect(new Headers(call?.[1]?.headers).get('cookie')).toBe('luban_session=secret')
    await expect(runCli(['--url', 'http://localhost:42600'], {})).rejects.toThrow(
      'LUBAN_SESSION_COOKIE',
    )
    await expect(
      runCli(['--url', 'http://owner:secret@localhost:42600'], {
        LUBAN_SESSION_COOKIE: 'luban_session=secret',
      }),
    ).rejects.toThrow('must not contain credentials')

    vi.stubGlobal(
      'fetch',
      vi.fn((): Promise<Response> =>
        Promise.resolve(new Response('upstream\nfailed\u001b[31m', { status: 503 })),
      ),
    )
    await expect(
      runCli([], {
        LUBAN_URL: 'http://127.0.0.1:42600',
        LUBAN_SESSION_COOKIE: 'luban_session=secret',
      }),
    ).rejects.toThrow('upstream failed [31m')
  })

  it('uses one registered SSE event id for fan-out and performs bounded replay', (): void => {
    const stream = new HudEventStream()
    const firstRequest = request('/luban-hud/events')
    const secondRequest = request('/luban-hud/events')
    const first = new MockResponse()
    const second = new MockResponse()
    stream.connect(firstRequest, first as unknown as ServerResponse, streamEnvelope(0))
    stream.connect(secondRequest, second as unknown as ServerResponse, streamEnvelope(0))
    expect(first.body).toContain(`id: 0\nevent: ${HUD_TELEMETRY_EVENT}\n`)
    expect(second.body).toContain(`id: 0\nevent: ${HUD_TELEMETRY_EVENT}\n`)

    first.body = ''
    second.body = ''
    stream.publish(streamEnvelope(1))
    expect(first.body).toContain(`id: 1\nevent: ${HUD_TELEMETRY_EVENT}\n`)
    expect(second.body).toContain(`id: 1\nevent: ${HUD_TELEMETRY_EVENT}\n`)
    stream.publish(streamEnvelope(2))

    const replay = new MockResponse()
    stream.connect(
      request('/luban-hud/events', undefined, { 'last-event-id': '1' }),
      replay as unknown as ServerResponse,
      streamEnvelope(2),
    )
    expect(replay.body).toContain(`id: 2\nevent: ${HUD_TELEMETRY_EVENT}\n`)
    expect(replay.body).not.toContain('id: 1\n')

    firstRequest.emit('close')
    secondRequest.emit('close')
    for (let at = 3; at <= 259; at += 1) stream.publish(streamEnvelope(at))
    const gap = new MockResponse()
    stream.connect(
      request('/luban-hud/events', undefined, { 'last-event-id': '1' }),
      gap as unknown as ServerResponse,
      streamEnvelope(999),
    )
    expect(gap.body).toContain(`id: 259\nevent: ${HUD_TELEMETRY_EVENT}\n`)
    expect(gap.body).toContain('"at":999')
    expect(gap.body.match(/^event:/gmu)).toHaveLength(1)
    stream.dispose()
    expect((): void =>
      stream.connect(
        request('/luban-hud/events'),
        new MockResponse() as unknown as ServerResponse,
        streamEnvelope(999),
      ),
    ).toThrow('disposed')
  })

  it('fails closed when plugin disposal races with asynchronous authentication', async (): Promise<void> => {
    let finishAuthentication:
      ((decision: { allowed: true; status: 200; user: string }) => void) | undefined
    let authenticationStarted: (() => void) | undefined
    const started = new Promise<void>((resolve): void => {
      authenticationStarted = resolve
    })
    const delayedAuth = {
      middleware: () => () => {
        authenticationStarted?.()
        return new Promise((resolve): void => {
          finishAuthentication = resolve
        })
      },
    } as unknown as AuthService
    const telemetry = new DefaultTelemetryAggregator({ refreshMs: 1_000, providerTimeoutMs: 100 })
    const api = new HudHttpApi({ telemetry, auth: delayedAuth, config: publicConfig })
    const response = new MockResponse()

    const pending = api.handler(
      request('/luban-hud/events', 'luban_session=ok'),
      response as unknown as ServerResponse,
    )
    await started
    api.dispose()
    if (finishAuthentication === undefined) throw new Error('authentication did not start')
    finishAuthentication({ allowed: true, status: 200, user: 'owner' })
    await pending

    expect(response.statusCode).toBe(503)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
  })

  it('registers the status bar in the official shell.overlay list slot', (): void => {
    const register = vi.fn((): (() => void) => (): void => undefined)
    const inject = vi.fn((_name: string, contribution: () => unknown): unknown => contribution())
    applyClient({ slots: { inject, register } } as unknown as ClientContext)
    expect(inject).toHaveBeenCalledWith('shell.overlay', expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'shell.overlay', id: 'luban-hud' }),
      expect.any(Function),
    )
  })
})
