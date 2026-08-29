import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AndroidChannelAdapter,
  AndroidService,
  parseAdbDevices,
  parseFastbootDevices,
} from '../src/android.js'
import {
  createGdbChannel,
  createSshChannel,
  TcpChannelAdapter,
  type SocketConnection,
  type SocketConnector,
} from '../src/channels.js'
import { SerialChannelAdapter } from '../src/serial.js'
import type { Config } from '../src/config.js'
import {
  FakeCommandRunner,
  FakeSerialConnection,
  FakeSerialProvider,
  testConfig,
} from './helpers.js'

const directories: string[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (path): Promise<void> => rm(path, { recursive: true, force: true })),
  )
})

async function configured(): Promise<Config> {
  const root = await mkdtemp(join(tmpdir(), 'luban-win-debug-channel-'))
  directories.push(root)
  return testConfig(root, {
    remote: [
      {
        id: 'board',
        label: 'Lab Board',
        kind: 'ssh',
        host: 'board.local',
        port: 22,
        user: 'debug',
        allowedCommands: ['uname', 'journalctl'],
      },
      {
        id: 'console',
        label: 'Network UART',
        kind: 'tcp-serial',
        host: '192.0.2.10',
        port: 7001,
        allowedCommands: [],
      },
      {
        id: 'boot',
        label: 'Bootloader Telnet',
        kind: 'telnet',
        host: '192.0.2.11',
        port: 23,
        allowedCommands: [],
      },
    ],
  })
}

describe('adb and fastboot state adapters', (): void => {
  it('parses offline, unauthorized and bootloader devices distinctly', (): void => {
    expect(
      parseAdbDevices(
        'List of devices attached\nSERIAL1\tdevice product:p model:m\nSERIAL2\toffline\nSERIAL3\tunauthorized usb:1-2\n',
      ),
    ).toMatchObject([
      { id: 'SERIAL1', state: 'device', detail: { product: 'p', model: 'm' } },
      { id: 'SERIAL2', state: 'offline' },
      { id: 'SERIAL3', state: 'unauthorized' },
    ])
    expect(parseFastbootDevices('BOOT1\tfastboot\n')).toEqual([
      { transport: 'fastboot', id: 'BOOT1', state: 'bootloader', detail: {} },
    ])
  })

  it('lists both transports and executes only per-transport allowlisted commands', async (): Promise<void> => {
    const config = await configured()
    const runner = new FakeCommandRunner()
    runner.responder = (call) => ({
      exitCode: 0,
      stdout:
        call.command === 'adb.exe'
          ? call.args[0] === 'devices'
            ? 'List of devices attached\nA1\toffline\nA2\tunauthorized\n'
            : 'device\n'
          : 'F1\tfastboot\n',
      stderr: '',
      durationMs: 1,
    })
    const adb = new AndroidChannelAdapter('adb', runner, config)
    const fastboot = new AndroidChannelAdapter('fastboot', runner, config)
    const service = new AndroidService(adb, fastboot)

    await expect(service.devices()).resolves.toMatchObject([
      { transport: 'adb', id: 'A1', state: 'offline' },
      { transport: 'adb', id: 'A2', state: 'unauthorized' },
      { transport: 'fastboot', id: 'F1', state: 'bootloader' },
    ])
    const endpoint = (await adb.list())[0]
    if (endpoint === undefined) throw new Error('missing adb endpoint')
    const handle = await adb.open(endpoint, {})
    await expect(handle.exec?.('get-state')).resolves.toMatchObject({ exitCode: 0 })
    expect(runner.calls.at(-1)).toMatchObject({
      command: 'adb.exe',
      args: ['-s', 'A1', 'get-state'],
    })
    const commandSignal = runner.calls.at(-1)?.options.signal
    expect(commandSignal?.aborted).toBe(false)
    await expect(handle.exec?.('shell rm -rf /')).rejects.toThrow('not allowlisted')
    await handle.close()
    expect(commandSignal?.aborted).toBe(true)
  })
})

