import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopMcpManager, type DesktopToolRegistry } from '../src/desktop-mcp.js'
import { DeviceExecutionGate } from '../src/device-gate.js'
import { GdbSessionManager } from '../src/gdb.js'
import { DefaultWinDebugService } from '../src/service.js'
import { SnippetStore } from '../src/snippet-store.js'
import { CommandTemplateRegistry, type TemplateExecutionPreflight } from '../src/templates.js'
import {
  FakeCommandRunner,
  FakeDesktopMcpClient,
  FakeManagedProcessRunner,
  flush,
  TEST_ACCOUNT,
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

async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'luban-win-debug-gdb-'))
  directories.push(path)
  return path
}

describe('GDB session manager', (): void => {
  it('owns bounded OpenOCD lifecycle and exports a structured batch snapshot', async (): Promise<void> => {
    const root = await temporary()
    const config = testConfig(root)
    const commands = new FakeCommandRunner()
    commands.result = {
      exitCode: 0,
      stdout: 'r0 0x00000001\n#0 main () at main.c:42\n',
      stderr: '',
      durationMs: 12,
    }
    const processes = new FakeManagedProcessRunner()
    const snippets = new SnippetStore(config.snippet)
    const manager = new GdbSessionManager({
      config,
      templates: new CommandTemplateRegistry(config, commands),
      commands,
      processes,
      snippets,
    })
    const interfaceConfig = join(root, 'interface.cfg')
    const targetConfig = join(root, 'target.cfg')
    const executable = join(root, 'firmware.elf')

    await manager.start(TEST_ACCOUNT, { interfaceConfig, targetConfig })
    expect(manager.status()).toMatchObject({ state: 'running', pid: 4242 })
    expect(processes.calls[0]).toMatchObject({
      command: 'openocd.exe',
      args: ['-f', interfaceConfig, '-f', targetConfig, '-c', 'gdb_port 3333'],
      options: {
        timeoutMs: 60_000,
        startupTimeoutMs: 1000,
        maxOutputBytes: 64 * 1024,
      },
    })

    const snapshot = await manager.snapshot(TEST_ACCOUNT, {
      executable,
      breakpoints: ['main', 'main.c:42'],
      variables: ['counter'],
      registers: true,
    })

    expect(commands.calls[0]?.command).toBe('arm-none-eabi-gdb.exe')
    expect(commands.calls[0]?.args).toEqual([
      '--batch',
      '--nx',
      '--quiet',
      executable,
      '-ex',
      'set pagination off',
      '-ex',
      'target extended-remote 127.0.0.1:3333',
      '-ex',
      'break main',
      '-ex',
      'break main.c:42',
      '-ex',
      'info breakpoints',
      '-ex',
      'print counter',
      '-ex',
      'info registers',
      '-ex',
      'backtrace',
      '-ex',
      'detach',
    ])
    expect(snapshot.snippet.content).toContain('r0 0x00000001')
    expect(snapshot.snippet.endpoint.kind).toBe('gdb')
    await expect(
      manager.snapshot(TEST_ACCOUNT, { executable, variables: ['dangerous()'] }),
    ).rejects.toThrow('Unsafe GDB expression')
    await manager.stop(TEST_ACCOUNT)
    expect(processes.processes[0]?.stop).toHaveBeenCalledOnce()
    expect(manager.status().state).toBe('stopped')
    expect(manager.statusFor(TEST_ACCOUNT)).toEqual({ state: 'stopped' })
  })

  it('bounds and sanitizes process output including event-stream failures', async (): Promise<void> => {
    const root = await temporary()
    const base = testConfig(root)
    const maxOutputBytes = 1024
    const config = Object.freeze({
      ...base,
      execution: Object.freeze({ ...base.execution, maxOutputBytes }),
    })
    const commands = new FakeCommandRunner()
    const processes = new FakeManagedProcessRunner()
    const manager = new GdbSessionManager({
      config,
      templates: new CommandTemplateRegistry(config, commands),
      commands,
      processes,
      snippets: new SnippetStore(config.snippet),
    })

    await manager.start(TEST_ACCOUNT, {
      interfaceConfig: join(root, 'interface.cfg'),
      targetConfig: join(root, 'target.cfg'),
    })
    const process = processes.processes[0]
    if (process === undefined) throw new Error('missing fake OpenOCD process')

    process.queue.push({ type: 'stdout', text: 'token=', at: 1 })
    process.queue.push({ type: 'stdout', text: '\u0001', at: 2 })
    process.queue.push({ type: 'stdout', text: 'event-secret\n', at: 3 })
    process.queue.push({ type: 'stderr', text: 'Bearer', at: 4 })
    process.queue.push({ type: 'stderr', text: '\u0007', at: 5 })
    process.queue.push({ type: 'stderr', text: 'event-auth\n', at: 6 })
    await flush()

    const crossChunkStatus = manager.status()
    const crossChunkText = crossChunkStatus.recentOutput
      .map((event): string => event.text ?? '')
      .join('')
    expect(crossChunkText).toContain('token=[REDACTED]')
    expect(crossChunkText).not.toContain('event-secret')
    expect(crossChunkText).not.toContain('event-auth')
    expect(crossChunkText).not.toContain('\u0001')
    expect(crossChunkText).not.toContain('\u0007')

    process.queue.push({ type: 'stdout', text: 'O'.repeat(700), at: 7 })
    process.queue.push({ type: 'stderr', text: 'E'.repeat(700), at: 8 })
    await flush()

    const aggregateStatus = manager.status()
    const aggregateText = aggregateStatus.recentOutput
      .map((event): string => event.text ?? '')
      .join('')
    expect(aggregateText).toContain('E'.repeat(50))
    expect(aggregateText).not.toContain('O'.repeat(50))
    expect(
      aggregateStatus.recentOutput.reduce(
        (bytes, event): number =>
          bytes + (event.text === undefined ? 0 : Buffer.byteLength(event.text, 'utf8')),
        0,
      ),
    ).toBeLessThanOrEqual(maxOutputBytes)

    for (let index = 0; index < 300; index += 1) {
      process.queue.push({ type: 'exit', exitCode: 0, at: index + 20 })
    }
    process.queue.end(new Error(`secret=\u0002catch-secret ${'界'.repeat(1000)}`))
    await flush()

    const status = manager.status()
    expect(status.state).toBe('stopped')
    expect(status.recentOutput).toHaveLength(256)
    const failureEvent = [...status.recentOutput]
      .reverse()
      .find((event): boolean => event.type === 'stderr')
    expect(failureEvent?.text).toContain('exceeded the safe display limit')
    const finalText = status.recentOutput.map((event): string => event.text ?? '').join('')
    expect(finalText).not.toContain('catch-secret')
    expect(finalText).not.toContain('\u0002')
    expect(
      status.recentOutput.reduce(
        (bytes, event): number =>
          bytes + (event.text === undefined ? 0 : Buffer.byteLength(event.text, 'utf8')),
        0,
      ),
    ).toBeLessThanOrEqual(maxOutputBytes)
    expect(
      status.recentOutput.every(
        (event): boolean =>
          event.text === undefined || Buffer.byteLength(event.text, 'utf8') <= maxOutputBytes,
      ),
    ).toBe(true)

    expect(
      status.recentOutput.every(
        (event): boolean =>
          event.text === undefined ||
          (!event.text.includes('\u0001') &&
            !event.text.includes('\u0002') &&
            !event.text.includes('\u0007')),
      ),
    ).toBe(true)

    await manager.stop(TEST_ACCOUNT)
  })

  it('rejects an OpenOCD config outside the configured root before starting', async (): Promise<void> => {
    const root = await temporary()
    const config = testConfig(root)
    const commands = new FakeCommandRunner()
    const processes = new FakeManagedProcessRunner()
    const manager = new GdbSessionManager({
      config,
      templates: new CommandTemplateRegistry(config, commands),
      commands,
      processes,
      snippets: new SnippetStore(config.snippet),
    })
    await expect(
      manager.start(TEST_ACCOUNT, {
        interfaceConfig: join(root, '..', 'outside.cfg'),
        targetConfig: join(root, 'target.cfg'),
      }),
    ).rejects.toThrow('outside execution.allowedRoots')
    expect(processes.calls).toHaveLength(0)
  })

  it('holds the debug-target lease until OpenOCD stops', async (): Promise<void> => {
    const root = await temporary()
    const config = testConfig(root)
    const commands = new FakeCommandRunner()
    const processes = new FakeManagedProcessRunner()
    const gate = new DeviceExecutionGate({ activeChannels: () => [] })
    const preflight: TemplateExecutionPreflight = (invocation, signal) =>
      gate.acquire(invocation, signal)
    const templates = new CommandTemplateRegistry(config, commands, undefined, preflight)
    const manager = new GdbSessionManager({
      config,
      templates,
      commands,
      processes,
      snippets: new SnippetStore(config.snippet),
      preflight,
    })
    const interfaceConfig = join(root, 'interface.cfg')
    const flashInterfaceConfig = join(root, 'alternate-interface.cfg')
    const targetConfig = join(root, 'target.cfg')
    const firmware = join(root, 'firmware.bin')

    await manager.start(TEST_ACCOUNT, { interfaceConfig, targetConfig })
    await expect(
      templates.run('openocd-flash', {
        interfaceConfig: flashInterfaceConfig,
        targetConfig,
        firmware,
      }),
    ).rejects.toThrow('occupied by running template openocd-server')
    expect(commands.calls).toHaveLength(0)

    await manager.stop(TEST_ACCOUNT)
    await expect(
      templates.run('openocd-flash', {
        interfaceConfig: flashInterfaceConfig,
        targetConfig,
        firmware,
      }),
    ).resolves.toMatchObject({ outcome: 'ok' })
    expect(commands.calls).toHaveLength(1)
  })

  it('releases the debug-target lease when process stop rejects', async (): Promise<void> => {
    const root = await temporary()
    const config = testConfig(root)
    const commands = new FakeCommandRunner()
    const processes = new FakeManagedProcessRunner()
    const release = vi.fn()
    const preflight: TemplateExecutionPreflight = vi.fn(() => Promise.resolve(release))
    const manager = new GdbSessionManager({
      config,
      templates: new CommandTemplateRegistry(config, commands),
      commands,
      processes,
      snippets: new SnippetStore(config.snippet),
      preflight,
    })

    await manager.start(TEST_ACCOUNT, {
      interfaceConfig: join(root, 'interface.cfg'),
      targetConfig: join(root, 'target.cfg'),
    })
    const process = processes.processes[0]
    if (process === undefined) throw new Error('missing fake OpenOCD process')
    process.stop.mockImplementationOnce((): Promise<never> => {
      process.queue.end()
      return Promise.reject(new Error('stop failed'))
    })

    await expect(manager.stop(TEST_ACCOUNT)).rejects.toThrow('stop failed')
    expect(release).toHaveBeenCalledOnce()
    expect(manager.status().state).toBe('stopped')
  })

  it('allows the GDB client channel to connect to its managed OpenOCD server', async (): Promise<void> => {
    const root = await temporary()
    const processes = new FakeManagedProcessRunner()
    const service = new DefaultWinDebugService(testConfig(root), { processes })
    try {
      await service.gdbStart(TEST_ACCOUNT, {
        interfaceConfig: join(root, 'interface.cfg'),
        targetConfig: join(root, 'target.cfg'),
      })

      const channel = await service.open(TEST_ACCOUNT, 'gdb:local')
      expect(channel.endpoint.params.target).toBe('127.0.0.1:3333')
      await service.close(TEST_ACCOUNT, channel.id)
      await service.gdbStop(TEST_ACCOUNT)
    } finally {
      await service.dispose()
    }
  })

  it('serializes concurrent start and stop-during-start transitions', async (): Promise<void> => {
    const root = await temporary()
    const config = testConfig(root)
    const commands = new FakeCommandRunner()
    const processes = new FakeManagedProcessRunner()
    let finishStart!: () => void
    processes.startBarrier = new Promise<void>((resolve): void => {
      finishStart = resolve
    })
    const manager = new GdbSessionManager({
      config,
      templates: new CommandTemplateRegistry(config, commands),
      commands,
      processes,
      snippets: new SnippetStore(config.snippet),
    })
    const starting = manager.start(TEST_ACCOUNT, {
      interfaceConfig: join(root, 'interface.cfg'),
      targetConfig: join(root, 'target.cfg'),
    })
    await flush()

    expect(() =>
      manager.start(TEST_ACCOUNT, {
        interfaceConfig: join(root, 'other-interface.cfg'),
        targetConfig: join(root, 'other-target.cfg'),
      }),
    ).toThrow('already running or starting')
    const stopping = manager.stop(TEST_ACCOUNT)
    expect(manager.stop(TEST_ACCOUNT)).toBe(stopping)
    let stopSettled = false
    void stopping.finally((): void => {
      stopSettled = true
    })
    await flush()
    expect(stopSettled).toBe(false)

    finishStart()
    await starting
    await stopping
    expect(processes.processes[0]?.stop).toHaveBeenCalledOnce()
    expect(manager.status().state).toBe('stopped')
  })
})

