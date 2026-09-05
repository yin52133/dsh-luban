import { mkdtemp, rm } from 'node:fs/promises'
import type * as WorkbenchClient from '@yin52133/dsh-luban-core/client'
import { registerWorkbenchPage } from '@yin52133/dsh-luban-core/client'
vi.mock('@yin52133/dsh-luban-core/client', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkbenchClient>()),
  registerWorkbenchPage: vi.fn(),
}))
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AccountId, AuthService, SessionId } from '@yin52133/dsh-luban-core'
import { asAccountId, asSessionId, LubanError } from '@yin52133/dsh-luban-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyClient, WinDebugSection } from '../src/client/index.js'
import { eventVisibleToAccount, WinDebugHttpApi } from '../src/http-api.js'
import { SerialChannelAdapter } from '../src/serial.js'
import { DefaultWinDebugService } from '../src/service.js'
import type { SessionInjection, WinDebugEvent } from '../src/types.js'
import {
  FakeCommandRunner,
  FakeDesktopMcpClient,
  FakeManagedProcessRunner,
  FakeSerialProvider,
  flush,
  memoryAccountSessions,
  testConfig,
} from './helpers.js'

const ALICE = asAccountId('alice')
const BOB = asAccountId('bob')

const directories: string[] = []
const closers: (() => Promise<void>)[] = []

interface SseFrame {
  readonly id: number
  readonly data: WinDebugEvent
}

class SseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  readonly #decoder = new TextDecoder()
  #buffer = ''

  public constructor(response: Response) {
    if (response.body === null) throw new Error('SSE response has no body')
    this.#reader = response.body.getReader()
  }

  public async next(type: WinDebugEvent['type']): Promise<SseFrame> {
    for (;;) {
      const boundary = this.#buffer.indexOf('\n\n')
      if (boundary >= 0) {
        const raw = this.#buffer.slice(0, boundary)
        this.#buffer = this.#buffer.slice(boundary + 2)
        const id = /^id: (\d+)$/mu.exec(raw)?.[1]
        const data = /^data: (.+)$/mu.exec(raw)?.[1]
        if (id !== undefined && data !== undefined) {
          const frame: SseFrame = {
            id: Number(id),
            data: JSON.parse(data) as WinDebugEvent,
          }
          if (frame.data.type === type) return frame
        }
        continue
      }
      const chunk = await this.#reader.read()
      if (chunk.done) throw new Error(`SSE stream closed before ${type}`)
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true })
    }
  }

  public async cancel(): Promise<void> {
    await this.#reader.cancel()
  }
}

afterEach(async (): Promise<void> => {
  await Promise.all(closers.splice(0).map(async (close): Promise<void> => close()))
  await Promise.all(
    directories
      .splice(0)
      .map(async (path): Promise<void> => rm(path, { recursive: true, force: true })),
  )
})

function auth(allowed: boolean, includeAccount = true): AuthService {
  const accountSessions = memoryAccountSessions()
  return {
    verify: vi.fn(() => Promise.resolve({ ok: true })),
    issueSession: vi.fn(() =>
      Promise.resolve({
        id: 'session',
        user: 'user',
        issuedAt: 1,
        expiresAt: 2,
        sourceIp: '127.0.0.1',
      }),
    ),
    revoke: vi.fn(() => Promise.resolve()),
    revokeAllFor: vi.fn(() => Promise.resolve()),
    middleware: () => (request) => {
      if (!allowed) return Promise.resolve({ allowed: false, status: 401 })
      const accountId = request.cookie?.includes('account=bob') === true ? BOB : ALICE
      const username = accountId === BOB ? 'bob' : 'alice'
      if (!includeAccount) return Promise.resolve({ allowed: true, status: 200, user: username })
      return Promise.resolve({
        allowed: true,
        status: 200,
        user: username,
        account: { accountId, username, role: 'admin' },
      })
    },
    onChange: vi.fn(() => (): void => undefined),
    accountSessions,
  }
}

