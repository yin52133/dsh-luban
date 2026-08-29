import { randomUUID } from 'node:crypto'
import type {
  ChannelAdapter,
  ChannelEndpoint,
  ChannelHandle,
  ChannelKind,
  ExecResult,
  OpenOptions,
  SnippetFile,
  SnippetRange,
} from '@luban/core'
import { LubanError } from '@luban/core'
import type { SnippetStore } from './snippet-store.js'
import type { ChannelLine, FilterOptions, ManagedChannel, WinDebugEvent } from './types.js'

interface ActiveChannel extends ManagedChannel {
  readonly lines: ChannelLine[]
  readonly decoder: TextDecoder
  readonly releaseLease: () => void
  pending: string
  pump: Promise<void>
  closing?: Promise<void>
}

interface CancellableCommandHandle extends ChannelHandle {
  exec(command: string, signal?: AbortSignal): Promise<ExecResult>
}

export type ChannelOpenPreflight = (
  endpoint: ChannelEndpoint,
  signal?: AbortSignal,
) => Promise<() => void>

const NOOP_RELEASE = (): void => undefined

function safePattern(query: string, caseSensitive: boolean): RegExp {
  if (
    query.length > 256 ||
    /\([^)]*[+*][^)]*\)[+*{]/u.test(query) ||
    /\.[+*].*\.[+*]/u.test(query)
  ) {
    throw new LubanError('E_INVALID_INPUT', 'Regular expression is too complex')
  }
  try {
    return new RegExp(query, caseSensitive ? 'u' : 'iu')
  } catch (error: unknown) {
    throw new LubanError('E_INVALID_INPUT', 'Regular expression is invalid', { cause: error })
  }
}

export function filterLines(
  lines: readonly ChannelLine[],
  options: FilterOptions,
): readonly ChannelLine[] {
  const query = options.query ?? ''
  if (query === '') return lines
  if (options.regex === true) {
    const pattern = safePattern(query, options.caseSensitive === true)
    return lines.filter((line): boolean => pattern.test(line.text))
  }
  const needle = options.caseSensitive === true ? query : query.toLocaleLowerCase()
  return lines.filter((line): boolean =>
    (options.caseSensitive === true ? line.text : line.text.toLocaleLowerCase()).includes(needle),
  )
}

/** M10-F008 unified channel lifecycle plus M10-F002 bounded line monitor. */
export class ChannelHub {
  readonly #adapters: ReadonlyMap<ChannelKind, ChannelAdapter>
  readonly #snippetStore: SnippetStore
  readonly #maxLines: number
  readonly #timestamp: boolean
  readonly #openPreflight: ChannelOpenPreflight | undefined
  readonly #channels = new Map<string, ActiveChannel>()
  readonly #openingEndpointIds = new Set<string>()
  readonly #handles = new WeakMap<ChannelHandle, ActiveChannel>()
  readonly #listeners = new Set<(event: WinDebugEvent) => void>()
  readonly #adapterErrors = new Map<ChannelKind, string>()
  #sequence = 0

  public constructor(options: {
    readonly adapters: readonly ChannelAdapter[]
    readonly snippetStore: SnippetStore
    readonly maxLines: number
    readonly timestamp: boolean
    readonly openPreflight?: ChannelOpenPreflight
  }) {
    const entries = options.adapters.map((adapter): readonly [ChannelKind, ChannelAdapter] => [
      adapter.kind,
      adapter,
    ])
    if (new Set(entries.map(([kind]): ChannelKind => kind)).size !== entries.length) {
      throw new TypeError('Channel adapter kinds must be unique')
    }
    this.#adapters = new Map(entries)
    this.#snippetStore = options.snippetStore
    this.#maxLines = options.maxLines
    this.#timestamp = options.timestamp
    this.#openPreflight = options.openPreflight
  }

