import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { AgentRegistry, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Context, type Context as ClientContext } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AccountId, AuthMiddlewareRequest, AuthService } from 'dsh-luban-core'
import { asAccountId } from 'dsh-luban-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DefaultTelemetryAggregator, type AccountTelemetryProvider } from '../src/aggregator.js'
import { runCli } from '../src/cli.js'
import { apply as applyClient, keepaliveIndicator } from '../src/client/index.js'
import { DshSessionTelemetryProvider } from '../src/dsh-telemetry.js'
import { HudEventStream, HudHttpApi } from '../src/http-api.js'
import { HudKeepaliveHealthStore } from '../src/keepalive-health.js'
import {
  HUD_RATE_CAPTURE_SCHEMA,
  type HudRateCapture,
  type HudRateLedger,
} from '../src/rate-ledger.js'
import { HUD_RATE_EXPORT_SCHEMA, type RateWindowUtc } from '../src/rate-reconcile.js'
import { HUD_TELEMETRY_EVENT, type HudSnapshotResponse } from '../src/types.js'
import {
  HUD_BUILD_PROVENANCE_FIXTURE,
  HUD_RUNTIME_ARTIFACT_FIXTURE,
} from './runtime-artifact-fixture.js'

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
  const accountId = asAccountId('owner')
  return {
    middleware: () => (input: AuthMiddlewareRequest) =>
      Promise.resolve(
        input.cookie === 'luban_session=ok'
          ? {
              allowed: true,
              status: 200,
              user: 'owner',
              account: { accountId, username: 'owner', role: 'operator' },
            }
          : { allowed: false, status: 401 },
      ),
    accountSessions: {
      bind: (): Promise<void> => Promise.resolve(),
      ownerOf: (): Promise<AccountId> => Promise.resolve(accountId),
    },
  } as unknown as AuthService
}

function accountAuth(): AuthService {
  return {
    middleware: () => (input: AuthMiddlewareRequest) => {
      const username =
        input.cookie === 'luban_session=alice'
          ? 'alice'
          : input.cookie === 'luban_session=bob'
            ? 'bob'
            : undefined
      if (username === undefined) {
        return Promise.resolve({ allowed: false, status: 401 })
      }
      const accountId = asAccountId(username)
      return Promise.resolve({
        allowed: true,
        status: 200,
        user: username,
        account: { accountId, username, role: 'operator' },
      })
    },
    accountSessions: {
      bind: (): Promise<void> => Promise.resolve(),
      ownerOf: (): Promise<null> => Promise.resolve(null),
    },
  } as unknown as AuthService
}

const OWNER_ACCOUNT = asAccountId('owner')
const ALICE_ACCOUNT = asAccountId('alice')
const BOB_ACCOUNT = asAccountId('bob')

function telemetrySession(idValue: string, cwd: string): Session {
  const id = SessionId(idValue)
  return Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd,
  })
}

function appendRoute(
  session: Session,
  model: string,
  reasoningEffort: 'low' | 'medium' | 'high',
  reason: 'initial' | 'change',
): void {
  session.append('request/context', {
    provider: 'deepseek',
    model,
    contextWindow: 128_000,
  })
  session.append('request/header', {
    header: {
      config: {
        provider: 'deepseek',
        model,
        reasoningEffort: ReasoningEffortId(reasoningEffort),
      },
    },
    reason,
  })
}

function registeredAgent(context: Context, session: Session, model: string): Agent {
  const inbox = new Inbox(session, {
    inserted: (): void => undefined,
    discarded: (): void => undefined,
    claimed: (): void => undefined,
  })
  return {
    id: session.id,
    options: { provider: 'deepseek', model },
    session,
    inbox,
    status: 'idle',
    ctx: context,
    cancel: (): void => undefined,
    whenIdle: (): Promise<void> => Promise.resolve(),
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(new AbortController().signal)
    },
    send(message, target, _wakeup): void {
      inbox.append(target, message)
    },
    followup(message): void {
      inbox.append('next-turn', message)
    },
    steer(message): void {
      inbox.append('next-step', message)
    },
    inject(message): void {
      inbox.append('next-step', message)
    },
  }
}

