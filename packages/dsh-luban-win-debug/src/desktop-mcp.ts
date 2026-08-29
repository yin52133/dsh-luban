import { LubanError } from '@luban/core'
import type { Config } from './config.js'
import type {
  DesktopMcpStatus,
  ManagedProcess,
  ManagedProcessEvent,
  ManagedProcessRunner,
} from './types.js'

export interface DesktopMcpDescriptor {
  readonly transport: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly allowedTools: readonly string[]
}

/** B-grade desktop automation wrapper; command/config stay local and tools are allowlisted. */
export class DesktopMcpManager {
  readonly #config: Config
  readonly #runner: ManagedProcessRunner
  readonly #output: ManagedProcessEvent[] = []
  #process: ManagedProcess | undefined
  #pump: Promise<void> | undefined

  public constructor(config: Config, runner: ManagedProcessRunner) {
    this.#config = config
    this.#runner = runner
  }

  public descriptor(): DesktopMcpDescriptor | null {
    if (!this.#config.desktopMcp.enabled || this.#config.desktopMcp.command === '') return null
    return Object.freeze({
      transport: 'stdio',
      command: this.#config.desktopMcp.command,
      args: this.#config.desktopMcp.args,
      allowedTools: this.#config.desktopMcp.tools,
    })
  }

  public status(): DesktopMcpStatus & { readonly recentOutput: readonly ManagedProcessEvent[] } {
    return {
      enabled: this.#config.desktopMcp.enabled,
      state: !this.#config.desktopMcp.enabled
        ? 'disabled'
        : this.#process === undefined
          ? 'stopped'
          : 'running',
      commandConfigured: this.#config.desktopMcp.command !== '',
      tools: this.#config.desktopMcp.tools,
      recentOutput: [...this.#output],
    }
  }

  public async start(signal?: AbortSignal): Promise<DesktopMcpStatus> {
    const descriptor = this.descriptor()
    if (descriptor === null)
      throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Desktop MCP is disabled or unconfigured')
    if (this.#process !== undefined) return this.status()
    this.#output.length = 0
    this.#process = await this.#runner.start(descriptor.command, descriptor.args, {
      timeoutMs: this.#config.execution.processLifetimeMs,
      startupTimeoutMs: this.#config.execution.startupTimeoutMs,
      maxOutputBytes: this.#config.execution.maxOutputBytes,
      ...(this.#config.execution.cwd === undefined ? {} : { cwd: this.#config.execution.cwd }),
      ...(signal === undefined ? {} : { signal }),
    })
    const owned = this.#process
    this.#pump = (async (): Promise<void> => {
      try {
        for await (const event of owned.events()) {
          this.#output.push(event)
          if (this.#output.length > 128) this.#output.shift()
          if (event.type === 'exit' && this.#process === owned) this.#process = undefined
        }
      } catch (error: unknown) {
        this.#output.push({
          type: 'stderr',
          text: error instanceof Error ? error.message : 'Desktop MCP event stream failed',
          at: Date.now(),
        })
        if (this.#process === owned) this.#process = undefined
      }
    })()
    return this.status()
  }

  public async stop(): Promise<DesktopMcpStatus> {
    const process = this.#process
    this.#process = undefined
    if (process !== undefined) await process.stop()
    await this.#pump
    this.#pump = undefined
    return this.status()
  }
}
