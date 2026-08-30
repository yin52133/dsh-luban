import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  childTaskDefinition,
  hostTaskDefinition,
  isManagedChildTaskXml,
  matchesWindowsTaskXml,
  renderWindowsTaskXml,
  WINDOWS_HOST_TASK_NAME,
  WINDOWS_SESSION_TASK_PREFIX,
} from '../src/windows-task.js'
import { WindowsHostTaskOperator } from '../src/windows-host.js'
import { runWindowsOperatorCli } from '../src/windows-operator-cli.js'
import { FakeScheduledTaskRunner } from './windows-task-fixture.js'

const directories = new Set<string>()

function temporaryDirectory(): string {
  const directory = join(tmpdir(), `luban-windows-host-${randomUUID()}`)
  directories.add(directory)
  return directory
}

function operator(
  runner: FakeScheduledTaskRunner,
  platform: NodeJS.Platform = 'win32',
): WindowsHostTaskOperator {
  return new WindowsHostTaskOperator({
    runner,
    timeoutMs: 1_000,
    platform,
    currentUser: 'builder',
    currentUserSid: 'S-1-5-21-1000',
    temporaryDirectory: temporaryDirectory(),
  })
}

function envelope(output: string): Readonly<Record<string, unknown>> {
  return JSON.parse(output) as Readonly<Record<string, unknown>>
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
    }),
  )
})

describe('Windows deployment host task', (): void => {
  it('uses a boot-only host namespace and a triggerless child namespace', (): void => {
    const host = hostTaskDefinition('S-1-5-21-1000')
    const child = childTaskDefinition({
      id: 'luban-job',
      principalSid: 'S-1-5-21-1000',
      command: 'dsh',
      arguments: 'resume',
    })
    const hostXml = renderWindowsTaskXml(host)
    const childXml = renderWindowsTaskXml(child)

    expect(host.name).toBe(WINDOWS_HOST_TASK_NAME)
    expect(host.name.startsWith(WINDOWS_SESSION_TASK_PREFIX)).toBe(false)
    expect(child.name.startsWith(WINDOWS_SESSION_TASK_PREFIX)).toBe(true)
    expect(hostXml).toContain('<BootTrigger>')
    expect(hostXml).toContain('<LogonType>S4U</LogonType>')
    expect(hostXml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(hostXml).toContain('$env:LUBAN_BOOT_RESTORE=&apos;1&apos;')
    expect(hostXml).toContain(
      '&amp; &apos;dsh&apos; &apos;--profile&apos; &apos;win-debug&apos; &apos;--no-open&apos;',
    )
    expect(childXml).not.toContain('<BootTrigger>')
    expect(childXml).not.toContain('<Triggers>')
    expect(matchesWindowsTaskXml(hostXml, host)).toBe(true)
    expect(matchesWindowsTaskXml(childXml, child)).toBe(true)
    expect(matchesWindowsTaskXml(hostXml.replace('<BootTrigger>', '<LogonTrigger>'), host)).toBe(
      false,
    )
    const extraAction = childXml.replace(
      '  </Actions>',
      '    <Exec><Command>calc.exe</Command></Exec>\n  </Actions>',
    )
    expect(matchesWindowsTaskXml(extraAction, child)).toBe(false)
    expect(isManagedChildTaskXml(extraAction, 'S-1-5-21-1000')).toBe(false)
    expect(
      matchesWindowsTaskXml(
        hostXml.replace('<Enabled>true</Enabled>', '<Enabled>false</Enabled>'),
        host,
      ),
    ).toBe(false)
    expect(
      matchesWindowsTaskXml(
        hostXml.replace(
          '</Actions>',
          '<ComHandler><ClassId>{00000000-0000-0000-0000-000000000000}</ClassId></ComHandler></Actions>',
        ),
        host,
      ),
    ).toBe(false)
  })

  it('plans and reports status without staging or mutating a task', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    const host = operator(runner)

    await expect(host.plan()).resolves.toMatchObject({
      action: 'install',
      state: 'missing',
      mutationRequired: true,
      ready: true,
      command: 'dsh',
      args: ['--profile', 'win-debug', '--no-open'],
      environment: { LUBAN_BOOT_RESTORE: '1' },
      elevated: true,
      operationallyVerified: false,
      s4uCapabilities: { networkResources: false, encryptedFiles: false },
    })
    expect(
      runner.calls.every(
        (call) =>
          call.command === 'powershell.exe' ||
          (call.command === 'schtasks.exe' && call.args[0] === '/Query'),
      ),
    ).toBe(true)
    expect(runner.createdXml).toHaveLength(0)
  })

  it('recognizes a missing task even when schtasks diagnostics are OEM-garbled', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    runner.missingStderr = '����: ϵͳ�Ҳ���ָ�����ļ���'

    await expect(operator(runner).plan()).resolves.toMatchObject({ state: 'missing', ready: true })
    expect(runner.calls.slice(0, 2).map((call) => call.args)).toEqual([
      ['/Query', '/TN', WINDOWS_HOST_TASK_NAME, '/XML'],
      ['/Query', '/FO', 'CSV', '/NH'],
    ])
    expect(runner.calls[2]?.command).toBe('powershell.exe')
  })

  it('installs and uninstalls idempotently without a password or immediate host start', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    const host = operator(runner)

    await host.install()
    await host.install()

    expect(runner.tasks.has(WINDOWS_HOST_TASK_NAME)).toBe(true)
    expect(runner.createdXml).toHaveLength(1)
    expect(runner.createdXml[0]).toContain('<BootTrigger>')
    expect(runner.createdXml[0]).toContain('<LogonType>S4U</LogonType>')
    expect(runner.calls.filter((call) => call.args[0] === '/Run')).toHaveLength(0)
    expect(
      runner.calls.every(
        (call): boolean =>
          !call.args.some((arg) => ['/RP', '/RU', '/NP', '/SC', 'ONSTART'].includes(arg)),
      ),
    ).toBe(true)

    await host.uninstall()
    await host.uninstall()
    expect(runner.tasks.has(WINDOWS_HOST_TASK_NAME)).toBe(false)
    expect(runner.calls.filter((call) => call.args[0] === '/Delete')).toHaveLength(1)
  })

  it('rejects foreign tasks and reuses an exact task after a concurrent create result', async (): Promise<void> => {
    const conflictRunner = new FakeScheduledTaskRunner()
    conflictRunner.tasks.set(WINDOWS_HOST_TASK_NAME, '<Task><BootTrigger /></Task>')
    const conflict = operator(conflictRunner)
    await expect(conflict.install()).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    await expect(conflict.uninstall()).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    expect(conflictRunner.calls.some((call) => call.args[0] === '/Delete')).toBe(false)

    const rollbackRunner = new FakeScheduledTaskRunner()
    rollbackRunner.failNextCreateAfterStore = true
    const rollback = operator(rollbackRunner)
    await expect(rollback.install()).resolves.toBeUndefined()
    expect(rollbackRunner.tasks.has(WINDOWS_HOST_TASK_NAME)).toBe(true)
    expect(rollbackRunner.calls.some((call) => call.args[0] === '/Delete')).toBe(false)
  })

  it('fails before schtasks when the resolved identity is not the current user', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    const host = new WindowsHostTaskOperator({
      runner,
      timeoutMs: 1_000,
      platform: 'win32',
      currentUser: 'other',
      temporaryDirectory: temporaryDirectory(),
    })

    await expect(host.plan()).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.command).toBe('whoami.exe')
  })

  it('blocks boot-task mutation when the operator is not elevated', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    runner.elevated = false
    const host = operator(runner)

    await expect(host.plan()).resolves.toMatchObject({
      state: 'missing',
      elevated: false,
      mutationRequired: true,
      ready: false,
    })
    await expect(host.install()).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
    expect(runner.calls.some((call) => call.args[0] === '/Create')).toBe(false)
  })

  it('rejects unsupported platforms before invoking the task runner', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    await expect(operator(runner, 'linux').plan()).rejects.toMatchObject({
      code: 'E_PLATFORM_UNSUPPORTED',
    })
    expect(runner.calls).toHaveLength(0)
  })
})

