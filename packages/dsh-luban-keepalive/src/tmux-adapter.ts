import { hostname } from 'node:os'
import type { Clock, KeepaliveAdapter, ManagedSession, SessionSpec } from 'dsh-luban-core'
import { asHostId, systemClock } from 'dsh-luban-core'
import type { CommandRunner } from './command-runner.js'
import { assertSuccess } from './command-runner.js'
import { managedSessionId, posixCommand } from './session-id.js'

export interface TmuxAdapterOptions {
  readonly runner: CommandRunner
  readonly timeoutMs: number
  readonly clock?: Clock
  readonly host?: string
  readonly signal?: AbortSignal
}

/** tmux HAL. Every host command is an argv vector and has a deadline. */
export class TmuxKeepaliveAdapter implements KeepaliveAdapter {
  readonly #runner: CommandRunner
  readonly #timeoutMs: number
  readonly #clock: Clock
  readonly #host: string
  readonly #signal: AbortSignal | undefined

  public constructor(options: TmuxAdapterOptions) {
    this.#runner = options.runner
    this.#timeoutMs = options.timeoutMs
    this.#clock = options.clock ?? systemClock
    this.#host = options.host ?? hostname()
    this.#signal = options.signal
  }

  public async create(spec: SessionSpec): Promise<ManagedSession> {
    const id = managedSessionId(spec.id)
    const existing = await this.isAlive(id)
    if (!existing) {
      const result = await this.#runner.run(
        'tmux',
        ['new-session', '-d', '-s', id, '--', posixCommand(spec.command, spec.args ?? [])],
        { timeoutMs: this.#timeoutMs, signal: this.#signal },
      )
      assertSuccess(result, `create tmux session ${id}`)
    }
    return {
      ...(spec.accountId === undefined ? {} : { accountId: spec.accountId }),
      id,
      host: asHostId(this.#host),
      kind: 'tmux',
      purpose: spec.purpose,
      ...(spec.ownerTaskId === undefined ? {} : { ownerTaskId: spec.ownerTaskId }),
      createdAt: this.#clock.now(),
    }
  }

  public async attach(id: string): Promise<void> {
    const sessionId = managedSessionId(id)
    const result = await this.#runner.run('tmux', ['attach-session', '-t', `=${sessionId}`], {
      timeoutMs: 12 * 60 * 60 * 1_000,
      signal: this.#signal,
      stdio: 'inherit',
    })
    assertSuccess(result, `attach tmux session ${sessionId}`)
  }

  public async list(): Promise<readonly ManagedSession[]> {
    const result = await this.#runner.run('tmux', ['list-sessions', '-F', '#{session_name}'], {
      timeoutMs: this.#timeoutMs,
      signal: this.#signal,
    })
    if (result.exitCode !== 0) {
      const noServer = /no server running|failed to connect/u.test(
        result.stderr.toLocaleLowerCase(),
      )
      if (noServer) return []
      assertSuccess(result, 'list tmux sessions')
    }
    return result.stdout
      .split(/\r?\n/u)
      .map((value): string => value.trim())
      .filter((value): boolean => value.startsWith('luban-'))
      .map((id): ManagedSession => ({
        id: managedSessionId(id),
        host: asHostId(this.#host),
        kind: 'tmux',
        purpose: 'task',
        createdAt: this.#clock.now(),
      }))
  }

  public async isAlive(id: string): Promise<boolean> {
    const sessionId = managedSessionId(id)
    const result = await this.#runner.run('tmux', ['has-session', '-t', `=${sessionId}`], {
      timeoutMs: this.#timeoutMs,
      signal: this.#signal,
    })
    if (result.exitCode === 0) return true
    if (result.exitCode === 1) return false
    assertSuccess(result, `probe tmux session ${sessionId}`)
    return false
  }

  public async destroy(spec: SessionSpec): Promise<void> {
    const sessionId = managedSessionId(spec.id)
    const result = await this.#runner.run('tmux', ['kill-session', '-t', `=${sessionId}`], {
      timeoutMs: this.#timeoutMs,
      signal: this.#signal,
    })
    if (result.exitCode !== 0 && !/can't find session|no server running/u.test(result.stderr)) {
      assertSuccess(result, `destroy tmux session ${sessionId}`)
    }
  }
}
