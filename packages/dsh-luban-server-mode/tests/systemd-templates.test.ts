import { mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProcessOptions, ProcessResult, ProcessRunner } from '../src/process-runner.js'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'
import { supportsServerMode } from '../src/index.js'
import { UserSystemdInstaller } from '../src/systemd.js'
import { compileTemplate } from '../src/templates.js'

const directories = new Set<string>()

interface ProcessCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: ProcessOptions
}

class FakeRunner implements ProcessRunner {
  public readonly calls: ProcessCall[] = []
  public run(
    command: string,
    args: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    this.calls.push({ command, args, options })
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 })
  }
}

function temporaryDirectory(prefix: string): string {
  const directory = join(tmpdir(), `${prefix}-${randomUUID()}`)
  directories.add(directory)
  return directory
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('UserSystemdInstaller', (): void => {
  it('writes a hardened user unit and runs only bounded argv commands', async (): Promise<void> => {
    const runner = new FakeRunner()
    const directory = temporaryDirectory('luban-systemd')
    const installer = new UserSystemdInstaller({
      runner,
      serviceName: 'dsh-luban',
      dshExecutable: 'dsh',
      timeoutMs: 7_000,
      platform: 'linux',
      unitDirectory: directory,
    })
    await installer.install('builder', 'ubuntu-server')

    const unit = await readFile(installer.unitPath, 'utf8')
    expect(unit).toContain('ExecStart="/usr/bin/env" "dsh" "web" "--profile" "ubuntu-server"')
    expect(unit).toContain('Environment=LUBAN_BOOT_RESTORE=1')
    expect(unit).toContain('NoNewPrivileges=true')
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      ['loginctl', ['enable-linger', 'builder']],
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'dsh-luban.service']],
    ])
    expect(runner.calls.every((call) => call.options.timeoutMs === 7_000)).toBe(true)

    await installer.uninstall()
    await expect(readFile(installer.unitPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(runner.calls.at(-2)?.args).toEqual(['--user', 'disable', '--now', 'dsh-luban.service'])
  })

  it('rejects unsupported platforms and unsafe linger users before executing', async (): Promise<void> => {
    const runner = new FakeRunner()
    const installer = new UserSystemdInstaller({
      runner,
      serviceName: 'dsh-luban',
      dshExecutable: 'dsh',
      timeoutMs: 1_000,
      platform: 'win32',
      unitDirectory: temporaryDirectory('luban-systemd-win'),
    })
    await expect(installer.install('builder', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_PLATFORM_UNSUPPORTED',
    })
    expect(runner.calls).toHaveLength(0)
    const linux = new UserSystemdInstaller({
      runner,
      serviceName: 'dsh-luban',
      dshExecutable: 'dsh',
      timeoutMs: 1_000,
      platform: 'linux',
      unitDirectory: temporaryDirectory('luban-systemd-safe'),
    })
    await expect(linux.install('bad;user', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    })
    expect(runner.calls).toHaveLength(0)
    expect(
      () =>
        new UserSystemdInstaller({
          runner,
          serviceName: '../escape',
          dshExecutable: 'dsh',
          timeoutMs: 1_000,
          platform: 'linux',
          unitDirectory: temporaryDirectory('luban-systemd-name'),
        }),
    ).toThrow(/service name/u)
    expect(supportsServerMode('linux')).toBe(true)
    expect(supportsServerMode('win32')).toBe(false)
  })
})

describe('build config and template compiler', (): void => {
  it('compiles params as argv values inside configured workspace roots', async (): Promise<void> => {
    const root = temporaryDirectory('luban-workspaces')
    const workspace = join(root, 'firmware')
    await mkdir(workspace, { recursive: true })
    const spec = compileTemplate({
      template: {
        id: 'firmware',
        title: 'Firmware',
        command: 'cmake',
        args: ['--build', '${workspace}/build', '--target', 'all;still-one-argument'],
        cwd: '${workspace}',
        collect: ['build/firmware.bin'],
      },
      params: { workspace },
      jobId: randomUUID(),
      artifactDirectory: join(root, 'artifacts'),
      resultFile: join(root, 'result.json'),
      timeoutMs: 30_000,
      workspaceRoots: [root],
    })
    expect(spec.command).toBe('cmake')
    expect(spec.args).toEqual([
      '--build',
      `${workspace}/build`,
      '--target',
      'all;still-one-argument',
    ])
    expect(spec.cwd).toBe(workspace)
    expect(spec.collect).toEqual([join(workspace, 'build/firmware.bin')])
  })

  it('blocks workspace escape, collection traversal, unknown params, and dynamic executables', async (): Promise<void> => {
    const root = temporaryDirectory('luban-safe-root')
    await mkdir(join(root, 'project'), { recursive: true })
    const base = {
      params: { workspace: join(root, 'project') },
      jobId: randomUUID(),
      artifactDirectory: join(root, 'artifacts'),
      resultFile: join(root, 'result.json'),
      timeoutMs: 1_000,
      workspaceRoots: [root],
    }
    expect(() =>
      compileTemplate({
        ...base,
        params: { workspace: join(root, '..', 'outside') },
        template: {
          id: 'x',
          title: 'x',
          command: 'make',
          args: [],
          cwd: '${workspace}',
          collect: [],
        },
      }),
    ).toThrow(/outside configured roots/u)
    expect(() =>
      compileTemplate({
        ...base,
        template: {
          id: 'x',
          title: 'x',
          command: 'make',
          args: [],
          cwd: '${workspace}',
          collect: ['../secret'],
        },
      }),
    ).toThrow(/escapes the build workspace/u)
    expect(() =>
      compileTemplate({
        ...base,
        params: { ...base.params, unused: 'value' },
        template: {
          id: 'x',
          title: 'x',
          command: 'make',
          args: [],
          cwd: '${workspace}',
          collect: [],
        },
      }),
    ).toThrow(/not used/u)
    expect(() =>
      compileTemplate({
        ...base,
        template: {
          id: 'x',
          title: 'x',
          command: '${workspace}',
          args: [],
          cwd: '${workspace}',
          collect: [],
        },
      }),
    ).toThrow(/executable/u)
    expect(() => parseConfig({ build: { maxConcurrent: 0 } })).toThrow(/positive integer/u)
  })

  it('rejects a workspace junction that resolves outside its configured root', async (): Promise<void> => {
    const root = temporaryDirectory('luban-junction-root')
    const outside = temporaryDirectory('luban-junction-outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    const linked = join(root, 'linked-workspace')
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() =>
      compileTemplate({
        template: {
          id: 'junction',
          title: 'junction',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: '${workspace}',
          collect: ['secret.txt'],
        },
        params: { workspace: linked },
        jobId: randomUUID(),
        artifactDirectory: join(root, 'artifacts'),
        resultFile: join(root, 'result.json'),
        timeoutMs: 1_000,
        workspaceRoots: [root],
      }),
    ).toThrow(/junction|outside configured roots/u)
  })
})
