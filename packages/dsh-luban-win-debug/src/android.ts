import type {
  ChannelAdapter,
  ChannelDataEvent,
  ChannelEndpoint,
  ChannelHandle,
  ExecResult,
  OpenOptions,
} from '@yin52133/dsh-luban-core'
import { LubanError } from '@yin52133/dsh-luban-core'
import { parseCommandWords } from './command-runner.js'
import type { Config } from './config.js'
import { BoundedAsyncQueue } from './queue.js'
import type { AndroidDevice, CommandRunner } from './types.js'

const ADB_ALLOWED = Object.freeze(['get-state', 'logcat', 'reboot', 'wait-for-device', 'bugreport'])
const FASTBOOT_ALLOWED = Object.freeze(['getvar', 'reboot', 'continue'])

export function parseAdbDevices(output: string): readonly AndroidDevice[] {
  return output
    .split(/\r?\n/u)
    .map((line): string => line.trim())
    .filter((line): boolean => line !== '' && !line.startsWith('List of devices'))
    .map((line): AndroidDevice | undefined => {
      const [id, rawState, ...fields] = line.split(/\s+/u)
      if (
        id === undefined ||
        rawState === undefined ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)
      )
        return undefined
      const state: AndroidDevice['state'] =
        rawState === 'device' || rawState === 'offline' || rawState === 'unauthorized'
          ? rawState
          : 'unknown'
      return {
        transport: 'adb',
        id,
        state,
        detail: Object.freeze(
          Object.fromEntries(
            fields
              .map((field): readonly [string, string] | undefined => {
                const separator = field.indexOf(':')
                return separator <= 0
                  ? undefined
                  : [field.slice(0, separator), field.slice(separator + 1)]
              })
              .filter((field): field is readonly [string, string] => field !== undefined),
          ),
        ),
      }
    })
    .filter((device): device is AndroidDevice => device !== undefined)
}

export function parseFastbootDevices(output: string): readonly AndroidDevice[] {
  return output
    .split(/\r?\n/u)
    .map((line): string => line.trim())
    .filter(Boolean)
    .map((line): AndroidDevice | undefined => {
      const [id] = line.split(/\s+/u)
      return id === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)
        ? undefined
        : { transport: 'fastboot', id, state: 'bootloader', detail: Object.freeze({}) }
    })
    .filter((device): device is AndroidDevice => device !== undefined)
}

class AndroidHandle implements ChannelHandle {
  readonly #kind: 'adb' | 'fastboot'
  readonly #id: string
  readonly #runner: CommandRunner
  readonly #config: Config
  readonly #queue = new BoundedAsyncQueue<ChannelDataEvent>(256)
  readonly #controller = new AbortController()
  #closed = false

  public constructor(kind: 'adb' | 'fastboot', id: string, runner: CommandRunner, config: Config) {
    this.#kind = kind
    this.#id = id
    this.#runner = runner
    this.#config = config
    this.#queue.push({ type: 'status', status: 'open', at: Date.now() })
  }

  public write(_data: Uint8Array | string): Promise<void> {
    return Promise.reject(new LubanError('E_INVALID_INPUT', `${this.#kind} is command-only`))
  }

  public readEvents(): AsyncIterable<ChannelDataEvent> {
    return this.#queue
  }

  public async exec(command: string, signal?: AbortSignal): Promise<ExecResult> {
    if (this.#closed) throw new LubanError('E_CHANNEL_UNAVAILABLE', 'Android channel is closed')
    const words = parseCommandWords(command)
    const root = words[0]
    const allowed = this.#kind === 'adb' ? ADB_ALLOWED : FASTBOOT_ALLOWED
    if (root === undefined || !allowed.includes(root)) {
      throw new LubanError(
        'E_INVALID_INPUT',
        `${root ?? '(missing)'} is not allowlisted for ${this.#kind}`,
      )
    }
    const result = await this.#runner.run(
      this.#config.tools[this.#kind],
      this.#kind === 'adb' ? ['-s', this.#id, ...words] : ['-s', this.#id, ...words],
      {
        timeoutMs: this.#config.execution.timeoutMs,
        maxOutputBytes: this.#config.execution.maxOutputBytes,
        signal:
          signal === undefined
            ? this.#controller.signal
            : AbortSignal.any([this.#controller.signal, signal]),
        ...(this.#config.execution.cwd === undefined ? {} : { cwd: this.#config.execution.cwd }),
      },
    )
    const output = `${result.stdout}${result.stderr}`
    if (output !== '') {
      this.#queue.push({
        type: 'data',
        data: new TextEncoder().encode(output.slice(-64 * 1024)),
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

/** M10-F005 adapter with explicit offline/unauthorized/bootloader states. */
export class AndroidChannelAdapter implements ChannelAdapter {
  public readonly kind: 'adb' | 'fastboot'
  readonly #runner: CommandRunner
  readonly #config: Config

  public constructor(kind: 'adb' | 'fastboot', runner: CommandRunner, config: Config) {
    this.kind = kind
    this.#runner = runner
    this.#config = config
  }

  public async devices(): Promise<readonly AndroidDevice[]> {
    const result = await this.#runner.run(
      this.#config.tools[this.kind],
      this.kind === 'adb' ? ['devices', '-l'] : ['devices'],
      {
        timeoutMs: Math.min(this.#config.execution.timeoutMs, 30_000),
        maxOutputBytes: this.#config.execution.maxOutputBytes,
        ...(this.#config.execution.cwd === undefined ? {} : { cwd: this.#config.execution.cwd }),
      },
    )
    if (result.exitCode !== 0) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', `${this.kind} devices failed`, {
        retriable: true,
        details: { exitCode: result.exitCode, stderr: result.stderr.slice(-2000) },
      })
    }
    return this.kind === 'adb'
      ? parseAdbDevices(result.stdout)
      : parseFastbootDevices(result.stdout)
  }

  public async list(): Promise<readonly ChannelEndpoint[]> {
    return (await this.devices()).map((device): ChannelEndpoint =>
      Object.freeze({
        kind: this.kind,
        id: `${this.kind}:${device.id}`,
        label: `${device.id} · ${device.state}`,
        params: Object.freeze({ deviceId: device.id, state: device.state, ...device.detail }),
      }),
    )
  }

  public async open(endpoint: ChannelEndpoint, _options: OpenOptions): Promise<ChannelHandle> {
    const configured = (await this.list()).find(
      (candidate): boolean => candidate.id === endpoint.id,
    )
    if (configured?.kind !== this.kind) {
      throw new LubanError('E_CHANNEL_UNAVAILABLE', `${this.kind} device is no longer available`, {
        retriable: true,
      })
    }
    return new AndroidHandle(
      this.kind,
      configured.params.deviceId ?? '',
      this.#runner,
      this.#config,
    )
  }
}

export class AndroidService {
  readonly #adb: AndroidChannelAdapter
  readonly #fastboot: AndroidChannelAdapter

  public constructor(adb: AndroidChannelAdapter, fastboot: AndroidChannelAdapter) {
    this.#adb = adb
    this.#fastboot = fastboot
  }

  public async devices(): Promise<readonly AndroidDevice[]> {
    const [adb, fastboot] = await Promise.allSettled([
      this.#adb.devices(),
      this.#fastboot.devices(),
    ])
    return [
      ...(adb.status === 'fulfilled' ? adb.value : []),
      ...(fastboot.status === 'fulfilled' ? fastboot.value : []),
    ]
  }
}
