import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@luban/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HotplugWatcher } from '../src/hotplug.js'
import { OptionalSerialPortProvider, SerialChannelAdapter } from '../src/serial.js'
import { DefaultWinDebugService } from '../src/service.js'
import type { SessionInjection } from '../src/types.js'
import { FakeCommandRunner, FakeSerialProvider, flush, testConfig } from './helpers.js'

const directories: string[] = []
const disposers: (() => Promise<void>)[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(disposers.splice(0).map(async (dispose): Promise<void> => dispose()))
  await Promise.all(
    directories
      .splice(0)
      .map(async (path): Promise<void> => rm(path, { recursive: true, force: true })),
  )
})

async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'luban-win-debug-serial-'))
  directories.push(path)
  return path
}

describe('serial adapter and hot-plug polling', (): void => {
  it('enumerates, opens with baud configuration, streams data and refuses stale ports', async (): Promise<void> => {
    const provider = new FakeSerialProvider()
    const adapter = new SerialChannelAdapter(provider, 115200)
    const endpoint = (await adapter.list())[0]
    expect(endpoint).toMatchObject({ kind: 'serial', id: 'serial:COM3' })
    if (endpoint === undefined) throw new Error('missing fake endpoint')

    const handle = await adapter.open(endpoint, { baudRate: 230400 })
    expect(provider.opens).toEqual([{ path: 'COM3', baudRate: 230400 }])
    provider.connections[0]?.emit('hello\n')
    const iterator = handle.readEvents()[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'status', status: 'open' },
    })
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'data' } })
    await handle.write('reset\r\n')
    expect(new TextDecoder().decode(provider.connections[0]?.writes[0])).toBe('reset\r\n')
    await handle.close()

    provider.ports = []
    await expect(adapter.open(endpoint, {})).rejects.toThrow('no longer available')
  })

  it('reports deterministic added and removed endpoint deltas', async (): Promise<void> => {
    const provider = new FakeSerialProvider()
    const watcher = new HotplugWatcher(new SerialChannelAdapter(provider), 1000)
    const changes: unknown[] = []
    watcher.subscribe((change): void => {
      changes.push(change)
    })

    await watcher.poll()
    provider.ports = [{ path: 'COM4' }]
    await watcher.poll()

    expect(changes).toHaveLength(2)
    expect(changes[1]).toMatchObject({
      kind: 'serial',
      added: [{ id: 'serial:COM4' }],
      removed: [{ id: 'serial:COM3' }],
    })
  })

  it('keeps the optional native module lazy and explains an unavailable binding', async (): Promise<void> => {
    const loader = vi.fn(() => Promise.reject(new Error('module not installed')))
    const provider = new OptionalSerialPortProvider(loader)

    await expect(provider.list()).rejects.toThrow('install the optional serialport package')
    expect(loader).toHaveBeenCalledWith('serialport')
  })
})

describe('serial monitor, filter, capture and session injection', (): void => {
  it('redacts a selected bounded range and injects its file plus excerpt', async (): Promise<void> => {
    const root = await temporary()
    const serialProvider = new FakeSerialProvider()
    const serial = new SerialChannelAdapter(serialProvider)
    const injected: {
      readonly sessionId: string
      readonly content: string
      readonly path: string
    }[] = []
    const injection: SessionInjection = {
      inject(sessionId, snippet): Promise<void> {
        injected.push({ sessionId, content: snippet.content, path: snippet.path })
        return Promise.resolve()
      },
    }
    const commands = new FakeCommandRunner()
    const service = new DefaultWinDebugService(testConfig(root), {
      commands,
      adapters: [serial],
      sessionInjection: injection,
    })
    disposers.push(async (): Promise<void> => service.dispose())

    const channel = await service.open('serial:COM3')
    serialProvider.connections[0]?.emit('boot ok\ntoken=super-secret-value\nfatal error\n')
    await flush()
    const lines = service.lines(channel.id)
    expect(lines.map((line): string => line.text)).toEqual([
      'boot ok',
      'token=super-secret-value',
      'fatal error',
    ])
    expect(service.lines(channel.id, { query: 'FATAL' })).toHaveLength(1)
    expect(service.lines(channel.id, { query: '^boot', regex: true })).toHaveLength(1)
    const from = lines[0]?.sequence
    const to = lines.at(-1)?.sequence
    if (from === undefined || to === undefined) throw new Error('missing monitored lines')

    const snippet = await service.captureAndInject(
      channel.id,
      { from, to },
      asSessionId('session-debug'),
    )

    expect(snippet.content).toContain('token=[REDACTED]')
    expect(snippet.content).not.toContain('super-secret-value')
    expect(await readFile(snippet.path, 'utf8')).toContain('fatal error')
    expect(injected).toEqual([
      { sessionId: 'session-debug', content: snippet.content, path: snippet.path },
    ])

    const template = await service.runTemplateArtifact(
      'fastboot-reboot',
      { device: 'ABC123' },
      undefined,
      asSessionId('session-debug'),
    )
    expect(commands.calls.at(-1)).toMatchObject({
      command: 'fastboot.exe',
      args: ['-s', 'ABC123', 'reboot'],
    })
    expect(template.snippet.content).toContain('template=fastboot-reboot')
    expect(template.injected).toBe(true)
    expect(injected).toHaveLength(2)
  })

  it('bounds regex complexity and buffered line count', async (): Promise<void> => {
    const root = await temporary()
    const provider = new FakeSerialProvider()
    const config = testConfig(root, {
      snippet: { dir: join(root, 'snippets'), maxLines: 2, maxBytes: 64 * 1024 },
    })
    const service = new DefaultWinDebugService(config, {
      adapters: [new SerialChannelAdapter(provider)],
      commands: new FakeCommandRunner(),
    })
    disposers.push(async (): Promise<void> => service.dispose())
    const channel = await service.open('serial:COM3')
    provider.connections[0]?.emit('one\ntwo\nthree\n')
    await flush()

    expect(service.lines(channel.id).map((line): string => line.text)).toEqual(['two', 'three'])
    expect(() => service.lines(channel.id, { query: '(a+)+', regex: true })).toThrow('too complex')
  })
})
