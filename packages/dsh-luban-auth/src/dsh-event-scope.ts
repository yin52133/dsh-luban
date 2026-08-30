import { LubanError, asSessionId, type AccountId, type SessionId } from 'dsh-luban-core'

export type DshEventChannel = 'mux' | 'host'

export type DshSessionOwnerLookup = (sessionId: SessionId) => Promise<AccountId | null>

const MUX_SESSION_FRAME_TYPES = new Set([
  'session/event',
  'session/subscribed',
  'approval/requested',
  'approval/resolved',
  'question/requested',
  'question/resolved',
  'session/queue',
  'session/jobs',
  'session/projection',
])

const HOST_SESSION_FRAME_TYPES = new Set([
  'host/session-removed',
  'host/session-status',
  'host/agent-error',
])

const GLOBAL_REMOTE_EVENTS = new Set([
  'commands/change',
  'credentials/reference-updated',
  'llm/adapters-updated',
  'settings/document-updated',
])

interface DshServerRequest {
  readonly type: 'server-request'
  readonly rpcId: string
  readonly method: string
  readonly payload: Record<string, unknown>
  readonly raw: Record<string, unknown>
}

/** Account-scopes DSH rc.2 downstream event envelopes without owning transport ordering. */
export class DshEventScope {
  readonly #ownerOf: DshSessionOwnerLookup
  readonly #questionRpcOwners = new Map<string, AccountId>()
  readonly #runRequestOwners = new Map<string, AccountId>()
  readonly #inspectRequestOwners = new Map<string, AccountId>()
  readonly #pluginOwners = new Map<string, AccountId>()

  public constructor(ownerOf: DshSessionOwnerLookup) {
    this.#ownerOf = ownerOf
  }

  /** Return the account allowed to send a session-less question cancellation. */
  public ownerOfQuestionRpc(rpcId: string): AccountId | null {
    return this.#questionRpcOwners.get(rpcId) ?? null
  }

  /** Forget a question only after DSH has accepted the corresponding response. */
  public completeQuestionRpc(rpcId: string): void {
    this.#questionRpcOwners.delete(rpcId)
  }

  /** Keep, rewrite, or drop one serialized `events.mux` / `events.host` server request. */
  public async filter(
    accountId: AccountId,
    channel: DshEventChannel,
    serialized: Buffer | string,
  ): Promise<Buffer | null> {
    const original = typeof serialized === 'string' ? Buffer.from(serialized, 'utf8') : serialized
    const message = parseServerRequest(original)
    const frameType = requiredString(message.payload, 'type', `${channel} payload`, true)
    if (message.method !== frameType) {
      throw protocolError(`method ${message.method} does not match payload type ${frameType}`, {
        channel,
        method: message.method,
        frameType,
      })
    }

    const payload =
      channel === 'mux'
        ? await this.#filterMux(accountId, message)
        : await this.#filterHost(accountId, message.payload)
    if (payload === null) return null
    if (payload === message.payload) return original
    return Buffer.from(JSON.stringify({ ...message.raw, payload }), 'utf8')
  }