const publicConfig = {
  thresholds: { warn: 0.7, danger: 0.85, critical: 0.95 },
  display: {
    fields: ['context', 'workspace', 'model', 'thinking', 'tpm', 'rpm'] as const,
    compact: false,
  },
}

function streamEnvelope(at: number, accountId: AccountId = OWNER_ACCOUNT): HudSnapshotResponse {
  return {
    snapshot: {
      accountId,
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
      keepalive: { healthy: true, alerts: [] },
    })
    api.dispose()
  })

  it('isolates authenticated Alice/Bob snapshot, history, live SSE, and ignores account spoofing', async (): Promise<void> => {
    let monotonicNow = 0
    const workspaces = new Map<AccountId, string>([
      [ALICE_ACCOUNT, 'alice/private'],
      [BOB_ACCOUNT, 'bob/private'],
    ])
    const scoped: AccountTelemetryProvider = {
      id: 'account-fixture',
      capabilities: (): readonly ['workspace'] => ['workspace'],
      sample: (): Promise<Partial<HudSnapshotResponse['snapshot']>> =>
        Promise.resolve({ workspace: { name: 'legacy/private' } }),
      sampleForAccount: (accountId: AccountId): Promise<Partial<HudSnapshotResponse['snapshot']>> =>
        Promise.resolve({
          accountId,
          workspace: { name: workspaces.get(accountId) ?? 'unknown' },
        }),
    }
    const telemetry = new DefaultTelemetryAggregator({
      refreshMs: 1_000,
      providerTimeoutMs: 100,
      monotonicClock: { now: (): number => monotonicNow },
    })
    telemetry.register(scoped)
    telemetry.register({
      id: 'legacy-only',
      capabilities: (): readonly ['model'] => ['model'],
      sample: (): Promise<Partial<HudSnapshotResponse['snapshot']>> =>
        Promise.resolve({ model: { name: 'legacy-secret', thinkingDepth: 'high' } }),
    })
    const api = new HudHttpApi({ telemetry, auth: accountAuth(), config: publicConfig })

    const aliceSnapshot = new MockResponse()
    await api.handler(
      request('/luban-hud/snapshot?accountId=bob', 'luban_session=alice'),
      aliceSnapshot as unknown as ServerResponse,
    )
    const aliceEnvelope = JSON.parse(aliceSnapshot.body) as HudSnapshotResponse
    expect(aliceEnvelope.snapshot).toMatchObject({
      accountId: ALICE_ACCOUNT,
      workspace: { name: 'alice/private' },
      model: { name: 'unknown' },
    })
    expect(JSON.stringify(aliceEnvelope)).not.toContain('bob/private')
    expect(JSON.stringify(aliceEnvelope)).not.toContain('legacy-secret')

    const bobSnapshot = new MockResponse()
    await api.handler(
      request('/luban-hud/snapshot', 'luban_session=bob'),
      bobSnapshot as unknown as ServerResponse,
    )
    expect((JSON.parse(bobSnapshot.body) as HudSnapshotResponse).snapshot).toMatchObject({
      accountId: BOB_ACCOUNT,
      workspace: { name: 'bob/private' },
    })

    const aliceRequest = request('/luban-hud/events', 'luban_session=alice')
    const bobRequest = request('/luban-hud/events', 'luban_session=bob')
    const aliceStream = new MockResponse()
    const bobStream = new MockResponse()
    await api.handler(aliceRequest, aliceStream as unknown as ServerResponse)
    await api.handler(bobRequest, bobStream as unknown as ServerResponse)
    aliceStream.body = ''
    bobStream.body = ''
    workspaces.set(ALICE_ACCOUNT, 'alice/next')
    monotonicNow = 1_001
    await telemetry.envelopeForAccount(ALICE_ACCOUNT)
    expect(aliceStream.body).toContain('alice/next')
    expect(bobStream.body).toBe('')

    const aliceHistory = new MockResponse()
    await api.handler(
      request('/luban-hud/history?accountId=bob', 'luban_session=alice'),
      aliceHistory as unknown as ServerResponse,
    )
    const history = JSON.parse(aliceHistory.body) as {
      snapshots: HudSnapshotResponse['snapshot'][]
    }
    expect(history.snapshots).toHaveLength(2)
    expect(
      history.snapshots.every((snapshot): boolean => snapshot.accountId === ALICE_ACCOUNT),
    ).toBe(true)
    expect(JSON.stringify(history)).not.toContain('bob/private')

    aliceRequest.emit('close')
    bobRequest.emit('close')
    api.dispose()
    telemetry.dispose()
  })

  it('authenticates and validates mounted rate capture requests', async (): Promise<void> => {
    const telemetry = new DefaultTelemetryAggregator({ refreshMs: 1_000, providerTimeoutMs: 100 })
    const capture = vi.fn((window: RateWindowUtc, challenge: string): Promise<HudRateCapture> =>
      Promise.resolve({
        schemaVersion: HUD_RATE_CAPTURE_SCHEMA,
        source: {
          kind: 'mounted-hud-capture',
          exportedAt: window.endUtc,
          coverageStartUtc: window.startUtc,
          processId: 123,
          nodeVersion: 'v24.0.0',
          challengeSha256: challenge,
          runtimeArtifact: HUD_RUNTIME_ARTIFACT_FIXTURE,
          build: HUD_BUILD_PROVENANCE_FIXTURE,
        },
        export: {
          schemaVersion: HUD_RATE_EXPORT_SCHEMA,
          source: {
            kind: 'hud-event-export',
            origin: 'live-hud-events',
            exportedAt: window.endUtc,
          },
          window,
          records: [],
        },
        captures: [],
      }),
    )
    const rateCapture = { capture } satisfies Pick<HudRateLedger, 'capture'>
    const api = new HudHttpApi({ telemetry, auth: auth(), config: publicConfig, rateCapture })

    const denied = new MockResponse()
    await api.handler(
      request('/luban-hud/rate-capture?startUtc=a&endUtc=b&challenge=c'),
      denied as unknown as ServerResponse,
    )
    expect(denied.statusCode).toBe(401)
    expect(capture).not.toHaveBeenCalled()

    const incomplete = new MockResponse()
    await api.handler(
      request('/luban-hud/rate-capture?startUtc=a&endUtc=b', 'luban_session=ok'),
      incomplete as unknown as ServerResponse,
    )
    expect(incomplete.statusCode).toBe(400)
    expect(capture).not.toHaveBeenCalled()

    const allowed = new MockResponse()
    await api.handler(
      request(
        '/luban-hud/rate-capture?startUtc=2026-08-30T12%3A00%3A00.000Z&endUtc=2026-08-30T12%3A05%3A00.000Z&challenge=capture_challenge_0123456789abcdef&accountId=bob',
        'luban_session=ok',
      ),
      allowed as unknown as ServerResponse,
    )
    expect(allowed.statusCode).toBe(200)
    expect(capture).toHaveBeenCalledWith(
      {
        startUtc: '2026-08-30T12:00:00.000Z',
        endUtc: '2026-08-30T12:05:00.000Z',
      },
      'capture_challenge_0123456789abcdef',
      OWNER_ACCOUNT,
    )
    expect(JSON.parse(allowed.body)).toMatchObject({
      schemaVersion: HUD_RATE_CAPTURE_SCHEMA,
      source: {
        kind: 'mounted-hud-capture',
        runtimeArtifact: HUD_RUNTIME_ARTIFACT_FIXTURE,
        build: HUD_BUILD_PROVENANCE_FIXTURE,
      },
    })
    api.dispose()

    const unavailable = new HudHttpApi({ telemetry, auth: auth(), config: publicConfig })
    const unavailableResponse = new MockResponse()
    await unavailable.handler(
      request(
        '/luban-hud/rate-capture?startUtc=a&endUtc=b&challenge=capture_challenge_0123456789abcdef',
        'luban_session=ok',
      ),
      unavailableResponse as unknown as ServerResponse,
    )
    expect(unavailableResponse.statusCode).toBe(503)
    unavailable.dispose()
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
            keepalive: {
              healthy: false,
              alerts: [{ sessionId: 'luban-build', detail: 'offline' }],
            },
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
    expect(line).toContain('keepalive 1 down: luban-build')
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

  it('refreshes rc2 session environment changes through the real loopback API and CLI', async (): Promise<void> => {
    const context = new Context()
    const agentsFiber = context.plugin(AgentRegistry)
    await agentsFiber
    const workspaceRoot = resolve('workspace-root')
    const initialWorkspace = resolve(workspaceRoot, 'firmware', 'alpha')
    const initialSession = telemetrySession('hud-loopback-alpha', initialWorkspace)
    appendRoute(initialSession, 'model-a', 'low', 'initial')
    let unregisterAgent = context.agents.register(
      registeredAgent(context, initialSession, 'model-a'),
    )
    let monotonicNow = 0
    const telemetry = new DefaultTelemetryAggregator({
      refreshMs: 1_000,
      providerTimeoutMs: 100,
      monotonicClock: { now: (): number => monotonicNow },
    })
    const authService = auth()
    telemetry.register(
      new DshSessionTelemetryProvider(
        context.agents,
        workspaceRoot,
        undefined,
        authService.accountSessions,
      ),
    )
    const api = new HudHttpApi({ telemetry, auth: authService, config: publicConfig })
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const environment = {
      LUBAN_URL: `http://127.0.0.1:${String(address.port)}`,
      LUBAN_SESSION_COOKIE: 'luban_session=ok',
    }

    try {
      const initial = await runCli([], environment)
      expect(context.agents.get(initialSession.id)?.session).toBe(initialSession)
      expect(initial).toContain('workspace firmware/alpha')
      expect(initial).toContain('model model-a')
      expect(initial).toContain('thinking low')

      appendRoute(initialSession, 'model-b', 'high', 'change')
      monotonicNow += 1_000
      const changedRoute = await runCli([], environment)
      expect(context.agents.get(initialSession.id)?.session).toBe(initialSession)
      expect(changedRoute).toContain('workspace firmware/alpha')
      expect(changedRoute).toContain('model model-b')
      expect(changedRoute).toContain('thinking high')

      unregisterAgent()
      const switchedSession = telemetrySession(
        'hud-loopback-beta',
        resolve(workspaceRoot, 'firmware', 'beta'),
      )
      appendRoute(switchedSession, 'model-c', 'medium', 'initial')
      unregisterAgent = context.agents.register(
        registeredAgent(context, switchedSession, 'model-c'),
      )
      monotonicNow += 1_000

      const switched = JSON.parse(await runCli(['--json'], environment)) as HudSnapshotResponse
      expect(switched.snapshot).toMatchObject({
        workspace: { name: 'firmware/beta' },
        model: { name: 'model-c', thinkingDepth: 'medium' },
      })
    } finally {
      unregisterAgent()
      api.dispose()
      telemetry.dispose()
      await new Promise<void>((resolve, reject): void => {
        server.close((error): void => (error === undefined ? resolve() : reject(error)))
      })
      await agentsFiber.dispose()
    }
  })

  it('uses one registered SSE event id for fan-out and performs bounded replay', (): void => {
    const stream = new HudEventStream()
    const firstRequest = request('/luban-hud/events')
    const secondRequest = request('/luban-hud/events')
    const first = new MockResponse()
    const second = new MockResponse()
    stream.connect(
      OWNER_ACCOUNT,
      firstRequest,
      first as unknown as ServerResponse,
      streamEnvelope(0),
    )
    const bobRequest = request('/luban-hud/events')
    const bob = new MockResponse()
    stream.connect(
      BOB_ACCOUNT,
      bobRequest,
      bob as unknown as ServerResponse,
      streamEnvelope(0, BOB_ACCOUNT),
    )
    stream.connect(
      OWNER_ACCOUNT,
      secondRequest,
      second as unknown as ServerResponse,
      streamEnvelope(0),
    )
    expect(first.body).toContain(`id: 0\nevent: ${HUD_TELEMETRY_EVENT}\n`)
    expect(second.body).toContain(`id: 0\nevent: ${HUD_TELEMETRY_EVENT}\n`)

    first.body = ''
    second.body = ''
    bob.body = ''
    stream.publish(OWNER_ACCOUNT, streamEnvelope(1))
    expect(first.body).toContain(`id: 1\nevent: ${HUD_TELEMETRY_EVENT}\n`)
    expect(second.body).toContain(`id: 1\nevent: ${HUD_TELEMETRY_EVENT}\n`)
    expect(bob.body).toBe('')
    stream.publish(BOB_ACCOUNT, streamEnvelope(1, BOB_ACCOUNT))
    expect(bob.body).toContain(`id: 1\nevent: ${HUD_TELEMETRY_EVENT}\n`)
    expect(first.body).not.toContain('"accountId":"bob"')
    stream.publish(OWNER_ACCOUNT, streamEnvelope(2))

    const replay = new MockResponse()
    stream.connect(
      OWNER_ACCOUNT,
      request('/luban-hud/events', undefined, { 'last-event-id': '1' }),
      replay as unknown as ServerResponse,
      streamEnvelope(2),
    )
    expect(replay.body).toContain(`id: 2\nevent: ${HUD_TELEMETRY_EVENT}\n`)
    expect(replay.body).not.toContain('id: 1\n')

    firstRequest.emit('close')
    secondRequest.emit('close')
    bobRequest.emit('close')
    for (let at = 3; at <= 259; at += 1) {
      stream.publish(OWNER_ACCOUNT, streamEnvelope(at))
    }
    const gap = new MockResponse()
    stream.connect(
      OWNER_ACCOUNT,
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
        OWNER_ACCOUNT,
        request('/luban-hud/events'),
        new MockResponse() as unknown as ServerResponse,
        streamEnvelope(999),
      ),
    ).toThrow('disposed')
  })

  it('pushes redacted M03 health changes through the existing compatible SSE envelope', async (): Promise<void> => {
    const telemetry = new DefaultTelemetryAggregator({ refreshMs: 1_000, providerTimeoutMs: 100 })
    const keepalive = new HudKeepaliveHealthStore()
    const api = new HudHttpApi({ telemetry, auth: auth(), config: publicConfig, keepalive })
    const streamRequest = request('/luban-hud/events', 'luban_session=ok')
    const response = new MockResponse()
    await api.handler(streamRequest, response as unknown as ServerResponse)
    expect(response.body).toContain('"keepalive":{"healthy":true,"alerts":[]}')

    keepalive.recordForAccount(OWNER_ACCOUNT, {
      sessionId: 'luban-worker',
      alive: false,
      detail: 'lost token=not-public',
    })
    await vi.waitFor((): void => expect(response.body).toContain('"keepalive":{"healthy":false'))
    expect(response.body).toContain('lost token=[REDACTED]')
    expect(response.body).not.toContain('not-public')
    streamRequest.emit('close')
    api.dispose()
    keepalive.dispose()
  })

  it('fails closed when plugin disposal races with asynchronous authentication', async (): Promise<void> => {
    let finishAuthentication:
      | ((decision: {
          allowed: true
          status: 200
          user: string
          account: { accountId: AccountId; username: string; role: 'operator' }
        }) => void)
      | undefined
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
    finishAuthentication({
      allowed: true,
      status: 200,
      user: 'owner',
      account: { accountId: OWNER_ACCOUNT, username: 'owner', role: 'operator' },
    })
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

  it('keeps old envelopes compatible and renders unhealthy M03 metadata visibly', (): void => {
    expect(keepaliveIndicator(undefined)).toBeNull()
    expect(keepaliveIndicator({ healthy: true, alerts: [] })).toBeNull()
    expect(
      keepaliveIndicator({
        healthy: false,
        alerts: [{ sessionId: 'luban-a', detail: 'offline' }, { sessionId: 'luban-b' }],
      }),
    ).toEqual({
      count: 2,
      label: 'keepalive 2 down',
      title: 'luban-a: offline; luban-b',
    })
  })
})
