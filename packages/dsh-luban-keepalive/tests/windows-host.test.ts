import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

const HOST_LAUNCH = Object.freeze({
  nodeExecutable: process.execPath,
  bootstrapPath: resolve('packages/dsh-luban-keepalive/dist/windows-host-bootstrap.js'),
  dshEntry: resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),
  dshHome: resolve('.dsh'),
  profile: 'win-debug' as const,
})

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
    launch: HOST_LAUNCH,
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
    const host = hostTaskDefinition('S-1-5-21-1000', HOST_LAUNCH)
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
    expect(host.command).toBe(process.execPath)
    expect(host.arguments).toContain(HOST_LAUNCH.bootstrapPath)
    expect(host.arguments).toContain(HOST_LAUNCH.dshEntry)
    expect(hostXml).not.toContain('powershell')
    expect(childXml).not.toContain('<BootTrigger>')
    expect(childXml).not.toContain('<Triggers>')
    expect(matchesWindowsTaskXml(hostXml, host)).toBe(true)
    expect(matchesWindowsTaskXml(childXml, child)).toBe(true)
    const normalizedHostXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${host.description}</Description>
    <URI>${host.name}</URI>
  </RegistrationInfo>
  <Principals><Principal id="CurrentUser">
    <UserId>${host.principalSid}</UserId><LogonType>S4U</LogonType>
  </Principal></Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <RestartOnFailure><Count>3</Count><Interval>PT1M</Interval></RestartOnFailure>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
  </Settings>
  <Triggers><BootTrigger /></Triggers>
  <Actions Context="CurrentUser"><Exec>
    <Command>${host.command}</Command><Arguments>${host.arguments}</Arguments>
  </Exec></Actions>
</Task>
`
    expect(matchesWindowsTaskXml(normalizedHostXml, host)).toBe(true)
    expect(matchesWindowsTaskXml(normalizedHostXml.replace('<URI>', '<URI>foreign-'), host)).toBe(
      false,
    )
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
      launch: HOST_LAUNCH,
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

  it('starts only an exact installed host task and reuses the running instance', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    const host = operator(runner)

    await expect(host.start()).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    await host.install()
    await host.start()
    await host.start()

    expect(runner.running.has(WINDOWS_HOST_TASK_NAME)).toBe(true)
    expect(runner.calls.filter((call) => call.args[0] === '/Run')).toHaveLength(1)
  })

  it('reports only the exact acceptance child command as running', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    const host = operator(runner)
    const input = {
      id: 'luban-m03-11111111-1111-4111-8111-111111111111',
      command: process.execPath,
      args: [resolve('worker.js'), '--run-id', '11111111-1111-4111-8111-111111111111'],
    }
    const definition = childTaskDefinition({
      id: input.id,
      principalSid: 'S-1-5-21-1000',
      command: input.command,
      arguments: input.args.join(' '),
    })
    runner.tasks.set(definition.name, renderWindowsTaskXml(definition))
    runner.running.add(definition.name)

    await expect(host.childStatus(input)).resolves.toEqual({
      taskName: definition.name,
      state: 'exact',
      running: true,
    })

    runner.tasks.set(definition.name, renderWindowsTaskXml({ ...definition, command: 'calc.exe' }))
    await expect(host.childStatus(input)).resolves.toEqual({
      taskName: definition.name,
      state: 'conflict',
      running: null,
    })
  })

  it('binds acceptance identity into the absolute Node bootstrap arguments', (): void => {
    const runId = '11111111-1111-4111-8111-111111111111'
    const definition = hostTaskDefinition('S-1-5-21-1000', {
      ...HOST_LAUNCH,
      acceptance: {
        runDir: resolve('private-m03-run'),
        runId,
        specSha256: 'a'.repeat(64),
      },
    })

    expect(definition.command).toBe(process.execPath)
    expect(definition.arguments).toContain('--acceptance-run-dir')
    expect(definition.arguments).toContain('--acceptance-run-id')
    expect(definition.arguments).toContain(runId)
    expect(definition.arguments).toContain('--acceptance-spec-sha256')
    expect(definition.arguments.toLocaleLowerCase('en-US')).not.toContain('powershell')
    expect(() =>
      hostTaskDefinition('S-1-5-21-1000', { ...HOST_LAUNCH, nodeExecutable: 'node.exe' }),
    ).toThrow()
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
      launch: HOST_LAUNCH,
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

  it('requires explicit bound arguments for the combined host and child acceptance status', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    const host = operator(runner)
    const runDir = resolve('private-m03-run')
    const runId = '11111111-1111-4111-8111-111111111111'
    const sessionId = `luban-m03-${runId}`
    const worker = resolve('worker.js')
    const child = childTaskDefinition({
      id: sessionId,
      principalSid: 'S-1-5-21-1000',
      command: process.execPath,
      arguments: [
        worker,
        '--run-dir',
        runDir,
        '--run-id',
        runId,
        '--spec-sha256',
        'a'.repeat(64),
      ].join(' '),
    })
    runner.tasks.set(child.name, renderWindowsTaskXml(child))
    runner.running.add(child.name)

    const result = await runWindowsOperatorCli(
      [
        'acceptance-status',
        '--acceptance-run-dir',
        runDir,
        '--acceptance-run-id',
        runId,
        '--acceptance-spec-sha256',
        'a'.repeat(64),
        '--session-id',
        sessionId,
        '--worker',
        worker,
      ],
      { operator: host },
    )
    expect(result.exitCode).toBe(0)
    expect(envelope(result.output)).toMatchObject({
      status: { child: { taskName: child.name, state: 'exact', running: true } },
    })
    const incomplete = await runWindowsOperatorCli(['acceptance-status'], { operator: host })
    expect(incomplete.exitCode).toBe(1)
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
