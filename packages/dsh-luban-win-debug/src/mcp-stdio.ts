import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { LubanError, redactSecrets } from '@yin52133/dsh-luban-core'
import type { ManagedProcessEvent } from './types.js'

const MCP_PROTOCOL_VERSION = '2024-11-05'
const MAX_TOOL_PAGES = 32
const DEFAULT_SHUTDOWN_GRACE_MS = 2000
const MAX_STATUS_BYTES = 64 * 1024
const UNSAFE_CONTROL_CLASS = '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F'
const UNSAFE_CONTROL_CHARACTERS = new RegExp(`[${UNSAFE_CONTROL_CLASS}]`, 'gu')
const CONTROL_SEPARATED_AUTH = new RegExp(
  `\\b(?:Bearer|Basic)[${UNSAFE_CONTROL_CLASS}]+[^\\s,;]+`,
  'giu',
)

type JsonRpcId = string | number

interface JsonRpcError {
  readonly code?: unknown
  readonly message?: unknown
  readonly data?: unknown
}

interface PendingRequest {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal: AbortSignal | undefined
  readonly abort: () => void
}

interface ProcessListeners {
  readonly child: DesktopMcpProcess
  readonly stdout: (chunk: Buffer) => void
  readonly stderr: (chunk: Buffer) => void
  readonly stdinError: (error: Error) => void
  readonly error: (error: Error) => void
  readonly close: (exitCode: number | null) => void
}

export interface DesktopMcpConnectOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly allowedTools: readonly string[]
  readonly startupTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly processLifetimeMs: number
  readonly maxMessageBytes: number
  readonly cwd?: string
  readonly signal?: AbortSignal
}

export interface DesktopMcpCallResult {
  readonly text: string
}

/** Injectable stdio child surface; tests use in-memory streams and never start a process. */
export type DesktopMcpProcess = Pick<
  ChildProcessWithoutNullStreams,
  'pid' | 'stdin' | 'stdout' | 'stderr' | 'exitCode' | 'kill' | 'once' | 'off' | 'unref'
>

export type DesktopMcpProcessFactory = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string },
) => DesktopMcpProcess