  async #filterMux(
    accountId: AccountId,
    message: DshServerRequest,
  ): Promise<Record<string, unknown> | null> {
    const payload = message.payload
    const frameType = requiredString(payload, 'type', 'mux payload', true)
    if (frameType === 'stream/error') return payload
    if (!MUX_SESSION_FRAME_TYPES.has(frameType)) {
      throw protocolError(`unknown mux frame type ${frameType}`, { frameType })
    }

    const sessionId = requiredString(payload, 'sessionId', `${frameType} payload`, true)
    const owner = await this.#ownerOf(asSessionId(sessionId))

    if (frameType === 'question/requested' && owner !== null) {
      rememberOwner(this.#questionRpcOwners, message.rpcId, owner, 'question rpc')
    } else if (frameType === 'question/resolved') {
      const questionRpcId = requiredString(
        payload,
        'questionRpcId',
        'question/resolved payload',
        true,
      )
      const recordedOwner = this.#questionRpcOwners.get(questionRpcId)
      if (recordedOwner !== undefined && owner !== null && recordedOwner !== owner) {
        throw relationError('question rpc', questionRpcId, recordedOwner, owner)
      }
      this.#questionRpcOwners.delete(questionRpcId)
    }

    return owner === accountId ? payload : null
  }

  async #filterHost(
    accountId: AccountId,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const frameType = requiredString(payload, 'type', 'host payload', true)
    if (frameType === 'stream/error') return payload
    if (frameType === 'host/session-added') {
      const sessionId = requiredString(payload, 'sessionId', `${frameType} payload`, true)
      if (!(await this.#isOwned(accountId, sessionId))) return null
      if (payload.parentSessionId === undefined) return payload
      const parentSessionId = requiredString(
        payload,
        'parentSessionId',
        `${frameType} payload`,
        true,
      )
      if (await this.#isOwned(accountId, parentSessionId)) return payload
      const projected = { ...payload }
      delete projected.parentSessionId
      return projected
    }
    if (HOST_SESSION_FRAME_TYPES.has(frameType)) {
      const sessionId = requiredString(payload, 'sessionId', `${frameType} payload`, true)
      return (await this.#isOwned(accountId, sessionId)) ? payload : null
    }

    switch (frameType) {
      case 'host/workspace-changed': {
        const workspace = requiredRecord(payload, 'workspace', `${frameType} payload`)
        const sessionIds = requiredStringArray(workspace, 'sessionIds', `${frameType} workspace`)
        const filtered = await this.#ownedSessionIds(accountId, sessionIds)
        if (filtered.length === sessionIds.length) return payload
        return { ...payload, workspace: { ...workspace, sessionIds: filtered } }
      }
      case 'host/archived-sessions-changed': {
        const sessionIds = requiredStringArray(
          payload,
          'archivedSessionIds',
          `${frameType} payload`,
        )
        const filtered = await this.#ownedSessionIds(accountId, sessionIds)
        return filtered.length === sessionIds.length
          ? payload
          : { ...payload, archivedSessionIds: filtered }
      }
      case 'host/workspace-removed':
      case 'host/workspace-order-changed':
        return payload
      case 'host/remote-event':
        return this.#filterRemoteEvent(accountId, payload)
      default:
        throw protocolError(`unknown host frame type ${frameType}`, { frameType })
    }
  }

  async #filterRemoteEvent(
    accountId: AccountId,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const event = requiredString(payload, 'event', 'host/remote-event payload', true)
    const args = requiredArray(payload, 'args', `remote event ${event}`)

    if (GLOBAL_REMOTE_EVENTS.has(event)) {
      return payload
    }

    switch (event) {
      case 'agent-preset/selected': {
        const sessionId = requiredArrayString(args, 0, event, true)
        return (await this.#isOwned(accountId, sessionId)) ? payload : null
      }
      case 'cordis/request-run': {
        const request = requiredRemoteRecord(event, args)
        const owner = await this.#ownerOf(
          asSessionId(requiredString(request, 'agentId', event, true)),
        )
        if (owner === null) return null
        const requestId = requiredString(request, 'requestId', event, true)
        const pluginId = requiredString(request, 'pluginId', event, true)
        rememberOwner(this.#runRequestOwners, requestId, owner, 'Cordis run request')
        rememberOwner(this.#pluginOwners, pluginId, owner, 'Cordis plugin')
        return owner === accountId ? payload : null
      }
      case 'cordis/request-run-resolved': {
        const resolved = requiredRemoteRecord(event, args)
        return this.#relatedPayload(
          accountId,
          payload,
          this.#runRequestOwners,
          requiredString(resolved, 'requestId', event, true),
        )
      }
      case 'cordis/inspect-query': {
        const request = requiredRemoteRecord(event, args)
        const owner = await this.#ownerOf(
          asSessionId(requiredString(request, 'agentId', event, true)),
        )
        if (owner === null) return null
        rememberOwner(
          this.#inspectRequestOwners,
          requiredString(request, 'requestId', event, true),
          owner,
          'Cordis inspect request',
        )
        return owner === accountId ? payload : null
      }
      case 'cordis/inspect-query-resolved': {
        const resolved = requiredRemoteRecord(event, args)
        const requestId = requiredString(resolved, 'requestId', event, true)
        return this.#relatedPayload(accountId, payload, this.#inspectRequestOwners, requestId)
      }
      case 'cordis/dynamic-package': {
        const pkg = requiredRemoteRecord(event, args)
        return this.#relatedPayload(
          accountId,
          payload,
          this.#pluginOwners,
          requiredString(pkg, 'pluginId', event, true),
        )
      }
      case 'cordis/dynamic-retract': {
        const retracted = requiredRemoteRecord(event, args)
        return this.#relatedPayload(
          accountId,
          payload,
          this.#pluginOwners,
          requiredString(retracted, 'pluginId', event, true),
        )
      }
      default:
        throw protocolError(`remote event ${event} is not in the DSH rc.2 allowlist`, { event })
    }
  }

  async #isOwned(accountId: AccountId, sessionId: string): Promise<boolean> {
    return (await this.#ownerOf(asSessionId(sessionId))) === accountId
  }

  async #ownedSessionIds(accountId: AccountId, sessionIds: readonly string[]): Promise<string[]> {
    const owned = await Promise.all(
      sessionIds.map(async (sessionId): Promise<boolean> => this.#isOwned(accountId, sessionId)),
    )
    return sessionIds.filter((_sessionId, index) => owned[index] === true)
  }

  #relatedPayload(
    accountId: AccountId,
    payload: Record<string, unknown>,
    owners: ReadonlyMap<string, AccountId>,
    id: string,
  ): Record<string, unknown> | null {
    return owners.get(id) === accountId ? payload : null
  }
}

