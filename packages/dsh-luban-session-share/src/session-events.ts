import type { SessionEvent, SessionId } from '@luban/core'
import { redactSecrets } from '@luban/core'
import type { SessionStreamEnvelope, SessionView } from './types.js'

type SessionEventInput =
  | { readonly type: 'output'; readonly text: string; readonly at: number }
  | { readonly type: 'status'; readonly status: string; readonly at: number }

interface SessionBuffer {
  sequence: number
  closed: boolean
  readonly events: SessionEvent[]
  readonly listeners: Set<(envelope: SessionStreamEnvelope) => void>
  readonly closeListeners: Set<() => void>
}

function parseLastEventId(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Per-session bounded event history with gap-detecting baseline replay. */
export class SessionEventLog {
  readonly #limit: number
  readonly #buffers = new Map<SessionId, SessionBuffer>()
  readonly #session: (id: SessionId) => SessionView | undefined

  public constructor(limit: number, session: (id: SessionId) => SessionView | undefined) {
    this.#limit = limit
    this.#session = session
  }

  public publish(id: SessionId, input: SessionEventInput): SessionEvent {
    const buffer = this.#buffer(id)
    const event: SessionEvent =
      input.type === 'output'
        ? {
            type: 'output',
            seq: ++buffer.sequence,
            text: redactSecrets(input.text),
            at: input.at,
          }
        : { type: 'status', seq: ++buffer.sequence, status: input.status, at: input.at }
    buffer.events.push(event)
    if (buffer.events.length > this.#limit) buffer.events.shift()
    const envelope: SessionStreamEnvelope = { id: event.seq, event: 'session', data: event }
    for (const listener of [...buffer.listeners]) listener(envelope)
    return event
  }

  public currentSequence(id: SessionId): number {
    return this.#buffers.get(id)?.sequence ?? 0
  }

  public clear(id: SessionId): void {
    const buffer = this.#buffers.get(id)
    if (buffer === undefined) return
    buffer.closed = true
    for (const listener of [...buffer.closeListeners]) listener()
    buffer.listeners.clear()
    buffer.closeListeners.clear()
    this.#buffers.delete(id)
  }

  public stream(
    id: SessionId,
    lastEventId: number | undefined,
    signal?: AbortSignal,
  ): AsyncIterable<SessionStreamEnvelope> {
    const buffer = this.#buffer(id)
    const requested = parseLastEventId(lastEventId)
    const oldest = buffer.events[0]?.seq ?? buffer.sequence
    const needsBaseline =
      requested === undefined || requested < oldest - 1 || requested > buffer.sequence
    const initial: readonly SessionStreamEnvelope[] = needsBaseline
      ? [this.#baseline(id, buffer)]
      : buffer.events
          .filter((event): boolean => event.seq > requested)
          .map((event): SessionStreamEnvelope => ({
            id: event.seq,
            event: 'session',
            data: event,
          }))

    return this.#iterate(buffer, initial, signal)
  }

  public subscribe(id: SessionId): AsyncIterable<SessionEvent> {
    const sequence = this.currentSequence(id)
    const controller = new AbortController()
    const frames = this.stream(id, sequence, controller.signal)
    return {
      [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
        const iterator = frames[Symbol.asyncIterator]()
        return {
          async next(): Promise<IteratorResult<SessionEvent>> {
            for (;;) {
              const result = await iterator.next()
              if (result.done === true) return { done: true, value: undefined }
              if (result.value.event === 'session') {
                return { done: false, value: result.value.data }
              }
            }
          },
          async return(): Promise<IteratorResult<SessionEvent>> {
            controller.abort()
            if (iterator.return !== undefined) await iterator.return()
            return { done: true, value: undefined }
          },
        }
      },
    }
  }

  #baseline(id: SessionId, buffer: SessionBuffer): SessionStreamEnvelope {
    const session = this.#session(id)
    if (session === undefined) throw new Error(`Session ${id} is unavailable`)
    return {
      id: buffer.sequence,
      event: 'baseline',
      data: { session, recent: [...buffer.events] },
    }
  }

  async *#iterate(
    buffer: SessionBuffer,
    initial: readonly SessionStreamEnvelope[],
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SessionStreamEnvelope> {
    const queue: SessionStreamEnvelope[] = []
    let wake: (() => void) | undefined
    let closed = buffer.closed
    const live = { overflowed: false }
    const listener = (event: SessionStreamEnvelope): void => {
      if (live.overflowed) return
      if (queue.length >= this.#limit) {
        live.overflowed = true
        wake?.()
        wake = undefined
        return
      }
      queue.push(event)
      wake?.()
      wake = undefined
    }
    const onClose = (): void => {
      closed = true
      wake?.()
      wake = undefined
    }
    const onAbort = (): void => {
      wake?.()
      wake = undefined
    }
    buffer.listeners.add(listener)
    buffer.closeListeners.add(onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for (const event of initial) {
        if (live.overflowed) break
        yield event
      }
      for (;;) {
        if (live.overflowed) break
        const next = queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (signal?.aborted === true || closed) break
        await new Promise<void>((resolve): void => {
          wake = resolve
        })
      }
    } finally {
      buffer.listeners.delete(listener)
      buffer.closeListeners.delete(onClose)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  #buffer(id: SessionId): SessionBuffer {
    let buffer = this.#buffers.get(id)
    if (buffer === undefined) {
      buffer = {
        sequence: 0,
        closed: false,
        events: [],
        listeners: new Set(),
        closeListeners: new Set(),
      }
      this.#buffers.set(id, buffer)
    }
    return buffer
  }
}