function requestHeaders(accountId: AccountId, json = false): Readonly<Record<string, string>> {
  return {
    cookie: `account=${accountId}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  }
}

async function fixture(
  allowed = true,
  includeAccount = true,
  desktopMcpEnabled = false,
): Promise<{
  readonly url: string
  readonly service: DefaultWinDebugService
  readonly serial: FakeSerialProvider
  readonly commands: FakeCommandRunner
  readonly desktopMcp: FakeDesktopMcpClient
  readonly auth: AuthService
  readonly injected: SessionId[]
  readonly root: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'luban-win-debug-http-'))
  directories.push(root)
  const serial = new FakeSerialProvider()
  const commands = new FakeCommandRunner()
  const desktopMcp = new FakeDesktopMcpClient()
  const authService = auth(allowed, includeAccount)
  const injected: SessionId[] = []
  const sessionInjection: SessionInjection = {
    inject(sessionId): Promise<void> {
      injected.push(asSessionId(sessionId))
      return Promise.resolve()
    },
  }
  const config = testConfig(
    root,
    desktopMcpEnabled
      ? {
          desktopMcp: Object.freeze({
            enabled: true,
            command: join(root, 'windows-mcp.exe'),
            args: Object.freeze(['--stdio']),
            tools: Object.freeze(['desktop.capture']),
          }),
        }
      : {},
  )
  const service = new DefaultWinDebugService(config, {
    commands,
    processes: new FakeManagedProcessRunner(),
    adapters: [new SerialChannelAdapter(serial)],
    sessionInjection,
    accountSessions: authService.accountSessions,
    desktopMcp,
  })
  const api = new WinDebugHttpApi(service, authService)
  const server = createServer((request, response): void => {
    void api.handler(request, response)
  })
  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  closers.push(async (): Promise<void> => {
    api.dispose()
    await service.dispose()
    await new Promise<void>((resolve, reject): void => {
      server.close((error): void => (error === undefined ? resolve() : reject(error)))
    })
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(port)}`,
    service,
    serial,
    commands,
    desktopMcp,
    auth: authService,
    injected,
    root,
  }
}

