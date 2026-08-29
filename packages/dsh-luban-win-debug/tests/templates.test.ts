import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCommandWords } from '../src/command-runner.js'
import { parseConfig } from '../src/config.js'
import { classifyOutput, CommandTemplateRegistry } from '../src/templates.js'
import { FakeCommandRunner, testConfig } from './helpers.js'

const directories: string[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (path): Promise<void> => rm(path, { recursive: true, force: true })),
  )
})

async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'luban-win-debug-template-'))
  directories.push(path)
  return path
}

describe('command template policy', (): void => {
  it('expands allowlisted params into one executable plus an argument array', async (): Promise<void> => {
    const root = await temporary()
    const runner = new FakeCommandRunner()
    const registry = new CommandTemplateRegistry(testConfig(root), runner)
    const firmware = join(root, 'firmware.bin')

    const result = await registry.run('esptool-flash', {
      chip: 'esp32',
      port: 'COM3',
      baud: '921600',
      address: '0x1000',
      firmware,
    })

    expect(result.outcome).toBe('ok')
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]).toMatchObject({
      command: 'esptool.exe',
      args: [
        '--chip',
        'esp32',
        '--port',
        'COM3',
        '--baud',
        '921600',
        'write_flash',
        '0x1000',
        firmware,
      ],
    })
    expect(
      registry
        .resolve('openocd-flash', {
          interfaceConfig: join(root, 'interface.cfg'),
          targetConfig: join(root, 'target.cfg'),
          firmware,
        })
        .args.at(-1),
    ).toBe(`program {${firmware}} verify reset exit`)
  })

  it('rejects path escape, unknown params and missing destructive confirmation', async (): Promise<void> => {
    const root = await temporary()
    const registry = new CommandTemplateRegistry(testConfig(root), new FakeCommandRunner())

    expect(() =>
      registry.resolve('esptool-flash', {
        chip: 'esp32',
        port: 'COM3',
        baud: '115200',
        address: '0x1000',
        firmware: join(root, '..', 'outside.bin'),
      }),
    ).toThrow('outside execution.allowedRoots')
    expect(() =>
      registry.resolve('fastboot-reboot', { device: 'ABC', extra: 'not-allowed' }),
    ).toThrow('Unknown template parameter')
    expect(() =>
      registry.resolve('fastboot-flash', {
        device: 'ABC',
        partition: 'boot',
        image: join(root, 'boot.img'),
      }),
    ).toThrow('requires confirmation phrase FLASH_DEVICE')
    expect(() =>
      registry.resolve(
        'fastboot-flash',
        { device: 'ABC', partition: 'boot', image: join(root, 'boot.img') },
        'FLASH_DEVICE',
      ),
    ).not.toThrow()
  })

  it('rejects shell syntax before any runner can see it', (): void => {
    expect(parseCommandWords('info registers')).toEqual(['info', 'registers'])
    expect(parseCommandWords('logcat "*:W"')).toEqual(['logcat', '*:W'])
    expect(() => parseCommandWords('get-state && erase')).toThrow('Shell operators')
    expect(() => parseCommandWords('uname value;whoami')).toThrow('Shell operators')
    expect(() => parseCommandWords('print $(whoami)')).toThrow('Shell operators')
    expect(() => parseCommandWords('info "unfinished')).toThrow('quoting is incomplete')
  })

  it('classifies tool output into structured highlighted lines', (): void => {
    expect(
      classifyOutput({
        exitCode: 1,
        stdout: 'programming\nwarning: retry',
        stderr: 'fatal error: verify failed',
        durationMs: 2,
      }),
    ).toEqual([
      { level: 'info', text: 'programming' },
      { level: 'warning', text: 'warning: retry' },
      { level: 'error', text: 'fatal error: verify failed' },
    ])
    expect(classifyOutput({ exitCode: 7, stdout: '', stderr: '', durationMs: 1 })).toEqual([
      { level: 'error', text: 'Process exited with code 7' },
    ])
  })
})

describe('config policy', (): void => {
  it('defaults file parameters to the current workspace allowlist', (): void => {
    const config = parseConfig({})
    expect(config.execution.allowedRoots).toEqual([process.cwd()])
    expect(config.serial.defaultBaud).toBe(115200)
  })

  it('requires loopback GDB and validates remote endpoint allowlists', (): void => {
    expect(() => parseConfig({ gdb: { target: 'device.example:3333' } })).toThrow('loopback')
    expect(() => parseConfig({ gdb: { target: '127.0.0.1:99999' } })).toThrow('between 1 and 65535')
    expect(() =>
      parseConfig({
        remote: [{ id: 'board', kind: 'ssh', host: 'board', allowedCommands: ['ok;bad'] }],
      }),
    ).toThrow('allowedCommands')
    expect(() =>
      parseConfig({ desktopMcp: { enabled: true, command: 'windows-mcp.exe' } }),
    ).toThrow('absolute allowlisted path')
    expect(() =>
      parseConfig({
        desktopMcp: { enabled: true, command: join(process.cwd(), 'windows-mcp.exe') },
      }),
    ).toThrow('at least one allowlisted tool')
    expect(() =>
      parseConfig({
        desktopMcp: {
          enabled: true,
          command: join(process.cwd(), 'windows-mcp.exe'),
          tools: ['run_code'],
        },
      }),
    ).toThrow('invalid or reserved tool name')
  })
})
