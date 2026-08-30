import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthService } from 'dsh-luban-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyClient, WinDebugSection } from '../src/client/index.js'
import { WinDebugHttpApi } from '../src/http-api.js'
import { SerialChannelAdapter } from '../src/serial.js'
import { DefaultWinDebugService } from '../src/service.js'
import { FakeCommandRunner, FakeSerialProvider, flush, testConfig } from './helpers.js'

const directories: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(closers.splice(0).map(async (close): Promise<void> => close()))
  await Promise.all(
    directories
      .splice(0)
      .map(async (path): Promise<void> => rm(path, { recursive: true, force: true })),
  )
})

function auth(allowed: boolean): AuthService {
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
    middleware: () => () =>
      Promise.resolve(
        allowed ? { allowed: true, status: 200, user: 'user' } : { allowed: false, status: 401 },
      ),
    onChange: vi.fn(() => (): void => undefined),
  }
}

async function fixture(allowed = true): Promise<{
  readonly url: string
  readonly service: DefaultWinDebugService
  readonly serial: FakeSerialProvider
  readonly commands: FakeCommandRunner
  readonly root: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'luban-win-debug-http-'))
  directories.push(root)
  const serial = new FakeSerialProvider()
  const commands = new FakeCommandRunner()
  const service = new DefaultWinDebugService(testConfig(root), {
    commands,
    adapters: [new SerialChannelAdapter(serial)],
  })
  const api = new WinDebugHttpApi(service, auth(allowed))
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
  return { url: `http://127.0.0.1:${String(port)}`, service, serial, commands, root }
}

describe('authenticated Windows debug API', (): void => {
  it('rejects unauthenticated endpoint discovery', async (): Promise<void> => {
    const { url } = await fixture(false)
    const response = await fetch(`${url}/luban-win-debug/endpoints`)
    expect(response.status).toBe(401)
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
  it('registers one lazy settings section without channel-kind-specific slots', (): void => {
    let registered: Readonly<Record<string, unknown>> | undefined
    let component: unknown
    const context = {
      slots: {
        inject(_name: string, factory: () => void): void {
          factory()
        },
        register(options: Readonly<Record<string, unknown>>, value: unknown): () => void {
          registered = options
          component = value
          return (): void => undefined
        },
      },
    }

    applyClient(context as unknown as Context)

    expect(registered).toMatchObject({
      name: 'settings.section',
      id: 'luban-win-debug',
      label: 'Windows Debug',
    })
    expect(component).toBe(WinDebugSection)
  })
})