  public adapters(): readonly ChannelAdapter[] {
    return [...this.#adapters.values()]
  }

  public subscribe(listener: (event: WinDebugEvent) => void): () => void {
    this.#listeners.add(listener)
    return (): void => {
      this.#listeners.delete(listener)
    }
  }

  public endpointErrors(): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(this.#adapterErrors))
  }

  public async listEndpoints(kind?: ChannelKind): Promise<readonly ChannelEndpoint[]> {
    const adapters =
      kind === undefined
        ? [...this.#adapters.values()]
        : [this.#adapters.get(kind)].filter(
            (adapter): adapter is ChannelAdapter => adapter !== undefined,
          )
    const outcomes = await Promise.allSettled(
      adapters.map(async (adapter): Promise<readonly ChannelEndpoint[]> => {
        try {
          const endpoints = await adapter.list()
          this.#adapterErrors.delete(adapter.kind)
          return endpoints
        } catch (error: unknown) {
          this.#adapterErrors.set(
            adapter.kind,
            error instanceof Error ? error.message : 'Adapter unavailable',
          )
          throw error
        }
      }),
    )
    return outcomes.flatMap((outcome): readonly ChannelEndpoint[] =>
      outcome.status === 'fulfilled' ? outcome.value : [],
    )
  }

  public active(): readonly ManagedChannel[] {
    return [...this.#channels.values()].map(
      ({ id, endpoint, handle, openedAt }): ManagedChannel => ({
        id,
        endpoint,
        handle,
        openedAt,
      }),
    )
  }

  public async open(endpointId: string, options: OpenOptions = {}): Promise<ManagedChannel> {
    if (endpointId.length > 512) throw new LubanError('E_INVALID_INPUT', 'Endpoint id is too large')
    for (const adapter of this.#adapters.values()) {
      const endpoint = (await this.#safeList(adapter)).find(
        (candidate): boolean => candidate.id === endpointId,
      )
      if (endpoint === undefined) continue
      const occupied = [...this.#channels.values()].find(
        (channel): boolean => channel.endpoint.id === endpoint.id,
      )
      if (occupied !== undefined || this.#openingEndpointIds.has(endpoint.id)) {
        throw new LubanError(
          'E_CHANNEL_UNAVAILABLE',
          `${endpoint.label} is already open in Luban; close its existing channel before retrying`,
          {
            retriable: true,
            details: {
              reason: 'occupied',
              endpointId: endpoint.id,
              owner: occupied === undefined ? 'luban-opening-channel' : 'luban-active-channel',
              ...(occupied === undefined ? {} : { channelId: occupied.id }),
            },
          },
        )
      }
      this.#openingEndpointIds.add(endpoint.id)
      let releaseLease: (() => void) | undefined
      try {
        releaseLease = await this.#openPreflight?.(endpoint, options.signal)
        const handle = await adapter.open(endpoint, options)
        const active: ActiveChannel = {
          id: randomUUID(),
          endpoint,
          handle,
          openedAt: Date.now(),
          lines: [],
          decoder: new TextDecoder(),
          releaseLease: releaseLease ?? NOOP_RELEASE,
          pending: '',
          pump: Promise.resolve(),
        }
        this.#channels.set(active.id, active)
        this.#handles.set(handle, active)
        active.pump = this.#pump(active)
        releaseLease = undefined
        return active
      } finally {
        this.#openingEndpointIds.delete(endpoint.id)
        releaseLease?.()
      }
    }
    throw new LubanError('E_CHANNEL_UNAVAILABLE', `Endpoint ${endpointId} is not available`, {
      retriable: true,
    })
  }

  public lines(channelId: string, options: FilterOptions = {}): readonly ChannelLine[] {
    const active = this.#require(channelId)
    return filterLines(active.lines, options)
  }

  public write(channelId: string, data: string): Promise<void> {
    if (data.length > 64 * 1024)
      throw new LubanError('E_INVALID_INPUT', 'Channel write is too large')
    return this.#require(channelId).handle.write(data)
  }

  public exec(channelId: string, command: string, signal?: AbortSignal): Promise<ExecResult> {
    const handle = this.#require(channelId).handle
    if (handle.exec === undefined)
      throw new LubanError('E_INVALID_INPUT', 'Channel does not support commands')
    return (handle as CancellableCommandHandle).exec(command, signal)
  }

  public async capture(handle: ChannelHandle, range: SnippetRange): Promise<SnippetFile> {
    const active = this.#handles.get(handle)
    if (active === undefined) throw new LubanError('E_NOT_FOUND', 'Channel is not monitored')
    if (
      !Number.isSafeInteger(range.from) ||
      !Number.isSafeInteger(range.to) ||
      range.from > range.to
    ) {
      throw new LubanError('E_INVALID_INPUT', 'Snippet range is invalid')
    }
    const selected = active.lines.filter(
      (line): boolean => line.sequence >= range.from && line.sequence <= range.to,
    )
    if (selected.length === 0)
      throw new LubanError('E_NOT_FOUND', 'Snippet range is no longer buffered')
    const content = selected
      .map(
        (line): string =>
          `${this.#timestamp ? `[${new Date(line.at).toISOString()}] ` : ''}${line.text}`,
      )
      .join('\n')
    return this.#snippetStore.write(
      active.endpoint,
      content,
      selected[0]?.at ?? Date.now(),
      selected.at(-1)?.at ?? Date.now(),
    )
  }

