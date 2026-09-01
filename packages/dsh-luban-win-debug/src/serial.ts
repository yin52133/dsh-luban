import type {
  ChannelAdapter,
  ChannelDataEvent,
  ChannelEndpoint,
  ChannelHandle,
  OpenOptions,
} from '@yin52133/dsh-luban-core'
import { LubanError } from '@yin52133/dsh-luban-core'
import { BoundedAsyncQueue } from './queue.js'
import type { SerialConnection, SerialPortDescriptor, SerialProvider } from './types.js'

const DEFAULT_SERIAL_OPEN_TIMEOUT_MS = 10_000
const SERIAL_CALLBACK_TIMEOUT_MS = 10_000

interface SerialPortInstance {
  open(callback: (error?: Error | null) => void): void
  write(data: Uint8Array, callback: (error?: Error | null) => void): void
  close(callback: (error?: Error | null) => void): void
  on(event: 'data', listener: (data: Buffer) => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'error', listener: (error: Error) => void): this
  off(event: 'data', listener: (data: Buffer) => void): this
  off(event: 'close', listener: () => void): this
  off(event: 'error', listener: (error: Error) => void): this
}

interface SerialPortConstructor {
  new (options: {
    readonly path: string
    readonly baudRate: number
    readonly autoOpen: false
  }): SerialPortInstance
  list(): Promise<readonly SerialPortDescriptor[]>
}

type ModuleLoader = (specifier: string) => Promise<unknown>

function errorCode(error: Error): string | undefined {
  const code = (error as Error & { readonly code?: unknown }).code
  return typeof code === 'string' ? code.toUpperCase() : undefined
}

function serialOpenFailure(path: string, error: Error): LubanError {
  const occupied =
    ['EACCES', 'EBUSY', 'EPERM'].includes(errorCode(error) ?? '') ||
    /(?:access|permission) denied|busy|in use|already open|cannot open.*(?:com|serial)/iu.test(
      error.message,
    )
  if (occupied) {
    return new LubanError(
      'E_CHANNEL_UNAVAILABLE',
      `Serial port ${path} is occupied; close the serial monitor, debugger, terminal, or service that owns it and retry`,
      {
        retriable: true,
        cause: error,
        details: {
          reason: 'occupied',
          path,
          ownerHint: 'another serial monitor, debugger, terminal, or background service',
        },
      },
    )
  }
  return new LubanError('E_CHANNEL_UNAVAILABLE', `Unable to open serial port ${path}`, {
    retriable: true,
    cause: error,
    details: { reason: 'open-failed', path },
  })
}

function moduleConstructor(value: unknown): SerialPortConstructor {
  if (typeof value !== 'object' || value === null) {
    throw new LubanError(
      'E_CHANNEL_UNAVAILABLE',
      'Optional serialport package returned an invalid module',
    )
  }
  const row = value as Readonly<Record<string, unknown>>
  const nested =
    typeof row.default === 'object' && row.default !== null
      ? (row.default as Readonly<Record<string, unknown>>)
      : undefined
  const candidate = row.SerialPort ?? nested?.SerialPort ?? row.default
  if (typeof candidate !== 'function' || typeof Reflect.get(candidate, 'list') !== 'function') {
    throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Optional serialport package is incompatible')
  }
  return candidate as SerialPortConstructor
}

/** Lazy optional `serialport` binding; importing the plugin never requires its native module. */
export class OptionalSerialPortProvider implements SerialProvider {
  readonly #loader: ModuleLoader
  #portClass: Promise<SerialPortConstructor> | undefined

  public constructor(loader: ModuleLoader = (specifier): Promise<unknown> => import(specifier)) {
    this.#loader = loader
  }

  public async list(): Promise<readonly SerialPortDescriptor[]> {
    const constructor = await this.#load()
    const ports = await constructor.list()
    return ports.map((port): SerialPortDescriptor => ({
      path: port.path,
      ...(port.manufacturer === undefined ? {} : { manufacturer: port.manufacturer }),
      ...(port.serialNumber === undefined ? {} : { serialNumber: port.serialNumber }),
      ...(port.vendorId === undefined ? {} : { vendorId: port.vendorId }),
      ...(port.productId === undefined ? {} : { productId: port.productId }),
    }))
  }

