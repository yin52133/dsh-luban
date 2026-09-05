import { asSessionId, type AccountId } from '@yin52133/dsh-luban-core'
import { dshMethodFromPath, dshRequestSessionIds } from './dsh-http-scope.js'
import type { DshEventScope, DshSessionOwnerLookup } from './dsh-event-scope.js'

type JsonRecord = Record<string, unknown>

/** Correlate event replies with the account and stream that actually received the request. */
export class RemoteReplyRegistry {
  readonly #clients = new Map<
    string,
    { readonly account: AccountId; readonly events: Set<string> }
  >()

  public register(clientId: string, account: AccountId): void {
    if (this.#clients.has(clientId)) throw new Error('Duplicate Remote event client')
    this.#clients.set(clientId, { account, events: new Set() })
  }

  public allow(clientId: string, eventId: string): void {
    const client = this.#clients.get(clientId)
    if (client === undefined || client.events.size >= 1024)
      throw new Error('Remote event limit exceeded')
    client.events.add(eventId)
  }

  public accepts(account: AccountId, payload: unknown): boolean {
    const result = record(record(payload)?.args)
    if (
      result === null ||
      typeof result.clientId !== 'string' ||
      typeof result.eventId !== 'string'
    )
      return false
    const client = this.#clients.get(result.clientId)
    return client?.account === account && client.events.has(result.eventId)
  }

  public forget(clientId: string, eventId: string): void {
    this.#clients.get(clientId)?.events.delete(eventId)
  }

  public remove(clientId: string): void {
    this.#clients.delete(clientId)
  }
}

interface Stream {
  readonly endpoint: string
  clientId?: string
}

/** Account policy for DSH 0.1.2 Remote streams; transport never forwards an unclassified stream. */
export class RemoteStreamScope {
  readonly #streams = new Map<string, Stream>()
  #disposed = false

  public constructor(
    private readonly account: AccountId,
    private readonly ownerOf: DshSessionOwnerLookup,
    private readonly replies: RemoteReplyRegistry,
    private readonly events: DshEventScope,
    private readonly decline: (clientId: string, eventId: string) => Promise<void>,
  ) {}