export interface DesktopMcpClient {
  readonly pid: number | undefined
  readonly connected: boolean
  readonly advertisedTools: readonly string[]
  readonly recentOutput: readonly ManagedProcessEvent[]
  connect(options: DesktopMcpConnectOptions): Promise<void>
  call(tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<string>
  stop(): Promise<void>
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function utf8Prefix(input: string, maximum: number): string {
  if (maximum <= 0) return ''
  const bytes = Buffer.from(input, 'utf8')
  if (bytes.byteLength <= maximum) return input
  return new StringDecoder('utf8').write(bytes.subarray(0, maximum))
}

function sanitizeBounded(input: string, maximum: number): string {
  const normalized = input
    .replace(/\r\n?/gu, '\n')
    .replace(CONTROL_SEPARATED_AUTH, '[REDACTED]')
    .replace(UNSAFE_CONTROL_CHARACTERS, '')
  const redacted = redactSecrets(normalized)
  return utf8Prefix(redacted, maximum)
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function rpcFailure(method: string, error: JsonRpcError, maximum: number): LubanError {
  const message =
    typeof error.message === 'string' && error.message.trim() !== ''
      ? sanitizeBounded(error.message, Math.min(maximum, 2000))
      : 'unknown JSON-RPC error'
  return new LubanError('E_UNAVAILABLE', `Desktop MCP ${method} failed: ${message}`, {
    retriable: true,
    details: {
      ...(typeof error.code === 'number' ? { rpcCode: error.code } : {}),
    },
  })
}

function serialized(value: unknown): string {
  try {
    const output: unknown = JSON.stringify(value)
    return typeof output === 'string' ? output : 'null'
  } catch {
    return '[unserializable MCP content]'
  }
}

export function formatDesktopMcpResult(value: unknown, maximum: number): string {
  const result = record(value)
  const content = result?.content
  if (!Array.isArray(content)) {
    throw new LubanError('E_UNAVAILABLE', 'Desktop MCP returned an invalid tools/call result')
  }
  let text = ''
  let used = 0
  const append = (raw: string): void => {
    if (used >= maximum) return
    const separator = used === 0 ? '' : '\n'
    const separatorBytes = Buffer.byteLength(separator, 'utf8')
    if (used + separatorBytes >= maximum) return
    const next = sanitizeBounded(raw, maximum - used - separatorBytes)
    text += `${separator}${next}`
    used += separatorBytes + Buffer.byteLength(next, 'utf8')
  }
  for (const entry of content) {
    if (used >= maximum) break
    const block = record(entry)
    append(
      block?.type === 'text' && typeof block.text === 'string' ? block.text : serialized(entry),
    )
  }
  if (result?.structuredContent !== undefined && used < maximum) {
    append(serialized(result.structuredContent))
  }
  text = sanitizeBounded(text, maximum)
  if (result?.isError === true) {
    const detail = sanitizeBounded(text, Math.min(maximum, 2000))
    throw new LubanError(
      'E_UNAVAILABLE',
      `Desktop MCP tool reported an error${detail === '' ? '' : `: ${detail}`}`,
      { retriable: true },
    )
  }
  return text
}

function sanitizedTransportFailure(error: unknown, maximum: number): LubanError {
  const message =
    error instanceof Error
      ? sanitizeBounded(error.message, Math.min(maximum, 2000))
      : 'unknown transport failure'
  return new LubanError('E_UNAVAILABLE', `Desktop MCP transport failed: ${message}`, {
    retriable: true,
  })
}

function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve): void => {
    let settled = false
    const timer = setTimeout((): void => {
      if (settled) return
      settled = true
      resolve(false)
    }, timeoutMs)
    timer.unref()
    void promise.then((): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function nodeProcessFactory(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string },
): DesktopMcpProcess {
  return spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * Minimal fail-closed MCP 2024-11-05 stdio client.
 *
 * The client implements only initialize, tools/list and tools/call. Unknown
 * server requests are rejected, output is bounded, and cancellation tears down
 * the owned process before the call settles.
 */
export class NodeStdioMcpClient implements DesktopMcpClient {
  readonly #factory: DesktopMcpProcessFactory
  readonly #shutdownGraceMs: number
  readonly #pending = new Map<JsonRpcId, PendingRequest>()
  readonly #output: ManagedProcessEvent[] = []
  #process: DesktopMcpProcess | undefined
  #options: DesktopMcpConnectOptions | undefined
  #buffer = ''
  #stdoutDecoder = new StringDecoder('utf8')
  #nextId = 0
  #connected = false
  #advertisedTools: readonly string[] = []
  #stderrDecoder = new StringDecoder('utf8')
  #stderrTail = ''
  #stderrOverflow = false
  #lifetimeTimer: ReturnType<typeof setTimeout> | undefined
  #stopping: Promise<void> | undefined
  #listeners: ProcessListeners | undefined
  #terminalFailure: LubanError | undefined
  #quiescing = false

  public constructor(
    factory: DesktopMcpProcessFactory = nodeProcessFactory,
    shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  ) {
    if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs <= 0) {
      throw new TypeError('shutdownGraceMs must be a positive integer')
    }
    this.#factory = factory
    this.#shutdownGraceMs = shutdownGraceMs
  }

  public get pid(): number | undefined {
    return this.#process?.pid
  }

  public get connected(): boolean {
    return this.#connected
  }

  public get advertisedTools(): readonly string[] {
    return this.#advertisedTools
  }

  public get recentOutput(): readonly ManagedProcessEvent[] {
    return [...this.#output]
  }

  public async connect(options: DesktopMcpConnectOptions): Promise<void> {
    if (this.#stopping !== undefined) {
      throw new LubanError('E_UNAVAILABLE', 'Desktop MCP is still stopping', { retriable: true })
    }
    if (this.#process !== undefined) {
      if (this.#connected) return
      throw new LubanError('E_UNAVAILABLE', 'Desktop MCP is already starting', { retriable: true })
    }
    if (isAborted(options.signal)) {
      throw new LubanError('E_UNAVAILABLE', 'Desktop MCP start was cancelled', { retriable: true })
    }
    this.#options = options
    this.#output.length = 0
    this.#buffer = ''
    this.#stdoutDecoder = new StringDecoder('utf8')
    this.#stderrDecoder = new StringDecoder('utf8')
    this.#stderrTail = ''
    this.#stderrOverflow = false
    this.#terminalFailure = undefined
    this.#quiescing = false
    let child: DesktopMcpProcess
    try {
      child = this.#factory(options.command, options.args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      })
    } catch (error: unknown) {
      this.#resetWithoutProcess()
      throw sanitizedTransportFailure(error, options.maxMessageBytes)
    }
    this.#process = child
    this.#listen(child)

    const abort = (): void => {
      this.#stopSilently()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      if (isAborted(options.signal)) {
        await this.stop()
        throw new LubanError('E_UNAVAILABLE', 'Desktop MCP start was cancelled', {
          retriable: true,
        })
      }
      await this.#waitForSpawn(child, options.startupTimeoutMs, options.signal)
      const initialized = record(
        await this.#request(
          'initialize',
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'dsh-luban-win-debug', version: '0.1.0' },
          },
          options.startupTimeoutMs,
          options.signal,
        ),
      )
      if (initialized?.protocolVersion !== MCP_PROTOCOL_VERSION) {
        throw new LubanError(
          'E_UNAVAILABLE',
          `Desktop MCP protocol mismatch; expected ${MCP_PROTOCOL_VERSION}`,
        )
      }
      this.#notification('notifications/initialized', {})
      this.#advertisedTools = await this.#discoverTools(options)
      const advertised = new Set(this.#advertisedTools)
      const missing = options.allowedTools.filter((tool): boolean => !advertised.has(tool))
      if (missing.length > 0) {
        throw new LubanError(
          'E_UNAVAILABLE',
          `Desktop MCP did not advertise allowlisted tool(s): ${missing.join(', ')}`,
        )
      }
      this.#connected = true
      this.#lifetimeTimer = setTimeout((): void => {
        this.#stopSilently()
      }, options.processLifetimeMs)
      this.#lifetimeTimer.unref()
    } catch (error: unknown) {
      await this.stop()
      throw error
    } finally {
      options.signal?.removeEventListener('abort', abort)
    }
  }