describe('Windows host operator CLI', (): void => {
  it('defaults to plan-only and requires an explicit command plus --apply', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    const host = operator(runner)

    const planned = await runWindowsOperatorCli([], { operator: host })
    expect(planned.exitCode).toBe(0)
    expect(envelope(planned.output)).toMatchObject({
      ok: true,
      command: 'plan',
      mode: 'plan',
      plan: { action: 'install', state: 'missing', trigger: 'boot', logon: 's4u' },
    })
    expect(runner.createdXml).toHaveLength(0)

    const rejected = await runWindowsOperatorCli(['--apply'], { operator: host })
    expect(rejected.exitCode).toBe(1)
    expect(envelope(rejected.output)).toMatchObject({ error: { code: 'E_INVALID_INPUT' } })

    const preview = await runWindowsOperatorCli(['install'], { operator: host })
    expect(envelope(preview.output)).toMatchObject({ command: 'install', mode: 'plan' })
    expect(runner.createdXml).toHaveLength(0)

    const installed = await runWindowsOperatorCli(['install', '--apply'], { operator: host })
    expect(installed.exitCode).toBe(0)
    expect(envelope(installed.output)).toMatchObject({
      ok: true,
      command: 'install',
      mode: 'apply',
      applied: true,
    })
    expect(runner.tasks.has(WINDOWS_HOST_TASK_NAME)).toBe(true)

    const uninstalled = await runWindowsOperatorCli(['uninstall', '--apply'], { operator: host })
    expect(uninstalled.exitCode).toBe(0)
    expect(runner.tasks.has(WINDOWS_HOST_TASK_NAME)).toBe(false)
  })

  it('emits structured status without raw runner output or rejected argv secrets', async (): Promise<void> => {
    const secret = 'windows-operator-secret-value'
    const runner = new FakeScheduledTaskRunner()
    const host = operator(runner)
    await host.install()
    runner.statusStderr = secret

    const status = await runWindowsOperatorCli(['status'], { operator: host })
    expect(status.exitCode).toBe(0)
    expect(envelope(status.output)).toMatchObject({
      ok: true,
      mode: 'read-only',
      status: { state: 'exact', running: false },
    })
    expect(status.output).not.toContain(secret)

    const rejectedSecret = 'do-not-echo-this-value'
    const invalid = await runWindowsOperatorCli(['--password', rejectedSecret], { operator: host })
    expect(invalid.exitCode).toBe(1)
    expect(invalid.output).not.toContain(rejectedSecret)
  })

  it('publishes the executable operator bin', async (): Promise<void> => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<Record<string, unknown>>
    expect(manifest.bin).toEqual({
      'luban-keepalive-windows': './dist/windows-operator-cli.js',
    })
  })
})
