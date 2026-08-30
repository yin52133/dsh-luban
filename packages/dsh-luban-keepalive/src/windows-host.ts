import { LubanError } from 'dsh-luban-core'
import {
  hostTaskDefinition,
  matchesWindowsTaskXml,
  WINDOWS_HOST_TASK_NAME,
  WindowsTaskRepository,
  type WindowsTaskDefinition,
  type WindowsTaskRepositoryOptions,
  type WindowsTaskState,
} from './windows-task.js'

export interface WindowsHostTaskOptions extends WindowsTaskRepositoryOptions {
  readonly platform?: NodeJS.Platform
}

export interface WindowsHostStatus {
  readonly schemaVersion: 1
  readonly taskName: typeof WINDOWS_HOST_TASK_NAME
  readonly user: string
  readonly state: WindowsTaskState
  readonly running: boolean | null
  readonly trigger: 'boot'
  readonly logon: 's4u'
  readonly runLevel: 'limited'
  readonly command: 'dsh'
  readonly args: readonly ['--profile', 'win-debug', '--no-open']
  readonly environment: { readonly LUBAN_BOOT_RESTORE: '1' }
  readonly elevated: boolean
  readonly operationallyVerified: false
  readonly s4uCapabilities: {
    readonly networkResources: false
    readonly encryptedFiles: false
  }
}

export interface WindowsHostPlan extends WindowsHostStatus {
  readonly action: 'install' | 'uninstall'
  readonly mutationRequired: boolean
  readonly ready: boolean
}

/** Deployment-owned boot launcher. Runtime child sessions never use this task namespace. */
export class WindowsHostTaskOperator {
  readonly #tasks: WindowsTaskRepository
  readonly #platform: NodeJS.Platform

  public constructor(options: WindowsHostTaskOptions) {
    this.#tasks = new WindowsTaskRepository(options)
    this.#platform = options.platform ?? process.platform
  }

  public get currentUser(): string {
    return this.#tasks.currentUser
  }

  public async status(): Promise<WindowsHostStatus> {
    this.#assertWindows()
    const definition = await this.#definition()
    const state = await this.#tasks.inspect(definition)
    const elevated = await this.#tasks.isElevated()
    const running = state === 'exact' ? await this.#tasks.isRunning(definition.name) : null
    return this.#status(state, running, elevated)
  }

  public async plan(action: 'install' | 'uninstall' = 'install'): Promise<WindowsHostPlan> {
    const status = await this.status()
    const mutationRequired =
      action === 'install' ? status.state === 'missing' : status.state === 'exact'
    return {
      ...status,
      action,
      mutationRequired,
      ready: status.state !== 'conflict' && (!mutationRequired || status.elevated),
    }
  }

  public async install(): Promise<void> {
    this.#assertWindows()
    const definition = await this.#definition()
    const state = await this.#tasks.inspect(definition)
    if (state === 'exact') return
    if (state === 'conflict') {
      throw new LubanError('E_INVALID_INPUT', 'Windows host task conflicts with an unmanaged task')
    }
    if (!(await this.#tasks.isElevated())) {
      throw new LubanError(
        'E_UNAVAILABLE',
        'Windows host boot-task registration requires an elevated operator',
      )
    }
    let created = false
    try {
      created = (await this.#tasks.createOrReuse(definition)) === 'created'
      if ((await this.#tasks.inspect(definition)) !== 'exact') {
        throw new LubanError('E_IO', 'Windows host task failed post-registration verification')
      }
    } catch (error: unknown) {
      if (created) await this.#rollbackCreated(definition, error)
      throw error
    }
  }

  public async uninstall(): Promise<void> {
    this.#assertWindows()
    const definition = await this.#definition()
    const state = await this.#tasks.inspect(definition)
    if (state === 'missing') return
    if (state === 'conflict') {
      throw new LubanError('E_INVALID_INPUT', 'Refusing to delete an unmanaged Windows host task')
    }
    if (!(await this.#tasks.isElevated())) {
      throw new LubanError(
        'E_UNAVAILABLE',
        'Windows host boot-task removal requires an elevated operator',
      )
    }
    await this.#tasks.endAndDelete(definition.name, (xml): boolean =>
      matchesWindowsTaskXml(xml, definition),
    )
    if ((await this.#tasks.inspect(definition)) !== 'missing') {
      throw new LubanError('E_IO', 'Windows host task still exists after uninstall')
    }
  }

  async #definition(): Promise<WindowsTaskDefinition> {
    return hostTaskDefinition(await this.#tasks.principalSid())
  }

  #status(state: WindowsTaskState, running: boolean | null, elevated: boolean): WindowsHostStatus {
    return {
      schemaVersion: 1,
      taskName: WINDOWS_HOST_TASK_NAME,
      user: this.#tasks.currentUser,
      state,
      running,
      trigger: 'boot',
      logon: 's4u',
      runLevel: 'limited',
      command: 'dsh',
      args: ['--profile', 'win-debug', '--no-open'],
      environment: { LUBAN_BOOT_RESTORE: '1' },
      elevated,
      operationallyVerified: false,
      s4uCapabilities: { networkResources: false, encryptedFiles: false },
    }
  }

  async #rollbackCreated(definition: WindowsTaskDefinition, original: unknown): Promise<never> {
    try {
      if ((await this.#tasks.inspect(definition)) === 'exact') {
        await this.#tasks.endAndDelete(definition.name, (xml): boolean =>
          matchesWindowsTaskXml(xml, definition),
        )
      }
    } catch (rollbackError: unknown) {
      throw new LubanError('E_IO', 'Unable to safely roll back the Windows host task', {
        cause: rollbackError,
      })
    }
    throw original
  }

  #assertWindows(): void {
    if (this.#platform !== 'win32') {
      throw new LubanError('E_PLATFORM_UNSUPPORTED', 'Windows host keepalive is Windows-only')
    }
  }
}
