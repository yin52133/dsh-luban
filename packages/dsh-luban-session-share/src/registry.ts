import { randomUUID } from 'node:crypto'
import type {
  AccountId,
  Actor,
  ActorId,
  Clock,
  HostId,
  RegistryEvent,
  SessionEvent,
  SessionId,
  SessionRegistry,
  SessionRole,
  SharedSession,
  TakeoverResult,
  TaskId,
  Unsubscribe,
} from 'dsh-luban-core'
import { LubanError, systemClock } from 'dsh-luban-core'
import type { PeerConfig } from './config.js'
import { SessionEventLog } from './session-events.js'
import type {
  AccountRole,
  LocalSessionInput,
  PeerNetwork,
  PeerSessionSnapshot,
  RegistryListFilter,
  SessionAccessView,
  SessionInputSink,
  SessionShareEvent,
  SessionStreamEnvelope,
  SessionView,
  TakeoverRequestRecord,
} from './types.js'

interface StoredSession {
  readonly view: SessionView
  readonly origin: 'local' | PeerConfig
}

interface RegistryOptions {
  readonly localHost: HostId
  readonly takeoverTimeoutMs: number
  readonly replayLimit: number
  readonly peers?: readonly PeerConfig[]
  readonly network?: PeerNetwork
  readonly input?: SessionInputSink
  readonly clock?: Clock
  readonly publishLock?: (session: SessionView, role: SessionRole) => void
}

class SessionMutex {
  readonly #tails = new Map<SessionId, Promise<void>>()

  public async run<Value>(id: SessionId, work: () => Value | Promise<Value>): Promise<Value> {
    const previous = this.#tails.get(id) ?? Promise.resolve()
    let release: (() => void) | undefined
    const current = new Promise<void>((resolve): void => {
      release = resolve
    })
    this.#tails.set(id, current)
    await previous
    try {
      return await work()
    } finally {
      release?.()
      if (this.#tails.get(id) === current) this.#tails.delete(id)
    }
  }
}

function sameActor(left: Actor | null | undefined, right: Actor): boolean {
  return (
    left?.kind === right.kind &&
    left.id === right.id &&
    left.accountId !== undefined &&
    left.accountId === right.accountId
  )
}

function cloneActor(actor: Actor): Actor {
  return {
    kind: actor.kind,
    id: actor.id,
    ...(actor.accountId === undefined ? {} : { accountId: actor.accountId }),
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
  }
}

function rolesFor(
  owner: Actor,
  holder: Actor,
  previous: Readonly<Record<ActorId, SessionRole>> = {},
): Readonly<Record<ActorId, SessionRole>> {
  const roles = Object.fromEntries(
    Object.keys(previous).map((id): readonly [string, SessionRole] => [id, 'observer']),
  ) as Record<ActorId, SessionRole>
  roles[owner.id] = sameActor(holder, owner) ? 'owner' : 'observer'
  if (!sameActor(holder, owner)) roles[holder.id] = 'operator'
  return Object.freeze(roles)
}

function cloneView(view: SessionView): SessionView {
  return Object.freeze({
    ...(view.accountId === undefined ? {} : { accountId: view.accountId }),
    id: view.id,
    host: view.host,
    ...(view.ownerTaskId === undefined ? {} : { ownerTaskId: view.ownerTaskId }),
    ...(view.lockHolder === undefined
      ? {}
      : { lockHolder: view.lockHolder === null ? null : cloneActor(view.lockHolder) }),
    roles: Object.freeze({ ...view.roles }),
    healthy: view.healthy,
    owner: cloneActor(view.owner),
    status: view.status,
    version: view.version,
    updatedAt: view.updatedAt,
  })
}

function shared(view: SessionView): SharedSession {
  return cloneView(view)
}

function changed(left: SessionView, right: SessionView): boolean {
  return JSON.stringify(left) !== JSON.stringify(right)
}

/** In-memory source of truth for local sessions plus bounded mirrors of configured peers. */
export class SharedSessionRegistry implements SessionRegistry {
  readonly #localHost: HostId
  readonly #takeoverTimeoutMs: number
  readonly #peers: readonly PeerConfig[]
  readonly #network: PeerNetwork | undefined
  readonly #input: SessionInputSink | undefined
  readonly #clock: Clock
  readonly #publishLock: ((session: SessionView, role: SessionRole) => void) | undefined
  readonly #sessions = new Map<SessionId, StoredSession>()
  readonly #remoteIds = new Map<string, Set<SessionId>>()
  readonly #requests = new Map<string, TakeoverRequestRecord>()
  readonly #pendingBySession = new Map<SessionId, string>()
  readonly #registryListeners = new Map<AccountId, Set<(event: RegistryEvent) => void>>()
  readonly #listeners = new Set<(event: SessionShareEvent) => void>()
  readonly #mutex = new SessionMutex()
  readonly #events: SessionEventLog
  #peerRefresh: Promise<readonly string[]> | undefined