  public async open(streamId: string, endpoint: string, payload: unknown): Promise<boolean> {
    if (this.isDisposed()) return false
    if (this.#streams.has(streamId) || this.#streams.size >= 128)
      throw new Error('Remote stream limit or duplicate id')
    if (!['$events', 'session/control', 'session/follow', 'workspace/follow'].includes(endpoint))
      return false
    if (endpoint === 'session/follow') {
      const ids = dshRequestSessionIds(dshMethodFromPath(`/api/${endpoint}`), { payload })
      if (ids.length === 0 || !(await this.ownsAll(ids))) return false
    }
    if (this.#disposed) return false
    this.#streams.set(streamId, { endpoint })
    return true
  }

  public has(streamId: string): boolean {
    return this.#streams.has(streamId)
  }

  public cancel(streamId: string): void {
    const stream = this.#streams.get(streamId)
    if (stream?.clientId !== undefined) this.replies.remove(stream.clientId)
    this.#streams.delete(streamId)
  }

  public dispose(): void {
    this.#disposed = true
    for (const id of this.#streams.keys()) this.cancel(id)
  }

  public async filter(streamId: string, input: unknown): Promise<unknown> {
    const stream = this.#streams.get(streamId)
    if (stream === undefined) return null
    const value = record(input)
    if (value === null) throw new Error('Invalid Remote stream item')
    if (stream.endpoint === 'session/follow') return value
    if (stream.endpoint === 'workspace/follow') return this.workspace(value)
    if (stream.endpoint === 'session/control') {
      if (value.type === 'baseline') {
        const baseline = record(value.value)
        if (baseline === null) throw new Error('Invalid control baseline')
        const result: JsonRecord = {}
        for (const key of ['queues', 'jobs', 'projections']) {
          const rows = record(baseline[key])
          if (rows === null) throw new Error('Invalid control map')
          const owned: JsonRecord = {}
          for (const [id, row] of Object.entries(rows)) if (await this.owns(id)) owned[id] = row
          result[key] = owned
        }
        return { ...value, value: result }
      }
      if (['queue', 'jobs', 'projection'].includes(String(value.type))) {
        return (await this.owns(value.sessionId)) ? value : null
      }
      throw new Error('Unknown control frame')
    }
    if (value.type === 'ready') {
      if (stream.clientId !== undefined || typeof value.clientId !== 'string')
        throw new Error('Invalid event generation')
      this.replies.register(value.clientId, this.account)
      stream.clientId = value.clientId
      return value
    }
    const clientId = stream.clientId
    if (clientId === undefined) throw new Error('Event before ready')
    if (value.type === 'waterfall') {
      if (typeof value.eventId !== 'string') throw new Error('Invalid event identity')
      if (!(await this.owns(value.agentId))) {
        await this.decline(clientId, value.eventId)
        return null
      }
      this.replies.allow(clientId, value.eventId)
      return value
    }
    if (value.type === 'cancel') {
      if (typeof value.eventId !== 'string') throw new Error('Invalid cancellation')
      const allowed = this.replies.accepts(this.account, {
        args: { clientId, eventId: value.eventId },
      })
      this.replies.forget(clientId, value.eventId)
      return allowed ? value : null
    }
    if (value.type !== 'emit' || typeof value.event !== 'string' || !Array.isArray(value.args))
      throw new Error('Unknown event frame')
    const args: unknown[] = value.args
    if (value.event === 'api-session/added') {
      const row = record(args[0])
      if (row === null || !(await this.owns(row.sessionId))) return null
      if (row.parentSessionId !== undefined && !(await this.owns(row.parentSessionId))) {
        const owned = { ...row }
        delete owned.parentSessionId
        return { ...value, args: [owned, ...args.slice(1)] }
      }
      return value
    }
    if (
      [
        'api-session/removed',
        'api-session/status',
        'api-session/activity',
        'api-session/error',
      ].includes(value.event)
    ) {
      return (await this.owns(args[0])) ? value : null
    }
    // Reuse the existing explicit global/dynamic-plugin event policy.
    const filtered = await this.events.filter(
      this.account,
      'host',
      JSON.stringify({
        type: 'server-request',
        rpcId: 'remote-event',
        method: 'host/remote-event',
        payload: { type: 'host/remote-event', event: value.event, args },
      }),
    )
    return filtered === null ? null : value
  }

  private async workspace(value: JsonRecord): Promise<JsonRecord> {
    const rewrite = async (input: unknown): Promise<unknown> => {
      if (Array.isArray(input)) return Promise.all(input.map(rewrite))
      const row = record(input)
      if (row === null) return input
      const result: JsonRecord = {}
      for (const [key, item] of Object.entries(row)) {
        if ((key === 'sessionIds' || key === 'archivedSessionIds') && Array.isArray(item)) {
          const ids: string[] = []
          for (const id of item as unknown[])
            if (typeof id === 'string' && (await this.owns(id))) ids.push(id)
          result[key] = ids
        } else result[key] = await rewrite(item)
      }
      return result
    }
    if (!['baseline', 'upsert', 'remove', 'order', 'archived'].includes(String(value.type)))
      throw new Error('Unknown workspace frame')
    return (await rewrite(value)) as JsonRecord
  }

  private async owns(value: unknown): Promise<boolean> {
    return (
      typeof value === 'string' &&
      value !== '' &&
      (await this.ownerOf(this.account, asSessionId(value))) === this.account
    )
  }

  private isDisposed(): boolean {
    return this.#disposed
  }

  private async ownsAll(ids: readonly string[]): Promise<boolean> {
    for (const id of ids) if (!(await this.owns(id))) return false
    return true
  }
}

function record(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}