describe('desktop MCP wrapper', (): void => {
  it('registers allowlisted DSH tools and lazily connects with the execution signal', async (): Promise<void> => {
    const root = await temporary()
    const base = testConfig(root)
    const config = Object.freeze({
      ...base,
      desktopMcp: Object.freeze({
        enabled: true,
        command: join(root, 'windows-mcp.exe'),
        args: Object.freeze(['--stdio']),
        tools: Object.freeze(['desktop.capture', 'desktop.click']),
      }),
    })
    const client = new FakeDesktopMcpClient()
    const manager = new DesktopMcpManager(config, client)

    expect(manager.descriptor()).toEqual({
      transport: 'stdio',
      command: join(root, 'windows-mcp.exe'),
      args: ['--stdio'],
      allowedTools: ['desktop.capture', 'desktop.click'],
    })
    const definitions: ToolDefinition[] = []
    const unregisters = [vi.fn(), vi.fn()]
    const registry: DesktopToolRegistry = {
      register(definition): () => void {
        definitions.push(definition)
        return unregisters[definitions.length - 1] ?? vi.fn()
      },
    }
    const unregisterTools = manager.registerTools(registry)
    expect(definitions.map((definition): string => definition.name)).toEqual([
      'desktop.capture',
      'desktop.click',
    ])
    expect(client.connects).toHaveLength(0)
    expect(manager.status().state).toBe('stopped')
    const capture = definitions[0]
    if (capture === undefined) throw new Error('missing registered desktop tool')
    const controller = new AbortController()
    const execution = {
      signal: controller.signal,
    } as unknown as ToolRunContext
    await expect(capture.execute({ display: 1 }, execution)).resolves.toEqual({
      content: 'called desktop.capture',
    })
    expect(client.connects[0]).toMatchObject({
      command: join(root, 'windows-mcp.exe'),
      args: ['--stdio'],
      requestTimeoutMs: 5000,
      startupTimeoutMs: 1000,
      maxMessageBytes: 64 * 1024,
      signal: controller.signal,
    })
    expect(manager.status().state).toBe('running')
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]).toMatchObject({ tool: 'desktop.capture', args: { display: 1 } })
    expect(client.calls[0]?.signal).toBe(controller.signal)
    unregisterTools()
    expect(unregisters.every((unregister): boolean => unregister.mock.calls.length === 1)).toBe(
      true,
    )

    await manager.stop()
    expect(manager.status().state).toBe('stopped')
  })
})
