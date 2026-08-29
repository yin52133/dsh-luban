import type { ToolDefinition, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { LubanError } from '@luban/core'
import type { Config } from './config.js'
import {
  NodeStdioMcpClient,
  type DesktopMcpClient,
  type DesktopMcpConnectOptions,
} from './mcp-stdio.js'
import type { DesktopMcpStatus, ManagedProcessEvent } from './types.js'

export interface DesktopMcpDescriptor {
  readonly transport: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly allowedTools: readonly string[]
}

export type DesktopToolRegistry = Pick<ToolRuntime, 'register'>

function toolArguments(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LubanError('E_INVALID_INPUT', 'Desktop MCP arguments must be an object')
  }
  return value as Readonly<Record<string, unknown>>
}

function toolDefinition(
  manager: DesktopMcpManager,
  name: string,
  timeoutMs: number,
): ToolDefinition {
  return {
    name,
    description: `Locally configured desktop MCP tool ${name}. The MCP server and allowlist are deployment-owned.`,
    parameters: { type: 'object', additionalProperties: true },
    timeoutMs,
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false,
      },
      render(_args, value) {
        const row = value as Readonly<Record<string, unknown>>
        const content = typeof row.content === 'string' ? row.content : ''
        return [
          {
            type: 'text',
            text: content === '' ? '(Desktop MCP tool completed with no text output)' : content,
          },
        ]
      },
    },
    async execute(args, execution) {
      return { content: await manager.call(name, toolArguments(args), execution.signal) }
    },
  }
}

/** B-grade MCP bridge exposed through the public DSH rc2 tool registry. */
export class DesktopMcpManager {
  readonly #config: Config
  readonly #client: DesktopMcpClient
  #starting: Promise<DesktopMcpStatus> | undefined

  public constructor(config: Config, client: DesktopMcpClient = new NodeStdioMcpClient()) {
    this.#config = config
    this.#client = client
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
        : this.#client.connected
          ? 'running'
          : 'stopped',
      commandConfigured: this.#config.desktopMcp.command !== '',
      tools: this.#config.desktopMcp.tools,
      recentOutput: this.#client.recentOutput,
    }
  }

  /** Register every profile-allowlisted MCP capability as a global DSH tool. */
  public registerTools(registry: DesktopToolRegistry): () => void {
    if (!this.#config.desktopMcp.enabled) return (): void => undefined
    const unregisters: (() => void)[] = []
    try {
      for (const name of this.#config.desktopMcp.tools) {
        unregisters.push(
          registry.register(toolDefinition(this, name, this.#config.execution.timeoutMs)),
        )
      }
    } catch (error: unknown) {
      for (const unregister of unregisters.reverse()) unregister()
      throw error
    }
    let active = true
    return (): void => {
      if (!active) return
      active = false
      for (const unregister of unregisters.reverse()) unregister()
    }
  }

  public start(signal?: AbortSignal): Promise<DesktopMcpStatus> {
    if (this.#client.connected) return Promise.resolve(this.status())
    this.#starting ??= this.#start(signal).finally((): void => {
      this.#starting = undefined
    })
    return this.#starting
  }

  public async call(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.#config.desktopMcp.tools.includes(tool)) {
      throw new LubanError('E_INVALID_INPUT', `Desktop MCP tool ${tool} is not allowlisted`)
    }
    await this.start(signal)
    return this.#client.call(tool, args, signal)
  }

  public async stop(): Promise<DesktopMcpStatus> {
    await this.#client.stop()
    return this.status()
  }

  async #start(signal?: AbortSignal): Promise<DesktopMcpStatus> {
    const descriptor = this.descriptor()
    if (descriptor === null) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Desktop MCP is disabled or unconfigured')
    }
    const options: DesktopMcpConnectOptions = {
      command: descriptor.command,
      args: descriptor.args,
      allowedTools: descriptor.allowedTools,
      startupTimeoutMs: this.#config.execution.startupTimeoutMs,
      requestTimeoutMs: this.#config.execution.timeoutMs,
      processLifetimeMs: this.#config.execution.processLifetimeMs,
      maxMessageBytes: this.#config.execution.maxOutputBytes,
      ...(this.#config.execution.cwd === undefined ? {} : { cwd: this.#config.execution.cwd }),
      ...(signal === undefined ? {} : { signal }),
    }
    await this.#client.connect(options)
    return this.status()
  }
}
