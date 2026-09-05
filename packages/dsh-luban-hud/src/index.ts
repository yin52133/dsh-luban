import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  AccountId,
  AuthService,
  TaskStore,
  TelemetryAggregator,
  TelemetrySnapshot,
} from '@yin52133/dsh-luban-core'
import { asSessionId, LubanError, modulePrefix, systemClock } from '@yin52133/dsh-luban-core'
import { DefaultTelemetryAggregator } from './aggregator.js'
import { TaskboardHudAlertSink } from './alerts.js'
import { Config as ConfigSchema, type Config as HudConfig, parseConfig } from './config.js'
import {
  DshContextEstimatorProvider,
  DshRateCollector,
  DshSessionTelemetryProvider,
  type SessionProjectionReader,
} from './dsh-telemetry.js'
import { HudHttpApi } from './http-api.js'
import { HudKeepaliveHealthStore } from './keepalive-health.js'
import { RateTelemetryProvider, SlidingRateWindow, systemMonotonicClock } from './rate-window.js'
import type { KeepaliveHealthPayload } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanAuth: AuthService
    lubanTaskStore: TaskStore
    lubanTelemetry: TelemetryAggregator
  }

  interface Events {
    'luban.keepalive.health'(payload: KeepaliveHealthPayload): void
    'luban.telemetry.snapshot'(snapshot: TelemetrySnapshot): void
  }
}

export const name = 'luban-hud'
export const inject = ['agents', 'webServer', 'lubanAuth']
export const provide = 'lubanTelemetry'
export const Config = ConfigSchema
export type Config = HudConfig

export { DefaultTelemetryAggregator } from './aggregator.js'
export type { AccountTelemetryProvider, TelemetryAggregatorOptions } from './aggregator.js'
export { TaskboardHudAlertSink } from './alerts.js'
export { renderCliHeader, sanitizeTerminalText } from './cli-render.js'
export { parseConfig } from './config.js'
export type { HudDisplayField, HudThresholds } from './config.js'
export {
  contextPressureTotal,
  displayWorkspace,
  DshContextEstimatorProvider,
  DshRateCollector,
  DshSessionTelemetryProvider,
  estimateSessionTokens,
  selectTelemetryAgent,
  tokenUsageTotal,
} from './dsh-telemetry.js'
export type { AgentLookup } from './dsh-telemetry.js'
export type { SessionProjectionReader, SessionProjectionResolver } from './dsh-telemetry.js'
export { HudEventStream, HudHttpApi } from './http-api.js'
export { HudKeepaliveHealthStore } from './keepalive-health.js'
export { RateTelemetryProvider, SlidingRateWindow, systemMonotonicClock } from './rate-window.js'
export type { MonotonicClock } from './rate-window.js'
export { HUD_TELEMETRY_EVENT } from './types.js'
export type {
  HudLevel,
  HudKeepaliveAlert,
  HudKeepaliveStatus,
  HudPublicConfig,
  HudSnapshotResponse,
  HudTelemetryEnvelope,
  ProviderFailure,
  TelemetryAdvisory,
  TelemetrySourceKey,
  KeepaliveHealthPayload,
} from './types.js'

const DIAGNOSTIC_CONTROL_CHARACTERS = /[\p{Cc}\u2028\u2029]/gu

function diagnostic(error: unknown): string {
  try {
    const value = error instanceof Error ? error.message : String(error)
    const message = value
      .replace(DIAGNOSTIC_CONTROL_CHARACTERS, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 512)
    return message === '' ? 'unknown error' : message
  } catch {
    return 'unknown error'
  }
}