function parseServerRequest(serialized: Buffer): DshServerRequest {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(serialized)
  } catch (error: unknown) {
    throw protocolError('event message is not valid UTF-8', undefined, error)
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(text) as unknown
  } catch (error: unknown) {
    throw protocolError('event message is not valid JSON', undefined, error)
  }
  const raw = asRecord(decoded)
  if (raw === null) throw protocolError('event message must be a JSON object')
  if (raw.type !== 'server-request') {
    throw protocolError('event message must be a server-request', { type: raw.type })
  }
  const rpcId = requiredString(raw, 'rpcId', 'server-request envelope', true)
  const method = requiredString(raw, 'method', 'server-request envelope', true)
  const payload = requiredRecord(raw, 'payload', 'server-request envelope')
  return { type: 'server-request', rpcId, method, payload, raw }
}

function requiredRemoteRecord(event: string, args: readonly unknown[]): Record<string, unknown> {
  const record = asRecord(args[0])
  if (record === null) throw protocolError(`${event} args[0] must be an object`)
  return record
}

function rememberOwner(
  owners: Map<string, AccountId>,
  id: string,
  owner: AccountId,
  relation: string,
): void {
  const recorded = owners.get(id)
  if (recorded !== undefined && recorded !== owner) {
    throw relationError(relation, id, recorded, owner)
  }
  owners.set(id, owner)
}

function relationError(
  relation: string,
  id: string,
  recorded: AccountId,
  received: AccountId,
): LubanError {
  return new LubanError('E_ACCOUNT_SCOPE_MISMATCH', `Conflicting DSH ${relation} owner`, {
    details: { relation, id, recorded, received },
  })
}

function requiredRecord(
  record: Readonly<Record<string, unknown>>,
  key: string,
  context: string,
): Record<string, unknown> {
  const value = asRecord(record[key])
  if (value === null) throw protocolError(`${context}.${key} must be an object`)
  return value
}

function requiredArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  context: string,
): unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) throw protocolError(`${context}.${key} must be an array`)
  return value
}

function requiredStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  context: string,
): string[] {
  const values = requiredArray(record, key, context)
  return values.map((value, index): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throw protocolError(`${context}.${key}[${String(index)}] must be a non-empty string`)
    }
    return value
  })
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  context: string,
  nonEmpty: boolean,
): string {
  const value = record[key]
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw protocolError(`${context}.${key} must be ${nonEmpty ? 'a non-empty string' : 'a string'}`)
  }
  return value
}

function requiredArrayString(
  values: readonly unknown[],
  index: number,
  context: string,
  nonEmpty: boolean,
): string {
  const value = values[index]
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw protocolError(
      `${context} args[${String(index)}] must be ${nonEmpty ? 'a non-empty string' : 'a string'}`,
    )
  }
  return value
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function protocolError(
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): LubanError {
  return new LubanError('E_INVALID_INPUT', `Invalid DSH event protocol: ${message}`, {
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  })
}
