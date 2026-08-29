/** Small bounded async queue used by channel/process event streams. */
export class BoundedAsyncQueue<Value> implements AsyncIterable<Value> {
  readonly #maximum: number
  readonly #values: Value[] = []
  readonly #waiters: {
    readonly resolve: (result: IteratorResult<Value>) => void
    readonly reject: (error: unknown) => void
  }[] = []
  #ended = false
  #failure: unknown

  public constructor(maximum = 1024) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0)
      throw new TypeError('maximum must be positive')
    this.#maximum = maximum
  }

  public push(value: Value): void {
    if (this.#ended) return
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) waiter.resolve({ done: false, value })
    else {
      this.#values.push(value)
      if (this.#values.length > this.#maximum) this.#values.shift()
    }
  }

  public end(failure?: unknown): void {
    if (this.#ended) return
    this.#ended = true
    this.#failure = failure
    for (const waiter of this.#waiters.splice(0)) {
      if (failure === undefined) waiter.resolve({ done: true, value: undefined })
      else waiter.reject(failure)
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<Value> {
    return {
      next: (): Promise<IteratorResult<Value>> => {
        const value = this.#values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.#ended) {
          return this.#failure === undefined
            ? Promise.resolve({ done: true, value: undefined })
            : Promise.reject(
                this.#failure instanceof Error
                  ? this.#failure
                  : new Error('Async queue failed', { cause: this.#failure }),
              )
        }
        return new Promise<IteratorResult<Value>>((resolve, reject): void => {
          this.#waiters.push({ resolve, reject })
        })
      },
    }
  }
}