/** Mount DSH telemetry providers, authenticated API/SSE, and the shared aggregator service. */
export function apply(ctx: Context, input: Partial<HudConfig> = {}): void {
  const config = parseConfig(input)
  const auth = ctx.get('lubanAuth')
  if (auth === undefined) throw new LubanError('E_UNAVAILABLE', 'lubanAuth is required')
  const sessionOwners = new Map<string, AccountId>()
  const ownerLookups = new Map<string, Promise<AccountId | null>>()
  const resolveSessionAccount = (
    sessionId: ReturnType<typeof asSessionId>,
  ): Promise<AccountId | null> => {
    const key = String(sessionId)
    const cached = sessionOwners.get(key)
    if (cached !== undefined) return Promise.resolve(cached)
    const existing = ownerLookups.get(key)
    if (existing !== undefined) return existing
    const lookup = auth.accountSessions
      .ownerOf(sessionId)
      .then((accountId): AccountId | null => {
        if (accountId !== null) sessionOwners.set(key, accountId)
        return accountId
      })
      .finally((): void => void ownerLookups.delete(key))
    ownerLookups.set(key, lookup)
    return lookup
  }
  const accountSessions = Object.freeze({
    bind: async (
      accountId: AccountId,
      sessionId: ReturnType<typeof asSessionId>,
    ): Promise<void> => {
      await auth.accountSessions.bind(accountId, sessionId)
      sessionOwners.set(String(sessionId), accountId)
    },
    ownerOf: resolveSessionAccount,
  })
  const window = new SlidingRateWindow(systemMonotonicClock)
  const collector = new DshRateCollector({
    window,
    clock: systemClock,
    monotonicClock: systemMonotonicClock,
  })
  const adoptedSessions = new Map<string, AccountId>()
  let acceptingEvents = true
  const collectOwnedSession = async (session: Session, event?: SessionEvent): Promise<void> => {
    const sessionId = asSessionId(String(session.id))
    const accountId = await resolveSessionAccount(sessionId)
    if (!acceptingEvents || accountId === null) return
    const adoptedAccount = adoptedSessions.get(String(sessionId))
    if (adoptedAccount !== undefined && adoptedAccount !== accountId) {
      throw new LubanError(
        'E_ACCOUNT_SCOPE_MISMATCH',
        `HUD session ${String(sessionId)} changed owner from ${String(adoptedAccount)} to ${String(accountId)}`,
      )
    }
    if (adoptedAccount === undefined) {
      collector.adoptForAccount(accountId, session)
      adoptedSessions.set(String(sessionId), accountId)
      return
    }
    if (event !== undefined) collector.observeForAccount(accountId, session, event)
  }
  const disposeOwnedSession = async (session: Session): Promise<void> => {
    await collectOwnedSession(session)
    const sessionId = String(session.id)
    const accountId = adoptedSessions.get(sessionId)
    if (accountId === undefined) return
    collector.disposeForAccount(accountId, session)
    adoptedSessions.delete(sessionId)
  }
  const refreshOwnedSessions = async (): Promise<void> => {
    await Promise.all(
      ctx.agents.list().map(async (agent): Promise<void> => collectOwnedSession(agent.session)),
    )
  }
  const telemetry = new DefaultTelemetryAggregator({
    refreshMs: config.refreshSec * 1_000,
    providerTimeoutMs: Math.max(500, Math.min(5_000, config.refreshSec * 1_000)),
    historyEnabled: config.history.enabled,
    historyRetentionMs: config.history.retainMinutes * 60_000,
    thresholds: config.thresholds,
    accountScoped: true,
    resolveSessionAccount,
    onError: (error: unknown): void => {
      ctx.logger.warn(`luban-hud: telemetry sampling failed: ${diagnostic(error)}`)
    },
  })
  const resolveProjections = (): SessionProjectionReader | undefined => {
    const service = (ctx as unknown as { get(name: string): unknown }).get('sessionProjections')
    if (
      service === null ||
      typeof service !== 'object' ||
      typeof (service as { snapshot?: unknown }).snapshot !== 'function'
    ) {
      return undefined
    }
    return service as SessionProjectionReader
  }
  telemetry.register(
    new DshSessionTelemetryProvider(ctx.agents, process.cwd(), resolveProjections, accountSessions),
  )
  telemetry.register(
    new DshContextEstimatorProvider(ctx.agents, resolveProjections, accountSessions),
  )
  telemetry.register(
    new RateTelemetryProvider(window, (accountId) => collector.windowForAccount(accountId)),
  )
  const publicConfig = Object.freeze({ thresholds: config.thresholds, display: config.display })
  const keepalive = new HudKeepaliveHealthStore()
  const api = new HudHttpApi({
    telemetry,
    auth,
    config: publicConfig,
    keepalive,
    onError: (error: unknown): void =>
      ctx.logger.warn(`luban-hud: stream refresh failed: ${diagnostic(error)}`),
  })
  const publishSnapshot = telemetry.subscribeAccounts((_accountId, snapshot): void => {
    ctx.emit('luban.telemetry.snapshot', snapshot)
  })
  ctx.provide('lubanTelemetry', telemetry)

  ctx.inject(['lubanTaskStore'], (taskContext): (() => Promise<void>) => {
    const taskStore = taskContext.get('lubanTaskStore')
    if (taskStore === undefined) {
      throw new LubanError('E_UNAVAILABLE', 'lubanTaskStore injection became unavailable')
    }
    const alerts = new TaskboardHudAlertSink(taskStore)
    const observe = telemetry.subscribeAccounts((_accountId, snapshot): void => {
      void alerts
        .observe(snapshot, telemetry.advisory(snapshot))
        .catch((error: unknown): void =>
          ctx.logger.warn(`luban-hud: Taskboard alert failed: ${diagnostic(error)}`),
        )
    })
    return async (): Promise<void> => {
      observe()
      await alerts.dispose()
    }
  })

  ctx.effect(() => {
    const pendingOwnership = new Set<Promise<void>>()
    const trackOwnership = (operation: Promise<void>): void => {
      const pending = operation
        .catch((error: unknown): void =>
          ctx.logger.warn(`luban-hud: session ownership collection failed: ${diagnostic(error)}`),
        )
        .finally((): void => void pendingOwnership.delete(pending))
      pendingOwnership.add(pending)
    }
    const withSessionOwner = (
      sessionId: string,
      operation: (accountId: AccountId) => void,
    ): void => {
      trackOwnership(
        resolveSessionAccount(asSessionId(sessionId)).then((accountId): void => {
          if (acceptingEvents && accountId !== null) operation(accountId)
        }),
      )
    }
    const unregisterRoute = ctx.webServer.register({
      kind: 'prefix',
      path: modulePrefix('hud'),
      handler: api.handler,
    })
    const unregisterCreated = ctx.on('session/created', (session): void =>
      trackOwnership(collectOwnedSession(session)),
    )
    const unregisterDisposed = ctx.on('session/disposed', (session): void =>
      trackOwnership(disposeOwnedSession(session)),
    )
    const unregisterEvent = ctx.on('session/event', (session, event): void =>
      trackOwnership(collectOwnedSession(session, event)),
    )
    const unregisterKeepalive = ctx.on('luban.keepalive.health', (payload): void =>
      withSessionOwner(payload.sessionId, (accountId): void =>
        keepalive.recordForAccount(accountId, payload),
      ),
    )
    for (const agent of ctx.agents.list()) {
      trackOwnership(collectOwnedSession(agent.session))
    }
    const ownerRetryTimer = setInterval(
      (): void => trackOwnership(refreshOwnedSessions()),
      config.refreshSec * 1_000,
    )
    ownerRetryTimer.unref()
    telemetry.start()
    return async (): Promise<void> => {
      acceptingEvents = false
      clearInterval(ownerRetryTimer)
      unregisterRoute()
      unregisterKeepalive()
      unregisterEvent()
      unregisterDisposed()
      unregisterCreated()
      await Promise.allSettled([...pendingOwnership])
      publishSnapshot()
      api.dispose()
      keepalive.dispose()
      telemetry.dispose()
    }
  }, 'luban-hud: providers, route, stream, and sampler lifecycle')
}
