import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {
  Actor,
  AuthService,
  KeepaliveService,
  SessionId,
  SessionRegistry,
  TaskStore,
} from '@luban/core'
import { LubanError, asActorId, modulePrefix } from '@luban/core'
import {
  Config as ConfigSchema,
  type Config as SessionShareConfig,
  parseConfig,
  resolveHostId,
} from './config.js'
import { DshSessionBridge, DshSessionInputSink } from './dsh-bridge.js'
import { SessionShareHttpApi } from './http-api.js'
import { HttpPeerNetwork } from './peer.js'
import { SharedSessionRegistry } from './registry.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanAuth: AuthService
    lubanKeepalive: KeepaliveService
    lubanSessionRegistry: SessionRegistry
    lubanTaskStore: TaskStore
  }

  interface Events {
    'luban.session.lock'(payload: {
      readonly sessionId: SessionId
      readonly holder: Actor | null
      readonly role: 'owner' | 'operator' | 'observer'
    }): void
  }
}

export const name = 'luban-session-share'
export const inject = ['agents', 'webServer', 'lubanAuth', 'lubanKeepalive']
export const provide = 'lubanSessionRegistry'
export const Config = ConfigSchema
export type Config = SessionShareConfig

export { parseConfig, resolveHostId } from './config.js'
export type { PeerConfig } from './config.js'
export { DshSessionBridge, DshSessionInputSink } from './dsh-bridge.js'
export { RegistryEventStream, SessionShareHttpApi } from './http-api.js'
export { decodePeerSession, HttpPeerNetwork } from './peer.js'
export { SharedSessionRegistry } from './registry.js'
export { SessionEventLog } from './session-events.js'
export type {
  AccountRole,
  AuthenticatedActor,
  LocalSessionInput,
  PeerNetwork,
  PeerSessionSnapshot,
  SessionAccessView,
  SessionInputSink,
  SessionShareEvent,
  SessionStreamEnvelope,
  SessionView,
  TakeoverRequestRecord,
  TakeoverStatus,
} from './types.js'

/** Mount the authenticated dual-host registry, rc2 event bridge, and takeover API. */
export function apply(ctx: Context, input: Partial<SessionShareConfig> = {}): void {
  const config = parseConfig(input)
  const auth = ctx.get('lubanAuth')
  const keepalive = ctx.get('lubanKeepalive')
  if (auth === undefined || keepalive === undefined) {
    throw new LubanError('E_UNAVAILABLE', 'lubanAuth and lubanKeepalive are required')
  }
  const host = resolveHostId(config.host)
  const network = new HttpPeerNetwork({ timeoutMs: config.requestTimeoutSec * 1_000 })
  const registry = new SharedSessionRegistry({
    localHost: host,
    takeoverTimeoutMs: config.takeoverTimeoutSec * 1_000,
    replayLimit: config.replayLimit,
    peers: config.peers,
    network,
    input: new DshSessionInputSink(ctx.agents),
    publishLock: (session, role): void => {
      ctx.emit('luban.session.lock', {
        sessionId: session.id,
        holder: session.lockHolder ?? null,
        role,
      })
    },
  })
  const owner = {
    kind: 'user' as const,
    id: asActorId(config.ownerUser),
    displayName: config.ownerUser,
  }
  const bridge = new DshSessionBridge({ agents: ctx.agents, registry, host, owner })
  bridge.initialize([])
  const taskStore = ctx.get('lubanTaskStore')
  const api = new SessionShareHttpApi(registry, auth, config.replayLimit)
  ctx.provide('lubanSessionRegistry', registry)

  ctx.effect(() => {
    const unregisterRoute = ctx.webServer.register({
      kind: 'prefix',
      path: modulePrefix('session-share'),
      handler: api.handler,
    })
    const unregisterCreated = ctx.on('agent/created', ({ agent }): void =>
      bridge.agentCreated(agent),
    )
    const unregisterDisposed = ctx.on('agent/disposed', ({ agent }): void =>
      bridge.agentDisposed(agent),
    )
    const unregisterStatus = ctx.on('agent/status', ({ agent, status }): void =>
      bridge.agentStatus(agent, status),
    )
    const unregisterSessionEvent = ctx.on('session/event', (session, event): void =>
      bridge.sessionEvent(session, event),
    )
    const unregisterKeepalive = keepalive.onEvent((event): void => bridge.keepaliveEvent(event))
    const refreshTaskLinks = (): void => {
      if (taskStore === undefined) return
      void taskStore
        .query({})
        .then((tasks): void => bridge.syncTasks(tasks))
        .catch((): void => ctx.logger.warn('luban-session-share: task link refresh failed'))
    }
    const unregisterTasks = taskStore?.subscribe(refreshTaskLinks)
    const refresh = (): void => {
      void registry.refreshPeers().then((issues): void => {
        for (const issue of issues) ctx.logger.warn(`luban-session-share: ${issue}`)
      })
      registry.sweepExpired()
    }
    refresh()
    refreshTaskLinks()
    const timer = setInterval(refresh, config.peerRefreshSec * 1_000)
    timer.unref()
    return (): void => {
      clearInterval(timer)
      unregisterTasks?.()
      unregisterKeepalive()
      unregisterSessionEvent()
      unregisterStatus()
      unregisterDisposed()
      unregisterCreated()
      unregisterRoute()
      api.dispose()
    }
  }, 'luban-session-share: registry, peer mirror, and authenticated streams')
}

const plugin = Object.freeze({ name, inject, provide, Config, apply })
export default plugin