  public captureById(channelId: string, range: SnippetRange): Promise<SnippetFile> {
    return this.capture(this.#require(channelId).handle, range)
  }

  public async close(channelId: string): Promise<void> {
    await this.#closing(this.#require(channelId))
  }

  public publishEndpointChange(
    event: Omit<Extract<WinDebugEvent, { readonly type: 'endpoints-changed' }>, 'type'>,
  ): void {
    this.#publish({ type: 'endpoints-changed', ...event })
  }

  public async dispose(): Promise<void> {
    const channels = [...this.#channels.values()]
    await Promise.allSettled(channels.map(async (channel): Promise<void> => this.#closing(channel)))
    this.#listeners.clear()
  }

  #closing(active: ActiveChannel): Promise<void> {
    active.closing ??= this.#closeActive(active)
    return active.closing
  }

  async #closeActive(active: ActiveChannel): Promise<void> {
    try {
      try {
        await active.handle.close()
      } finally {
        await active.pump
      }
    } finally {
      if (this.#channels.get(active.id) === active) this.#channels.delete(active.id)
      active.releaseLease()
    }
  }

  async #safeList(adapter: ChannelAdapter): Promise<readonly ChannelEndpoint[]> {
    try {
      const endpoints = await adapter.list()
      this.#adapterErrors.delete(adapter.kind)
      return endpoints
    } catch (error: unknown) {
      this.#adapterErrors.set(
        adapter.kind,
        error instanceof Error ? error.message : 'Adapter unavailable',
      )
      return []
    }
  }

  async #pump(active: ActiveChannel): Promise<void> {
    try {
      for await (const event of active.handle.readEvents()) {
        if (event.type === 'status') {
          this.#publish({
            type: 'channel-status',
            channelId: active.id,
            endpoint: active.endpoint,
            event,
          })
          continue
        }
        const text = active.decoder.decode(event.data, { stream: true })
        const parts = `${active.pending}${text}`.split(/\r?\n/u)
        active.pending = parts.pop() ?? ''
        for (const line of parts) this.#appendLine(active, line, event.at)
      }
      const tail = `${active.pending}${active.decoder.decode()}`
      if (tail !== '') this.#appendLine(active, tail, Date.now())
    } catch (error: unknown) {
      this.#publish({
        type: 'channel-status',
        channelId: active.id,
        endpoint: active.endpoint,
        event: {
          type: 'status',
          status: 'error',
          detail: error instanceof Error ? error.message : 'Channel event stream failed',
          at: Date.now(),
        },
      })
    }
  }

  #appendLine(active: ActiveChannel, text: string, at: number): void {
    const line: ChannelLine = {
      sequence: ++this.#sequence,
      channelId: active.id,
      endpoint: active.endpoint,
      text: text.slice(-16_384),
      at,
    }
    active.lines.push(line)
    if (active.lines.length > this.#maxLines) active.lines.shift()
    this.#publish({ type: 'line', line })
  }

  #require(channelId: string): ActiveChannel {
    const channel = this.#channels.get(channelId)
    if (channel === undefined)
      throw new LubanError('E_NOT_FOUND', `Channel ${channelId} was not found`)
    return channel
  }

  #publish(event: WinDebugEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}