  public async open(
    path: string,
    baudRate: number,
    signal?: AbortSignal,
  ): Promise<SerialConnection> {
    if (isAborted(signal)) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Serial open was cancelled', {
        retriable: true,
      })
    }
    const Constructor = await this.#load()
    let port: SerialPortInstance
    try {
      port = new Constructor({ path, baudRate, autoOpen: false })
    } catch (error: unknown) {
      throw serialOpenFailure(
        path,
        error instanceof Error ? error : new Error('Unknown serial construction failure'),
      )
    }
    await new Promise<void>((resolve, reject): void => {
      let settled = false
      const detach = (): void => signal?.removeEventListener('abort', abort)
      const abort = (): void => {
        if (settled) return
        settled = true
        detach()
        try {
          port.close((): void => undefined)
        } catch {
          // A late successful open callback below makes one more best-effort close.
        }
        reject(
          new LubanError('E_CHANNEL_UNAVAILABLE', 'Serial open was cancelled', {
            retriable: true,
          }),
        )
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (abortRequested(signal, abort)) return
      try {
        port.open((error): void => {
          if (settled) {
            if (error === undefined || error === null) {
              try {
                port.close((): void => undefined)
              } catch {
                // The caller has already failed closed; no command will use this port.
              }
            }
            return
          }
          settled = true
          detach()
          if (error === undefined || error === null) resolve()
          else reject(serialOpenFailure(path, error))
        })
      } catch (error: unknown) {
        settled = true
        detach()
        reject(
          serialOpenFailure(
            path,
            error instanceof Error ? error : new Error('Unknown serial open failure'),
          ),
        )
      }
    })
    if (isAborted(signal)) {
      await callbackOperation(
        (done): void => port.close(done),
        `Unable to close serial port ${path}`,
      )
      throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Serial open was cancelled', {
        retriable: true,
      })
    }
    return new NodeSerialConnection(port, path)
  }

  async #load(): Promise<SerialPortConstructor> {
    this.#portClass ??= this.#loader('serialport')
      .then(moduleConstructor)
      .catch((error: unknown): never => {
        throw new LubanError(
          'E_CHANNEL_UNAVAILABLE',
          'Serial support is unavailable; install the optional serialport package for this profile',
          { retriable: true, cause: error },
        )
      })
    return this.#portClass
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function abortRequested(signal: AbortSignal | undefined, abort: () => void): boolean {
  if (!isAborted(signal)) return false
  abort()
  return true
}

function cancelledSerialOpen(): LubanError {
  return new LubanError('E_CHANNEL_UNAVAILABLE', 'Serial open was cancelled', {
    retriable: true,
  })
}

function closeLateConnection(connection: SerialConnection): void {
  try {
    void connection.close().catch((): void => {
      // The caller already failed closed and must not observe a late connection.
    })
  } catch {
    // The caller already failed closed and must not observe a late connection.
  }
}

async function boundedSerialOpen(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<SerialConnection>,
): Promise<SerialConnection> {
  if (isAborted(signal)) throw cancelledSerialOpen()
  const controller = new AbortController()
  let failure: LubanError | undefined
  let rejectDeadline!: (error: LubanError) => void
  const deadline = new Promise<never>((_resolve, reject): void => {
    rejectDeadline = reject
  })
  const fail = (error: LubanError): void => {
    if (failure !== undefined) return
    failure = error
    rejectDeadline(error)
    controller.abort()
  }
  const abort = (): void => fail(cancelledSerialOpen())
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout((): void => {
    fail(new LubanError('E_TIMEOUT', 'Serial open timed out', { retriable: true }))
  }, timeoutMs)
  timer.unref()
  const cleanup = (): void => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
  const opening = Promise.resolve()
    .then((): Promise<SerialConnection> => operation(controller.signal))
    .then(
      (connection): SerialConnection => {
        if (failure !== undefined) {
          closeLateConnection(connection)
          throw failure
        }
        return connection
      },
      (error: unknown): never => {
        if (failure !== undefined) throw failure
        throw error
      },
    )
  try {
    return await Promise.race([opening, deadline])
  } finally {
    cleanup()
  }
}

function callbackOperation(
  invoke: (done: (error?: Error | null) => void) => void,
  message: string,
): Promise<void> {
  return new Promise<void>((resolve, reject): void => {
    let settled = false
    const timer = setTimeout((): void => {
      if (settled) return
      settled = true
      reject(new LubanError('E_TIMEOUT', `${message} timed out`, { retriable: true }))
    }, SERIAL_CALLBACK_TIMEOUT_MS)
    timer.unref()
    try {
      invoke((error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error === undefined || error === null) resolve()
        else
          reject(
            new LubanError('E_CHANNEL_UNAVAILABLE', message, { retriable: true, cause: error }),
          )
      })
    } catch (error: unknown) {
      settled = true
      clearTimeout(timer)
      reject(
        new LubanError('E_CHANNEL_UNAVAILABLE', message, {
          retriable: true,
          cause: error,
        }),
      )
    }
  })
}

class NodeSerialConnection implements SerialConnection {
  readonly #port: SerialPortInstance
  readonly #path: string
  #closed = false

  public constructor(port: SerialPortInstance, path: string) {
    this.#port = port
    this.#path = path
  }

