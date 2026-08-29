import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { ChannelEndpoint } from '@luban/core'
import { LubanError, redactSecrets } from '@luban/core'
import { assertAllowedPath, type Config } from './config.js'
import type { SnippetStore } from './snippet-store.js'
import type {
  CommandTemplateRegistry,
  ResolvedInvocation,
  TemplateExecutionPreflight,
} from './templates.js'
import type {
  CommandRunner,
  GdbSnapshot,
  ManagedProcess,
  ManagedProcessEvent,
  ManagedProcessRunner,
} from './types.js'

const MAX_RECENT_OUTPUT_EVENTS = 256
const MAX_RECENT_OUTPUT_BYTES = 64 * 1024
const OUTPUT_OVERFLOW_MESSAGE = '[OpenOCD output exceeded the safe display limit and was redacted]'
const UNSAFE_CONTROL_CLASS = '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F'
const UNSAFE_CONTROL_CHARACTERS = new RegExp(`[${UNSAFE_CONTROL_CLASS}]`, 'gu')
const CONTROL_SEPARATED_AUTH = new RegExp(
  `\\b(?:Bearer|Basic)[${UNSAFE_CONTROL_CLASS}]+[^\\s,;]+`,
  'giu',
)

function utf8Prefix(input: string, maximum: number): string {
  if (maximum <= 0) return ''
  const bytes = Buffer.from(input, 'utf8')
  if (bytes.byteLength <= maximum) return input
  return new StringDecoder('utf8').write(bytes.subarray(0, maximum))
}

