import { connect, type Socket } from 'node:net'
import type {
  ChannelAdapter,
  ChannelDataEvent,
  ChannelEndpoint,
  ChannelHandle,
  ChannelKind,
  ExecResult,
  OpenOptions,
} from 'dsh-luban-core'
import { LubanError } from 'dsh-luban-core'
import type { Config, RemoteEndpointConfig } from './config.js'
import { parseCommandWords } from './command-runner.js'
import { BoundedAsyncQueue } from './queue.js'
import type { CommandRunner } from './types.js'

interface ExecutionPolicy {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly cwd?: string
}

interface Invocation {
  readonly args: readonly string[]
  readonly allowedCommands: readonly string[]
}

type InvocationFactory = (endpoint: ChannelEndpoint, words: readonly string[]) => Invocation

class CommandHandle implements ChannelHandle {
  readonly #runner: CommandRunner
  readonly #executable: string
  readonly #endpoint: ChannelEndpoint
  readonly #policy: ExecutionPolicy
  readonly #invocation: InvocationFactory
  readonly #queue = new BoundedAsyncQueue<ChannelDataEvent>(256)
  readonly #controller = new AbortController()
  #closed = false

  public constructor(
    runner: CommandRunner,
    executable: string,
    endpoint: ChannelEndpoint,
    policy: ExecutionPolicy,
    invocation: InvocationFactory,
  ) {
    this.#runner = runner
    this.#executable = executable
    this.#endpoint = endpoint
    this.#policy = policy
    this.#invocation = invocation
    this.#queue.push({ type: 'status', status: 'open', at: Date.now() })
  }

  public write(_data: Uint8Array | string): Promise<void> {
    return Promise.reject(
      new LubanError('E_INVALID_INPUT', `${this.#endpoint.kind} is a command-only channel`),
    )
  }

  public readEvents(): AsyncIterable<ChannelDataEvent> {
    return this.#queue
  }

  public async exec(command: string, signal?: AbortSignal): Promise<ExecResult> {
    if (this.#closed) throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Channel is closed')
    const words = parseCommandWords(command)
    const invocation = this.#invocation(this.#endpoint, words)
    const root = words[0]
    if (root === undefined || !invocation.allowedCommands.includes(root)) {
      throw new LubanError('E_INVALID_INPUT', `Command ${root ?? '(missing)'} is not allowlisted`)
    }
    const result = await this.#runner.run(this.#executable, invocation.args, {
      timeoutMs: this.#policy.timeoutMs,
      maxOutputBytes: this.#policy.maxOutputBytes,
      signal:
        signal === undefined
          ? this.#controller.signal
          : AbortSignal.any([this.#controller.signal, signal]),
      ...(this.#policy.cwd === undefined ? {} : { cwd: this.#policy.cwd }),
    })
    const output = `${result.stdout}${result.stderr}`
    if (output !== '') {
      this.#queue.push({
        type: 'data',
        data: new TextEncoder().encode(output.slice(-64 * 1024)),
        at: Date.now(),
      })
    }
    if (result.exitCode !== 0) {
      this.#queue.push({
        type: 'status',
        status: 'error',
        detail: `${this.#endpoint.kind} exited with ${String(result.exitCode)}`,
        at: Date.now(),
      })
    }
    return result
  }

  public close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true
      this.#controller.abort()
      this.#queue.push({ type: 'status', status: 'closed', at: Date.now() })
      this.#queue.end()
    }
    return Promise.resolve()
  }
}

/** Fixed-endpoint command adapter used for safe GDB and SSH command channels. */
export class StaticCommandChannelAdapter implements ChannelAdapter {
  public readonly kind: ChannelKind
  readonly #endpoints: readonly ChannelEndpoint[]
  readonly #runner: CommandRunner
  readonly #executable: string
  readonly #policy: ExecutionPolicy
  readonly #invocation: InvocationFactory

  public constructor(options: {
    readonly kind: 'gdb' | 'ssh'
    readonly endpoints: readonly ChannelEndpoint[]
    readonly runner: CommandRunner
    readonly executable: string
    readonly policy: ExecutionPolicy
    readonly invocation: InvocationFactory
  }) {
    this.kind = options.kind
    this.#endpoints = options.endpoints
    this.#runner = options.runner
    this.#executable = options.executable
    this.#policy = options.policy
    this.#invocation = options.invocation
  }

