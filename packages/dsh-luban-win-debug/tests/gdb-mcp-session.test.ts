import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SnippetFile } from '@luban/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopMcpManager } from '../src/desktop-mcp.js'
import { GdbSessionManager } from '../src/gdb.js'
import { DshSessionInjection } from '../src/session-injector.js'
import { SnippetStore } from '../src/snippet-store.js'
import { CommandTemplateRegistry } from '../src/templates.js'
import { FakeCommandRunner, FakeManagedProcessRunner, testConfig } from './helpers.js'

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

    await manager.start({ interfaceConfig, targetConfig })
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

    const snapshot = await manager.snapshot({
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
    await expect(manager.snapshot({ executable, variables: ['dangerous()'] })).rejects.toThrow(
      'Unsafe GDB expression',
    )
    await manager.stop()
    expect(processes.processes[0]?.stop).toHaveBeenCalledOnce()
    expect(manager.status().state).toBe('stopped')
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
      manager.start({
        interfaceConfig: join(root, '..', 'outside.cfg'),
        targetConfig: join(root, 'target.cfg'),
      }),
    ).rejects.toThrow('outside execution.allowedRoots')
    expect(processes.calls).toHaveLength(0)
  })
})

describe('desktop MCP wrapper', (): void => {
  it('starts only the locally configured command and publishes a tool allowlist descriptor', async (): Promise<void> => {
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
    const processes = new FakeManagedProcessRunner()
    const manager = new DesktopMcpManager(config, processes)

    expect(manager.descriptor()).toEqual({
      transport: 'stdio',
      command: join(root, 'windows-mcp.exe'),
      args: ['--stdio'],
      allowedTools: ['desktop.capture', 'desktop.click'],
    })
    await manager.start()
    expect(processes.calls[0]).toMatchObject({
      command: join(root, 'windows-mcp.exe'),
      args: ['--stdio'],
      options: { timeoutMs: 60_000, startupTimeoutMs: 1000, maxOutputBytes: 64 * 1024 },
    })
    expect(manager.status().state).toBe('running')
    await manager.stop()
    expect(manager.status().state).toBe('stopped')
  })
})

describe('DSH session injection', (): void => {
  it('sends a file path, endpoint metadata and excerpt to a live session', async (): Promise<void> => {
    const followup = vi.fn()
    const agents = {
      get: vi.fn(() => ({ followup })),
      resume: vi.fn(),
    } as unknown as AgentRegistry
    const snippet: SnippetFile = {
      path: 'C:\\debug\\snippet.log',
      content: 'fatal: target halted',
      timeFrom: 1,
      timeTo: 2,
      endpoint: {
        kind: 'serial',
        id: 'serial:COM3',
        label: 'COM3',
        params: { port: 'COM3', baud: '115200' },
      },
    }

    await new DshSessionInjection(agents).inject('session-1', snippet)

    expect(followup).toHaveBeenCalledOnce()
    const encoded = JSON.stringify(followup.mock.calls[0]?.[0])
    expect(encoded).toContain('C:\\\\debug\\\\snippet.log')
    expect(encoded).toContain('fatal: target halted')
    expect(encoded).toContain('115200')
  })
})
