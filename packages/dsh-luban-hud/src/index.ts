import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type { AuthService, TelemetryAggregator, TelemetrySnapshot } from '@luban/core'
import { LubanError, modulePrefix, redactSecrets, systemClock } from '@luban/core'
import { DefaultTelemetryAggregator } from './aggregator.js'
import { Config as ConfigSchema, type Config as HudConfig, parseConfig } from './config.js'
import {
  DshContextEstimatorProvider,
  DshRateCollector,
  DshSessionTelemetryProvider,
} from './dsh-telemetry.js'
import { HudHttpApi } from './http-api.js'
import { RateTelemetryProvider, SlidingRateWindow, systemMonotonicClock } from './rate-window.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanAuth: AuthService
    lubanTelemetry: TelemetryAggregator
  }

  interface Events {
    'luban.telemetry.snapshot'(snapshot: TelemetrySnapshot): void
  }
}

export const name = 'luban-hud'
export const inject = ['agents', 'webServer', 'lubanAuth']
export const provide = 'lubanTelemetry'
export const Config = ConfigSchema
export type Config = HudConfig

export { DefaultTelemetryAggregator } from './aggregator.js'
export type { TelemetryAggregatorOptions } from './aggregator.js'
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
export { HudEventStream, HudHttpApi } from './http-api.js'
export { RateTelemetryProvider, SlidingRateWindow, systemMonotonicClock } from './rate-window.js'
export type { MonotonicClock } from './rate-window.js'
export { HUD_TELEMETRY_EVENT } from './types.js'
export type {
  HudLevel,
  HudPublicConfig,
  HudSnapshotResponse,
  HudTelemetryEnvelope,
  ProviderFailure,
  TelemetryAdvisory,
  TelemetrySourceKey,
} from './types.js'

/** Mount rc2 telemetry providers, authenticated API/SSE, and the shared aggregator service. */
export function apply(ctx: Context, input: Partial<HudConfig> = {}): void {
  const config = parseConfig(input)
  const auth = ctx.get('lubanAuth')
  if (auth === undefined) throw new LubanError('E_UNAVAILABLE', 'lubanAuth is required')
  const window = new SlidingRateWindow(systemMonotonicClock)
  const collector = new DshRateCollector({
    window,
    clock: systemClock,
    monotonicClock: systemMonotonicClock,
  })
  const telemetry = new DefaultTelemetryAggregator({
    refreshMs: config.refreshSec * 1_000,
    providerTimeoutMs: Math.max(500, Math.min(5_000, config.refreshSec * 1_000)),
    historyEnabled: config.history.enabled,
    historyRetentionMs: config.history.retainMinutes * 60_000,
    thresholds: config.thresholds,
    onError: (error: unknown): void => {
      const message = redactSecrets(error instanceof Error ? error.message : String(error)).slice(
        0,
        512,
      )
      ctx.logger.warn(`luban-hud: telemetry sampling failed: ${message}`)
    },
  })
  telemetry.register(new DshSessionTelemetryProvider(ctx.agents))
  telemetry.register(new DshContextEstimatorProvider(ctx.agents))
  telemetry.register(new RateTelemetryProvider(window))
  const publicConfig = Object.freeze({ thresholds: config.thresholds, display: config.display })
  const api = new HudHttpApi({ telemetry, auth, config: publicConfig })
  const publishSnapshot = telemetry.subscribe((snapshot): void => {
    ctx.emit('luban.telemetry.snapshot', snapshot)
  })
  ctx.provide('lubanTelemetry', telemetry)

  ctx.effect(() => {
    const unregisterRoute = ctx.webServer.register({
      kind: 'prefix',
      path: modulePrefix('hud'),
      handler: api.handler,
    })
    const unregisterCreated = ctx.on('session/created', (session): void => collector.adopt(session))
    const unregisterDisposed = ctx.on('session/disposed', (session): void =>
      collector.dispose(session),
    )
    const unregisterEvent = ctx.on('session/event', (session, event): void =>
      collector.observe(session, event),
    )
    for (const agent of ctx.agents.list()) collector.adopt(agent.session)
    telemetry.start()
    return (): void => {
      unregisterRoute()
      unregisterEvent()
      unregisterDisposed()
      unregisterCreated()
      publishSnapshot()
      api.dispose()
      telemetry.dispose()
    }
  }, 'luban-hud: providers, route, stream, and sampler lifecycle')
}
