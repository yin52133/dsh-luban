import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {
  AuthService,
  ProviderRequestIdentityAdapter,
  TaskStore,
  TelemetryAggregator,
  TelemetrySnapshot,
} from 'dsh-luban-core'
import { LubanError, modulePrefix, redactSecrets, systemClock } from 'dsh-luban-core'
import { DefaultTelemetryAggregator } from './aggregator.js'
import { TaskboardHudAlertSink } from './alerts.js'
import {
  HUD_BUILD_PROVENANCE_SCHEMA,
  inspectHudBuildProvenance,
  type HudBuildProvenance,
} from './build-provenance.js'
import { Config as ConfigSchema, type Config as HudConfig, parseConfig } from './config.js'
import {
  DshContextEstimatorProvider,
  DshRateCollector,
  DshSessionTelemetryProvider,
  type SessionProjectionReader,
} from './dsh-telemetry.js'
import { HudHttpApi } from './http-api.js'
import { HudKeepaliveHealthStore } from './keepalive-health.js'
import { HudRateLedger } from './rate-ledger.js'
import { RateTelemetryProvider, SlidingRateWindow, systemMonotonicClock } from './rate-window.js'
import { inspectHudRuntimeArtifact, type HudRuntimeArtifactIdentity } from './runtime-artifact.js'
import type { KeepaliveHealthPayload } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    lubanAuth: AuthService
    lubanTaskStore: TaskStore
    lubanTelemetry: TelemetryAggregator
    lubanProviderRequestIdentity: ProviderRequestIdentityAdapter
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
export type { TelemetryAggregatorOptions } from './aggregator.js'
export { TaskboardHudAlertSink } from './alerts.js'
export {
  HUD_BUILD_PROVENANCE_SCHEMA,
  inspectHudBuildProvenance,
  parseHudBuildProvenance,
} from './build-provenance.js'
export type { HudBuildProvenance, HudLoadedBuildIdentity } from './build-provenance.js'
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
export type { AgentLookup, HudRateEventSink } from './dsh-telemetry.js'
export type { SessionProjectionReader, SessionProjectionResolver } from './dsh-telemetry.js'
export { HudEventStream, HudHttpApi } from './http-api.js'
export { HudKeepaliveHealthStore } from './keepalive-health.js'
export { HUD_RATE_CAPTURE_SCHEMA, HudRateLedger } from './rate-ledger.js'
export type { HudRateCapture, HudRateCaptureMetadata, HudRateLedgerOptions } from './rate-ledger.js'
export { attestHudProviderRequest } from './provider-request-identity.js'
export type {
  HudProviderRequestIdentityEvidence,
  ResolvedHudProviderRequestIdentity,
} from './provider-request-identity.js'
export { RateTelemetryProvider, SlidingRateWindow, systemMonotonicClock } from './rate-window.js'
export type { MonotonicClock } from './rate-window.js'
export {
  HUD_RUNTIME_ARTIFACT_SCHEMA,
  hudRuntimeArtifactBundleSha256,
  inspectHudRuntimeArtifact,
  parseHudRuntimeArtifactIdentity,
} from './runtime-artifact.js'
export type { HudRuntimeArtifactFile, HudRuntimeArtifactIdentity } from './runtime-artifact.js'
export {
  HUD_RATE_EXPORT_SCHEMA,
  PROVIDER_RATE_EXPORT_SCHEMA,
  RATE_RECONCILIATION_SCHEMA,
  RATE_TOKEN_TOLERANCE,
  RateReconciliationError,
  reconcileRateExports,
} from './rate-reconcile.js'
export type {
  HudRateExport,
  HudRateOrigin,
  ProviderRateExport,
  ProviderRateOrigin,
  RateLedgerRecord,
  RateMetricDelta,
  RateReconciliation,
  RateTotals,
  RateWindowUtc,
  ReconciledTokenUsage,
} from './rate-reconcile.js'
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

