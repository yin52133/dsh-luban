import type { ChannelAdapter, ChannelEndpoint, ChannelKind } from '@yin52133/dsh-luban-core'

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
  #polling: Promise<void> | undefined
  #generation = 0
  #running = false

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
    if (this.#running) return
    this.#running = true
    this.#generation += 1
    void this.poll().catch((): undefined => undefined)
    this.#timer = setInterval((): void => {
      if (!this.#running) return
      void this.poll().catch((): undefined => undefined)
    }, this.#intervalMs)
    this.#timer.unref()
  }

  public async stop(): Promise<void> {
    this.#running = false
    this.#generation += 1
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    await this.#polling?.catch((): undefined => undefined)
  }

  public endpoints(): readonly ChannelEndpoint[] {
    return [...this.#current.values()]
  }

  public poll(): Promise<void> {
    if (this.#polling !== undefined) return this.#polling
    const generation = this.#generation
    const operation = this.#poll(generation)
    this.#polling = operation
    const reset = (): void => {
      if (this.#polling === operation) this.#polling = undefined
    }
    void operation.then(reset, reset)
    return operation
  }

  async #poll(generation: number): Promise<void> {
    const endpoints = await this.#adapter.list()
    if (generation !== this.#generation) return
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
  }
}
