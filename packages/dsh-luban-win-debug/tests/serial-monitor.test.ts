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

  it('classifies Windows exclusive-open failures with a stable occupancy hint', async (): Promise<void> => {
    class BusySerialPort {
      public static list(): Promise<readonly { readonly path: string }[]> {
        return Promise.resolve([{ path: 'COM7' }])
      }

      public open(callback: (error?: Error | null) => void): void {
        callback(Object.assign(new Error('Opening COM7: Access denied'), { code: 'EACCES' }))
      }
    }
    const provider = new OptionalSerialPortProvider(() =>
      Promise.resolve({ SerialPort: BusySerialPort }),
    )

    await expect(provider.open('COM7', 115200)).rejects.toMatchObject({
      code: 'E_CHANNEL_UNAVAILABLE',
      message:
        'Serial port COM7 is occupied; close the serial monitor, debugger, terminal, or service that owns it and retry',
      details: {
        reason: 'occupied',
        path: 'COM7',
        ownerHint: 'another serial monitor, debugger, terminal, or background service',
      },
    })

    const ConstructorBusySerialPort = Object.assign(
      function ConstructorBusySerialPort(): never {
        throw Object.assign(new Error('port is already open'), { code: 'EBUSY' })
      },
      {
        list: (): Promise<readonly { readonly path: string }[]> =>
          Promise.resolve([{ path: 'COM8' }]),
      },
    )
    const constructorBusy = new OptionalSerialPortProvider(() =>
      Promise.resolve({ SerialPort: ConstructorBusySerialPort }),
    )
    await expect(constructorBusy.open('COM8', 115200)).rejects.toMatchObject({
      code: 'E_CHANNEL_UNAVAILABLE',
      details: { reason: 'occupied', path: 'COM8' },
    })
  })

  it('cancels a hanging native serial open and closes a late success', async (): Promise<void> => {
    let completeOpen!: (error?: Error | null) => void
    let closeCalls = 0
    class HangingSerialPort {
      public static list(): Promise<readonly { readonly path: string }[]> {
        return Promise.resolve([{ path: 'COM9' }])
      }

      public open(callback: (error?: Error | null) => void): void {
        completeOpen = callback
      }

      public close(callback: (error?: Error | null) => void): void {
        closeCalls += 1
        callback()
      }
    }
    const provider = new OptionalSerialPortProvider(() =>
      Promise.resolve({ SerialPort: HangingSerialPort }),
    )
    const controller = new AbortController()
    const opening = provider.open('COM9', 115200, controller.signal)
    await flush()

    controller.abort()
    await expect(opening).rejects.toThrow('Serial open was cancelled')
    expect(closeCalls).toBe(1)
    completeOpen()
    expect(closeCalls).toBe(2)
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

  it('fails closed on open/flash occupancy and probes a released COM port before execution', async (): Promise<void> => {
    const root = await temporary()
    const provider = new FakeSerialProvider()
    const commands = new FakeCommandRunner()
    commands.responder = () => {
      expect(provider.connections.at(-1)?.closed).toBe(true)
      return commands.result
    }
    const service = new DefaultWinDebugService(testConfig(root), {
      serial: provider,
      commands,
    })
    disposers.push(async (): Promise<void> => service.dispose())
    const channel = await service.open('serial:COM3')

    await expect(service.open('serial:COM3')).rejects.toThrow(
      'COM3 · Fake Probe is already open in Luban',
    )
    await expect(
      service.runTemplateDetailed('esptool-flash', {
        chip: 'esp32',
        port: 'COM3',
        baud: '115200',
        address: '0x1000',
        firmware: join(root, 'firmware.bin'),
      }),
    ).rejects.toThrow(`serial port COM3 is occupied by Luban channel ${channel.id}`)
    expect(commands.calls).toHaveLength(0)

    await service.close(channel.id)
    await expect(
      service.runTemplateDetailed('esptool-flash', {
        chip: 'esp32',
        port: 'COM3',
        baud: '115200',
        address: '0x1000',
        firmware: join(root, 'firmware.bin'),
      }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    expect(provider.opens).toEqual([
      { path: 'COM3', baudRate: 115200 },
      { path: 'COM3', baudRate: 115200 },
    ])
    expect(commands.calls).toHaveLength(1)
  })

  it('blocks channel open while a flasher owns the device lease', async (): Promise<void> => {
    const root = await temporary()
    const provider = new FakeSerialProvider()
    const commands = new FakeCommandRunner()
    let finish!: (result: typeof commands.result) => void
    commands.responder = () =>
      new Promise<typeof commands.result>((resolve): void => {
        finish = resolve
      })
    const service = new DefaultWinDebugService(testConfig(root), {
      serial: provider,
      commands,
    })
    disposers.push(async (): Promise<void> => service.dispose())

    const running = service.runTemplateDetailed('esptool-flash', {
      chip: 'esp32',
      port: 'COM3',
      baud: '115200',
      address: '0x1000',
      firmware: join(root, 'firmware.bin'),
    })
    await flush()
    expect(commands.calls).toHaveLength(1)
    await expect(service.open('serial:COM3')).rejects.toThrow(
      'serial port COM3 is occupied by running template esptool-flash',
    )

    finish(commands.result)
    await running
    const channel = await service.open('serial:COM3')
    await service.close(channel.id)
  })

  it('holds the device lease while channel open is in flight', async (): Promise<void> => {
    const root = await temporary()
    const provider = new FakeSerialProvider()
    const commands = new FakeCommandRunner()
    let finishOpen!: () => void
    provider.openBarrier = new Promise<void>((resolve): void => {
      finishOpen = resolve
    })
    const service = new DefaultWinDebugService(testConfig(root), {
      serial: provider,
      commands,
    })
    disposers.push(async (): Promise<void> => service.dispose())

    const opening = service.open('serial:COM3')
    await flush()
    expect(provider.opens).toEqual([{ path: 'COM3', baudRate: 115200 }])
    await expect(
      service.runTemplateDetailed('esptool-flash', {
        chip: 'esp32',
        port: 'COM3',
        baud: '115200',
        address: '0x1000',
        firmware: join(root, 'firmware.bin'),
      }),
    ).rejects.toThrow('serial port COM3 is occupied by Luban channel serial:COM3')
    expect(commands.calls).toHaveLength(0)

    provider.openBarrier = undefined
    finishOpen()
    const channel = await opening
    await service.close(channel.id)
  })

  it('keeps the device occupied until channel close and event pumping finish', async (): Promise<void> => {
    const root = await temporary()
    const provider = new FakeSerialProvider()
    const commands = new FakeCommandRunner()
    const service = new DefaultWinDebugService(testConfig(root), {
      serial: provider,
      commands,
    })
    disposers.push(async (): Promise<void> => service.dispose())
    const channel = await service.open('serial:COM3')
    const connection = provider.connections[0]
    if (connection === undefined) throw new Error('missing fake serial connection')
    let finishClose!: () => void
    connection.closeBarrier = new Promise<void>((resolve): void => {
      finishClose = resolve
    })

    const closing = service.close(channel.id)
    const duplicateClosing = service.close(channel.id)
    await flush()
    expect(connection.closeCalls).toBe(1)
    await expect(
      service.runTemplateDetailed('esptool-flash', {
        chip: 'esp32',
        port: 'COM3',
        baud: '115200',
        address: '0x1000',
        firmware: join(root, 'firmware.bin'),
      }),
    ).rejects.toThrow(`serial port COM3 is occupied by Luban channel ${channel.id}`)
    expect(commands.calls).toHaveLength(0)

    finishClose()
    await Promise.all([closing, duplicateClosing])
    await expect(
      service.runTemplateDetailed('esptool-flash', {
        chip: 'esp32',
        port: 'COM3',
        baud: '115200',
        address: '0x1000',
        firmware: join(root, 'firmware.bin'),
      }),
    ).resolves.toMatchObject({ outcome: 'ok' })
  })

  it('bounds a hanging serial preflight close and releases the template lease', async (): Promise<void> => {
    const root = await temporary()
    const base = testConfig(root)
    const config = Object.freeze({
      ...base,
      execution: Object.freeze({ ...base.execution, startupTimeoutMs: 5 }),
    })
    const provider = new FakeSerialProvider()
    let finishClose!: () => void
    provider.connectionCloseBarrier = new Promise<void>((resolve): void => {
      finishClose = resolve
    })
    const commands = new FakeCommandRunner()
    const service = new DefaultWinDebugService(config, { serial: provider, commands })
    disposers.push(async (): Promise<void> => service.dispose())
    const params = {
      chip: 'esp32',
      port: 'COM3',
      baud: '115200',
      address: '0x1000',
      firmware: join(root, 'firmware.bin'),
    }

    await expect(service.runTemplateDetailed('esptool-flash', params)).rejects.toThrow(
      'Serial occupancy preflight timed out for COM3',
    )
    expect(commands.calls).toHaveLength(0)

    provider.connectionCloseBarrier = undefined
    finishClose()
    await flush()
    await expect(service.runTemplateDetailed('esptool-flash', params)).resolves.toMatchObject({
      outcome: 'ok',
    })
    expect(commands.calls).toHaveLength(1)
  })
})