describe('remote and command ChannelAdapter implementations', (): void => {
  it('builds SSH and GDB argument arrays without a shell', async (): Promise<void> => {
    const config = await configured()
    const runner = new FakeCommandRunner()
    const ssh = createSshChannel(config, runner)
    const sshEndpoint = (await ssh.list())[0]
    if (sshEndpoint === undefined) throw new Error('missing ssh endpoint')
    const sshHandle = await ssh.open(sshEndpoint, {})

    await sshHandle.exec?.('uname -a')
    expect(runner.calls.at(-1)).toMatchObject({
      command: 'ssh.exe',
      args: [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-p',
        '22',
        'debug@board.local',
        '--',
        'uname',
        '-a',
      ],
    })
    await expect(sshHandle.exec?.('rm file')).rejects.toThrow('not allowlisted')
    await expect(sshHandle.exec?.('uname && whoami')).rejects.toThrow('Shell operators')
    const sshSignal = runner.calls.at(-1)?.options.signal
    expect(sshSignal?.aborted).toBe(false)
    await sshHandle.close()
    expect(sshSignal?.aborted).toBe(true)

    const gdb = createGdbChannel(config, runner)
    const gdbEndpoint = (await gdb.list())[0]
    if (gdbEndpoint === undefined) throw new Error('missing gdb endpoint')
    const gdbHandle = await gdb.open(gdbEndpoint, {})
    await gdbHandle.exec?.('info registers')
    expect(runner.calls.at(-1)).toMatchObject({
      command: 'arm-none-eabi-gdb.exe',
      args: [
        '--batch',
        '--nx',
        '--quiet',
        '-ex',
        'target extended-remote 127.0.0.1:3333',
        '-ex',
        'info registers',
      ],
    })
  })

  it('opens allowlisted TCP serial and telnet endpoints through the same contract', async (): Promise<void> => {
    const config = await configured()
    const connection = new FakeSerialConnection()
    const calls: { readonly host: string; readonly port: number; readonly timeoutMs: number }[] = []
    const connector: SocketConnector = {
      open(host, port, timeoutMs): Promise<SocketConnection> {
        calls.push({ host, port, timeoutMs })
        return Promise.resolve(connection)
      },
    }
    const tcp = new TcpChannelAdapter('tcp-serial', config.remote, connector)
    const telnet = new TcpChannelAdapter('telnet', config.remote, connector)
    const tcpEndpoint = (await tcp.list())[0]
    const telnetEndpoint = (await telnet.list())[0]
    if (tcpEndpoint === undefined || telnetEndpoint === undefined)
      throw new Error('missing network endpoint')

    const tcpHandle = await tcp.open(tcpEndpoint, { timeoutMs: 4321 })
    await tcpHandle.write('version\r\n')
    expect(calls[0]).toEqual({ host: '192.0.2.10', port: 7001, timeoutMs: 4321 })
    expect(new TextDecoder().decode(connection.writes[0])).toBe('version\r\n')
    await tcpHandle.close()
    await telnet.open(telnetEndpoint, {})
    expect(calls[1]).toMatchObject({ host: '192.0.2.11', port: 23 })
  })

  it('covers every M10 channel kind behind the core adapter surface', async (): Promise<void> => {
    const config = await configured()
    const runner = new FakeCommandRunner()
    const provider = new FakeSerialProvider()
    const connector: SocketConnector = {
      open: (): Promise<SocketConnection> => Promise.resolve(new FakeSerialConnection()),
    }
    const adapters = [
      new SerialChannelAdapter(provider),
      new AndroidChannelAdapter('adb', runner, config),
      new AndroidChannelAdapter('fastboot', runner, config),
      createGdbChannel(config, runner),
      createSshChannel(config, runner),
      new TcpChannelAdapter('telnet', config.remote, connector),
      new TcpChannelAdapter('tcp-serial', config.remote, connector),
    ]
    expect(adapters.map((adapter): string => adapter.kind)).toEqual([
      'serial',
      'adb',
      'fastboot',
      'gdb',
      'ssh',
      'telnet',
      'tcp-serial',
    ])
    expect(
      adapters.every(
        (adapter): boolean =>
          typeof adapter.list === 'function' && typeof adapter.open === 'function',
      ),
    ).toBe(true)
  })
})