  public constructor(options: RegistryOptions) {
    this.#localHost = options.localHost
    this.#takeoverTimeoutMs = options.takeoverTimeoutMs
    this.#peers = options.peers ?? []
    this.#network = options.network
    this.#input = options.input
    this.#clock = options.clock ?? systemClock
    this.#publishLock = options.publishLock
    this.#events = new SessionEventLog(options.replayLimit, (id): SessionView | undefined =>
      this.getView(id),
    )
  }

  public getView(id: SessionId): SessionView | undefined {
    const stored = this.#sessions.get(id)
    return stored === undefined ? undefined : cloneView(stored.view)
  }

  public getViewFor(id: SessionId, accountId: AccountId): SessionView | undefined {
    const view = this.getView(id)
    return view?.accountId === accountId ? view : undefined
  }

  public async list(
    accountId: AccountId,
    filter: Omit<RegistryListFilter, 'accountId'> = {},
  ): Promise<readonly SharedSession[]> {
    return (await this.listViews({ ...filter, accountId })).map(shared)
  }

  public listViews(filter: RegistryListFilter = {}): Promise<readonly SessionView[]> {
    const views = [...this.#sessions.values()]
      .map(({ view }): SessionView => cloneView(view))
      .filter(
        (view): boolean =>
          (filter.host === undefined || view.host === filter.host) &&
          (filter.accountId === undefined || view.accountId === filter.accountId) &&
          (filter.taskId === undefined || view.ownerTaskId === filter.taskId),
      )
      .sort((left, right): number =>
        `${left.host}/${left.id}`.localeCompare(`${right.host}/${right.id}`),
      )
    return Promise.resolve(views)
  }

  public async listFor(
    actor: Actor,
    accountRole: AccountRole,
    filter: RegistryListFilter = {},
  ): Promise<readonly SessionAccessView[]> {
    if (actor.accountId === undefined) {
      throw new LubanError('E_AUTH_REQUIRED', 'Account context is required')
    }
    const scopedFilter = { ...filter, accountId: actor.accountId }
    return (await this.listViews(scopedFilter)).map((view): SessionAccessView => ({
      ...view,
      role: this.roleFor(view.id, actor, accountRole),
    }))
  }

  public subscribe(
    id: SessionId,
    accountId: AccountId,
    _role: SessionRole,
  ): AsyncIterable<SessionEvent> {
    if (this.getViewFor(id, accountId) === undefined) {
      throw new LubanError('E_NOT_FOUND', `Session ${id} was not found`)
    }
    const remote = this.#remote(id)
    if (remote === undefined) return this.#events.subscribe(id)
    if (this.#network === undefined) {
      throw new LubanError('E_UNAVAILABLE', `Peer ${remote.name} is unavailable`)
    }
    const controller = new AbortController()
    const frames = this.#network.stream(remote, id, undefined, controller.signal)
    return {
      [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
        const iterator = frames[Symbol.asyncIterator]()
        return {
          async next(): Promise<IteratorResult<SessionEvent>> {
            for (;;) {
              const next = await iterator.next()
              if (next.done === true) return { done: true, value: undefined }
              if (next.value.event === 'session') {
                return { done: false, value: next.value.data }
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

  public stream(
    id: SessionId,
    lastEventId: number | undefined,
    signal: AbortSignal,
  ): AsyncIterable<SessionStreamEnvelope> {
    this.#required(id)
    const remote = this.#remote(id)
    if (remote === undefined) return this.#events.stream(id, lastEventId, signal)
    if (this.#network === undefined) {
      throw new LubanError('E_UNAVAILABLE', `Peer ${remote.name} is unavailable`)
    }
    return this.#network.stream(remote, id, lastEventId, signal)
  }

  public async requestTakeover(id: SessionId, by: Actor): Promise<TakeoverResult> {
    this.#assertActorAccount(id, by)
    const remote = this.#remote(id)
    if (remote !== undefined) {
      if (this.#network === undefined)
        throw new LubanError('E_UNAVAILABLE', `Peer ${remote.name} is unavailable`)
      return this.#network.requestTakeover(remote, id, by)
    }
    return this.#mutex.run(id, (): TakeoverResult => {
      this.#assertActorAccount(id, by)
      this.sweepExpired()
      const stored = this.#requiredLocal(id)
      if (sameActor(stored.view.lockHolder, by)) {
        return { status: 'granted', session: shared(stored.view) }
      }
      if (sameActor(stored.view.owner, by)) {
        return {
          status: 'denied',
          reason: 'The current operator must release control before the owner resumes it',
        }
      }
      const activeId = this.#pendingBySession.get(id)
      if (activeId !== undefined) {
        const active = this.#requests.get(activeId)
        if (active !== undefined && sameActor(active.requestedBy, by)) {
          return { status: 'pending', requestId: active.id }
        }
        return { status: 'denied', reason: 'Another takeover request is pending' }
      }
      const now = this.#clock.now()
      const session = this.#rememberObserver(id, by)
      const request: TakeoverRequestRecord = Object.freeze({
        id: randomUUID(),
        sessionId: id,
        requestedBy: cloneActor(by),
        owner: cloneActor(stored.view.owner),
        sessionVersion: session.version,
        status: 'pending',
        createdAt: now,
        expiresAt: now + this.#takeoverTimeoutMs,
      })
      this.#requests.set(request.id, request)
      this.#pendingBySession.set(id, request.id)
      this.#emitShare({ type: 'takeover', request })
      this.#pruneRequests()
      return { status: 'pending', requestId: request.id }
    })
  }

  public async decideTakeover(
    requestId: string,
    decision: 'approve' | 'deny',
    by: Actor,
    expectedVersion: number,
  ): Promise<TakeoverResult> {
    const initial = this.#requests.get(requestId)
    if (initial === undefined) throw new LubanError('E_NOT_FOUND', 'Takeover request was not found')
    this.#assertActorAccount(initial.sessionId, by)
    return this.#mutex.run(initial.sessionId, (): TakeoverResult => {
      this.#assertActorAccount(initial.sessionId, by)
      this.sweepExpired()
      const request = this.#requests.get(requestId)
      if (request === undefined)
        throw new LubanError('E_NOT_FOUND', 'Takeover request was not found')
      if (!sameActor(request.owner, by)) {
        throw new LubanError('E_AUTH_REQUIRED', 'Only the session owner may decide takeover', {
          details: { status: 403 },
        })
      }
      if (request.status !== 'pending') {
        return request.status === 'granted'
          ? { status: 'granted', session: shared(this.#requiredLocal(request.sessionId).view) }
          : { status: 'denied', reason: request.reason ?? `Takeover is ${request.status}` }
      }
      const stored = this.#requiredLocal(request.sessionId)
      if (
        expectedVersion !== request.sessionVersion ||
        stored.view.version !== request.sessionVersion ||
        this.#pendingBySession.get(request.sessionId) !== request.id
      ) {
        throw new LubanError('E_VERSION_CONFLICT', 'Session lock changed before approval')
      }
      const now = this.#clock.now()
      if (decision === 'deny') {
        const denied: TakeoverRequestRecord = Object.freeze({
          ...request,
          status: 'denied',
          decidedAt: now,
          reason: 'Denied by session owner',
        })
        this.#requests.set(request.id, denied)
        this.#pendingBySession.delete(request.sessionId)
        this.#emitShare({ type: 'takeover', request: denied })
        return { status: 'denied', reason: denied.reason ?? 'Denied' }
      }

      const next = this.#replaceHolder(stored.view, request.requestedBy, now)
      this.#sessions.set(request.sessionId, { view: next, origin: 'local' })
      const granted: TakeoverRequestRecord = Object.freeze({
        ...request,
        status: 'granted',
        decidedAt: now,
      })
      this.#requests.set(request.id, granted)
      this.#pendingBySession.delete(request.sessionId)
      this.#emitRegistry({ type: 'changed', session: shared(next) })
      this.#emitShare({ type: 'takeover', request: granted })
      this.#publishLock?.(next, 'operator')
      return { status: 'granted', session: shared(next) }
    })
  }

  public async release(id: SessionId, by: Actor): Promise<void> {
    this.#assertActorAccount(id, by)
    const remote = this.#remote(id)
    if (remote !== undefined) {
      if (this.#network === undefined)
        throw new LubanError('E_UNAVAILABLE', `Peer ${remote.name} is unavailable`)
      await this.#network.release(remote, id, by)
      return
    }
    await this.#mutex.run(id, (): void => {
      this.#assertActorAccount(id, by)
      const stored = this.#requiredLocal(id)
      if (!sameActor(stored.view.lockHolder, by)) {
        throw new LubanError(
          'E_AUTH_REQUIRED',
          'Only the current lock holder may release control',
          { details: { status: 403 } },
        )
      }
      if (sameActor(stored.view.owner, by)) return
      const next = this.#replaceHolder(stored.view, stored.view.owner, this.#clock.now())
      this.#sessions.set(id, { view: next, origin: 'local' })
      this.#emitRegistry({ type: 'changed', session: shared(next) })
      this.#publishLock?.(next, 'owner')
    })
  }

  public async injectInput(
    id: SessionId,
    identity: { readonly actor: Actor; readonly accountRole: AccountRole },
    text: string,
  ): Promise<void> {
    const role = this.roleFor(id, identity.actor, identity.accountRole)
    if (role !== 'owner' && role !== 'operator') {
      throw new LubanError('E_AUTH_REQUIRED', 'Observer role cannot inject session input', {
        details: { status: 403 },
      })
    }
    if (identity.accountRole === 'observer') {
      throw new LubanError('E_AUTH_REQUIRED', 'Observer account cannot inject session input', {
        details: { status: 403 },
      })
    }
    const remote = this.#remote(id)
    if (remote !== undefined) {
      if (this.#network === undefined)
        throw new LubanError('E_UNAVAILABLE', `Peer ${remote.name} is unavailable`)
      await this.#network.injectInput(remote, id, identity.actor, text)
      return
    }
    if (this.#input === undefined) {
      throw new LubanError('E_UNAVAILABLE', 'Session input adapter is unavailable')
    }
    await this.#input.inject(id, text)
  }

  public roleFor(id: SessionId, actor: Actor, accountRole: AccountRole): SessionRole {
    const session = this.#required(id).view
    if (actor.accountId === undefined || session.accountId !== actor.accountId) {
      throw new LubanError('E_NOT_FOUND', `Session ${id} was not found`)
    }
    if (accountRole === 'observer' || accountRole === 'unknown') return 'observer'
    return session.roles[actor.id] ?? 'observer'
  }

  public takeoversFor(actor: Actor): readonly TakeoverRequestRecord[] {
    if (actor.accountId === undefined) return []
    this.sweepExpired()
    return [...this.#requests.values()]
      .filter(
        (request): boolean =>
          this.#sessions.get(request.sessionId)?.view.accountId === actor.accountId &&
          (sameActor(request.owner, actor) || sameActor(request.requestedBy, actor)),
      )
      .sort((left, right): number => right.createdAt - left.createdAt)
      .map((request): TakeoverRequestRecord => ({ ...request }))
  }

  public registerLocal(input: LocalSessionInput): SessionView {
    if (input.host !== this.#localHost) {
      throw new LubanError('E_INVALID_INPUT', 'Local session host does not match registry host')
    }
    const existing = this.#sessions.get(input.id)
    if (existing !== undefined && existing.origin !== 'local') {
      throw new LubanError(
        'E_VERSION_CONFLICT',
        'Local session id collides with a peer registry origin',
      )
    }
    const now = this.#clock.now()
    const previous = existing?.origin === 'local' ? existing.view : undefined
    const accountId = input.accountId ?? input.owner.accountId
    if (accountId === undefined) {
      throw new LubanError('E_ACCOUNT_SCOPE_MISMATCH', 'Local session has no account ownership')
    }
    if (input.owner.accountId !== undefined && input.owner.accountId !== accountId) {
      throw new LubanError('E_ACCOUNT_SCOPE_MISMATCH', 'Local session owner account does not match')
    }
    if (previous?.accountId !== undefined && previous.accountId !== accountId) {
      throw new LubanError('E_ACCOUNT_SCOPE_MISMATCH', 'Local session account cannot change')
    }
    const owner =
      input.owner.accountId === undefined
        ? Object.freeze({ ...input.owner, accountId })
        : input.owner
    const holder = previous?.lockHolder ?? owner
    const view: SessionView = Object.freeze({
      accountId,
      id: input.id,
      host: input.host,
      ...(input.ownerTaskId === undefined ? {} : { ownerTaskId: input.ownerTaskId }),
      lockHolder: cloneActor(holder),
      roles: rolesFor(owner, holder, previous?.roles),
      healthy: input.healthy,
      owner: cloneActor(owner),
      status: input.status,
      version: previous?.version ?? 1,
      updatedAt: now,
    })
    this.#sessions.set(input.id, { view, origin: 'local' })
    this.#emitRegistry({
      type: previous === undefined ? 'registered' : 'changed',
      session: shared(view),
    })
    return cloneView(view)
  }

  public updateLocal(
    id: SessionId,
    patch: {
      readonly healthy?: boolean
      readonly status?: string
      readonly ownerTaskId?: TaskId
    },
  ): SessionView {
    const stored = this.#requiredLocal(id)
    const next: SessionView = Object.freeze({
      ...stored.view,
      ...(patch.healthy === undefined ? {} : { healthy: patch.healthy }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.ownerTaskId === undefined ? {} : { ownerTaskId: patch.ownerTaskId }),
      updatedAt: this.#clock.now(),
    })
    this.#sessions.set(id, { view: next, origin: 'local' })
    this.#emitRegistry({ type: 'changed', session: shared(next) })
    if (patch.status !== undefined) {
      this.#events.publish(id, { type: 'status', status: patch.status, at: this.#clock.now() })
    }
    return cloneView(next)
  }

  public setOwnerTask(id: SessionId, taskId: TaskId | null): SessionView {
    const stored = this.#requiredLocal(id)
    if (
      stored.view.ownerTaskId === taskId ||
      (stored.view.ownerTaskId === undefined && taskId === null)
    ) {
      return cloneView(stored.view)
    }
    const mutable = { ...stored.view }
    if (taskId === null) delete mutable.ownerTaskId
    else mutable.ownerTaskId = taskId
    mutable.updatedAt = this.#clock.now()
    const next: SessionView = Object.freeze(mutable)
    this.#sessions.set(id, { view: next, origin: 'local' })
    this.#emitRegistry({ type: 'changed', session: shared(next) })
    return cloneView(next)
  }

  public publishOutput(id: SessionId, text: string, at = this.#clock.now()): SessionEvent {
    this.#requiredLocal(id)
    return this.#events.publish(id, { type: 'output', text, at })
  }

  public removeLocal(id: SessionId): void {
    const stored = this.#sessions.get(id)
    if (stored?.origin !== 'local') return
    this.#events.publish(id, { type: 'status', status: 'disposed', at: this.#clock.now() })
    this.#events.clear(id)
    this.#sessions.delete(id)
    const requestId = this.#pendingBySession.get(id)
    if (requestId !== undefined) {
      const request = this.#requests.get(requestId)
      if (request?.status === 'pending') {
        const denied: TakeoverRequestRecord = Object.freeze({
          ...request,
          status: 'denied',
          decidedAt: this.#clock.now(),
          reason: 'Session ended before takeover approval',
        })
        this.#requests.set(requestId, denied)
        this.#emitShare({ type: 'takeover', request: denied })
      }
      this.#pendingBySession.delete(id)
    }
    this.#emitRegistry({
      type: 'removed',
      sessionId: id,
      ...(stored.view.accountId === undefined ? {} : { accountId: stored.view.accountId }),
    })
  }

  public async refreshPeers(): Promise<readonly string[]> {
    if (this.#peers.length === 0) return []
    if (this.#network === undefined)
      return this.#peers.map((peer): string => `${peer.name}: unavailable`)
    if (this.#peerRefresh !== undefined) return this.#peerRefresh
    const refresh = this.#refreshPeersOnce(this.#network)
    this.#peerRefresh = refresh
    try {
      return await refresh
    } finally {
      if (this.#peerRefresh === refresh) this.#peerRefresh = undefined
    }
  }

  async #refreshPeersOnce(network: PeerNetwork): Promise<readonly string[]> {
    const results = await Promise.allSettled(
      this.#peers.map(async (peer): Promise<void> => {
        const sessions = await network.list(peer)
        this.#mergePeer(peer, sessions)
      }),
    )
    const issues: string[] = []
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') continue
      const peer = this.#peers[index]
      if (peer === undefined) continue
      issues.push(
        result.reason instanceof LubanError && result.reason.code === 'E_VERSION_CONFLICT'
          ? `${peer.name}: session-id-collision`
          : `${peer.name}: unavailable`,
      )
      this.#markPeerUnhealthy(peer)
    }
    return issues
  }

  public sweepExpired(): void {
    const now = this.#clock.now()
    for (const [id, request] of this.#requests) {
      if (request.status !== 'pending' || request.expiresAt > now) continue
      const expired: TakeoverRequestRecord = Object.freeze({
        ...request,
        status: 'expired',
        decidedAt: now,
        reason: 'Takeover approval timed out',
      })
      this.#requests.set(id, expired)
      if (this.#pendingBySession.get(request.sessionId) === id) {
        this.#pendingBySession.delete(request.sessionId)
      }
      this.#emitShare({ type: 'takeover', request: expired })
    }
  }

  public onRegistryChange(
    accountId: AccountId,
    listener: (event: RegistryEvent) => void,
  ): Unsubscribe {
    let listeners = this.#registryListeners.get(accountId)
    if (listeners === undefined) {
      listeners = new Set()
      this.#registryListeners.set(accountId, listeners)
    }
    listeners.add(listener)
    return (): void => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#registryListeners.delete(accountId)
    }
  }

  public onEvent(listener: (event: SessionShareEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return (): void => {
      this.#listeners.delete(listener)
    }
  }

  #mergePeer(peer: PeerConfig, incoming: readonly PeerSessionSnapshot[]): void {
    const previousIds = this.#remoteIds.get(peer.name) ?? new Set<SessionId>()
    const nextIds = new Set<SessionId>()
    const accepted = incoming.filter((raw): boolean => raw.host !== this.#localHost)
    for (const raw of accepted) {
      const current = this.#sessions.get(raw.id)
      if (
        current !== undefined &&
        (current.origin === 'local' || current.origin.name !== peer.name)
      ) {
        throw new LubanError(
          'E_VERSION_CONFLICT',
          'Peer session id collides with another registry origin',
        )
      }
    }
    for (const raw of accepted) {
      const current = this.#sessions.get(raw.id)
      const view = cloneView(raw)
      nextIds.add(view.id)
      this.#sessions.set(view.id, { view, origin: peer })
      if (current === undefined) this.#emitRegistry({ type: 'registered', session: shared(view) })
      else if (changed(current.view, view)) {
        this.#emitRegistry({ type: 'changed', session: shared(view) })
      }
    }
    for (const id of previousIds) {
      if (nextIds.has(id)) continue
      const stored = this.#sessions.get(id)
      if (stored?.origin !== 'local' && stored?.origin.name === peer.name) {
        this.#sessions.delete(id)
        this.#emitRegistry({
          type: 'removed',
          sessionId: id,
          ...(stored.view.accountId === undefined ? {} : { accountId: stored.view.accountId }),
        })
      }
    }
    this.#remoteIds.set(peer.name, nextIds)
  }

  #markPeerUnhealthy(peer: PeerConfig): void {
    for (const id of this.#remoteIds.get(peer.name) ?? []) {
      const stored = this.#sessions.get(id)
      if (stored?.origin === 'local' || stored?.origin.name !== peer.name) continue
      if (!stored.view.healthy && stored.view.status === 'peer-unavailable') continue
      const view: SessionView = Object.freeze({
        ...stored.view,
        healthy: false,
        status: 'peer-unavailable',
        updatedAt: this.#clock.now(),
      })
      this.#sessions.set(id, { view, origin: peer })
      this.#emitRegistry({ type: 'changed', session: shared(view) })
    }
  }

  #rememberObserver(id: SessionId, actor: Actor): SessionView {
    const stored = this.#requiredLocal(id)
    if (stored.view.roles[actor.id] !== undefined) return stored.view
    const roles = { ...stored.view.roles, [actor.id]: 'observer' as const }
    const next: SessionView = Object.freeze({
      ...stored.view,
      roles: Object.freeze(roles),
      version: stored.view.version + 1,
      updatedAt: this.#clock.now(),
    })
    this.#sessions.set(id, { view: next, origin: 'local' })
    this.#emitRegistry({ type: 'changed', session: shared(next) })
    return next
  }

