import type { CommandOptions, CommandResult, CommandRunner } from '../src/command-runner.js'
import { describe, expect, it } from 'vitest'
import { managedSessionId, posixCommand, windowsCommand } from '../src/session-id.js'
import { TmuxKeepaliveAdapter } from '../src/tmux-adapter.js'
import { WindowsTaskKeepaliveAdapter } from '../src/windows-adapter.js'

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
    await adapter.destroy('luban-build')

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
  it('registers and starts a native ONSTART task without invoking a shell', async (): Promise<void> => {
    const runner = new FakeRunner([
      { exitCode: 1 },
      { exitCode: 0 },
      { exitCode: 0, stdout: 'Status: Ready' },
      { exitCode: 0 },
    ])
    const adapter = new WindowsTaskKeepaliveAdapter({ runner, timeoutMs: 5_000, host: 'win01' })
    const session = await adapter.create({
      id: 'main',
      purpose: 'dsh-main',
      command: 'C:\\Program Files\\dsh.exe',
      args: ['web', '--patch', 'C:\\profile path\\cordis.yml'],
    })

    expect(session).toMatchObject({ id: 'luban-main', kind: 'service' })
    const create = runner.calls[1]
    expect(create?.command).toBe('schtasks.exe')
    expect(create?.args).toContain('/SC')
    expect(create?.args).toContain('ONSTART')
    expect(create?.args[create.args.indexOf('/TR') + 1]).toBe(
      '"C:\\Program Files\\dsh.exe" web --patch "C:\\profile path\\cordis.yml"',
    )
    expect(runner.calls[3]?.args).toEqual(['/Run', '/TN', '\\dsh-luban\\luban-main'])
  })

  it('recognizes running state and rejects interactive attach', async (): Promise<void> => {
    const runner = new FakeRunner([{ stdout: '状态: 正在运行' }])
    const adapter = new WindowsTaskKeepaliveAdapter({ runner, timeoutMs: 1_000 })
    await expect(adapter.isAlive('luban-main')).resolves.toBe(true)
    await expect(adapter.attach('luban-main')).rejects.toMatchObject({
      code: 'E_PLATFORM_UNSUPPORTED',
    })
  })

  it('lists, stops, and deletes only scheduled tasks in the managed folder', async (): Promise<void> => {
    const runner = new FakeRunner([
      {
        stdout:
          '"\\dsh-luban\\luban-main","N/A","Ready"\r\n"\\Microsoft\\foreign","N/A","Ready"\r\n',
      },
      { exitCode: 1 },
      { exitCode: 0 },
    ])
    const adapter = new WindowsTaskKeepaliveAdapter({ runner, timeoutMs: 1_000, host: 'win01' })

    await expect(adapter.list()).resolves.toEqual([
      expect.objectContaining({ id: 'luban-main', kind: 'service' }),
    ])
    await adapter.destroy('luban-main')

    expect(runner.calls.map(({ args }) => args)).toEqual([
      ['/Query', '/FO', 'CSV', '/NH'],
      ['/End', '/TN', '\\dsh-luban\\luban-main'],
      ['/Delete', '/TN', '\\dsh-luban\\luban-main', '/F'],
    ])
  })
})