function diagnostic(error: unknown): string {
  try {
    return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 512)
  } catch {
    return 'unknown error'
  }
}

function readHudBuildDiagnostic(
  entrypoint: URL,
  runtimeArtifact: HudRuntimeArtifactIdentity,
): HudBuildProvenance {
  try {
    return inspectHudBuildProvenance(entrypoint, runtimeArtifact)
  } catch {
    // Build metadata is diagnostic only. A dirty or unpacked dist must not prevent HUD mounting.
    return Object.freeze({
      schemaVersion: HUD_BUILD_PROVENANCE_SCHEMA,
      gitHead: '0'.repeat(40),
      buildId: '00000000-0000-4000-8000-000000000000',
      dirty: true,
      runtime: 'repo-dist',
      manifestSha256: '0'.repeat(64),
      runtimeBundleSha256: runtimeArtifact.bundleSha256,
    })
  }
}

/** Mount rc2 telemetry providers, authenticated API/SSE, and the shared aggregator service. */
export function apply(
  ctx: Context,
  input: Partial<HudConfig> = {},
  runtimeArtifact: HudRuntimeArtifactIdentity = inspectHudRuntimeArtifact(new URL(import.meta.url)),
  build: HudBuildProvenance = readHudBuildDiagnostic(new URL(import.meta.url), runtimeArtifact),
): void {
  const config = parseConfig(input)
  const auth = ctx.get('lubanAuth')
  if (auth === undefined) throw new LubanError('E_UNAVAILABLE', 'lubanAuth is required')
  const window = new SlidingRateWindow(systemMonotonicClock)
  const rateLedger = new HudRateLedger({
    runtimeArtifact,
    build,
    clock: systemClock,
    monotonicClock: systemMonotonicClock,
    resolveProviderRequestIdentity: (): ProviderRequestIdentityAdapter | undefined =>
      ctx.get('lubanProviderRequestIdentity'),
  })
  const collector = new DshRateCollector({
    window,
    clock: systemClock,
    monotonicClock: systemMonotonicClock,
    rateLedger,
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
  telemetry.register(new DshSessionTelemetryProvider(ctx.agents, process.cwd(), resolveProjections))
  telemetry.register(new DshContextEstimatorProvider(ctx.agents, resolveProjections))
  telemetry.register(new RateTelemetryProvider(window))
  const publicConfig = Object.freeze({ thresholds: config.thresholds, display: config.display })
  const keepalive = new HudKeepaliveHealthStore()
  const api = new HudHttpApi({
    telemetry,
    auth,
    config: publicConfig,
    keepalive,
    rateCapture: rateLedger,
    onError: (error: unknown): void =>
      ctx.logger.warn(`luban-hud: stream refresh failed: ${diagnostic(error)}`),
  })
  const publishSnapshot = telemetry.subscribe((snapshot): void => {
    ctx.emit('luban.telemetry.snapshot', snapshot)
  })
  ctx.provide('lubanTelemetry', telemetry)

  ctx.inject(['lubanTaskStore'], (taskContext): (() => Promise<void>) => {
    const taskStore = taskContext.get('lubanTaskStore')
    if (taskStore === undefined) {
      throw new LubanError('E_UNAVAILABLE', 'lubanTaskStore injection became unavailable')
    }
    const alerts = new TaskboardHudAlertSink(taskStore)
    const observe = telemetry.subscribe((snapshot): void => {
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
    const unregisterKeepalive = ctx.on('luban.keepalive.health', (payload): void =>
      keepalive.record(payload),
    )
    for (const agent of ctx.agents.list()) collector.adopt(agent.session)
    telemetry.start()
    return (): void => {
      unregisterRoute()
      unregisterKeepalive()
      unregisterEvent()
      unregisterDisposed()
      unregisterCreated()
      publishSnapshot()
      api.dispose()
      keepalive.dispose()
      telemetry.dispose()
    }
  }, 'luban-hud: providers, route, stream, and sampler lifecycle')
}
