import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
  readonly #respond: (call: ProcessCall, index: number) => ProcessResult | Promise<ProcessResult>

  public constructor(
    respond: (call: ProcessCall, index: number) => ProcessResult | Promise<ProcessResult> = (
      call,
    ): ProcessResult => processResult(call.command === 'loginctl' ? 'yes\n' : ''),
  ) {
    this.#respond = respond
  }

  public async run(
    command: string,
    args: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    const call = { command, args, options }
    this.calls.push(call)
    return await this.#respond(call, this.calls.length - 1)
  }
}

function processResult(stdout = '', exitCode = 0, stderr = ''): ProcessResult {
  return { exitCode, stdout, stderr, durationMs: 1 }
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
  it('installs idempotently after read-only linger verification', async (): Promise<void> => {
    const runner = new FakeRunner()
    const directory = temporaryDirectory('luban-systemd')
    const installer = new UserSystemdInstaller({
      runner,
      serviceName: 'dsh-luban',
      dshExecutable: 'dsh',
      timeoutMs: 7_000,
      platform: 'linux',
      unitDirectory: directory,
      currentUser: 'builder',
    })
    await installer.install('builder', 'ubuntu-server')

    const unit = await readFile(installer.unitPath, 'utf8')
    expect(unit).toContain('ExecStart="/usr/bin/env" "dsh" "--profile" "ubuntu-server" "--no-open"')
    expect(unit).not.toContain('"web" "--profile"')
    expect(unit).toContain('Environment=LUBAN_BOOT_RESTORE=1')
    expect(unit).toContain('NoNewPrivileges=true')
    expect(runner.calls.map((call) => [call.command, call.args])).toEqual([
      ['loginctl', ['show-user', 'builder', '--property=Linger', '--value']],
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'dsh-luban.service']],
    ])
    expect(runner.calls.every((call) => call.options.timeoutMs === 7_000)).toBe(true)
    expect(runner.calls.every((call) => call.options.maxOutputBytes === 4_096)).toBe(true)

    const firstIdentity = await lstat(installer.unitPath)
    await installer.install('builder', 'ubuntu-server')
    const secondIdentity = await lstat(installer.unitPath)
    expect({ dev: secondIdentity.dev, ino: secondIdentity.ino }).toEqual({
      dev: firstIdentity.dev,
      ino: firstIdentity.ino,
    })
    expect(runner.calls.slice(3).map((call) => [call.command, call.args])).toEqual([
      ['loginctl', ['show-user', 'builder', '--property=Linger', '--value']],
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'dsh-luban.service']],
    ])

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
      currentUser: 'builder',
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
      currentUser: 'builder',
    })
    await expect(linux.install('bad;user', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    })
    expect(runner.calls).toHaveLength(0)
    await expect(linux.install('other', 'ubuntu-server')).rejects.toMatchObject({
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
          currentUser: 'builder',
        }),
    ).toThrow(/service name/u)
    expect(supportsServerMode('linux')).toBe(true)
    expect(supportsServerMode('win32')).toBe(false)
  })

  it('fails closed without Linger=yes and never writes or enables linger', async (): Promise<void> => {
    const runner = new FakeRunner((call): ProcessResult =>
      processResult(call.command === 'loginctl' ? 'no\n' : ''),
    )
    const installer = new UserSystemdInstaller({
      runner,
      serviceName: 'dsh-luban',
      dshExecutable: 'dsh',
      timeoutMs: 1_000,
      platform: 'linux',
      unitDirectory: temporaryDirectory('luban-systemd-linger'),
      currentUser: 'builder',
    })

    const preflight = await installer.preflight('builder')
    expect(preflight).toMatchObject({ linger: 'disabled', unit: 'missing', ready: false })
    await expect(installer.install('builder', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
    })
    await expect(readFile(installer.unitPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(runner.calls.every((call) => !call.args.includes('enable-linger'))).toBe(true)
    expect(runner.calls.every((call) => call.command === 'loginctl')).toBe(true)
  })

  it('rejects different, symlink, and non-regular unit paths before systemctl mutation', async (): Promise<void> => {
    const states = ['different', 'symlink', 'non-regular'] as const
    for (const state of states) {
      const runner = new FakeRunner()
      const directory = temporaryDirectory(`luban-systemd-${state}`)
      const installer = new UserSystemdInstaller({
        runner,
        serviceName: 'dsh-luban',
        dshExecutable: 'dsh',
        timeoutMs: 1_000,
        platform: 'linux',
        unitDirectory: directory,
        currentUser: 'builder',
      })
      await mkdir(directory, { recursive: true })
      if (state === 'different') {
        await writeFile(installer.unitPath, '[Unit]\nDescription=unmanaged\n', 'utf8')
      } else if (state === 'non-regular') {
        await mkdir(installer.unitPath)
      } else {
        const target = join(directory, 'unmanaged.service')
        await writeFile(target, installer.render('ubuntu-server'), 'utf8')
        await symlink(target, installer.unitPath, 'file')
      }

      const preflight = await installer.preflight('builder')
      expect(preflight.unit).toBe(state)
      await expect(installer.install('builder', 'ubuntu-server')).rejects.toMatchObject({
        code: 'E_INVALID_INPUT',
      })
      expect(runner.calls.every((call) => call.command === 'loginctl')).toBe(true)
    }
  })

  it('removes a newly created unit when a later systemctl command fails', async (): Promise<void> => {
    const runner = new FakeRunner((call): ProcessResult => {
      if (call.command === 'loginctl') return processResult('yes\n')
      if (call.args.includes('enable')) return processResult('', 1, 'enable failed')
      return processResult()
    })
    const installer = new UserSystemdInstaller({
      runner,
      serviceName: 'dsh-luban',
      dshExecutable: 'dsh',
      timeoutMs: 1_000,
      platform: 'linux',
      unitDirectory: temporaryDirectory('luban-systemd-rollback'),
      currentUser: 'builder',
    })

    await expect(installer.install('builder', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
    })
    await expect(readFile(installer.unitPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['show-user', 'builder', '--property=Linger', '--value'],
      ['--user', 'daemon-reload'],
      ['--user', 'enable', '--now', 'dsh-luban.service'],
      ['--user', 'disable', '--now', 'dsh-luban.service'],
      ['--user', 'daemon-reload'],
    ])
  })

  it('removes a newly created unit when daemon-reload fails', async (): Promise<void> => {
    const runner = new FakeRunner((call): ProcessResult =>
      call.command === 'loginctl'
        ? processResult('yes\n')
        : processResult('', 1, 'daemon reload failed'),
    )
    const installer = new UserSystemdInstaller({
      runner,
      serviceName: 'dsh-luban',
      dshExecutable: 'dsh',
      timeoutMs: 1_000,
      platform: 'linux',
      unitDirectory: temporaryDirectory('luban-systemd-reload-rollback'),
      currentUser: 'builder',
    })

    await expect(installer.install('builder', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
    })
    await expect(readFile(installer.unitPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(runner.calls.map((call) => call.args)).toEqual([
      ['show-user', 'builder', '--property=Linger', '--value'],
      ['--user', 'daemon-reload'],
    ])
  })

  it('preserves an exact pre-existing unit after a systemctl failure', async (): Promise<void> => {
    const runner = new FakeRunner((call): ProcessResult => {
      if (call.command === 'loginctl') return processResult('yes\n')
      if (call.args.includes('enable')) return processResult('', 1, 'enable failed')
      return processResult()
    })
    const directory = temporaryDirectory('luban-systemd-existing')
    const installer = new UserSystemdInstaller({
      runner,
      serviceName: 'dsh-luban',
      dshExecutable: 'dsh',
      timeoutMs: 1_000,
      platform: 'linux',
      unitDirectory: directory,
      currentUser: 'builder',
    })
    await mkdir(directory, { recursive: true })
    const expected = installer.render('ubuntu-server')
    await writeFile(installer.unitPath, expected, 'utf8')

    await expect(installer.install('builder', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
    })
    expect(await readFile(installer.unitPath, 'utf8')).toBe(expected)
    expect(runner.calls).toHaveLength(3)
  })

  it('does not delete a unit path replaced during rollback', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-race')
    const unitPath = join(directory, 'dsh-luban.service')
    const runner = new FakeRunner(async (call): Promise<ProcessResult> => {
      if (call.command === 'loginctl') return processResult('yes\n')
      if (call.args.includes('enable')) {
        await rm(unitPath)
        await writeFile(unitPath, 'replacement', 'utf8')
        return processResult('', 1, 'enable failed')
      }
      return processResult()
    })
    const installer = new UserSystemdInstaller({
      runner,
      serviceName: 'dsh-luban',
      dshExecutable: 'dsh',
      timeoutMs: 1_000,
      platform: 'linux',
      unitDirectory: directory,
      currentUser: 'builder',
    })

    await expect(installer.install('builder', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_IO',
    })
    expect(await readFile(installer.unitPath, 'utf8')).toBe('replacement')
  })

  it('reports read-only service status without exposing command output', async (): Promise<void> => {
    const runner = new FakeRunner((call): ProcessResult => {
      if (call.command === 'loginctl') return processResult('yes\n')
      if (call.args.includes('is-enabled')) return processResult('enabled\n')
      if (call.args.includes('is-active')) return processResult('active\n')
      return processResult()
    })
    const installer = new UserSystemdInstaller({
      runner,
      serviceName: 'dsh-luban',
      dshExecutable: 'dsh',
      timeoutMs: 1_000,
      platform: 'linux',
      unitDirectory: temporaryDirectory('luban-systemd-status'),
      currentUser: 'builder',
    })

    await expect(installer.status()).resolves.toMatchObject({
      service: 'dsh-luban.service',
      user: 'builder',
      linger: 'enabled',
      unit: 'missing',
      enabled: 'enabled',
      active: 'active',
    })
    expect(runner.calls.every((call) => !call.args.includes('enable-linger'))).toBe(true)
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
