import { randomUUID } from 'node:crypto'
import type { ChannelEndpoint } from '@luban/core'
import { LubanError } from '@luban/core'
import { assertAllowedPath, type Config } from './config.js'
import type { SnippetStore } from './snippet-store.js'
import type { CommandTemplateRegistry } from './templates.js'
import type {
  CommandRunner,
  GdbSnapshot,
  ManagedProcess,
  ManagedProcessEvent,
  ManagedProcessRunner,
} from './types.js'

export interface GdbStartRequest {
  readonly interfaceConfig: string
  readonly targetConfig: string
  readonly gdbPort?: number
}

export interface GdbSnapshotRequest {
  readonly executable: string
  readonly breakpoints?: readonly string[]
  readonly variables?: readonly string[]
  readonly registers?: boolean
  readonly signal?: AbortSignal
}

export interface GdbStatus {
  readonly state: 'stopped' | 'running'
  readonly pid?: number
  readonly target: string
  readonly recentOutput: readonly ManagedProcessEvent[]
}

function safeBreakpoint(value: string): string {
  if (
    !/^(?:[A-Za-z_][A-Za-z0-9_:.]*|[A-Za-z0-9_./\\-]+:\d{1,8}|\*0x[0-9A-Fa-f]{1,16})$/u.test(value)
  ) {
    throw new LubanError('E_INVALID_INPUT', `Unsafe GDB breakpoint ${value}`)
  }
  return value
}

function safeExpression(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.>*+-]{0,255}$/u.test(value) || value.includes('->>')) {
    throw new LubanError('E_INVALID_INPUT', `Unsafe GDB expression ${value}`)
  }
  return value
}

/** M10-F004 bounded OpenOCD owner plus batch-only GDB snapshot exporter. */
export class GdbSessionManager {
  readonly #config: Config
  readonly #templates: CommandTemplateRegistry
  readonly #commands: CommandRunner
  readonly #processes: ManagedProcessRunner
  readonly #snippets: SnippetStore
  readonly #output: ManagedProcessEvent[] = []
  #process: ManagedProcess | undefined
  #pump: Promise<void> | undefined

  public constructor(options: {
    readonly config: Config
    readonly templates: CommandTemplateRegistry
    readonly commands: CommandRunner
    readonly processes: ManagedProcessRunner
    readonly snippets: SnippetStore
  }) {
    this.#config = options.config
    this.#templates = options.templates
    this.#commands = options.commands
    this.#processes = options.processes
    this.#snippets = options.snippets
  }

  public status(): GdbStatus {
    return {
      state: this.#process === undefined ? 'stopped' : 'running',
      ...(this.#process?.pid === undefined ? {} : { pid: this.#process.pid }),
      target: this.#config.gdb.target,
      recentOutput: [...this.#output],
    }
  }

  public async start(request: GdbStartRequest, signal?: AbortSignal): Promise<GdbStatus> {
    if (this.#process !== undefined)
      throw new LubanError('E_INVALID_TRANSITION', 'GDB server is already running')
    const configuredPort = Number(
      this.#config.gdb.target.slice(this.#config.gdb.target.lastIndexOf(':') + 1),
    )
    const port = request.gdbPort ?? configuredPort
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || port !== configuredPort) {
      throw new LubanError('E_INVALID_INPUT', 'GDB port must match the configured loopback target')
    }
    const invocation = this.#templates.resolve('openocd-server', {
      interfaceConfig: request.interfaceConfig,
      targetConfig: request.targetConfig,
      gdbPort: String(port),
    })
    this.#output.length = 0
    this.#process = await this.#processes.start(invocation.command, invocation.args, {
      timeoutMs: this.#config.execution.processLifetimeMs,
      startupTimeoutMs: this.#config.execution.startupTimeoutMs,
      maxOutputBytes: this.#config.execution.maxOutputBytes,
      ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
      ...(signal === undefined ? {} : { signal }),
    })
    const owned = this.#process
    this.#pump = (async (): Promise<void> => {
      try {
        for await (const event of owned.events()) {
          this.#output.push(event)
          if (this.#output.length > 256) this.#output.shift()
          if (event.type === 'exit' && this.#process === owned) this.#process = undefined
        }
      } catch (error: unknown) {
        this.#output.push({
          type: 'stderr',
          text: error instanceof Error ? error.message : 'OpenOCD event stream failed',
          at: Date.now(),
        })
        if (this.#process === owned) this.#process = undefined
      }
    })()
    return this.status()
  }

  public async snapshot(request: GdbSnapshotRequest): Promise<GdbSnapshot> {
    if (this.#process === undefined)
      throw new LubanError('E_INVALID_TRANSITION', 'GDB server is not running')
    if ((request.breakpoints?.length ?? 0) > 128 || (request.variables?.length ?? 0) > 256) {
      throw new LubanError('E_INVALID_INPUT', 'GDB snapshot request is too large')
    }
    if (/[;{}"'`\r\n]/u.test(request.executable)) {
      throw new LubanError('E_INVALID_INPUT', 'GDB executable path contains metacharacters')
    }
    const executable = assertAllowedPath(request.executable, this.#config, 'executable')
    const breakpoints = Object.freeze((request.breakpoints ?? []).map(safeBreakpoint))
    const variables = Object.freeze((request.variables ?? []).map(safeExpression))
    const args = [
      '--batch',
      '--nx',
      '--quiet',
      executable,
      '-ex',
      'set pagination off',
      '-ex',
      `target extended-remote ${this.#config.gdb.target}`,
      ...breakpoints.flatMap((value): readonly string[] => ['-ex', `break ${value}`]),
      '-ex',
      'info breakpoints',
      ...variables.flatMap((value): readonly string[] => ['-ex', `print ${value}`]),
      ...(request.registers === false ? [] : ['-ex', 'info registers']),
      '-ex',
      'backtrace',
      '-ex',
      'detach',
    ]
    const result = await this.#commands.run(this.#config.tools.gdb, args, {
      timeoutMs: this.#config.execution.timeoutMs,
      maxOutputBytes: this.#config.execution.maxOutputBytes,
      ...(this.#config.execution.cwd === undefined ? {} : { cwd: this.#config.execution.cwd }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    const createdAt = Date.now()
    const endpoint: ChannelEndpoint = Object.freeze({
      kind: 'gdb',
      id: 'gdb:local',
      label: `GDB snapshot · ${this.#config.gdb.target}`,
      params: Object.freeze({ target: this.#config.gdb.target, executable }),
    })
    const content = [
      `target=${this.#config.gdb.target}`,
      `executable=${executable}`,
      `breakpoints=${JSON.stringify(breakpoints)}`,
      `variables=${JSON.stringify(variables)}`,
      `registers=${String(request.registers !== false)}`,
      `exitCode=${String(result.exitCode)}`,
      '',
      result.stdout,
      result.stderr,
    ].join('\n')
    const snippet = await this.#snippets.write(endpoint, content, createdAt, Date.now())
    return {
      id: randomUUID(),
      createdAt,
      target: this.#config.gdb.target,
      breakpoints,
      variables,
      registers: request.registers !== false,
      result,
      snippet,
    }
  }

  public async stop(): Promise<GdbStatus> {
    const process = this.#process
    this.#process = undefined
    if (process !== undefined) await process.stop()
    await this.#pump
    this.#pump = undefined
    return this.status()
  }
}
