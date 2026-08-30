import { existsSync, realpathSync } from 'node:fs'
import { chmod, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute as isAbsolutePath,
  join,
  resolve,
} from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProcessOptions, ProcessResult, ProcessRunner } from '../src/process-runner.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'
import { supportsServerMode } from '../src/index.js'
import { UserSystemdInstaller } from '../src/systemd.js'
import { compileTemplate } from '../src/templates.js'

const directories = new Set<string>()
const originalPath = process.env.PATH
const SHOW_KEYS = [
  'Id',
  'LoadState',
  'FragmentPath',
  'DropInPaths',
  'NeedDaemonReload',
  'UnitFileState',
  'ActiveState',
  'SubState',
  'MainPID',
  'Type',
] as const

interface ProcessCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: ProcessOptions
}

interface ManagerModel {
  id: string
  loadState: string
  fragmentPath: string
  dropInPaths: string
  needDaemonReload: string
  unitFileState: string
  activeState: string
  subState: string
  mainPid: number | string
  type: string
}

type RunnerInterceptor = (
  call: ProcessCall,
  runner: ModelRunner,
) => ProcessResult | undefined | Promise<ProcessResult | undefined>

function processResult(stdout = '', exitCode = 0, stderr = ''): ProcessResult {
  return { exitCode, stdout, stderr, durationMs: 1 }
}

function absentModel(): ManagerModel {
  return {
    id: 'dsh-luban.service',
    loadState: 'not-found',
    fragmentPath: '',
    dropInPaths: '',
    needDaemonReload: 'no',
    unitFileState: '',
    activeState: 'inactive',
    subState: 'dead',
    mainPid: 0,
    type: '',
  }
}

function managedModel(unitPath: string, overrides: Partial<ManagerModel> = {}): ManagerModel {
  return {
    id: 'dsh-luban.service',
    loadState: 'loaded',
    fragmentPath: realpathSync(unitPath),
    dropInPaths: '',
    needDaemonReload: 'no',
    unitFileState: 'disabled',
    activeState: 'inactive',
    subState: 'dead',
    mainPid: 0,
    type: 'exec',
    ...overrides,
  }
}

function snapshotOutput(model: ManagerModel, keys: readonly string[] = SHOW_KEYS): string {
  const values: Readonly<Record<string, string>> = {
    Id: model.id,
    LoadState: model.loadState,
    FragmentPath: model.fragmentPath,
    DropInPaths: model.dropInPaths,
    NeedDaemonReload: model.needDaemonReload,
    UnitFileState: model.unitFileState,
    ActiveState: model.activeState,
    SubState: model.subState,
    MainPID: String(model.mainPid),
    Type: model.type,
  }
  return `${keys.map((key): string => `${key}=${values[key] ?? ''}`).join('\n')}\n`
}

class ModelRunner implements ProcessRunner {
  public readonly calls: ProcessCall[] = []
  public model: ManagerModel
  public linger = 'yes'
  readonly #unitPath: string
  readonly #interceptor: RunnerInterceptor | undefined

  public constructor(
    unitPath: string,
    model: ManagerModel = absentModel(),
    interceptor?: RunnerInterceptor,
  ) {
    this.#unitPath = unitPath
    this.model = model
    this.#interceptor = interceptor
  }

