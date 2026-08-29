import { hostname } from 'node:os'
import type { Clock, KeepaliveAdapter, ManagedSession, SessionSpec } from '@luban/core'
import { asHostId, LubanError, systemClock } from '@luban/core'
import type { CommandRunner } from './command-runner.js'
import { assertSuccess } from './command-runner.js'
import { managedSessionId, windowsCommand } from './session-id.js'

const TASK_FOLDER = '\\dsh-luban\\'

export interface WindowsAdapterOptions {
  readonly runner: CommandRunner
  readonly timeoutMs: number
  readonly clock?: Clock
  readonly host?: string
  readonly signal?: AbortSignal
}

function taskName(id: string): string {
  return `${TASK_FOLDER}${managedSessionId(id)}`
}

function csvFirstField(line: string): string | null {
  const match = /^"((?:[^"]|"")*)"/u.exec(line.trim())
  return match?.[1]?.replaceAll('""', '"') ?? null
}

/** Native Windows Scheduled Tasks HAL; it deliberately avoids an NSSM dependency. */
export class WindowsTaskKeepaliveAdapter implements KeepaliveAdapter {
  readonly #runner: CommandRunner
  readonly #timeoutMs: number
  readonly #clock: Clock
  readonly #host: string
  readonly #signal: AbortSignal | undefined

  public constructor(options: WindowsAdapterOptions) {
    this.#runner = options.runner
    this.#timeoutMs = options.timeoutMs
    this.#clock = options.clock ?? systemClock
    this.#host = options.host ?? hostname()
    this.#signal = options.signal
  }

  public async create(spec: SessionSpec): Promise<ManagedSession> {
    const id = managedSessionId(spec.id)
    if (!(await this.#registered(id))) {
      const create = await this.#runner.run(
        'schtasks.exe',
        [
          '/Create',
          '/TN',
          taskName(id),
          '/TR',
          windowsCommand(spec.command, spec.args ?? []),
          '/SC',
          'ONSTART',
          '/RL',
          'LIMITED',
          '/F',
        ],
        { timeoutMs: this.#timeoutMs, signal: this.#signal },
      )
      assertSuccess(create, `register scheduled task ${id}`)
    }
    if (!(await this.isAlive(id))) {
      const start = await this.#runner.run('schtasks.exe', ['/Run', '/TN', taskName(id)], {
        timeoutMs: this.#timeoutMs,
        signal: this.#signal,
      })
      assertSuccess(start, `start scheduled task ${id}`)
    }
    return {
      id,
      host: asHostId(this.#host),
      kind: 'service',
      purpose: spec.purpose,
      ...(spec.ownerTaskId === undefined ? {} : { ownerTaskId: spec.ownerTaskId }),
      createdAt: this.#clock.now(),
    }
  }

  public attach(_id: string): Promise<void> {
    return Promise.reject(
      new LubanError(
        'E_PLATFORM_UNSUPPORTED',
        'Scheduled tasks do not expose an interactive terminal',
      ),
    )
  }

  public async list(): Promise<readonly ManagedSession[]> {
    const result = await this.#runner.run('schtasks.exe', ['/Query', '/FO', 'CSV', '/NH'], {
      timeoutMs: this.#timeoutMs,
      signal: this.#signal,
    })
    assertSuccess(result, 'list scheduled tasks')
    return result.stdout.split(/\r?\n/u).flatMap((line): readonly ManagedSession[] => {
      const name = csvFirstField(line)
      if (!name?.toLocaleLowerCase().startsWith(TASK_FOLDER)) return []
      const id = name.slice(TASK_FOLDER.length).toLocaleLowerCase()
      try {
        return [
          {
            id: managedSessionId(id),
            host: asHostId(this.#host),
            kind: 'service',
            purpose: 'task',
            createdAt: this.#clock.now(),
          },
        ]
      } catch {
        return []
      }
    })
  }

  public async isAlive(id: string): Promise<boolean> {
    const result = await this.#runner.run(
      'schtasks.exe',
      ['/Query', '/TN', taskName(id), '/FO', 'LIST', '/V'],
      { timeoutMs: this.#timeoutMs, signal: this.#signal },
    )
    if (result.exitCode !== 0) return false
    return /(?:^|:\s*)(?:running|正在运行|en cours|wird ausgef.hr|en ejecuci.n)(?:\s*$)/imu.test(
      result.stdout,
    )
  }

  public async destroy(id: string): Promise<void> {
    await this.#runner.run('schtasks.exe', ['/End', '/TN', taskName(id)], {
      timeoutMs: this.#timeoutMs,
      signal: this.#signal,
    })
    const result = await this.#runner.run('schtasks.exe', ['/Delete', '/TN', taskName(id), '/F'], {
      timeoutMs: this.#timeoutMs,
      signal: this.#signal,
    })
    if (result.exitCode !== 0 && !/cannot find|找不到/u.test(result.stderr)) {
      assertSuccess(result, `delete scheduled task ${managedSessionId(id)}`)
    }
  }

  async #registered(id: string): Promise<boolean> {
    const result = await this.#runner.run('schtasks.exe', ['/Query', '/TN', taskName(id)], {
      timeoutMs: this.#timeoutMs,
      signal: this.#signal,
    })
    return result.exitCode === 0
  }
}