  public write(data: Uint8Array): Promise<void> {
    if (this.#closed) throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Serial port is closed')
    return callbackOperation(
      (done): void => this.#port.write(data, done),
      `Unable to write serial port ${this.#path}`,
    )
  }

  public onData(listener: (data: Uint8Array) => void): () => void {
    const receive = (data: Buffer): void => listener(new Uint8Array(data))
    this.#port.on('data', receive)
    return (): void => {
      this.#port.off('data', receive)
    }
  }

  public onStatus(listener: (status: 'closed' | 'error', detail?: string) => void): () => void {
    const close = (): void => listener('closed')
    const error = (reason: Error): void => listener('error', reason.message)
    this.#port.on('close', close)
    this.#port.on('error', error)
    return (): void => {
      this.#port.off('close', close)
      this.#port.off('error', error)
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await callbackOperation(
      (done): void => this.#port.close(done),
      `Unable to close serial port ${this.#path}`,
    )
  }
}

function serialEndpoint(port: SerialPortDescriptor): ChannelEndpoint {
  return Object.freeze({
    kind: 'serial' as const,
    id: `serial:${port.path}`,
    label: port.manufacturer === undefined ? port.path : `${port.path} · ${port.manufacturer}`,
    params: Object.freeze({
      port: port.path,
      ...(port.manufacturer === undefined ? {} : { manufacturer: port.manufacturer }),
      ...(port.serialNumber === undefined ? {} : { serialNumber: port.serialNumber }),
      ...(port.vendorId === undefined ? {} : { vendorId: port.vendorId }),
      ...(port.productId === undefined ? {} : { productId: port.productId }),
    }),
  })
}

class SerialHandle implements ChannelHandle {
  readonly #connection: SerialConnection
  readonly #queue = new BoundedAsyncQueue<ChannelDataEvent>(2048)
  readonly #detachData: () => void
  readonly #detachStatus: () => void
  #closed = false

  public constructor(connection: SerialConnection) {
    this.#connection = connection
    this.#detachData = connection.onData((data): void => {
      const bounded = data.byteLength <= 64 * 1024 ? data : data.slice(data.byteLength - 64 * 1024)
      this.#queue.push({ type: 'data', data: bounded, at: Date.now() })
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
      throw new LubanError('E_INVALID_INPUT', 'Serial write is too large')
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
    if (!this.#closed) this.#closed = true
    this.#detachData()
    this.#detachStatus()
    this.#queue.end()
  }
}

/** M10-F001 serial HAL with live enumeration and strict open-by-enumerated-endpoint. */
export class SerialChannelAdapter implements ChannelAdapter {
  public readonly kind = 'serial' as const
  readonly #provider: SerialProvider
  readonly #defaultBaud: number

  public constructor(provider: SerialProvider, defaultBaud = 115200) {
    this.#provider = provider
    this.#defaultBaud = defaultBaud
  }

  public async list(): Promise<readonly ChannelEndpoint[]> {
    return (await this.#provider.list())
      .map(serialEndpoint)
      .sort((left, right): number => left.label.localeCompare(right.label))
  }

  public async open(endpoint: ChannelEndpoint, options: OpenOptions): Promise<ChannelHandle> {
    if (endpoint.kind !== this.kind)
      throw new LubanError('E_INVALID_INPUT', 'Endpoint is not serial')
    const timeoutMs = options.timeoutMs ?? DEFAULT_SERIAL_OPEN_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
      throw new LubanError('E_INVALID_INPUT', 'Serial timeout is invalid')
    }
    const baudRate = options.baudRate ?? this.#defaultBaud
    if (!Number.isSafeInteger(baudRate) || baudRate < 50 || baudRate > 12_000_000) {
      throw new LubanError('E_INVALID_INPUT', 'baudRate is outside the supported range')
    }
    const connection = await boundedSerialOpen(timeoutMs, options.signal, async (signal) => {
      const current = await this.list()
      const allowed = current.find((candidate): boolean => candidate.id === endpoint.id)
      if (allowed === undefined || allowed.params.port !== endpoint.params.port) {
        throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Serial endpoint is no longer available', {
          retriable: true,
        })
      }
      return this.#provider.open(allowed.params.port ?? '', baudRate, signal)
    })
    return new SerialHandle(connection)
  }

  /** Probe Windows' exclusive-open boundary immediately before a flasher takes ownership. */
  public async checkAvailable(
    path: string,
    baudRate = this.#defaultBaud,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isSafeInteger(baudRate) || baudRate < 50 || baudRate > 12_000_000) {
      throw new LubanError('E_INVALID_INPUT', 'baudRate is outside the supported range')
    }
    const port = (await this.#provider.list()).find(
      (candidate): boolean => candidate.path.toLocaleUpperCase() === path.toLocaleUpperCase(),
    )
    if (port === undefined) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', `Serial port ${path} is no longer available`, {
        retriable: true,
        details: { reason: 'missing', path },
      })
    }
    const connection = await this.#provider.open(port.path, baudRate, signal)
    await connection.close()
  }
}
