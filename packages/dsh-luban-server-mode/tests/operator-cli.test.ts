import { existsSync, realpathSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runOperatorCli } from '../src/operator-cli.js'
import type { ProcessOptions, ProcessResult, ProcessRunner } from '../src/process-runner.js'
import { UserSystemdInstaller } from '../src/systemd.js'

const directories = new Set<string>()
const originalPath = process.env.PATH

interface ProcessCall {
  readonly command: string
  readonly args: readonly string[]
  readonly options: ProcessOptions
}

class FakeRunner implements ProcessRunner {
  public readonly calls: ProcessCall[] = []
  public unitPath: string | undefined
  public linger = 'yes'
  public loaded = false
  public enabled = false
  public active = false
  readonly #respond: ((call: ProcessCall) => ProcessResult | undefined) | undefined

  public constructor(respond?: (call: ProcessCall) => ProcessResult | undefined) {
    this.#respond = respond
  }

  public run(
    command: string,
    args: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    const call = { command, args, options }
    this.calls.push(call)
    const custom = this.#respond?.(call)
    if (custom !== undefined) return Promise.resolve(custom)
    if (command === 'loginctl') return Promise.resolve(result(`${this.linger}\n`))
    if (args.includes('show')) return Promise.resolve(result(this.#snapshot()))
    if (args.includes('daemon-reload')) {
      this.loaded = this.unitPath !== undefined && existsSync(this.unitPath)
      if (!this.loaded) {
        this.enabled = false
        this.active = false
      }
      return Promise.resolve(result())
    }
    if (args.includes('enable') && args.includes('--now')) {
      this.enabled = true
      this.active = true
      return Promise.resolve(result())
    }
    if (args.includes('disable')) {
      this.enabled = false
      this.active = false
      return Promise.resolve(result())
    }
    return Promise.resolve(result())
  }

  #snapshot(): string {
    const service = 'dsh-luban.service'
    return [
      `Id=${service}`,
      `LoadState=${this.loaded ? 'loaded' : 'not-found'}`,
      `FragmentPath=${this.loaded && this.unitPath !== undefined ? realpathSync(this.unitPath) : ''}`,
      'DropInPaths=',
      'NeedDaemonReload=no',
      `UnitFileState=${this.loaded ? (this.enabled ? 'enabled' : 'disabled') : ''}`,
      `ActiveState=${this.active ? 'active' : 'inactive'}`,
      `SubState=${this.active ? 'running' : 'dead'}`,
      `MainPID=${this.active ? '4242' : '0'}`,
      `Type=${this.loaded ? 'exec' : ''}`,
      '',
    ].join('\n')
  }
}

function result(stdout = '', exitCode = 0, stderr = ''): ProcessResult {
  return { exitCode, stdout, stderr, durationMs: 1 }
}

function temporaryDirectory(): string {
  const directory = join(tmpdir(), `luban-operator-${randomUUID()}`)
  directories.add(directory)
  return directory
}

function installer(runner: ProcessRunner): UserSystemdInstaller {
  const target = new UserSystemdInstaller({
    runner,
    serviceName: 'dsh-luban',
    dshExecutable: process.execPath,
    timeoutMs: 1_000,
    platform: 'linux',
    unitDirectory: temporaryDirectory(),
    currentUser: 'builder',
  })
  if (runner instanceof FakeRunner) runner.unitPath = target.unitPath
  return target
}

function envelope(output: string): Readonly<Record<string, unknown>> {
  return JSON.parse(output) as Readonly<Record<string, unknown>>
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

describe('server-mode operator CLI', (): void => {
  it('defaults to a read-only install plan', async (): Promise<void> => {
    const runner = new FakeRunner()
    const target = installer(runner)

    const execution = await runOperatorCli([], { installer: target })

    expect(execution.exitCode).toBe(0)
    expect(envelope(execution.output)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: 'plan',
      mode: 'plan',
      action: 'install',
      preflight: { linger: 'enabled', unit: 'missing', ready: true },
    })
    expect(runner.calls.some((call) => call.args.includes('show'))).toBe(true)
    expect(
      runner.calls.every(
        (call) => !call.args.includes('enable') && !call.args.includes('daemon-reload'),
      ),
    ).toBe(true)
    await expect(readFile(target.unitPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires both an explicit mutation command and --apply', async (): Promise<void> => {
    const runner = new FakeRunner()
    const target = installer(runner)

    const planned = await runOperatorCli(['install'], { installer: target })
    expect(envelope(planned.output)).toMatchObject({ command: 'install', mode: 'plan' })
    await expect(readFile(target.unitPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const rejected = await runOperatorCli(['--apply'], { installer: target })
    expect(rejected.exitCode).toBe(1)
    expect(envelope(rejected.output)).toMatchObject({
      ok: false,
      error: { code: 'E_INVALID_INPUT' },
    })
    expect(runner.calls.every((call) => !call.args.includes('enable'))).toBe(true)

    const installed = await runOperatorCli(['install', '--apply'], { installer: target })
    expect(installed.exitCode).toBe(0)
    expect(envelope(installed.output)).toMatchObject({
      ok: true,
      command: 'install',
      mode: 'apply',
      applied: true,
    })
    expect(await readFile(target.unitPath, 'utf8')).toContain(
      `ExecStart="${process.execPath.replaceAll('\\', '\\\\')}" "--profile" "ubuntu-server" "--no-open"`,
    )

    const uninstalled = await runOperatorCli(['uninstall', '--apply'], { installer: target })
    expect(uninstalled.exitCode).toBe(0)
    expect(envelope(uninstalled.output)).toMatchObject({
      ok: true,
      command: 'uninstall',
      mode: 'apply',
      applied: true,
    })
    await expect(readFile(target.unitPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('provides read-only preflight and status with no raw command output', async (): Promise<void> => {
    const secret = 'server-mode-test-secret-value'
    const runner = new FakeRunner((call): ProcessResult | undefined => {
      if (call.command === 'loginctl') return result('no\n', 0, secret)
      if (call.args.includes('show')) return undefined
      return undefined
    })
    const target = installer(runner)

    const preflight = await runOperatorCli(['preflight'], { installer: target })
    expect(preflight.exitCode).toBe(2)
    expect(envelope(preflight.output)).toMatchObject({
      ok: false,
      mode: 'read-only',
      preflight: { linger: 'disabled', ready: false },
    })
    const status = await runOperatorCli(['status'], { installer: target })
    expect(status.exitCode).toBe(0)
    expect(envelope(status.output)).toMatchObject({
      ok: true,
      mode: 'read-only',
      status: { linger: 'disabled', enabled: 'not-found', active: 'inactive' },
    })
    expect(`${preflight.output}${status.output}`).not.toContain(secret)
    expect(runner.calls.every((call) => !call.args.includes('enable-linger'))).toBe(true)
  })

  it('fails safely for another user and does not echo rejected argv values', async (): Promise<void> => {
    const runner = new FakeRunner()
    const target = installer(runner)
    const otherUser = await runOperatorCli(['install', '--apply', '--user', 'other'], {
      installer: target,
    })
    expect(otherUser.exitCode).toBe(1)
    expect(envelope(otherUser.output)).toMatchObject({
      error: { code: 'E_INVALID_INPUT' },
    })
    expect(otherUser.output).toContain('current user')
    expect(runner.calls).toHaveLength(0)

    const secret = 'do-not-echo-this-secret'
    const invalid = await runOperatorCli(['--password', secret], { installer: target })
    expect(invalid.exitCode).toBe(1)
    expect(invalid.output).not.toContain(secret)
    expect(envelope(invalid.output)).toMatchObject({ error: { code: 'E_INVALID_INPUT' } })
  })

  it('publishes the executable operator bin', async (): Promise<void> => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<Record<string, unknown>>
    expect(manifest.bin).toEqual({
      'luban-build-worker': './dist/build-worker.js',
      'luban-server-mode': './dist/operator-cli.js',
    })
  })
})
