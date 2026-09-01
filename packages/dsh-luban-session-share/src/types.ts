import type {
  AccountId,
  Actor,
  ActorId,
  HostId,
  RegistryEvent,
  SessionEvent,
  SessionId,
  SessionRole,
  SharedSession,
  TaskId,
  TakeoverResult,
} from '@yin52133/dsh-luban-core'
import type { PeerConfig } from './config.js'

export type AccountRole = 'admin' | 'operator' | 'observer' | 'unknown'

export interface AuthenticatedActor {
  readonly actor: Actor
  readonly accountId: AccountId
  readonly accountRole: AccountRole
}

export interface SessionView extends SharedSession {
  readonly owner: Actor
  readonly status: string
  readonly version: number
  readonly updatedAt: number
}

export interface SessionAccessView extends SessionView {
  readonly role: SessionRole
}

export interface LocalSessionInput {
  /** Explicit owner for tests/imports; production resolves this from M01 session ownership. */
  readonly accountId?: AccountId
  readonly id: SessionId
  readonly host: HostId
  readonly owner: Actor
  readonly ownerTaskId?: TaskId
  readonly healthy: boolean
  readonly status: string
}

export type TakeoverStatus = 'pending' | 'granted' | 'denied' | 'expired'

export interface TakeoverRequestRecord {
  readonly id: string
  readonly sessionId: SessionId
  readonly requestedBy: Actor
  readonly owner: Actor
  readonly sessionVersion: number
  readonly status: TakeoverStatus
  readonly createdAt: number
  readonly expiresAt: number
  readonly decidedAt?: number
  readonly reason?: string
}

export type SessionShareEvent =
  | { readonly type: 'registry'; readonly event: RegistryEvent; readonly accountId?: AccountId }
  | { readonly type: 'takeover'; readonly request: TakeoverRequestRecord }

export type SessionStreamEnvelope =
  | {
      readonly id: number
      readonly event: 'baseline'
      readonly data: { readonly session: SessionView; readonly recent: readonly SessionEvent[] }
    }
  | { readonly id: number; readonly event: 'session'; readonly data: SessionEvent }

export interface PeerSessionSnapshot extends SessionView {
  readonly roles: Readonly<Record<ActorId, SessionRole>>
}

export interface PeerNetwork {
  list(peer: PeerConfig): Promise<readonly PeerSessionSnapshot[]>
  requestTakeover(peer: PeerConfig, id: SessionId, by: Actor): Promise<TakeoverResult>
  release(peer: PeerConfig, id: SessionId, by: Actor): Promise<void>
  injectInput(peer: PeerConfig, id: SessionId, by: Actor, text: string): Promise<void>
  stream(
    peer: PeerConfig,
    id: SessionId,
    lastEventId: number | undefined,
    signal: AbortSignal,
  ): AsyncIterable<SessionStreamEnvelope>
}

export interface SessionInputSink {
  inject(id: SessionId, text: string): Promise<void>
}

export interface RegistryListFilter {
  readonly accountId?: AccountId
  readonly host?: HostId
  readonly taskId?: TaskId
}