  public async run(
    command: string,
    args: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    if (options.signal?.aborted === true) throw new Error('runner observed an aborted signal')
    const call = { command, args, options }
    this.calls.push(call)
    const intercepted = await this.#interceptor?.(call, this)
    if (intercepted !== undefined) return intercepted
    if (command === 'loginctl') return processResult(`${this.linger}\n`)
    if (args.includes('show')) return processResult(snapshotOutput(this.model))
    if (args.includes('daemon-reload')) {
      const managedPath = resolve(this.#unitPath)
      const currentlyManaged =
        this.model.loadState === 'not-found' || resolve(this.model.fragmentPath) === managedPath
      if (currentlyManaged && existsSync(this.#unitPath)) {
        const enabled = this.model.unitFileState === '' ? 'disabled' : this.model.unitFileState
        this.model = managedModel(this.#unitPath, {
          unitFileState: enabled,
          activeState: this.model.activeState,
          subState: this.model.subState,
          mainPid: this.model.mainPid,
        })
      } else if (currentlyManaged) {
        this.model = absentModel()
      }
      return processResult()
    }
    if (args.includes('enable') && args.includes('--now')) {
      this.model.unitFileState = 'enabled'
      this.model.activeState = 'active'
      this.model.subState = 'running'
      this.model.mainPid = 4242
      return processResult()
    }
    if (args.includes('disable')) {
      this.model.unitFileState = 'disabled'
      this.model.activeState = 'inactive'
      this.model.subState = 'dead'
      this.model.mainPid = 0
      return processResult()
    }
    if (args.includes('enable')) {
      this.model.unitFileState = 'enabled'
      return processResult()
    }
    if (args.includes('start')) {
      this.model.activeState = 'active'
      this.model.subState = 'running'
      this.model.mainPid = 4343
      return processResult()
    }
    return processResult()
  }
}

function temporaryDirectory(prefix: string): string {
  const directory = join(tmpdir(), `${prefix}-${randomUUID()}`)
  directories.add(directory)
  return directory
}

function installerFor(
  directory: string,
  runner: ProcessRunner,
  dshExecutable = process.execPath,
  signal?: AbortSignal,
): UserSystemdInstaller {
  return new UserSystemdInstaller({
    runner,
    serviceName: 'dsh-luban',
    dshExecutable,
    timeoutMs: 7_000,
    platform: 'linux',
    unitDirectory: directory,
    currentUser: 'builder',
    ...(signal === undefined ? {} : { signal }),
  })
}

beforeEach((): void => {
  process.env.PATH = dirname(process.execPath)
})

afterEach(async (): Promise<void> => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('UserSystemdInstaller', (): void => {
  it('installs idempotently, preserves schema v1, and verifies uninstall shutdown', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd')
    const unitPath = join(directory, 'dsh-luban.service')
    const runner = new ModelRunner(unitPath)
    const installer = installerFor(directory, runner)

    await installer.install('builder', 'ubuntu-server')
    const unit = await readFile(unitPath, 'utf8')
    expect(unit).toContain(
      `ExecStart="${process.execPath.replaceAll('\\', '\\\\')}" "--profile" "ubuntu-server" "--no-open"`,
    )
    expect(unit).toContain('Type=exec')
    expect(unit).toContain(
      `Environment="PATH=${dirname(process.execPath).replaceAll('\\', '\\\\')}"`,
    )
    expect(unit).toContain('Environment=LUBAN_BOOT_RESTORE=1')
    expect(unit).not.toContain('/usr/bin/env')
    expect(runner.model).toMatchObject({
      unitFileState: 'enabled',
      activeState: 'active',
      subState: 'running',
      mainPid: 4242,
    })
    expect(runner.calls.every((call) => call.options.timeoutMs === 7_000)).toBe(true)
    expect(runner.calls.every((call) => call.options.maxOutputBytes === 4_096)).toBe(true)

    const status = await installer.status()
    expect(status).toMatchObject({
      schemaVersion: 1,
      enabled: 'enabled',
      active: 'active',
    })
    expect(Object.keys(status).sort()).toEqual(
      [
        'schemaVersion',
        'service',
        'user',
        'unitPath',
        'linger',
        'unit',
        'enabled',
        'active',
      ].sort(),
    )
    const firstIdentity = await lstat(unitPath)
    const mutationsBefore = runner.calls.filter(
      (call) => call.args.includes('enable') || call.args.includes('daemon-reload'),
    ).length
    await installer.install('builder', 'ubuntu-server')
    const secondIdentity = await lstat(unitPath)
    expect({ dev: secondIdentity.dev, ino: secondIdentity.ino }).toEqual({
      dev: firstIdentity.dev,
      ino: firstIdentity.ino,
    })
    expect(
      runner.calls.filter(
        (call) => call.args.includes('enable') || call.args.includes('daemon-reload'),
      ),
    ).toHaveLength(mutationsBefore)

    await installer.uninstall()
    await expect(readFile(unitPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(runner.model).toEqual(absentModel())
    expect(runner.calls.some((call) => call.args.includes('disable'))).toBe(true)
  })

  it('rejects unsupported platforms and unsafe users before executing', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-platform')
    const runner = new ModelRunner(join(directory, 'dsh-luban.service'))
    const unsupported = new UserSystemdInstaller({
      runner,
      serviceName: 'dsh-luban',
      dshExecutable: process.execPath,
      timeoutMs: 1_000,
      platform: 'win32',
      unitDirectory: directory,
      currentUser: 'builder',
    })
    await expect(unsupported.install('builder', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_PLATFORM_UNSUPPORTED',
    })
    const installer = installerFor(directory, runner)
    await expect(installer.install('bad;user', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    })
    await expect(installer.install('other', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    })
    expect(runner.calls).toHaveLength(0)
    expect(
      () =>
        new UserSystemdInstaller({
          runner,
          serviceName: '../escape',
          dshExecutable: process.execPath,
          timeoutMs: 1_000,
        }),
    ).toThrow(/service name/u)
    expect(supportsServerMode('linux')).toBe(true)
    expect(supportsServerMode('win32')).toBe(false)
  })

  it('fails closed without Linger=yes and never enables linger', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-linger')
    const runner = new ModelRunner(join(directory, 'dsh-luban.service'))
    runner.linger = 'no'
    const installer = installerFor(directory, runner)

    await expect(installer.preflight('builder')).resolves.toMatchObject({
      schemaVersion: 1,
      linger: 'disabled',
      unit: 'missing',
      ready: false,
    })
    await expect(installer.install('builder', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
    })
    expect(runner.calls.every((call) => !call.args.includes('enable-linger'))).toBe(true)
    expect(runner.calls.every((call) => !call.args.includes('enable'))).toBe(true)
  })

  it('rejects different, symlink, and non-regular unit paths before mutation', async (): Promise<void> => {
    const states = ['different', 'symlink', 'non-regular'] as const
    for (const state of states) {
      const directory = temporaryDirectory(`luban-systemd-${state}`)
      const unitPath = join(directory, 'dsh-luban.service')
      const runner = new ModelRunner(unitPath)
      const installer = installerFor(directory, runner)
      await mkdir(directory, { recursive: true })
      if (state === 'different') {
        await writeFile(unitPath, '[Unit]\nDescription=unmanaged\n', 'utf8')
      } else if (state === 'non-regular') {
        await mkdir(unitPath)
      } else {
        const target = join(directory, 'unmanaged.service')
        await writeFile(target, installer.render('ubuntu-server'), 'utf8')
        await symlink(target, unitPath, 'file')
      }

      await expect(installer.preflight('builder')).resolves.toMatchObject({ unit: state })
      await expect(installer.install('builder', 'ubuntu-server')).rejects.toMatchObject({
        code: 'E_INVALID_INPUT',
      })
      expect(
        runner.calls.every(
          (call) => !call.args.includes('enable') && !call.args.includes('daemon-reload'),
        ),
      ).toBe(true)
    }
  })

  it('parses shuffled show fields and rejects failed or malformed snapshots', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-show')
    const unitPath = join(directory, 'dsh-luban.service')
    const shuffled = new ModelRunner(
      unitPath,
      absentModel(),
      (call, runner): ProcessResult | undefined =>
        call.args.includes('show')
          ? processResult(snapshotOutput(runner.model, [...SHOW_KEYS].reverse()))
          : undefined,
    )
    await expect(installerFor(directory, shuffled).preflight()).resolves.toMatchObject({
      unit: 'missing',
      ready: true,
    })

    const invalidSnapshots = [
      processResult(snapshotOutput(absentModel()), 1, 'manager unavailable'),
      processResult(snapshotOutput(absentModel(), SHOW_KEYS.slice(1))),
      processResult(`${snapshotOutput(absentModel())}Id=dsh-luban.service\n`),
      processResult(`${snapshotOutput(absentModel())}Unknown=value\n`),
      processResult(snapshotOutput({ ...absentModel(), mainPid: 'not-a-pid' })),
      processResult(snapshotOutput(absentModel()).replace('SubState=dead', 'SubState=de\rad')),
    ]
    for (const [index, invalid] of invalidSnapshots.entries()) {
      const path = temporaryDirectory(`luban-systemd-invalid-show-${String(index)}`)
      const runner = new ModelRunner(
        join(path, 'dsh-luban.service'),
        absentModel(),
        (call): ProcessResult | undefined => (call.args.includes('show') ? invalid : undefined),
      )
      await expect(installerFor(path, runner).preflight()).rejects.toMatchObject({
        code: 'E_UNAVAILABLE',
      })
      expect(runner.calls.every((call) => !call.args.includes('enable'))).toBe(true)
    }
  })

  it('detects a same-name foreign unit before creating or disabling anything', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-foreign')
    const unitPath = join(directory, 'dsh-luban.service')
    const foreignPath = join(temporaryDirectory('luban-systemd-vendor'), 'dsh-luban.service')
    await mkdir(dirname(foreignPath), { recursive: true })
    await writeFile(foreignPath, '[Service]\nExecStart=/foreign\n', 'utf8')
    const runner = new ModelRunner(
      unitPath,
      managedModel(foreignPath, {
        unitFileState: 'enabled',
        activeState: 'active',
        subState: 'running',
        mainPid: 9001,
      }),
    )
    const installer = installerFor(directory, runner)

    await expect(installer.preflight()).resolves.toMatchObject({ unit: 'different', ready: false })
    await expect(installer.install('builder', 'ubuntu-server')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    })
    expect(existsSync(unitPath)).toBe(false)
    expect(
      runner.calls.every((call) => !call.args.includes('disable') && !call.args.includes('enable')),
    ).toBe(true)
  })

  it('rejects stale effective configuration and transient enablement before mutation', async (): Promise<void> => {
    const cases: readonly Partial<ManagerModel>[] = [
      { fragmentPath: '/usr/lib/systemd/user/dsh-luban.service' },
      { dropInPaths: '/tmp/foreign.conf' },
      { needDaemonReload: 'yes' },
      { unitFileState: 'enabled-runtime' },
      { type: 'simple' },
      { activeState: 'active', subState: 'running', mainPid: 0 },
      { activeState: 'active', subState: 'exited', mainPid: 1234 },
    ]
    for (const [index, overrides] of cases.entries()) {
      const directory = temporaryDirectory(`luban-systemd-stale-${String(index)}`)
      const unitPath = join(directory, 'dsh-luban.service')
      const placeholder = new ModelRunner(unitPath)
      const installer = installerFor(directory, placeholder)
      await mkdir(directory, { recursive: true })
      await writeFile(unitPath, installer.render('ubuntu-server'), 'utf8')
      placeholder.model = managedModel(unitPath, overrides)

      await expect(installer.preflight()).resolves.toMatchObject({ unit: 'changed', ready: false })
      await expect(installer.install('builder', 'ubuntu-server')).rejects.toMatchObject({
        code: 'E_INVALID_INPUT',
      })
      expect(
        placeholder.calls.every(
          (call) => !call.args.includes('enable') && !call.args.includes('disable'),
        ),
      ).toBe(true)
    }
  })

  it('removes a newly owned unit after a partial activation failure', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-partial')
    const unitPath = join(directory, 'dsh-luban.service')
    const runner = new ModelRunner(
      unitPath,
      absentModel(),
      (call, state): ProcessResult | undefined => {
        if (call.args.includes('enable') && call.args.includes('--now')) {
          state.model.unitFileState = 'enabled'
          state.model.activeState = 'active'
          state.model.subState = 'running'
          state.model.mainPid = 5151
          return processResult('', 1, 'partial enable failure')
        }
        return undefined
      },
    )

    await expect(
      installerFor(directory, runner).install('builder', 'ubuntu-server'),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
    expect(existsSync(unitPath)).toBe(false)
    expect(runner.model).toEqual(absentModel())
    expect(runner.calls.some((call) => call.args.includes('disable'))).toBe(true)
  })

  it('ignores an aborted caller signal while compensating partial activation', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-aborted-rollback')
    const unitPath = join(directory, 'dsh-luban.service')
    const controller = new AbortController()
    const runner = new ModelRunner(
      unitPath,
      absentModel(),
      (call, state): ProcessResult | undefined => {
        if (!call.args.includes('enable') || !call.args.includes('--now')) return undefined
        state.model.unitFileState = 'enabled'
        state.model.activeState = 'active'
        state.model.subState = 'running'
        state.model.mainPid = 5252
        controller.abort()
        return processResult('', 1, 'activation failed while cancelling')
      },
    )

    await expect(
      installerFor(directory, runner, process.execPath, controller.signal).install(
        'builder',
        'ubuntu-server',
      ),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
    expect(existsSync(unitPath)).toBe(false)
    expect(runner.model).toEqual(absentModel())
    const activationIndex = runner.calls.findIndex(
      (call) => call.args.includes('enable') && call.args.includes('--now'),
    )
    expect(activationIndex).toBeGreaterThanOrEqual(0)
    expect(
      runner.calls.slice(activationIndex + 1).every((call) => call.options.signal === undefined),
    ).toBe(true)
    expect(runner.calls.some((call) => call.args.includes('disable'))).toBe(true)
  })

  it('retries manager reload after a failed initial reload and proves absence', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-reload-failure')
    const unitPath = join(directory, 'dsh-luban.service')
    let reloads = 0
    const runner = new ModelRunner(
      unitPath,
      absentModel(),
      (call, state): ProcessResult | undefined => {
        if (!call.args.includes('daemon-reload')) return undefined
        reloads += 1
        if (reloads !== 1) return undefined
        state.model = managedModel(unitPath, {
          unitFileState: 'enabled',
          activeState: 'active',
          subState: 'running',
          mainPid: 6060,
        })
        return processResult('', 1, 'reload failed after partial effect')
      },
    )

    await expect(
      installerFor(directory, runner).install('builder', 'ubuntu-server'),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
    expect(reloads).toBe(2)
    expect(existsSync(unitPath)).toBe(false)
    expect(runner.model).toEqual(absentModel())
    expect(runner.calls.some((call) => call.args.includes('disable'))).toBe(true)
    expect(runner.calls.every((call) => !call.args.includes('enable'))).toBe(true)
  })

  it('restores an existing baseline when reload changes runtime before activation', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-reload-baseline')
    const unitPath = join(directory, 'dsh-luban.service')
    const initial = new ModelRunner(unitPath)
    const installer = installerFor(directory, initial)
    await mkdir(directory, { recursive: true })
    await writeFile(unitPath, installer.render('ubuntu-server'), 'utf8')
    let reloads = 0
    const runner = new ModelRunner(
      unitPath,
      managedModel(unitPath),
      (call, state): ProcessResult | undefined => {
        if (!call.args.includes('daemon-reload')) return undefined
        reloads += 1
        if (reloads === 1) {
          state.model.unitFileState = 'enabled'
          state.model.activeState = 'active'
          state.model.subState = 'running'
          state.model.mainPid = 6161
          return processResult()
        }
        return undefined
      },
    )

    await expect(
      installerFor(directory, runner).install('builder', 'ubuntu-server'),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
    expect(reloads).toBe(2)
    expect(runner.model).toMatchObject({
      unitFileState: 'disabled',
      activeState: 'inactive',
      subState: 'dead',
      mainPid: 0,
    })
    expect(existsSync(unitPath)).toBe(true)
  })

  it('restores the three mutable enabled/active baseline combinations', async (): Promise<void> => {
    const baselines = [
      { unitFileState: 'disabled', activeState: 'inactive', subState: 'dead', mainPid: 0 },
      { unitFileState: 'enabled', activeState: 'inactive', subState: 'dead', mainPid: 0 },
      { unitFileState: 'disabled', activeState: 'active', subState: 'running', mainPid: 7001 },
    ] as const
    for (const [index, baseline] of baselines.entries()) {
      const directory = temporaryDirectory(`luban-systemd-restore-${String(index)}`)
      const unitPath = join(directory, 'dsh-luban.service')
      const runner = new ModelRunner(unitPath)
      const installer = installerFor(directory, runner)
      await mkdir(directory, { recursive: true })
      await writeFile(unitPath, installer.render('ubuntu-server'), 'utf8')
      runner.model = managedModel(unitPath, baseline)
      const original = { ...runner.model }
      const failing = new ModelRunner(
        unitPath,
        runner.model,
        (call, state): ProcessResult | undefined => {
          if (call.args.includes('enable') && call.args.includes('--now')) {
            state.model.unitFileState = 'enabled'
            state.model.activeState = 'active'
            state.model.subState = 'running'
            state.model.mainPid = 8001
            return processResult('', 1, 'activation failed')
          }
          return undefined
        },
      )
      const tested = installerFor(directory, failing)

      await expect(tested.install('builder', 'ubuntu-server')).rejects.toMatchObject({
        code: 'E_UNAVAILABLE',
      })
      expect(failing.model.unitFileState).toBe(original.unitFileState)
      expect(failing.model.activeState).toBe(original.activeState)
      expect(failing.model.subState).toBe(original.subState)
      expect(failing.model.mainPid === 0).toBe(original.mainPid === 0)
      expect(await readFile(unitPath, 'utf8')).toBe(tested.render('ubuntu-server'))
    }
  })

  it('leaves an already enabled and running exact unit untouched', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-ready')
    const unitPath = join(directory, 'dsh-luban.service')
    const runner = new ModelRunner(unitPath)
    const installer = installerFor(directory, runner)
    await mkdir(directory, { recursive: true })
    await writeFile(unitPath, installer.render('ubuntu-server'), 'utf8')
    runner.model = managedModel(unitPath, {
      unitFileState: 'enabled',
      activeState: 'active',
      subState: 'running',
      mainPid: 9002,
    })

    await installer.install('builder', 'ubuntu-server')
    expect(
      runner.calls.every(
        (call) =>
          !call.args.includes('enable') &&
          !call.args.includes('disable') &&
          !call.args.includes('daemon-reload'),
      ),
    ).toBe(true)
  })

  it('recovers or removes an exact crash-orphan whose manager is safely absent', async (): Promise<void> => {
    const installDirectory = temporaryDirectory('luban-systemd-orphan-install')
    const installPath = join(installDirectory, 'dsh-luban.service')
    const installRunner = new ModelRunner(installPath)
    const installTarget = installerFor(installDirectory, installRunner)
    await mkdir(installDirectory, { recursive: true })
    await writeFile(installPath, installTarget.render('ubuntu-server'), 'utf8')

    await expect(installTarget.preflight()).resolves.toMatchObject({ unit: 'exact', ready: true })
    await installTarget.install('builder', 'ubuntu-server')
    expect(installRunner.model).toMatchObject({
      unitFileState: 'enabled',
      activeState: 'active',
      mainPid: 4242,
    })

    const removeDirectory = temporaryDirectory('luban-systemd-orphan-remove')
    const removePath = join(removeDirectory, 'dsh-luban.service')
    const removeRunner = new ModelRunner(removePath)
    const removeTarget = installerFor(removeDirectory, removeRunner)
    await mkdir(removeDirectory, { recursive: true })
    await writeFile(removePath, removeTarget.render('ubuntu-server'), 'utf8')
    await removeTarget.uninstall()
    expect(existsSync(removePath)).toBe(false)
    expect(removeRunner.model).toEqual(absentModel())
    expect(removeRunner.calls.every((call) => !call.args.includes('disable'))).toBe(true)
  })

  it('fails closed when shutdown is not proven and never deletes the unit', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-uninstall-running')
    const unitPath = join(directory, 'dsh-luban.service')
    const runner = new ModelRunner(unitPath)
    const installer = installerFor(directory, runner)
    await mkdir(directory, { recursive: true })
    const expected = installer.render('ubuntu-server')
    await writeFile(unitPath, expected, 'utf8')
    runner.model = managedModel(unitPath, {
      unitFileState: 'enabled',
      activeState: 'active',
      subState: 'running',
      mainPid: 7777,
    })
    const failing = new ModelRunner(unitPath, runner.model, (call): ProcessResult | undefined =>
      call.args.includes('disable') ? processResult('', 1, 'still running') : undefined,
    )

    await expect(installerFor(directory, failing).uninstall()).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
    })
    expect(await readFile(unitPath, 'utf8')).toBe(expected)
    expect(failing.model.mainPid).toBe(7777)
  })

  it('does not claim success for a missing disk unit with a foreign active service', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-uninstall-foreign')
    const unitPath = join(directory, 'dsh-luban.service')
    const foreignPath = join(temporaryDirectory('luban-systemd-foreign-active'), 'foreign.service')
    await mkdir(dirname(foreignPath), { recursive: true })
    await writeFile(foreignPath, '[Service]\nExecStart=/foreign\n', 'utf8')
    const runner = new ModelRunner(
      unitPath,
      managedModel(foreignPath, {
        unitFileState: 'enabled',
        activeState: 'active',
        subState: 'running',
        mainPid: 8181,
      }),
    )

    await expect(installerFor(directory, runner).uninstall()).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
    })
    expect(runner.calls.every((call) => !call.args.includes('disable'))).toBe(true)
  })

  it('rolls back executable and fixed-PATH drift after activation', async (): Promise<void> => {
    const cases = ['dsh', 'path'] as const
    for (const kind of cases) {
      const directory = temporaryDirectory(`luban-systemd-launch-drift-${kind}`)
      const executableDirectory = temporaryDirectory(`luban-systemd-executable-${kind}`)
      const executable = join(executableDirectory, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
      await mkdir(executableDirectory, { recursive: true })
      await writeFile(executable, '#!/bin/sh\nexec node "$@"\n', 'utf8')
      await chmod(executable, 0o755)
      const unitPath = join(directory, 'dsh-luban.service')
      const pathBefore = process.env.PATH
      if (pathBefore === undefined) throw new Error('test PATH must be defined')
      const runner = new ModelRunner(
        unitPath,
        absentModel(),
        async (call, state): Promise<ProcessResult | undefined> => {
          if (!call.args.includes('enable') || !call.args.includes('--now')) return undefined
          state.model.unitFileState = 'enabled'
          state.model.activeState = 'active'
          state.model.subState = 'running'
          state.model.mainPid = 9191
          if (kind === 'dsh') {
            await rm(executable)
            await writeFile(executable, '#!/bin/sh\nexit 1\n', 'utf8')
            await chmod(executable, 0o755)
          } else {
            process.env.PATH = `${pathBefore}${delimiter}${executableDirectory}`
          }
          return processResult()
        },
      )

      try {
        await expect(
          installerFor(directory, runner, executable).install('builder', 'ubuntu-server'),
        ).rejects.toMatchObject({ code: kind === 'dsh' ? 'E_IO' : 'E_UNAVAILABLE' })
      } finally {
        process.env.PATH = pathBefore
      }
      expect(runner.calls.some((call) => call.args.includes('disable'))).toBe(true)
      expect(existsSync(unitPath)).toBe(false)
    }
  })

  it('never restarts an active baseline through a replaced executable', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-active-drift')
    const executableDirectory = temporaryDirectory('luban-systemd-active-executable')
    const executable = join(executableDirectory, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    await mkdir(executableDirectory, { recursive: true })
    await writeFile(executable, '#!/bin/sh\nexec node "$@"\n', 'utf8')
    await chmod(executable, 0o755)
    const unitPath = join(directory, 'dsh-luban.service')
    const initial = new ModelRunner(unitPath)
    const installer = installerFor(directory, initial, executable)
    await mkdir(directory, { recursive: true })
    await writeFile(unitPath, installer.render('ubuntu-server', await realpath(executable)), 'utf8')
    const runner = new ModelRunner(
      unitPath,
      managedModel(unitPath, {
        unitFileState: 'disabled',
        activeState: 'active',
        subState: 'running',
        mainPid: 7373,
      }),
      async (call, state): Promise<ProcessResult | undefined> => {
        if (!call.args.includes('enable') || !call.args.includes('--now')) return undefined
        state.model.unitFileState = 'enabled'
        await rm(executable)
        await writeFile(executable, '#!/bin/sh\nexit 1\n', 'utf8')
        await chmod(executable, 0o755)
        return processResult()
      },
    )

    await expect(
      installerFor(directory, runner, executable).install('builder', 'ubuntu-server'),
    ).rejects.toMatchObject({ code: 'E_IO' })
    expect(runner.model).toMatchObject({
      unitFileState: 'disabled',
      activeState: 'inactive',
      subState: 'dead',
      mainPid: 0,
    })
    expect(runner.calls.every((call) => !call.args.includes('start'))).toBe(true)
    expect(existsSync(unitPath)).toBe(true)
  })

  it('pins an explicit PATH for npm-style shims and rejects unsafe PATH entries', async (): Promise<void> => {
    const directory = temporaryDirectory('luban-systemd-shim')
    const executable = join(directory, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    await mkdir(directory, { recursive: true })
    await writeFile(executable, '#!/bin/sh\nexec node "$@"\n', 'utf8')
    await chmod(executable, 0o755)
    const runner = new ModelRunner(join(directory, 'dsh-luban.service'))
    const installer = installerFor(directory, runner, executable)
    const preflight = await installer.preflight()
    const resolvedExecutable = await realpath(executable)
    expect(isAbsolutePath(resolvedExecutable)).toBe(true)
    expect(Object.keys(preflight).sort()).toEqual(
      ['schemaVersion', 'service', 'user', 'unitPath', 'linger', 'unit', 'ready'].sort(),
    )
    const rendered = installer.render('ubuntu-server', resolvedExecutable)
    expect(rendered).toContain('Environment="PATH=')
    expect(rendered.indexOf(dirname(process.execPath))).toBeLessThan(rendered.indexOf('Restart='))

    const unsafeValues = [
      '',
      `.${delimiter}${dirname(process.execPath)}`,
      `${dirname(process.execPath)}${delimiter}${join(directory, 'bad%path')}`,
      `${dirname(process.execPath)}${delimiter}${join(directory, 'bad$path')}`,
      `${dirname(process.execPath)}${delimiter}${join(directory, 'bad\u0085path')}`,
    ]
    for (const unsafe of unsafeValues) {
      process.env.PATH = unsafe
      expect(() => installer.render('ubuntu-server', resolvedExecutable)).toThrow()
    }
  })

  it('resolves a PATH command and rejects relative executable paths', async (): Promise<void> => {
    process.env.PATH = dirname(process.execPath)
    const directory = temporaryDirectory('luban-systemd-path')
    const runner = new ModelRunner(join(directory, 'dsh-luban.service'))
    const installer = installerFor(directory, runner, basename(process.execPath))
    await expect(installer.preflight()).resolves.toMatchObject({ unit: 'missing', ready: true })

    const relative = installerFor(directory, runner, './dsh')
    await expect(relative.preflight()).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    expect(() => installer.render('ubuntu-server', join(directory, 'unsafe%name'))).toThrow(
      /invalid character/u,
    )
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