describe('authenticated Windows debug API', (): void => {
  it('rejects unauthenticated endpoint discovery', async (): Promise<void> => {
    const { url } = await fixture(false)
    const response = await fetch(`${url}/luban-win-debug/endpoints`)
    expect(response.status).toBe(401)
  })

  it('fails closed when a legacy authentication decision has no account context', async (): Promise<void> => {
    const { url } = await fixture(true, false)
    const response = await fetch(`${url}/luban-win-debug/endpoints`)
    expect(response.status).toBe(401)
  })

  it('scopes desktop MCP status and lifecycle control to its account owner', async (): Promise<void> => {
    const { url, desktopMcp } = await fixture(true, true, true)
    const startUrl = `${url}/luban-win-debug/desktop-mcp/start`
    const stopUrl = `${url}/luban-win-debug/desktop-mcp/stop`
    const statusUrl = `${url}/luban-win-debug/desktop-mcp`

    const aliceStart = await fetch(startUrl, {
      method: 'POST',
      headers: requestHeaders(ALICE),
    })
    expect(aliceStart.status).toBe(202)
    desktopMcp.recentOutput = [{ type: 'stderr', text: 'alice-output', at: 1 }]

    const aliceStatus = await fetch(statusUrl, { headers: requestHeaders(ALICE) }).then(
      async (response) =>
        response.json() as Promise<{
          readonly status: Readonly<Record<string, unknown>>
        }>,
    )
    expect(aliceStatus.status).toMatchObject({
      state: 'running',
      recentOutput: [{ text: 'alice-output' }],
    })
    const bobStatus = await fetch(statusUrl, { headers: requestHeaders(BOB) }).then(
      async (response) =>
        response.json() as Promise<{
          readonly status: Readonly<Record<string, unknown>>
        }>,
    )
    expect(bobStatus.status).toMatchObject({ state: 'running' })
    expect(bobStatus.status).not.toHaveProperty('recentOutput')
    const bobRootStatus = await fetch(`${url}/luban-win-debug/status`, {
      headers: requestHeaders(BOB),
    }).then(
      async (response) =>
        response.json() as Promise<{
          readonly desktopMcp: Readonly<Record<string, unknown>>
        }>,
    )
    expect(bobRootStatus.desktopMcp).not.toHaveProperty('recentOutput')

    for (const endpoint of [startUrl, stopUrl]) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: requestHeaders(BOB),
      })
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'E_ACCOUNT_SCOPE_MISMATCH' },
      })
    }

    expect(
      (
        await fetch(stopUrl, {
          method: 'POST',
          headers: requestHeaders(ALICE),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(startUrl, {
          method: 'POST',
          headers: requestHeaders(BOB),
        })
      ).status,
    ).toBe(202)
    desktopMcp.recentOutput = [{ type: 'stderr', text: 'bob-output', at: 2 }]
    const aliceAfterHandoff = await fetch(statusUrl, { headers: requestHeaders(ALICE) }).then(
      async (response) =>
        response.json() as Promise<{
          readonly status: Readonly<Record<string, unknown>>
        }>,
    )
    expect(aliceAfterHandoff.status).not.toHaveProperty('recentOutput')
  })

  it('returns concrete desktop MCP lifecycle failures and keeps ownership consistent', async (): Promise<void> => {
    const { url, desktopMcp } = await fixture(true, true, true)
    const startUrl = `${url}/luban-win-debug/desktop-mcp/start`
    const stopUrl = `${url}/luban-win-debug/desktop-mcp/stop`
    vi.spyOn(desktopMcp, 'connect').mockRejectedValueOnce(
      new LubanError('E_UNAVAILABLE', 'concrete startup failure', { retriable: true }),
    )

    const failedStart = await fetch(startUrl, {
      method: 'POST',
      headers: requestHeaders(ALICE),
    })
    expect(failedStart.status).toBe(503)
    await expect(failedStart.json()).resolves.toMatchObject({
      error: {
        code: 'E_UNAVAILABLE',
        message: 'concrete startup failure',
        retriable: true,
      },
    })
    expect(
      (
        await fetch(startUrl, {
          method: 'POST',
          headers: requestHeaders(BOB),
        })
      ).status,
    ).toBe(202)

    vi.spyOn(desktopMcp, 'stop').mockRejectedValueOnce(
      new LubanError('E_TIMEOUT', 'concrete stop failure', { retriable: true }),
    )
    const failedStop = await fetch(stopUrl, {
      method: 'POST',
      headers: requestHeaders(BOB),
    })
    expect(failedStop.status).toBe(504)
    await expect(failedStop.json()).resolves.toMatchObject({
      error: {
        code: 'E_TIMEOUT',
        message: 'concrete stop failure',
        retriable: true,
      },
    })
    const aliceStart = await fetch(startUrl, {
      method: 'POST',
      headers: requestHeaders(ALICE),
    })
    expect(aliceStart.status).toBe(403)
    await expect(aliceStart.json()).resolves.toMatchObject({
      error: { code: 'E_ACCOUNT_SCOPE_MISMATCH' },
    })
    expect(
      (
        await fetch(stopUrl, {
          method: 'POST',
          headers: requestHeaders(BOB),
        })
      ).status,
    ).toBe(200)
  })

  it('opens one channel and captures a monitored selection through bounded JSON routes', async (): Promise<void> => {
    const { url, serial } = await fixture()
    const endpoints = await fetch(`${url}/luban-win-debug/endpoints`).then(
      async (response) =>
        response.json() as Promise<{ readonly endpoints: readonly { readonly id: string }[] }>,
    )
    expect(endpoints.endpoints).toEqual([expect.objectContaining({ id: 'serial:COM3' })])
    const openedResponse = await fetch(`${url}/luban-win-debug/channels/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpointId: 'serial:COM3', baudRate: 115200 }),
    })
    expect(openedResponse.status).toBe(201)
    const opened = (await openedResponse.json()) as { readonly channel: { readonly id: string } }
    serial.connections[0]?.emit('line one\nline two\n')
    await flush()
    const logs = await fetch(
      `${url}/luban-win-debug/channels/${encodeURIComponent(opened.channel.id)}/logs?q=two`,
    ).then(
      async (response) =>
        response.json() as Promise<{ readonly lines: readonly { readonly sequence: number }[] }>,
    )
    expect(logs.lines).toHaveLength(1)
    const sequence = logs.lines[0]?.sequence
    if (sequence === undefined) throw new Error('missing line sequence')
    const capture = await fetch(
      `${url}/luban-win-debug/channels/${encodeURIComponent(opened.channel.id)}/capture`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: sequence, to: sequence }),
      },
    )
    expect(capture.status).toBe(201)
    const captureText = await capture.text()
    expect(captureText).toContain('"injected":false')
    expect(captureText).toContain('line two')
  })

  it('keeps Alice channels, logs, events and mutations hidden from Bob', async (): Promise<void> => {
    const { url, service, serial } = await fixture()
    const events: WinDebugEvent[] = []
    const unsubscribe = service.subscribe((event): void => {
      events.push(event)
    })
    closers.push((): Promise<void> => {
      unsubscribe()
      return Promise.resolve()
    })

    const openedResponse = await fetch(`${url}/luban-win-debug/channels/open`, {
      method: 'POST',
      headers: requestHeaders(ALICE, true),
      body: JSON.stringify({ endpointId: 'serial:COM3' }),
    })
    expect(openedResponse.status).toBe(201)
    const opened = (await openedResponse.json()) as {
      readonly channel: { readonly accountId: AccountId; readonly id: string }
    }
    expect(opened.channel.accountId).toBe(ALICE)

    const bobChannels = await fetch(`${url}/luban-win-debug/channels`, {
      headers: requestHeaders(BOB),
    })
    await expect(bobChannels.json()).resolves.toEqual({ channels: [] })
    const bobStatus = await fetch(`${url}/luban-win-debug/status`, {
      headers: requestHeaders(BOB),
    }).then(async (response) => response.json() as Promise<{ readonly active: readonly unknown[] }>)
    expect(bobStatus.active).toEqual([])

    serial.connections[0]?.emit('alice-only line\n')
    await flush()
    const aliceLogs = await fetch(
      `${url}/luban-win-debug/channels/${encodeURIComponent(opened.channel.id)}/logs`,
      { headers: requestHeaders(ALICE) },
    ).then(
      async (response) =>
        response.json() as Promise<{
          readonly lines: readonly { readonly accountId: AccountId; readonly sequence: number }[]
        }>,
    )
    expect(aliceLogs.lines).toHaveLength(1)
    expect(aliceLogs.lines[0]?.accountId).toBe(ALICE)
    const lineEvent = events.find((event): boolean => event.type === 'line')
    if (lineEvent === undefined) throw new Error('missing account-scoped line event')
    expect(eventVisibleToAccount(lineEvent, ALICE)).toBe(true)
    expect(eventVisibleToAccount(lineEvent, BOB)).toBe(false)

    const channelPath = `${url}/luban-win-debug/channels/${encodeURIComponent(opened.channel.id)}`
    const bobRequests: readonly (readonly [string, RequestInit])[] = [
      [`${channelPath}/logs`, { headers: requestHeaders(BOB) }],
      [
        `${channelPath}/write`,
        {
          method: 'POST',
          headers: requestHeaders(BOB, true),
          body: JSON.stringify({ data: 'reset' }),
        },
      ],
      [
        `${channelPath}/exec`,
        {
          method: 'POST',
          headers: requestHeaders(BOB, true),
          body: JSON.stringify({ command: 'reset' }),
        },
      ],
      [
        `${channelPath}/capture`,
        {
          method: 'POST',
          headers: requestHeaders(BOB, true),
          body: JSON.stringify({
            from: aliceLogs.lines[0]?.sequence,
            to: aliceLogs.lines[0]?.sequence,
          }),
        },
      ],
      [`${channelPath}/close`, { method: 'POST', headers: requestHeaders(BOB) }],
    ]
    for (const [requestUrl, init] of bobRequests) {
      expect((await fetch(requestUrl, init)).status).toBe(404)
    }

    const stillOwned = await fetch(`${url}/luban-win-debug/channels`, {
      headers: requestHeaders(ALICE),
    }).then(
      async (response) => response.json() as Promise<{ readonly channels: readonly unknown[] }>,
    )
    expect(stillOwned.channels).toHaveLength(1)
    const aliceCapture = await fetch(`${channelPath}/capture`, {
      method: 'POST',
      headers: requestHeaders(ALICE, true),
      body: JSON.stringify({
        from: aliceLogs.lines[0]?.sequence,
        to: aliceLogs.lines[0]?.sequence,
      }),
    }).then(
      async (response) =>
        response.json() as Promise<{
          readonly snippet: { readonly accountId: AccountId; readonly path: string }
        }>,
    )
    expect(aliceCapture.snippet.accountId).toBe(ALICE)
    expect(
      (
        await fetch(`${channelPath}/close`, {
          method: 'POST',
          headers: requestHeaders(ALICE),
        })
      ).status,
    ).toBe(200)

    const bobOpenResponse = await fetch(`${url}/luban-win-debug/channels/open`, {
      method: 'POST',
      headers: requestHeaders(BOB, true),
      body: JSON.stringify({ endpointId: 'serial:COM3' }),
    })
    const bobOpen = (await bobOpenResponse.json()) as {
      readonly channel: { readonly accountId: AccountId; readonly id: string }
    }
    expect(bobOpen.channel.accountId).toBe(BOB)
    serial.connections.at(-1)?.emit('bob-only line\n')
    await flush()
    const bobLogs = await fetch(
      `${url}/luban-win-debug/channels/${encodeURIComponent(bobOpen.channel.id)}/logs`,
      { headers: requestHeaders(BOB) },
    ).then(
      async (response) =>
        response.json() as Promise<{ readonly lines: readonly { readonly sequence: number }[] }>,
    )
    const bobSequence = bobLogs.lines[0]?.sequence
    if (bobSequence === undefined) throw new Error('missing Bob capture sequence')
    const bobCapture = await fetch(
      `${url}/luban-win-debug/channels/${encodeURIComponent(bobOpen.channel.id)}/capture`,
      {
        method: 'POST',
        headers: requestHeaders(BOB, true),
        body: JSON.stringify({ from: bobSequence, to: bobSequence }),
      },
    ).then(
      async (response) =>
        response.json() as Promise<{
          readonly snippet: { readonly accountId: AccountId; readonly path: string }
        }>,
    )
    expect(bobCapture.snippet.accountId).toBe(BOB)
    expect(dirname(bobCapture.snippet.path)).not.toBe(dirname(aliceCapture.snippet.path))
  })

  it('keeps live and replay SSE cursors independent per account and resyncs replay gaps', async (): Promise<void> => {
    const { url, serial } = await fixture()
    const aliceLive = new SseReader(
      await fetch(`${url}/luban-win-debug/events`, { headers: requestHeaders(ALICE) }),
    )
    const bobLive = new SseReader(
      await fetch(`${url}/luban-win-debug/events`, { headers: requestHeaders(BOB) }),
    )
    await aliceLive.next('resync')
    await bobLive.next('resync')

    const open = async (accountId: AccountId): Promise<string> => {
      const response = await fetch(`${url}/luban-win-debug/channels/open`, {
        method: 'POST',
        headers: requestHeaders(accountId, true),
        body: JSON.stringify({ endpointId: 'serial:COM3' }),
      })
      const body = (await response.json()) as { readonly channel: { readonly id: string } }
      return body.channel.id
    }
    const close = async (accountId: AccountId, channelId: string): Promise<void> => {
      const response = await fetch(
        `${url}/luban-win-debug/channels/${encodeURIComponent(channelId)}/close`,
        { method: 'POST', headers: requestHeaders(accountId) },
      )
      expect(response.status).toBe(200)
    }

    const aliceChannel = await open(ALICE)
    serial.connections.at(-1)?.emit('alice-live\n')
    expect((await aliceLive.next('line')).data).toMatchObject({
      line: { accountId: ALICE, text: 'alice-live' },
    })
    await close(ALICE, aliceChannel)

    const bobChannel = await open(BOB)
    serial.connections
      .at(-1)
      ?.emit(
        `${Array.from({ length: 520 }, (_value, index): string => `bob-${String(index)}`).join('\n')}\n`,
      )
    expect((await bobLive.next('line')).data).toMatchObject({
      line: { accountId: BOB, text: 'bob-0' },
    })
    await close(BOB, bobChannel)
    await Promise.all([aliceLive.cancel(), bobLive.cancel()])

    const aliceReplay = new SseReader(
      await fetch(`${url}/luban-win-debug/events`, {
        headers: { ...requestHeaders(ALICE), 'last-event-id': '0' },
      }),
    )
    expect((await aliceReplay.next('line')).data).toMatchObject({
      line: { accountId: ALICE, text: 'alice-live' },
    })
    await aliceReplay.cancel()

    const aliceOverflow = await open(ALICE)
    serial.connections
      .at(-1)
      ?.emit(
        `${Array.from({ length: 520 }, (_value, index): string => `alice-${String(index)}`).join('\n')}\n`,
      )
    await close(ALICE, aliceOverflow)
    const aliceGap = new SseReader(
      await fetch(`${url}/luban-win-debug/events`, {
        headers: { ...requestHeaders(ALICE), 'last-event-id': '0' },
      }),
    )
    expect((await aliceGap.next('resync')).data).toEqual({ type: 'resync', accountId: ALICE })
    await aliceGap.cancel()
  })

  it('allows all three injection routes only for a session owned by the caller', async (): Promise<void> => {
    const { url, auth: authService, injected, serial, root } = await fixture()
    const aliceSession = asSessionId('alice-session')
    const bobSession = asSessionId('bob-session')
    const unboundSession = asSessionId('unbound-session')
    await authService.accountSessions.bind(ALICE, aliceSession)
    await authService.accountSessions.bind(BOB, bobSession)

    const openedResponse = await fetch(`${url}/luban-win-debug/channels/open`, {
      method: 'POST',
      headers: requestHeaders(ALICE, true),
      body: JSON.stringify({ endpointId: 'serial:COM3' }),
    })
    const opened = (await openedResponse.json()) as { readonly channel: { readonly id: string } }
    serial.connections[0]?.emit('capture me\n')
    await flush()
    const logs = await fetch(
      `${url}/luban-win-debug/channels/${encodeURIComponent(opened.channel.id)}/logs`,
      { headers: requestHeaders(ALICE) },
    ).then(
      async (response) =>
        response.json() as Promise<{ readonly lines: readonly { readonly sequence: number }[] }>,
    )
    const sequence = logs.lines[0]?.sequence
    if (sequence === undefined) throw new Error('missing capture sequence')

    const captureUrl = `${url}/luban-win-debug/channels/${encodeURIComponent(opened.channel.id)}/capture`
    for (const sessionId of [bobSession, unboundSession]) {
      const response = await fetch(captureUrl, {
        method: 'POST',
        headers: requestHeaders(ALICE, true),
        body: JSON.stringify({ from: sequence, to: sequence, sessionId }),
      })
      expect(response.status).toBe(404)
    }
    expect(
      (
        await fetch(captureUrl, {
          method: 'POST',
          headers: requestHeaders(ALICE, true),
          body: JSON.stringify({ from: sequence, to: sequence, sessionId: aliceSession }),
        })
      ).status,
    ).toBe(201)

    const templateUrl = `${url}/luban-win-debug/templates/fastboot-reboot/run`
    for (const sessionId of [bobSession, unboundSession]) {
      const response = await fetch(templateUrl, {
        method: 'POST',
        headers: requestHeaders(ALICE, true),
        body: JSON.stringify({ params: { device: 'ABC123' }, sessionId }),
      })
      expect(response.status).toBe(404)
    }
    expect(
      (
        await fetch(templateUrl, {
          method: 'POST',
          headers: requestHeaders(ALICE, true),
          body: JSON.stringify({ params: { device: 'ABC123' }, sessionId: aliceSession }),
        })
      ).status,
    ).toBe(200)

    const gdbStart = await fetch(`${url}/luban-win-debug/gdb/start`, {
      method: 'POST',
      headers: requestHeaders(ALICE, true),
      body: JSON.stringify({
        interfaceConfig: join(root, 'interface.cfg'),
        targetConfig: join(root, 'target.cfg'),
      }),
    })
    expect(gdbStart.status).toBe(202)
    const aliceGdbStatus = await fetch(`${url}/luban-win-debug/gdb`, {
      headers: requestHeaders(ALICE),
    }).then(async (response) => response.json() as Promise<Readonly<Record<string, unknown>>>)
    expect(aliceGdbStatus).toMatchObject({ state: 'running', target: '127.0.0.1:3333' })
    expect(aliceGdbStatus).toHaveProperty('recentOutput')
    const bobGdbStatus = await fetch(`${url}/luban-win-debug/gdb`, {
      headers: requestHeaders(BOB),
    }).then(async (response) => response.json() as Promise<Readonly<Record<string, unknown>>>)
    expect(bobGdbStatus).toEqual({ state: 'running' })
    const bobSnapshot = await fetch(`${url}/luban-win-debug/gdb/snapshot`, {
      method: 'POST',
      headers: requestHeaders(BOB, true),
      body: JSON.stringify({ executable: join(root, 'firmware.elf') }),
    })
    expect(bobSnapshot.status).toBe(403)
    await expect(bobSnapshot.json()).resolves.toMatchObject({
      error: { code: 'E_ACCOUNT_SCOPE_MISMATCH' },
    })
    expect(
      (
        await fetch(`${url}/luban-win-debug/gdb/stop`, {
          method: 'POST',
          headers: requestHeaders(BOB),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(`${url}/luban-win-debug/gdb/start`, {
          method: 'POST',
          headers: requestHeaders(BOB, true),
          body: JSON.stringify({
            interfaceConfig: join(root, 'interface.cfg'),
            targetConfig: join(root, 'target.cfg'),
          }),
        })
      ).status,
    ).toBe(403)
    for (const sessionId of [bobSession, unboundSession]) {
      const response = await fetch(`${url}/luban-win-debug/gdb/snapshot`, {
        method: 'POST',
        headers: requestHeaders(ALICE, true),
        body: JSON.stringify({ executable: join(root, 'firmware.elf'), sessionId }),
      })
      expect(response.status).toBe(404)
    }
    expect(
      (
        await fetch(`${url}/luban-win-debug/gdb/snapshot`, {
          method: 'POST',
          headers: requestHeaders(ALICE, true),
          body: JSON.stringify({
            executable: join(root, 'firmware.elf'),
            sessionId: aliceSession,
          }),
        })
      ).status,
    ).toBe(201)
    expect(injected).toEqual([aliceSession, aliceSession, aliceSession])
    expect(
      (
        await fetch(`${url}/luban-win-debug/gdb/stop`, {
          method: 'POST',
          headers: requestHeaders(ALICE),
        })
      ).status,
    ).toBe(200)
  })

  it('runs only a registered template and returns structured error lines', async (): Promise<void> => {
    const { url, root, commands } = await fixture()
    commands.result = {
      exitCode: 1,
      stdout: '',
      stderr: 'fatal error: verify failed',
      durationMs: 5,
    }
    const response = await fetch(`${url}/luban-win-debug/templates/esptool-flash/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        params: {
          chip: 'esp32',
          port: 'COM3',
          baud: '115200',
          address: '0x1000',
          firmware: join(root, 'firmware.bin'),
        },
      }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      result: {
        outcome: 'failed',
        lines: [{ level: 'error', text: 'fatal error: verify failed' }],
      },
    })
    expect(commands.calls).toHaveLength(1)
    expect(commands.calls[0]?.command).toBe('esptool.exe')
  })
})

describe('DSH client entry', (): void => {
  it('registers a business page in the workbench', (): void => {
    const context = { effect: (execute: () => () => void): (() => void) => execute() }
    applyClient(context as unknown as Context)
    const registered = vi.mocked(registerWorkbenchPage).mock.calls.at(-1)?.[1]
    expect(registered).toMatchObject({ id: 'luban-win-debug', title: '设备调试' })
    expect(registered?.component).toBe(WinDebugSection)
  })
})