  public list(): Promise<readonly ChannelEndpoint[]> {
    return Promise.resolve(this.#endpoints)
  }

  public open(endpoint: ChannelEndpoint, _options: OpenOptions): Promise<ChannelHandle> {
    const configured = this.#endpoints.find((candidate): boolean => candidate.id === endpoint.id)
    if (configured?.kind !== this.kind) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', `${this.kind} endpoint is not allowlisted`)
    }
    return Promise.resolve(
      new CommandHandle(this.#runner, this.#executable, configured, this.#policy, this.#invocation),
    )
  }
}

export interface SocketConnection {
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
  onData(listener: (data: Uint8Array) => void): () => void
  onStatus(listener: (status: 'closed' | 'error', detail?: string) => void): () => void
}

export interface SocketConnector {
  open(
    host: string,
    port: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SocketConnection>
}

class NodeSocketConnection implements SocketConnection {
  readonly #socket: Socket
  #closed = false

  public constructor(socket: Socket) {
    this.#socket = socket
  }

  public write(data: Uint8Array): Promise<void> {
    if (this.#closed) throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Network channel is closed')
    return new Promise<void>((resolve, reject): void => {
      this.#socket.write(data, (error?: Error | null): void => {
        if (error === undefined || error === null) resolve()
        else
          reject(new LubanError('E_CHANNEL_UNAVAILABLE', 'Network write failed', { cause: error }))
      })
    })
  }

  public onData(listener: (data: Uint8Array) => void): () => void {
    const receive = (data: Buffer): void => listener(new Uint8Array(data))
    this.#socket.on('data', receive)
    return (): void => {
      this.#socket.off('data', receive)
    }
  }

  public onStatus(listener: (status: 'closed' | 'error', detail?: string) => void): () => void {
    const close = (): void => listener('closed')
    const error = (reason: Error): void => listener('error', reason.message)
    this.#socket.on('close', close)
    this.#socket.on('error', error)
    return (): void => {
      this.#socket.off('close', close)
      this.#socket.off('error', error)
    }
  }

  public close(): Promise<void> {
    if (this.#closed || this.#socket.destroyed) {
      this.#closed = true
      return Promise.resolve()
    }
    this.#closed = true
    return new Promise<void>((resolve): void => {
      this.#socket.once('close', (): void => resolve())
      this.#socket.destroy()
    })
  }
}

/** Node TCP connector with explicit host/port, open timeout and cancellation. */
export class NodeSocketConnector implements SocketConnector {
  public open(
    host: string,
    port: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SocketConnection> {
    if (signal?.aborted === true) {
      return Promise.reject(new LubanError('E_CHANNEL_UNAVAILABLE', 'Network open was cancelled'))
    }
    return new Promise<SocketConnection>((resolve, reject): void => {
      let settled = false
      const socket = connect({ host: host.replace(/^\[|\]$/gu, ''), port })
      const abort = (): void => {
        socket.destroy()
        if (!settled) {
          settled = true
          reject(new LubanError('E_CHANNEL_UNAVAILABLE', 'Network open was cancelled'))
        }
      }
      const timer = setTimeout((): void => {
        socket.destroy()
        if (!settled) {
          settled = true
          reject(new LubanError('E_TIMEOUT', 'Network open timed out', { retriable: true }))
        }
      }, timeoutMs)
      timer.unref()
      signal?.addEventListener('abort', abort, { once: true })
      socket.once('connect', (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        resolve(new NodeSocketConnection(socket))
      })
      socket.once('error', (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(
          new LubanError('E_CHANNEL_UNAVAILABLE', `Unable to connect to ${host}:${String(port)}`, {
            retriable: true,
            cause: error,
          }),
        )
      })
    })
  }
}

class NetworkHandle implements ChannelHandle {
  readonly #connection: SocketConnection
  readonly #queue = new BoundedAsyncQueue<ChannelDataEvent>(2048)
  readonly #detachData: () => void
  readonly #detachStatus: () => void
  #closed = false

  public constructor(connection: SocketConnection) {
    this.#connection = connection
    this.#detachData = connection.onData((data): void => {
      this.#queue.push({
        type: 'data',
        data: data.byteLength <= 64 * 1024 ? data : data.slice(data.byteLength - 64 * 1024),
        at: Date.now(),
      })
    })
    this.#detachStatus = connection.onStatus((status, detail): void => {
      this.#queue.push({
        type: 'status',
        status,
        ...(detail === undefined ? {} : { detail }),
        at: Date.now(),
      })
      if (status === 'closed') this.#finish()
    })
    this.#queue.push({ type: 'status', status: 'open', at: Date.now() })
  }

  public write(data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    if (bytes.byteLength > 64 * 1024)
      throw new LubanError('E_INVALID_INPUT', 'Network write is too large')
    return this.#connection.write(bytes)
  }

  public readEvents(): AsyncIterable<ChannelDataEvent> {
    return this.#queue
  }

  public async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await this.#connection.close()
    } finally {
      this.#queue.push({ type: 'status', status: 'closed', at: Date.now() })
      this.#finish()
    }
  }

  #finish(): void {
    this.#closed = true
    this.#detachData()
    this.#detachStatus()
    this.#queue.end()
  }
}