  #replaceHolder(view: SessionView, holder: Actor, now: number): SessionView {
    return Object.freeze({
      ...view,
      lockHolder: cloneActor(holder),
      roles: rolesFor(view.owner, holder, view.roles),
      version: view.version + 1,
      updatedAt: now,
    })
  }

  #remote(id: SessionId): PeerConfig | undefined {
    const origin = this.#sessions.get(id)?.origin
    return origin === undefined || origin === 'local' ? undefined : origin
  }

  #assertActorAccount(id: SessionId, actor: Actor): void {
    const session = this.#required(id).view
    if (actor.accountId === undefined || session.accountId !== actor.accountId) {
      throw new LubanError('E_NOT_FOUND', `Session ${id} was not found`)
    }
  }

  #required(id: SessionId): StoredSession {
    const stored = this.#sessions.get(id)
    if (stored === undefined) throw new LubanError('E_NOT_FOUND', `Session ${id} was not found`)
    return stored
  }

  #requiredLocal(id: SessionId): StoredSession {
    const stored = this.#required(id)
    if (stored.origin !== 'local') {
      throw new LubanError('E_INVALID_TRANSITION', 'Operation belongs to a remote peer')
    }
    return stored
  }

  #emitRegistry(event: RegistryEvent): void {
    const accountId = event.type === 'removed' ? event.accountId : event.session.accountId
    if (accountId !== undefined) {
      for (const listener of [...(this.#registryListeners.get(accountId) ?? [])]) listener(event)
    }
    this.#emitShare({
      type: 'registry',
      event,
      ...(accountId === undefined ? {} : { accountId }),
    })
  }

  #emitShare(event: SessionShareEvent): void {
    for (const listener of [...this.#listeners]) listener(event)
  }

  #pruneRequests(): void {
    if (this.#requests.size <= 1_024) return
    const removable = [...this.#requests.values()]
      .filter((request): boolean => request.status !== 'pending')
      .sort((left, right): number => left.createdAt - right.createdAt)
    for (const request of removable.slice(0, this.#requests.size - 1_024)) {
      this.#requests.delete(request.id)
    }
  }
}
