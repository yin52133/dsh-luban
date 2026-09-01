import type { ToolDefinition, ToolRunContext, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { AccountId, AccountSessionRegistry } from '@yin52133/dsh-luban-core'
import { asSessionId, LubanError } from '@yin52133/dsh-luban-core'
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

export interface DesktopMcpAccountStatus extends DesktopMcpStatus {
  /** Present only when the caller owns the current MCP context. */
  readonly recentOutput?: readonly ManagedProcessEvent[]
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
      return {
        content: await manager.callForExecution(name, toolArguments(args), execution),
      }
    },
  }
}

/** B-grade MCP bridge exposed through the public DSH rc2 tool registry. */
export class DesktopMcpManager {
  readonly #config: Config
  readonly #client: DesktopMcpClient
  readonly #accountSessions: AccountSessionRegistry | undefined
  #starting: Promise<DesktopMcpAccountStatus> | undefined
  #startingOwner: AccountId | undefined
  #stopping: Promise<void> | undefined
  #stoppingOwner: AccountId | undefined
  #owner: AccountId | undefined

  public constructor(
    config: Config,
    client: DesktopMcpClient = new NodeStdioMcpClient(),
    accountSessions?: AccountSessionRegistry,
  ) {
    this.#config = config
    this.#client = client
    this.#accountSessions = accountSessions
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

  public statusFor(accountId: AccountId): DesktopMcpAccountStatus {
    const status = this.#status()
    if (this.#contextOwner() !== accountId) return status
    return {
      ...status,
      recentOutput: this.#client.recentOutput,
    }
  }

  #status(): DesktopMcpStatus {
    return {
      enabled: this.#config.desktopMcp.enabled,
      state: !this.#config.desktopMcp.enabled
        ? 'disabled'
        : this.#client.connected
          ? 'running'
          : 'stopped',
      commandConfigured: this.#config.desktopMcp.command !== '',
      tools: this.#config.desktopMcp.tools,
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

  public start(accountId: AccountId, signal?: AbortSignal): Promise<DesktopMcpAccountStatus> {
    this.#releaseExitedOwner()
    if (this.#stopping !== undefined) {
      this.#requireOwner(accountId)
      throw new LubanError('E_INVALID_TRANSITION', 'Desktop MCP is still stopping')
    }
    if (this.#client.connected) {
      this.#requireOwner(accountId)
      this.#owner ??= accountId
      return Promise.resolve(this.statusFor(accountId))
    }
    if (this.#starting !== undefined) {
      this.#requireOwner(accountId)
      return this.#starting
    }
    this.#startingOwner = accountId
    const operation = this.#start(accountId, signal)
    this.#starting = operation
    const reset = (): void => {
      if (this.#starting === operation) this.#starting = undefined
      if (this.#startingOwner === accountId) this.#startingOwner = undefined
      this.#releaseExitedOwner()
    }
    void operation.then(reset, reset)
    return operation
  }

  public async call(
    accountId: AccountId,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.#config.desktopMcp.tools.includes(tool)) {
      throw new LubanError('E_INVALID_INPUT', `Desktop MCP tool ${tool} is not allowlisted`)
    }
    await this.start(accountId, signal)
    this.#requireOwner(accountId)
    return this.#client.call(tool, args, signal)
  }

  public async callForExecution(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    execution: ToolRunContext,
  ): Promise<string> {
    const accountId = await this.#executionAccount(execution)
    return this.call(accountId, tool, args, execution.signal)
  }

  public stop(accountId: AccountId): Promise<DesktopMcpAccountStatus> {
    this.#requireOwner(accountId)
    const operation = this.#stopping ?? this.#beginStop(accountId)
    return operation.then((): DesktopMcpAccountStatus => this.statusFor(accountId))
  }

  /** Internal lifecycle cleanup that intentionally bypasses account ownership. */
  public async forceStop(): Promise<DesktopMcpStatus> {
    await (this.#stopping ?? this.#beginStop(this.#contextOwner()))
    return this.#status()
  }

  async #start(accountId: AccountId, signal?: AbortSignal): Promise<DesktopMcpAccountStatus> {
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
    this.#owner = accountId
    return this.statusFor(accountId)
  }

  async #executionAccount(execution: ToolRunContext): Promise<AccountId> {
    if (execution.agent === undefined || this.#accountSessions === undefined) {
      throw new LubanError(
        'E_AUTH_REQUIRED',
        'Desktop MCP tools require an account-owned DSH session',
      )
    }
    const accountId = await this.#accountSessions.ownerOf(asSessionId(String(execution.agent.id)))
    if (accountId === null) {
      throw new LubanError(
        'E_AUTH_REQUIRED',
        'Desktop MCP tools require an account-owned DSH session',
      )
    }
    return accountId
  }

  #contextOwner(): AccountId | undefined {
    this.#releaseExitedOwner()
    return this.#startingOwner ?? this.#stoppingOwner ?? this.#owner
  }

  #requireOwner(accountId: AccountId): void {
    const owner = this.#contextOwner()
    if (owner !== undefined && owner !== accountId) {
      throw new LubanError(
        'E_ACCOUNT_SCOPE_MISMATCH',
        'Desktop MCP context belongs to another account',
      )
    }
  }

  #releaseExitedOwner(): void {
    if (!this.#client.connected && this.#starting === undefined && this.#stopping === undefined) {
      this.#owner = undefined
    }
  }

  #beginStop(accountId: AccountId | undefined): Promise<void> {
    this.#stoppingOwner = accountId
    const operation = this.#stopClient()
    this.#stopping = operation
    const reset = (): void => {
      if (this.#stopping === operation) this.#stopping = undefined
      if (this.#stoppingOwner === accountId) this.#stoppingOwner = undefined
      if (!this.#client.connected) {
        this.#owner = undefined
        this.#startingOwner = undefined
      }
      this.#releaseExitedOwner()
    }
    void operation.then(reset, reset)
    return operation
  }

  async #stopClient(): Promise<void> {
    const starting = this.#starting
    try {
      await this.#client.stop()
    } finally {
      if (starting !== undefined) {
        try {
          await starting
        } catch {
          // The original start caller still receives its concrete startup failure.
        }
      }
    }
  }
}