/** Raw telnet/TCP-serial channels share the same ChannelAdapter UI contract as serial. */
export class TcpChannelAdapter implements ChannelAdapter {
  public readonly kind: 'telnet' | 'tcp-serial'
  readonly #endpoints: readonly ChannelEndpoint[]
  readonly #configs: ReadonlyMap<string, RemoteEndpointConfig>
  readonly #connector: SocketConnector

  public constructor(
    kind: 'telnet' | 'tcp-serial',
    configs: readonly RemoteEndpointConfig[],
    connector: SocketConnector = new NodeSocketConnector(),
  ) {
    this.kind = kind
    const selected = configs.filter((config): boolean => config.kind === kind)
    this.#configs = new Map(
      selected.map((config): readonly [string, RemoteEndpointConfig] => [
        `${kind}:${config.id}`,
        config,
      ]),
    )
    this.#endpoints = selected.map((config): ChannelEndpoint =>
      Object.freeze({
        kind,
        id: `${kind}:${config.id}`,
        label: config.label,
        params: Object.freeze({ host: config.host, port: String(config.port) }),
      }),
    )
    this.#connector = connector
  }

  public list(): Promise<readonly ChannelEndpoint[]> {
    return Promise.resolve(this.#endpoints)
  }

  public async open(endpoint: ChannelEndpoint, options: OpenOptions): Promise<ChannelHandle> {
    const configured = this.#configs.get(endpoint.id)
    if (configured === undefined || endpoint.kind !== this.kind) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', `${this.kind} endpoint is not allowlisted`)
    }
    const timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
      throw new LubanError('E_INVALID_INPUT', 'Network timeout is invalid')
    }
    return new NetworkHandle(
      await this.#connector.open(configured.host, configured.port, timeoutMs, options.signal),
    )
  }
}

function commandPolicy(config: Config): ExecutionPolicy {
  return {
    timeoutMs: config.execution.timeoutMs,
    maxOutputBytes: config.execution.maxOutputBytes,
    ...(config.execution.cwd === undefined ? {} : { cwd: config.execution.cwd }),
  }
}

export function createGdbChannel(config: Config, runner: CommandRunner): ChannelAdapter {
  const endpoint: ChannelEndpoint = Object.freeze({
    kind: 'gdb',
    id: 'gdb:local',
    label: `GDB · ${config.gdb.target}`,
    params: Object.freeze({ target: config.gdb.target }),
  })
  const allowed = ['info', 'print', 'x', 'bt', 'monitor']
  return new StaticCommandChannelAdapter({
    kind: 'gdb',
    endpoints: [endpoint],
    runner,
    executable: config.tools.gdb,
    policy: commandPolicy(config),
    invocation: (_candidate, words): Invocation => ({
      args: [
        '--batch',
        '--nx',
        '--quiet',
        '-ex',
        `target extended-remote ${config.gdb.target}`,
        '-ex',
        words.join(' '),
      ],
      allowedCommands: allowed,
    }),
  })
}

export function createSshChannel(config: Config, runner: CommandRunner): ChannelAdapter {
  const ssh = config.remote.filter((endpoint): boolean => endpoint.kind === 'ssh')
  const endpointMap = new Map(
    ssh.map((row): readonly [string, RemoteEndpointConfig] => [`ssh:${row.id}`, row]),
  )
  const endpoints = ssh.map((row): ChannelEndpoint =>
    Object.freeze({
      kind: 'ssh',
      id: `ssh:${row.id}`,
      label: row.label,
      params: Object.freeze({
        host: row.host,
        port: String(row.port),
        ...(row.user === undefined ? {} : { user: row.user }),
      }),
    }),
  )
  return new StaticCommandChannelAdapter({
    kind: 'ssh',
    endpoints,
    runner,
    executable: config.tools.ssh,
    policy: commandPolicy(config),
    invocation: (endpoint, words): Invocation => {
      const row = endpointMap.get(endpoint.id)
      if (row === undefined)
        throw new LubanError('E_CHANNEL_UNAVAILABLE', 'SSH endpoint is not allowlisted')
      const destination = row.user === undefined ? row.host : `${row.user}@${row.host}`
      return {
        args: [
          '-T',
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=yes',
          '-p',
          String(row.port),
          ...(row.identityFile === undefined ? [] : ['-i', row.identityFile]),
          destination,
          '--',
          ...words,
        ],
        allowedCommands: row.allowedCommands,
      }
    },
  })
}
