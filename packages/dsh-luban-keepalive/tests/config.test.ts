import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config.js'
import { createPlatformAdapter, name } from '../src/index.js'
import type { CommandOptions, CommandResult, CommandRunner } from '../src/command-runner.js'
import { TmuxKeepaliveAdapter } from '../src/tmux-adapter.js'
import { WindowsTaskKeepaliveAdapter } from '../src/windows-adapter.js'

class NoopRunner implements CommandRunner {
  public run(
    _command: string,
    _args: readonly string[],
    _options: CommandOptions,
  ): Promise<CommandResult> {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 })
  }
}

describe('keepalive config and platform guard', (): void => {
  it('normalizes defaults and rejects invalid timing', (): void => {
    expect(parseConfig({})).toMatchObject({
      strategy: 'auto',
      patrolIntervalSec: 60,
      commandTimeoutSec: 15,
      bootRestore: true,
    })
    expect(() => parseConfig({ patrolIntervalSec: 0 })).toThrow(/positive integer/u)
    expect(parseConfig({ patrolIntervalSec: 300 }).patrolIntervalSec).toBe(300)
    expect(() => parseConfig({ patrolIntervalSec: 301 })).toThrow(/at most 300/u)
    expect(name).toBe('luban-keepalive')
  })

  it('selects only the supported HAL for each operating system', (): void => {
    const runner = new NoopRunner()
    const controller = new AbortController()
    const base = { config: parseConfig({}), runner, signal: controller.signal }
    expect(createPlatformAdapter({ ...base, platform: 'linux' })).toBeInstanceOf(
      TmuxKeepaliveAdapter,
    )
    expect(createPlatformAdapter({ ...base, platform: 'win32' })).toBeInstanceOf(
      WindowsTaskKeepaliveAdapter,
    )
    expect(() => createPlatformAdapter({ ...base, platform: 'darwin' })).toThrow(/not supported/u)
  })
})
