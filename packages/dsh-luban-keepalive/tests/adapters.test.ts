import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CommandOptions, CommandResult, CommandRunner } from '../src/command-runner.js'
import { afterEach, describe, expect, it } from 'vitest'
import {
  managedSessionId,
  posixCommand,
  windowsArguments,
  windowsCommand,
} from '../src/session-id.js'
import { TmuxKeepaliveAdapter } from '../src/tmux-adapter.js'
import { WindowsTaskKeepaliveAdapter } from '../src/windows-adapter.js'
import {
  childTaskDefinition,
  hostTaskDefinition,
  renderWindowsTaskXml,
  WINDOWS_HOST_TASK_NAME,
  windowsSessionTaskName,
} from '../src/windows-task.js'
import { FakeScheduledTaskRunner } from './windows-task-fixture.js'

const directories = new Set<string>()

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly options: CommandOptions
}

class FakeRunner implements CommandRunner {
  public readonly calls: Call[] = []
  readonly #results: CommandResult[]

  public constructor(results: readonly Partial<CommandResult>[]) {
    this.#results = results.map((result): CommandResult => ({
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      durationMs: result.durationMs ?? 1,
    }))
  }

  public run(
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args, options })
    const result = this.#results.shift()
    if (result === undefined) throw new Error('FakeRunner has no queued result')
    return Promise.resolve(result)
  }
}

