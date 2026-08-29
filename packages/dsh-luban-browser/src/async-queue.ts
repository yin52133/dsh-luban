export class AsyncQueue<Value> implements AsyncIterable<Value> {
  readonly #values: Value[] = []
  readonly #waiters: {
    readonly resolve: (result: IteratorResult<Value>) => void
    readonly reject: (error: unknown) => void
  }[] = []
  #closed = false
  #error: Error | undefined

  public push(value: Value): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter === undefined) this.#values.push(value)
    else waiter.resolve({ done: false, value })
  }

  public close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
  }

  public fail(error: unknown): void {
    if (this.#closed) return
    this.#closed = true
    this.#error = error instanceof Error ? error : new Error('Async queue failed', { cause: error })
    for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#error)
  }

  public [Symbol.asyncIterator](): AsyncIterator<Value> {
    return {
      next: (): Promise<IteratorResult<Value>> => {
        const value = this.#values.shift()
        if (value !== undefined) return Promise.resolve({ done: false, value })
        if (this.#closed) {
          return this.#error === undefined
            ? Promise.resolve({ done: true, value: undefined })
            : Promise.reject(this.#error)
        }
        return new Promise<IteratorResult<Value>>((resolve, reject): void => {
          this.#waiters.push({ resolve, reject })
        })
      },
    }
  }
}
