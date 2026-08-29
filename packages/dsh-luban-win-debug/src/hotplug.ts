import type { ChannelAdapter, ChannelEndpoint, ChannelKind } from '@luban/core'

export interface EndpointChange {
  readonly kind: ChannelKind
  readonly added: readonly ChannelEndpoint[]
  readonly removed: readonly ChannelEndpoint[]
  readonly endpoints: readonly ChannelEndpoint[]
}

/** Poll an adapter without overlapping polls and report deterministic hot-plug deltas. */
export class HotplugWatcher {
  readonly #adapter: ChannelAdapter
  readonly #intervalMs: number
  readonly #listeners = new Set<(change: EndpointChange) => void>()
  #timer: ReturnType<typeof setInterval> | undefined
  #current = new Map<string, ChannelEndpoint>()
  #polling = false

  public constructor(adapter: ChannelAdapter, intervalMs: number) {
    this.#adapter = adapter
    this.#intervalMs = intervalMs
  }

  public subscribe(listener: (change: EndpointChange) => void): () => void {
    this.#listeners.add(listener)
    return (): void => {
      this.#listeners.delete(listener)
    }
  }

  public start(): void {
    if (this.#timer !== undefined) return
    void this.poll().catch((): undefined => undefined)
    this.#timer = setInterval((): void => {
      void this.poll().catch((): undefined => undefined)
    }, this.#intervalMs)
    this.#timer.unref()
  }

  public stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  public endpoints(): readonly ChannelEndpoint[] {
    return [...this.#current.values()]
  }

  public async poll(): Promise<void> {
    if (this.#polling) return
    this.#polling = true
    try {
      const endpoints = await this.#adapter.list()
      const next = new Map(
        endpoints.map((endpoint): readonly [string, ChannelEndpoint] => [endpoint.id, endpoint]),
      )
      const added = endpoints.filter((endpoint): boolean => !this.#current.has(endpoint.id))
      const removed = [...this.#current.values()].filter(
        (endpoint): boolean => !next.has(endpoint.id),
      )
      const changed = endpoints.some(
        (endpoint): boolean =>
          JSON.stringify(endpoint) !== JSON.stringify(this.#current.get(endpoint.id)),
      )
      this.#current = next
      if (added.length > 0 || removed.length > 0 || changed) {
        const change: EndpointChange = {
          kind: this.#adapter.kind,
          added,
          removed,
          endpoints: [...endpoints],
        }
        for (const listener of this.#listeners) listener(change)
      }
    } finally {
      this.#polling = false
    }
  }
}
