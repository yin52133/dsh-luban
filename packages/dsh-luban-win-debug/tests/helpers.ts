import type { ExecResult } from '@luban/core'
import { vi } from 'vitest'
import { parseConfig, type Config } from '../src/config.js'
import { BoundedAsyncQueue } from '../src/queue.js'
import type {
  CommandOptions,
  CommandRunner,
  ManagedProcess,
  ManagedProcessEvent,
  ManagedProcessOptions,
  ManagedProcessRunner,
  SerialConnection,
  SerialPortDescriptor,
  SerialProvider,
} from '../src/types.js'

export interface Invocation {
  readonly command: string
  readonly args: readonly string[]
  readonly options: CommandOptions
}

export class FakeCommandRunner implements CommandRunner {
  public readonly calls: Invocation[] = []
  public result: ExecResult = {
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
  }
  public responder: ((call: Invocation) => ExecResult | Promise<ExecResult>) | undefined

  public async run(
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ): Promise<ExecResult> {
    const call = { command, args: [...args], options }
    this.calls.push(call)
    return (await this.responder?.(call)) ?? this.result
  }
}

export class FakeManagedProcess implements ManagedProcess {
  public readonly pid = 4242
  public readonly queue = new BoundedAsyncQueue<ManagedProcessEvent>(256)
  public readonly stop = vi.fn((): Promise<ExecResult> => {
    this.queue.push({ type: 'exit', exitCode: 0, at: Date.now() })
    this.queue.end()
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 })
  })

  public events(): AsyncIterable<ManagedProcessEvent> {
    return this.queue
  }
}

export class FakeManagedProcessRunner implements ManagedProcessRunner {
  public readonly calls: {
    readonly command: string
    readonly args: readonly string[]
    readonly options: ManagedProcessOptions
  }[] = []
  public readonly processes: FakeManagedProcess[] = []

  public start(
    command: string,
    args: readonly string[],
    options: ManagedProcessOptions,
  ): Promise<ManagedProcess> {
    this.calls.push({ command, args: [...args], options })
    const process = new FakeManagedProcess()
    this.processes.push(process)
    return Promise.resolve(process)
  }
}

export class FakeSerialConnection implements SerialConnection {
  readonly #data = new Set<(data: Uint8Array) => void>()
  readonly #status = new Set<(status: 'closed' | 'error', detail?: string) => void>()
  public readonly writes: Uint8Array[] = []
  public closed = false

  public write(data: Uint8Array): Promise<void> {
    this.writes.push(data)
    return Promise.resolve()
  }

  public close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      for (const listener of this.#status) listener('closed')
    }
    return Promise.resolve()
  }

  public onData(listener: (data: Uint8Array) => void): () => void {
    this.#data.add(listener)
    return (): void => {
      this.#data.delete(listener)
    }
  }

  public onStatus(listener: (status: 'closed' | 'error', detail?: string) => void): () => void {
    this.#status.add(listener)
    return (): void => {
      this.#status.delete(listener)
    }
  }

  public emit(text: string): void {
    const data = new TextEncoder().encode(text)
    for (const listener of this.#data) listener(data)
  }

  public fail(detail: string): void {
    for (const listener of this.#status) listener('error', detail)
  }
}

export class FakeSerialProvider implements SerialProvider {
  public ports: SerialPortDescriptor[] = [{ path: 'COM3', manufacturer: 'Fake Probe' }]
  public readonly connections: FakeSerialConnection[] = []
  public readonly opens: { readonly path: string; readonly baudRate: number }[] = []

  public list(): Promise<readonly SerialPortDescriptor[]> {
    return Promise.resolve(this.ports)
  }

  public open(path: string, baudRate: number): Promise<SerialConnection> {
    this.opens.push({ path, baudRate })
    const connection = new FakeSerialConnection()
    this.connections.push(connection)
    return Promise.resolve(connection)
  }
}

export function testConfig(root: string, overrides: Partial<Config> = {}): Config {
  const base = parseConfig({
    snippet: { dir: `${root}/snippets`, maxLines: 50, maxBytes: 64 * 1024 },
    execution: {
      allowedRoots: [root],
      cwd: root,
      timeoutMs: 5000,
      startupTimeoutMs: 1000,
      processLifetimeMs: 60_000,
      maxOutputBytes: 64 * 1024,
    },
  })
  return Object.freeze({ ...base, ...overrides })
}

export async function flush(): Promise<void> {
  await new Promise<void>((resolve): void => {
    setImmediate(resolve)
  })
}