  public async call(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const options = this.#options
    if (!this.#connected || options === undefined) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Desktop MCP is not connected', {
        retriable: true,
      })
    }
    if (!options.allowedTools.includes(tool) || !this.#advertisedTools.includes(tool)) {
      throw new LubanError('E_INVALID_INPUT', `Desktop MCP tool ${tool} is not allowlisted`)
    }
    const result = await this.#request(
      'tools/call',
      { name: tool, arguments: args },
      options.requestTimeoutMs,
      signal,
    )
    return formatDesktopMcpResult(result, options.maxMessageBytes)
  }

  public stop(): Promise<void> {
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

  #stopSilently(): void {
    void this.stop().catch((): void => {
      // Timeout paths already detach state and reject active callers explicitly.
    })
  }

  async #stop(): Promise<void> {
    const child = this.#process
    this.#quiescing = true
    this.#connected = false
    this.#advertisedTools = []
    clearTimeout(this.#lifetimeTimer)
    this.#lifetimeTimer = undefined
    if (child === undefined) {
      this.#quiescing = false
      return
    }
    if (child.exitCode !== null) {
      this.#disconnect(
        child,
        this.#terminalFailure ??
          new LubanError('E_CHANNEL_UNAVAILABLE', 'Desktop MCP process exited', {
            retriable: true,
            details: { exitCode: child.exitCode },
          }),
      )
      return
    }
    const observedClose = (): void => resolveClosed()
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve): void => {
      resolveClosed = resolve
    })
    child.once('close', observedClose)
    try {
      try {
        child.kill('SIGTERM')
      } catch {
        // The final SIGKILL + bounded close wait below remains authoritative.
      }
      let exited = await waitFor(closed, this.#shutdownGraceMs)
      if (!exited) {
        try {
          child.kill('SIGKILL')
        } catch {
          // A missing close event is handled by the bounded failure below.
        }
        exited = await waitFor(closed, this.#shutdownGraceMs)
      }
      if (!exited) {
        const failure = new LubanError(
          'E_TIMEOUT',
          'Desktop MCP process did not close after forced termination',
          { retriable: true },
        )
        this.#disconnect(child, this.#terminalFailure ?? failure)
        throw failure
      }
    } finally {
      child.off('close', observedClose)
    }
  }

  async #discoverTools(options: DesktopMcpConnectOptions): Promise<readonly string[]> {
    const names = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = record(
        await this.#request(
          'tools/list',
          cursor === undefined ? {} : { cursor },
          options.startupTimeoutMs,
          options.signal,
        ),
      )
      if (!Array.isArray(result?.tools)) {
        throw new LubanError('E_UNAVAILABLE', 'Desktop MCP returned an invalid tools/list result')
      }
      for (const value of result.tools) {
        const tool = record(value)
        if (
          typeof tool?.name !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(tool.name)
        ) {
          throw new LubanError('E_UNAVAILABLE', 'Desktop MCP advertised an invalid tool name')
        }
        names.add(tool.name)
      }
      if (result.nextCursor === undefined) return Object.freeze([...names].sort())
      if (typeof result.nextCursor !== 'string' || result.nextCursor === '') {
        throw new LubanError('E_UNAVAILABLE', 'Desktop MCP returned an invalid tools/list cursor')
      }
      cursor = result.nextCursor
    }
    throw new LubanError('E_UNAVAILABLE', 'Desktop MCP tools/list exceeded the page limit')
  }

  #waitForSpawn(child: DesktopMcpProcess, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject): void => {
      let settled = false
      const cleanup = (): void => {
        clearTimeout(timer)
        child.off('spawn', spawned)
        child.off('error', failed)
        child.off('close', closed)
        signal?.removeEventListener('abort', aborted)
      }
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error === undefined) resolve()
        else reject(error)
      }
      const spawned = (): void => settle()
      const failed = (error: Error): void => {
        settle(
          new LubanError('E_CHANNEL_UNAVAILABLE', 'Unable to start Desktop MCP', {
            retriable: true,
            cause: error,
          }),
        )
      }
      const closed = (): void => {
        settle(
          new LubanError('E_CHANNEL_UNAVAILABLE', 'Desktop MCP exited before startup completed', {
            retriable: true,
          }),
        )
      }
      const aborted = (): void => {
        settle(
          new LubanError('E_UNAVAILABLE', 'Desktop MCP start was cancelled', { retriable: true }),
        )
      }
      const timer = setTimeout((): void => {
        settle(new LubanError('E_TIMEOUT', 'Desktop MCP startup timed out', { retriable: true }))
        try {
          child.kill('SIGKILL')
        } catch {
          // connect() awaits the bounded stop path after this timeout settles.
        }
      }, timeoutMs)
      timer.unref()
      child.once('spawn', spawned)
      child.once('error', failed)
      child.once('close', closed)
      signal?.addEventListener('abort', aborted, { once: true })
      if (child.exitCode !== null) closed()
      else if (isAborted(signal)) aborted()
    })
  }

  #request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted === true) {
      return this.#rejectAfterStop(
        new LubanError('E_UNAVAILABLE', `Desktop MCP ${method} was cancelled`, {
          retriable: true,
        }),
      )
    }
    const id = ++this.#nextId
    return new Promise<unknown>((resolve, reject): void => {
      const timer = setTimeout((): void => {
        this.#settle(id)
        void this.#rejectAfterStop(
          new LubanError('E_TIMEOUT', `Desktop MCP ${method} timed out`, { retriable: true }),
        ).catch(reject)
      }, timeoutMs)
      timer.unref()
      const abort = (): void => {
        this.#settle(id)
        void this.#rejectAfterStop(
          new LubanError('E_UNAVAILABLE', `Desktop MCP ${method} was cancelled`, {
            retriable: true,
          }),
        ).catch(reject)
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.#pending.set(id, { method, resolve, reject, timer, signal, abort })
      try {
        this.#write({ jsonrpc: '2.0', id, method, params })
      } catch (error: unknown) {
        this.#settle(id)
        reject(error instanceof Error ? error : new Error('Desktop MCP request failed'))
      }
    })
  }

  #notification(method: string, params: Readonly<Record<string, unknown>>): void {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  async #rejectAfterStop(error: LubanError): Promise<never> {
    try {
      await this.stop()
    } catch {
      // The stop path has already detached all owned handles before rejecting.
    }
    throw error
  }

  #listen(child: DesktopMcpProcess): void {
    const listeners: ProcessListeners = {
      child,
      stdout: (chunk): void => this.#onStdout(child, chunk),
      stderr: (chunk): void => this.#onStderr(child, chunk),
      stdinError: (error): void => this.#fail(child, error),
      error: (error): void => this.#fail(child, error),
      close: (exitCode): void => this.#closed(child, exitCode),
    }
    this.#listeners = listeners
    child.stdout.on('data', listeners.stdout)
    child.stderr.on('data', listeners.stderr)
    child.stdin.on('error', listeners.stdinError)
    child.once('error', listeners.error)
    child.once('close', listeners.close)
  }

  #write(message: Readonly<Record<string, unknown>>): void {
    if (this.#quiescing) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Desktop MCP process is stopping', {
        retriable: true,
      })
    }
    const child = this.#process
    const options = this.#options
    if (child === undefined || options === undefined) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Desktop MCP process is unavailable', {
        retriable: true,
      })
    }
    if (child.exitCode !== null) {
      this.#fail(
        child,
        new LubanError('E_CHANNEL_UNAVAILABLE', 'Desktop MCP process is unavailable', {
          retriable: true,
        }),
      )
      return
    }
    if (child.stdin.destroyed || child.stdin.writableEnded) {
      const failure = new LubanError('E_CHANNEL_UNAVAILABLE', 'Desktop MCP stdin is unavailable', {
        retriable: true,
      })
      this.#fail(child, failure)
      return
    }
    let line: string
    try {
      line = `${JSON.stringify(message)}\n`
    } catch {
      throw new LubanError('E_INVALID_INPUT', 'Desktop MCP request is not JSON serializable')
    }
    if (Buffer.byteLength(line, 'utf8') > options.maxMessageBytes) {
      throw new LubanError('E_INVALID_INPUT', 'Desktop MCP request is too large')
    }
    try {
      child.stdin.write(line, (error?: Error | null): void => {
        if (error !== undefined && error !== null) this.#fail(child, error)
      })
    } catch (error: unknown) {
      this.#fail(child, error)
    }
  }

  #onStdout(child: DesktopMcpProcess, chunk: Buffer): void {
    if (this.#process !== child || this.#quiescing) return
    const options = this.#options
    if (options === undefined) return
    this.#buffer += this.#stdoutDecoder.write(chunk)
    let newline = this.#buffer.indexOf('\n')
    while (newline >= 0) {
      const rawLine = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (Buffer.byteLength(rawLine, 'utf8') > options.maxMessageBytes) {
        this.#fail(child, new LubanError('E_UNAVAILABLE', 'Desktop MCP response is too large'))
        return
      }
      const line = rawLine.trim()
      if (line !== '') this.#receive(child, line)
      newline = this.#buffer.indexOf('\n')
    }
    if (Buffer.byteLength(this.#buffer, 'utf8') > options.maxMessageBytes) {
      this.#fail(child, new LubanError('E_UNAVAILABLE', 'Desktop MCP response is too large'))
    }
  }

  #onStderr(child: DesktopMcpProcess, chunk: Buffer): void {
    if (this.#process !== child) return
    const maximum = Math.min(this.#options?.maxMessageBytes ?? MAX_STATUS_BYTES, MAX_STATUS_BYTES)
    if (!this.#stderrOverflow) {
      const next = `${this.#stderrTail}${this.#stderrDecoder.write(chunk)}`
      if (Buffer.byteLength(next, 'utf8') > maximum) {
        this.#stderrOverflow = true
        this.#stderrTail = ''
      } else {
        this.#stderrTail = next
      }
    }
    this.#publishStderr(maximum)
  }

  #receive(child: DesktopMcpProcess, line: string): void {
    if (this.#process !== child || this.#quiescing) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch (error: unknown) {
      this.#fail(
        child,
        new LubanError('E_UNAVAILABLE', 'Desktop MCP emitted invalid JSON', { cause: error }),
      )
      return
    }
    const message = record(parsed)
    if (message?.jsonrpc !== '2.0') {
      this.#fail(
        child,
        new LubanError('E_UNAVAILABLE', 'Desktop MCP emitted an invalid JSON-RPC message'),
      )
      return
    }
    const id = message.id
    if (typeof id === 'number' || typeof id === 'string') {
      const pending = this.#pending.get(id)
      if (pending !== undefined && (message.result !== undefined || message.error !== undefined)) {
        this.#settle(id)
        const error = record(message.error)
        if (error === undefined) pending.resolve(message.result)
        else
          pending.reject(
            rpcFailure(pending.method, error, this.#options?.maxMessageBytes ?? MAX_STATUS_BYTES),
          )
        return
      }
      if (typeof message.method === 'string') {
        try {
          this.#write({
            jsonrpc: '2.0',
            id,
            ...(message.method === 'ping'
              ? { result: {} }
              : { error: { code: -32_601, message: 'Method not supported by this client' } }),
          })
        } catch (error: unknown) {
          this.#fail(child, error)
        }
      }
    }
  }

  #settle(id: JsonRpcId): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.abort)
  }

  #rejectPending(error: unknown): void {
    for (const [id, pending] of this.#pending) {
      this.#settle(id)
      pending.reject(error)
    }
  }

  #fail(child: DesktopMcpProcess, error: unknown): void {
    if (this.#process !== child) return
    this.#terminalFailure ??= sanitizedTransportFailure(
      error,
      this.#options?.maxMessageBytes ?? MAX_STATUS_BYTES,
    )
    this.#stopSilently()
  }

  #closed(child: DesktopMcpProcess, exitCode: number | null): void {
    if (this.#process !== child) return
    this.#output.push({ type: 'exit', exitCode: exitCode ?? -1, at: Date.now() })
    this.#disconnect(
      child,
      this.#terminalFailure ??
        new LubanError('E_CHANNEL_UNAVAILABLE', 'Desktop MCP process exited', {
          retriable: true,
          details: { exitCode: exitCode ?? -1 },
        }),
    )
  }

  #disconnect(child: DesktopMcpProcess, failure: LubanError): void {
    if (this.#process !== child) return
    const remainder = this.#stderrDecoder.end()
    if (remainder !== '' && !this.#stderrOverflow) {
      const maximum = Math.min(this.#options?.maxMessageBytes ?? MAX_STATUS_BYTES, MAX_STATUS_BYTES)
      const next = `${this.#stderrTail}${remainder}`
      if (Buffer.byteLength(next, 'utf8') > maximum) {
        this.#stderrOverflow = true
        this.#stderrTail = ''
      } else {
        this.#stderrTail = next
      }
      this.#publishStderr(maximum)
    }
    this.#releaseProcess(child)
    clearTimeout(this.#lifetimeTimer)
    this.#lifetimeTimer = undefined
    this.#connected = false
    this.#advertisedTools = []
    this.#buffer = ''
    this.#stdoutDecoder.end()
    this.#stdoutDecoder = new StringDecoder('utf8')
    this.#stderrTail = ''
    this.#stderrOverflow = false
    this.#stderrDecoder = new StringDecoder('utf8')
    this.#options = undefined
    this.#process = undefined
    this.#terminalFailure = undefined
    this.#quiescing = false
    this.#rejectPending(failure)
  }

  #releaseProcess(child: DesktopMcpProcess): void {
    const listeners = this.#listeners
    if (listeners?.child === child) {
      child.stdout.off('data', listeners.stdout)
      child.stderr.off('data', listeners.stderr)
      child.stdin.off('error', listeners.stdinError)
      child.off('error', listeners.error)
      child.off('close', listeners.close)
      this.#listeners = undefined
    }
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    try {
      child.unref()
    } catch {
      // State is already detached; an unusual child implementation cannot retain the client.
    }
  }

  #resetWithoutProcess(): void {
    clearTimeout(this.#lifetimeTimer)
    this.#lifetimeTimer = undefined
    this.#connected = false
    this.#advertisedTools = []
    this.#buffer = ''
    this.#stdoutDecoder = new StringDecoder('utf8')
    this.#stderrDecoder = new StringDecoder('utf8')
    this.#stderrTail = ''
    this.#stderrOverflow = false
    this.#options = undefined
    this.#process = undefined
    this.#listeners = undefined
    this.#terminalFailure = undefined
    this.#quiescing = false
  }

  #publishStderr(maximum: number): void {
    const event: ManagedProcessEvent = {
      type: 'stderr',
      text: this.#stderrOverflow
        ? '[Desktop MCP stderr exceeded the safe display limit and was redacted]'
        : sanitizeBounded(this.#stderrTail, maximum),
      at: Date.now(),
    }
    const current = this.#output.findIndex((candidate): boolean => candidate.type === 'stderr')
    if (current < 0) this.#output.push(event)
    else this.#output[current] = event
  }
}