function temporaryDirectory(): string {
  const directory = join(tmpdir(), `luban-windows-task-${randomUUID()}`)
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

describe('session command encoding', (): void => {
  it('uses one collision-resistant namespace and shell-safe command encoders', (): void => {
    expect(managedSessionId('task-17')).toBe('luban-task-17')
    expect(() => managedSessionId('../bad')).toThrow(/session id/u)
    expect(posixCommand('dsh', ['--patch', "a'b", '$(touch nope)'])).toBe(
      "'dsh' '--patch' 'a'\"'\"'b' '$(touch nope)'",
    )
    expect(windowsCommand('C:\\Program Files\\dsh.exe', ['--patch', 'a "b"'])).toBe(
      '"C:\\Program Files\\dsh.exe" --patch "a \\"b\\""',
    )
    expect(() => windowsCommand('dsh', ['line-one\nline-two'])).toThrow(/control character/u)
  })
})

describe('TmuxKeepaliveAdapter', (): void => {
  it('creates an idempotent detached luban session using bounded argv calls', async (): Promise<void> => {
    const runner = new FakeRunner([{ exitCode: 1 }, { exitCode: 0 }])
    const adapter = new TmuxKeepaliveAdapter({ runner, timeoutMs: 4_000, host: 'build01' })
    const session = await adapter.create({
      id: 'compile-1',
      purpose: 'build',
      command: 'dsh',
      args: ['headless', '--patch', '/tmp/value;still-an-argument'],
    })

    expect(session).toMatchObject({ id: 'luban-compile-1', kind: 'tmux', purpose: 'build' })
    expect(runner.calls).toHaveLength(2)
    expect(runner.calls[0]).toMatchObject({
      command: 'tmux',
      args: ['has-session', '-t', '=luban-compile-1'],
      options: { timeoutMs: 4_000 },
    })
    expect(runner.calls[1]?.args).toEqual([
      'new-session',
      '-d',
      '-s',
      'luban-compile-1',
      '--',
      "'dsh' 'headless' '--patch' '/tmp/value;still-an-argument'",
    ])
  })

  it('lists only owned sessions and treats a missing tmux server as empty', async (): Promise<void> => {
    const listed = new FakeRunner([{ stdout: 'luban-a\nforeign\nluban-b\n' }])
    const adapter = new TmuxKeepaliveAdapter({ runner: listed, timeoutMs: 1_000, host: 'host' })
    expect((await adapter.list()).map((session) => session.id)).toEqual(['luban-a', 'luban-b'])

    const missing = new TmuxKeepaliveAdapter({
      runner: new FakeRunner([{ exitCode: 1, stderr: 'no server running on /tmp/tmux' }]),
      timeoutMs: 1_000,
    })
    await expect(missing.list()).resolves.toEqual([])
  })

  it('attaches and destroys only an exact managed tmux session', async (): Promise<void> => {
    const runner = new FakeRunner([{ exitCode: 0 }, { exitCode: 0 }])
    const adapter = new TmuxKeepaliveAdapter({ runner, timeoutMs: 1_000 })

    await adapter.attach('luban-build')
    await adapter.destroy({ id: 'luban-build', purpose: 'build', command: 'dsh' })

    expect(runner.calls[0]).toMatchObject({
      command: 'tmux',
      args: ['attach-session', '-t', '=luban-build'],
      options: { stdio: 'inherit' },
    })
    expect(runner.calls[1]).toMatchObject({
      command: 'tmux',
      args: ['kill-session', '-t', '=luban-build'],
    })
  })
})

describe('WindowsTaskKeepaliveAdapter', (): void => {
  it('registers one idempotent, triggerless S4U child task and starts it on demand', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    const adapter = new WindowsTaskKeepaliveAdapter({
      runner,
      timeoutMs: 5_000,
      host: 'win01',
      currentUser: 'builder',
      currentUserSid: 'S-1-5-21-1000',
      temporaryDirectory: temporaryDirectory(),
    })
    const session = await adapter.create({
      id: 'main',
      purpose: 'dsh-main',
      command: 'C:\\Program Files\\dsh.exe',
      args: ['web', '--patch', 'C:\\profile path\\cordis.yml'],
    })

    expect(session).toMatchObject({ id: 'luban-main', kind: 'service' })
    const name = windowsSessionTaskName('luban-main')
    const xml = runner.tasks.get(name)
    expect(xml).toContain('<LogonType>S4U</LogonType>')
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(xml).toContain('<Command>C:\\Program Files\\dsh.exe</Command>')
    expect(xml).toContain('web --patch &quot;C:\\profile path\\cordis.yml&quot;')
    expect(xml).not.toContain('<BootTrigger>')
    expect(xml).not.toContain('<Triggers>')
    expect(runner.running.has(name)).toBe(true)
    expect(
      runner.calls.every(
        (call): boolean =>
          !call.args.some((arg) => ['/RP', '/RU', '/NP', '/SC', 'ONSTART'].includes(arg)),
      ),
    ).toBe(true)
    expect(
      runner.calls.every(
        (call): boolean => !call.args.some((arg) => arg.startsWith('\\dsh-luban\\')),
      ),
    ).toBe(true)

    await adapter.create({
      id: 'main',
      purpose: 'dsh-main',
      command: 'C:\\Program Files\\dsh.exe',
      args: ['web', '--patch', 'C:\\profile path\\cordis.yml'],
    })
    expect(runner.calls.filter((call) => call.args[0] === '/Create')).toHaveLength(1)
    expect(runner.calls.filter((call) => call.args[0] === '/Run')).toHaveLength(1)
  })

  it('resolves and pins the current user SID without a password-bearing schtasks call', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    const adapter = new WindowsTaskKeepaliveAdapter({
      runner,
      timeoutMs: 1_000,
      currentUser: 'builder',
      temporaryDirectory: temporaryDirectory(),
    })

    await adapter.create({ id: 'sid', purpose: 'task', command: 'dsh', args: ['resume'] })

    expect(runner.calls[0]).toMatchObject({
      command: 'whoami.exe',
      args: ['/user', '/fo', 'csv', '/nh'],
    })
    expect(runner.createdXml[0]).toContain('<UserId>S-1-5-21-1000</UserId>')
    expect(runner.createdXml[0]).toMatch(/^<\?xml version="1\.0" encoding="UTF-16"\?>/u)
    expect(runner.createdEncoding).toEqual(['utf16le-bom'])
    expect(
      runner.calls
        .filter((call) => call.command === 'schtasks.exe')
        .every((call) => !call.args.includes('/RP') && !call.args.includes('/RU')),
    ).toBe(true)
  })

  it('recognizes only a running managed child and rejects interactive attach', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    const definition = childTaskDefinition({
      id: 'luban-main',
      principalSid: 'S-1-5-21-1000',
      command: 'dsh',
      arguments: 'resume',
    })
    runner.tasks.set(definition.name, renderWindowsTaskXml(definition))
    runner.running.add(definition.name)
    const adapter = new WindowsTaskKeepaliveAdapter({
      runner,
      timeoutMs: 1_000,
      currentUser: 'builder',
      currentUserSid: 'S-1-5-21-1000',
    })
    await expect(adapter.isAlive('luban-main')).resolves.toBe(true)
    await expect(adapter.isAlive('luban-main')).resolves.toBe(true)
    await expect(adapter.attach('luban-main')).rejects.toMatchObject({
      code: 'E_PLATFORM_UNSUPPORTED',
    })

    runner.tasks.set(definition.name, '<Task><BootTrigger /></Task>')
    await expect(adapter.isAlive('luban-main')).resolves.toBe(false)
  })

  it('lists structurally owned tasks but destroys only the exact persisted child specification', async (): Promise<void> => {
    const runner = new FakeScheduledTaskRunner()
    const child = childTaskDefinition({
      id: 'luban-main',
      principalSid: 'S-1-5-21-1000',
      command: 'dsh',
      arguments: 'resume',
    })
    runner.tasks.set(child.name, renderWindowsTaskXml(child))
    runner.tasks.set(
      WINDOWS_HOST_TASK_NAME,
      renderWindowsTaskXml(
        hostTaskDefinition('S-1-5-21-1000', {
          nodeExecutable: process.execPath,
          bootstrapPath: resolve('dist/windows-host-bootstrap.js'),
          dshEntry: resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),
          dshHome: resolve('.dsh'),
          profile: 'win-debug',
        }),
      ),
    )
    runner.tasks.set('\\foreign', '<Task />')
    runner.tasks.set(windowsSessionTaskName('luban-spoof'), '<Task />')
    const adapter = new WindowsTaskKeepaliveAdapter({
      runner,
      timeoutMs: 1_000,
      host: 'win01',
      currentUser: 'builder',
      currentUserSid: 'S-1-5-21-1000',
    })

    await expect(adapter.list()).resolves.toEqual([
      expect.objectContaining({ id: 'luban-main', kind: 'service' }),
    ])
    await expect(adapter.list()).resolves.toEqual([
      expect.objectContaining({ id: 'luban-main', kind: 'service' }),
    ])
    const spec = { id: 'luban-main', purpose: 'task', command: 'dsh', args: ['resume'] } as const
    await adapter.destroy(spec)
    await adapter.destroy(spec)

    expect(runner.tasks.has(child.name)).toBe(false)
    expect(runner.tasks.has(WINDOWS_HOST_TASK_NAME)).toBe(true)
    expect(runner.calls.filter((call) => call.args[0] === '/Delete')).toHaveLength(1)
  })

  it('rejects conflicting tasks and rolls back registration or start failures', async (): Promise<void> => {
    const conflictRunner = new FakeScheduledTaskRunner()
    const conflictName = windowsSessionTaskName('luban-conflict')
    conflictRunner.tasks.set(conflictName, '<Task><BootTrigger /></Task>')
    const conflict = new WindowsTaskKeepaliveAdapter({
      runner: conflictRunner,
      timeoutMs: 1_000,
      currentUser: 'builder',
      currentUserSid: 'S-1-5-21-1000',
      temporaryDirectory: temporaryDirectory(),
    })
    await expect(
      conflict.create({ id: 'conflict', purpose: 'task', command: 'dsh', args: [] }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    await expect(
      conflict.destroy({ id: 'luban-conflict', purpose: 'task', command: 'dsh', args: [] }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    expect(conflictRunner.tasks.has(conflictName)).toBe(true)

    const concurrentRunner = new FakeScheduledTaskRunner()
    concurrentRunner.failNextCreateAfterStore = true
    const concurrent = new WindowsTaskKeepaliveAdapter({
      runner: concurrentRunner,
      timeoutMs: 1_000,
      currentUser: 'builder',
      currentUserSid: 'S-1-5-21-1000',
      temporaryDirectory: temporaryDirectory(),
    })
    await expect(
      concurrent.create({ id: 'create', purpose: 'task', command: 'dsh', args: ['resume'] }),
    ).resolves.toMatchObject({ id: 'luban-create' })
    expect(concurrentRunner.tasks.has(windowsSessionTaskName('luban-create'))).toBe(true)
    expect(concurrentRunner.calls.some((call) => call.args[0] === '/Delete')).toBe(false)

    for (const failure of ['run'] as const) {
      const runner = new FakeScheduledTaskRunner()
      runner.failNextRun = true
      const adapter = new WindowsTaskKeepaliveAdapter({
        runner,
        timeoutMs: 1_000,
        currentUser: 'builder',
        currentUserSid: 'S-1-5-21-1000',
        temporaryDirectory: temporaryDirectory(),
      })
      await expect(
        adapter.create({ id: failure, purpose: 'task', command: 'dsh', args: ['resume'] }),
      ).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
      expect(runner.tasks.has(windowsSessionTaskName(`luban-${failure}`))).toBe(false)
    }
  })

  it('refuses a replaced child task both before cleanup and between the exact ownership checks', async (): Promise<void> => {
    const spec = {
      id: 'luban-cleanup',
      purpose: 'task',
      command: 'C:\\workspace\\node.exe',
      args: ['C:\\workspace\\worker.js', '--run-id', 'owned'],
    } as const
    const expected = childTaskDefinition({
      id: spec.id,
      principalSid: 'S-1-5-21-1000',
      command: spec.command,
      arguments: windowsArguments(spec.args),
    })
    const foreign = childTaskDefinition({
      id: spec.id,
      principalSid: 'S-1-5-21-1000',
      command: 'C:\\foreign\\payload.exe',
      arguments: '--foreign',
    })
    const foreignXml = renderWindowsTaskXml(foreign)

    const replacedBefore = new FakeScheduledTaskRunner()
    replacedBefore.tasks.set(expected.name, foreignXml)
    const beforeAdapter = new WindowsTaskKeepaliveAdapter({
      runner: replacedBefore,
      timeoutMs: 1_000,
      currentUser: 'builder',
      currentUserSid: 'S-1-5-21-1000',
    })
    await expect(beforeAdapter.destroy(spec)).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    expect(replacedBefore.tasks.get(expected.name)).toBe(foreignXml)
    expect(replacedBefore.calls.some((call) => call.args[0] === '/End')).toBe(false)
    expect(replacedBefore.calls.some((call) => call.args[0] === '/Delete')).toBe(false)

    const replacedDuring = new FakeScheduledTaskRunner()
    replacedDuring.tasks.set(expected.name, renderWindowsTaskXml(expected))
    replacedDuring.running.add(expected.name)
    replacedDuring.replaceTaskAfterEnd = { name: expected.name, xml: foreignXml }
    const duringAdapter = new WindowsTaskKeepaliveAdapter({
      runner: replacedDuring,
      timeoutMs: 1_000,
      currentUser: 'builder',
      currentUserSid: 'S-1-5-21-1000',
    })
    await expect(duringAdapter.destroy(spec)).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    expect(replacedDuring.tasks.get(expected.name)).toBe(foreignXml)
    expect(replacedDuring.calls.filter((call) => call.args[0] === '/End')).toHaveLength(1)
    expect(replacedDuring.calls.some((call) => call.args[0] === '/Delete')).toBe(false)
  })

  it('fails closed on a query error instead of treating it as a missing task', async (): Promise<void> => {
    const runner = new FakeRunner([
      { exitCode: 1, stderr: 'ERROR: Access is denied.' },
      { exitCode: 1, stderr: 'ERROR: Access is denied.' },
    ])
    const adapter = new WindowsTaskKeepaliveAdapter({
      runner,
      timeoutMs: 1_000,
      currentUser: 'builder',
      currentUserSid: 'S-1-5-21-1000',
    })
    await expect(
      adapter.create({ id: 'denied', purpose: 'task', command: 'dsh', args: [] }),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
    expect(runner.calls).toHaveLength(2)
  })
})