function sanitizeOutputText(input: string, maximum: number): string {
  const normalized = input
    .replace(/\r\n?/gu, '\n')
    .replace(CONTROL_SEPARATED_AUTH, '[REDACTED]')
    .replace(UNSAFE_CONTROL_CHARACTERS, '')
  return utf8Prefix(redactSecrets(normalized), maximum)
}

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
  readonly #preflight: TemplateExecutionPreflight | undefined
  readonly #output: ManagedProcessEvent[] = []
  readonly #streamRaw: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  readonly #streamOverflowed: Record<'stdout' | 'stderr', boolean> = {
    stdout: false,
    stderr: false,
  }
  #process: ManagedProcess | undefined
  #pump: Promise<void> | undefined
  #release: (() => void) | undefined
  #starting: Promise<GdbStatus> | undefined
  #stopping: Promise<GdbStatus> | undefined
  #startController: AbortController | undefined

  public constructor(options: {
    readonly config: Config
    readonly templates: CommandTemplateRegistry
    readonly commands: CommandRunner
    readonly processes: ManagedProcessRunner
    readonly snippets: SnippetStore
    readonly preflight?: TemplateExecutionPreflight
  }) {
    this.#config = options.config
    this.#templates = options.templates
    this.#commands = options.commands
    this.#processes = options.processes
    this.#snippets = options.snippets
    this.#preflight = options.preflight
  }

  public status(): GdbStatus {
    return {
      state: this.#process === undefined ? 'stopped' : 'running',
      ...(this.#process?.pid === undefined ? {} : { pid: this.#process.pid }),
      target: this.#config.gdb.target,
      recentOutput: [...this.#output],
    }
  }

  public start(request: GdbStartRequest, signal?: AbortSignal): Promise<GdbStatus> {
    if (this.#process !== undefined || this.#starting !== undefined) {
      throw new LubanError('E_INVALID_TRANSITION', 'GDB server is already running or starting')
    }
    if (this.#stopping !== undefined) {
      throw new LubanError('E_INVALID_TRANSITION', 'GDB server is still stopping')
    }
    const controller = new AbortController()
    this.#startController = controller
    const combined =
      signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    const operation = this.#start(request, combined)
    this.#starting = operation
    const reset = (): void => {
      if (this.#starting === operation) this.#starting = undefined
      if (this.#startController === controller) this.#startController = undefined
    }
    void operation.then(reset, reset)
    return operation
  }

  async #start(request: GdbStartRequest, signal: AbortSignal): Promise<GdbStatus> {
    if (signal.aborted) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', 'GDB server start was cancelled', {
        retriable: true,
      })
    }
    const configuredPort = Number(
      this.#config.gdb.target.slice(this.#config.gdb.target.lastIndexOf(':') + 1),
    )
    const port = request.gdbPort ?? configuredPort
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || port !== configuredPort) {
      throw new LubanError('E_INVALID_INPUT', 'GDB port must match the configured loopback target')
    }
    const invocation: ResolvedInvocation = this.#templates.resolve('openocd-server', {
      interfaceConfig: request.interfaceConfig,
      targetConfig: request.targetConfig,
      gdbPort: String(port),
    })
    this.#output.length = 0
    this.#streamRaw.stdout = ''
    this.#streamRaw.stderr = ''
    this.#streamOverflowed.stdout = false
    this.#streamOverflowed.stderr = false
    const release = await this.#preflight?.(invocation, signal)
    try {
      this.#process = await this.#processes.start(invocation.command, invocation.args, {
        timeoutMs: this.#config.execution.processLifetimeMs,
        startupTimeoutMs: this.#config.execution.startupTimeoutMs,
        maxOutputBytes: this.#config.execution.maxOutputBytes,
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        signal,
      })
      this.#release = release
    } catch (error: unknown) {
      release?.()
      throw error
    }
    const owned = this.#process
    this.#pump = (async (): Promise<void> => {
      try {
        for await (const event of owned.events()) {
          this.#appendOutput(event)
          if (event.type === 'exit' && this.#process === owned) this.#process = undefined
        }
      } catch (error: unknown) {
        this.#appendOutput({
          type: 'stderr',
          text: error instanceof Error ? error.message : 'OpenOCD event stream failed',
          at: Date.now(),
        })
        if (this.#process === owned) this.#process = undefined
      } finally {
        if (this.#release === release) {
          this.#release = undefined
          release?.()
        }
      }
    })()
    return this.status()
  }

  #appendOutput(event: ManagedProcessEvent): void {
    const maximum = Math.min(this.#config.execution.maxOutputBytes, MAX_RECENT_OUTPUT_BYTES)
    let output = event
    if (event.text !== undefined) {
      const stream = event.type === 'stdout' || event.type === 'stderr' ? event.type : undefined
      const text =
        stream === undefined
          ? sanitizeOutputText(event.text, maximum)
          : this.#accumulateStream(stream, event.text, maximum)
      if (stream !== undefined) {
        const previous = this.#output.findIndex(
          (candidate): boolean => candidate.type === stream && candidate.text !== undefined,
        )
        if (previous >= 0) this.#output.splice(previous, 1)
      }
      output = { ...event, text }
    }
    this.#output.push(output)
    this.#trimOutput(maximum)
  }

  #accumulateStream(stream: 'stdout' | 'stderr', chunk: string, maximum: number): string {
    if (this.#streamOverflowed[stream]) return utf8Prefix(OUTPUT_OVERFLOW_MESSAGE, maximum)
    const current = this.#streamRaw[stream]
    const currentBytes = Buffer.byteLength(current, 'utf8')
    const chunkBytes = Buffer.byteLength(chunk, 'utf8')
    if (chunkBytes > maximum - currentBytes) {
      this.#streamRaw[stream] = ''
      this.#streamOverflowed[stream] = true
      return utf8Prefix(OUTPUT_OVERFLOW_MESSAGE, maximum)
    }
    const accumulated = `${current}${chunk}`
    this.#streamRaw[stream] = accumulated
    return sanitizeOutputText(accumulated, maximum)
  }

  #trimOutput(maximum: number): void {
    while (this.#output.length > MAX_RECENT_OUTPUT_EVENTS) this.#output.shift()
    let total = this.#output.reduce(
      (bytes, event): number =>
        bytes + (event.text === undefined ? 0 : Buffer.byteLength(event.text, 'utf8')),
      0,
    )
    while (total > maximum) {
      const removed = this.#output.shift()
      if (removed === undefined) break
      if (removed.text !== undefined) total -= Buffer.byteLength(removed.text, 'utf8')
    }
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

  public stop(): Promise<GdbStatus> {
    if (this.#stopping === undefined) {
      const operation = this.#stop()
      this.#stopping = operation
      const reset = (): void => {
        if (this.#stopping === operation) this.#stopping = undefined
      }
      void operation.then(reset, reset)
    }
    return this.#stopping
  }

  async #stop(): Promise<GdbStatus> {
    const starting = this.#starting
    this.#startController?.abort()
    try {
      await starting
    } catch {
      // A failed or cancelled start has already released its preflight lease.
    }
    const process = this.#process
    const pump = this.#pump
    const release = this.#release
    this.#process = undefined
    this.#pump = undefined
    this.#release = undefined
    try {
      if (process !== undefined) await process.stop()
    } finally {
      try {
        await pump
      } finally {
        release?.()
      }
    }
    return this.status()
  }
}
