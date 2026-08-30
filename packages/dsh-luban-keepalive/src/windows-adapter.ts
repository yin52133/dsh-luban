import { hostname } from 'node:os'
import type { Clock, KeepaliveAdapter, ManagedSession, SessionSpec } from '@luban/core'
import { asHostId, LubanError, systemClock } from '@luban/core'
import type { CommandRunner } from './command-runner.js'
import { managedSessionId, windowsArguments } from './session-id.js'
import {
  childTaskDefinition,
  isManagedChildTaskXml,
  matchesWindowsTaskXml,
  WINDOWS_SESSION_TASK_PREFIX,
  WindowsTaskRepository,
  windowsSessionTaskName,
  type WindowsTaskDefinition,
} from './windows-task.js'

export interface WindowsAdapterOptions {
  readonly runner: CommandRunner
  readonly timeoutMs: number
  readonly clock?: Clock
  readonly host?: string
  readonly currentUser?: string
  readonly currentUserSid?: string
  readonly temporaryDirectory?: string
  readonly signal?: AbortSignal
}

function csvFirstField(line: string): string | null {
  const match = /^"((?:[^"]|"")*)"/u.exec(line.trim())
  return match?.[1]?.replaceAll('""', '"') ?? null
}

/** Current-user, on-demand Scheduled Tasks HAL for runtime child sessions only. */
export class WindowsTaskKeepaliveAdapter implements KeepaliveAdapter {
  readonly #tasks: WindowsTaskRepository
  readonly #clock: Clock
  readonly #host: string

  public constructor(options: WindowsAdapterOptions) {
    this.#tasks = new WindowsTaskRepository(options)
    this.#clock = options.clock ?? systemClock
    this.#host = options.host ?? hostname()
  }

  public async create(spec: SessionSpec): Promise<ManagedSession> {
    const id = managedSessionId(spec.id)
    const definition = childTaskDefinition({
      id,
      principalSid: await this.#tasks.principalSid(),
      command: spec.command,
      arguments: windowsArguments(spec.args ?? []),
    })
    const state = await this.#tasks.inspect(definition)
    if (state === 'conflict') {
      throw new LubanError('E_INVALID_INPUT', 'Windows child task conflicts with an unmanaged task')
    }

    let created = false
    if (state === 'missing') {
      try {
        created = (await this.#tasks.createOrReuse(definition)) === 'created'
        if ((await this.#tasks.inspect(definition)) !== 'exact') {
          throw new LubanError('E_IO', 'Windows child task failed post-registration verification')
        }
      } catch (error: unknown) {
        if (created) await this.#rollbackCreated(definition, error)
        throw error
      }
    }

    if (!(await this.#tasks.isRunning(definition.name))) {
      try {
        await this.#tasks.runTask(definition.name)
        await this.#tasks.waitUntilRunning(definition.name)
      } catch (error: unknown) {
        if (created) await this.#rollbackCreated(definition, error)
        throw error
      }
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
    const csv = await this.#tasks.listCsv()
    const prefix = WINDOWS_SESSION_TASK_PREFIX.toLocaleLowerCase('en-US')
    const candidates = new Map<string, string>()
    for (const line of csv.split(/\r?\n/u)) {
      const name = csvFirstField(line)
      if (!name?.toLocaleLowerCase('en-US').startsWith(prefix)) continue
      const id = name.slice(WINDOWS_SESSION_TASK_PREFIX.length).toLocaleLowerCase('en-US')
      try {
        candidates.set(name.toLocaleLowerCase('en-US'), managedSessionId(id))
      } catch {
        // A namespace lookalike is not owned by this adapter.
      }
    }
    const principalSid = await this.#tasks.principalSid()
    const inspected = await Promise.all(
      [...candidates.entries()].map(async ([name, id]): Promise<ManagedSession | null> => {
        const query = await this.#tasks.query(name)
        if (query.state !== 'present' || !isManagedChildTaskXml(query.xml ?? '', principalSid)) {
          return null
        }
        return {
          id,
          host: asHostId(this.#host),
          kind: 'service',
          purpose: 'task',
          createdAt: this.#clock.now(),
        }
      }),
    )
    return inspected.filter((session): session is ManagedSession => session !== null)
  }

  public async isAlive(id: string): Promise<boolean> {
    const name = windowsSessionTaskName(managedSessionId(id))
    const query = await this.#tasks.query(name)
    if (query.state === 'missing') return false
    if (!isManagedChildTaskXml(query.xml ?? '', await this.#tasks.principalSid())) return false
    return await this.#tasks.isRunning(name)
  }

  public async destroy(id: string): Promise<void> {
    const name = windowsSessionTaskName(managedSessionId(id))
    const query = await this.#tasks.query(name)
    if (query.state === 'missing') return
    if (!isManagedChildTaskXml(query.xml ?? '', await this.#tasks.principalSid())) {
      throw new LubanError('E_INVALID_INPUT', 'Refusing to delete an unmanaged Windows task')
    }
    const principalSid = await this.#tasks.principalSid()
    await this.#tasks.endAndDelete(name, (xml): boolean => isManagedChildTaskXml(xml, principalSid))
  }

  async #rollbackCreated(definition: WindowsTaskDefinition, original: unknown): Promise<never> {
    try {
      if ((await this.#tasks.inspect(definition)) === 'exact') {
        await this.#tasks.endAndDelete(definition.name, (xml): boolean =>
          matchesWindowsTaskXml(xml, definition),
        )
      }
    } catch (rollbackError: unknown) {
      throw new LubanError('E_IO', 'Unable to safely roll back the Windows child task', {
        cause: rollbackError,
      })
    }
    throw original
  }
}
