import type { TelemetrySnapshot } from '@luban/core'
import type { HudDisplayField, HudThresholds } from './config.js'

export const HUD_TELEMETRY_EVENT = 'luban.telemetry.snapshot' as const

export type HudLevel = 'unknown' | 'normal' | 'warn' | 'danger' | 'critical'

export interface TelemetryAdvisory {
  readonly level: HudLevel
  readonly message: string
  readonly compactionSuggested: boolean
}

export interface ProviderFailure {
  readonly providerId: string
  readonly message: string
}

export type TelemetrySourceKey =
  | 'context.used'
  | 'context.max'
  | 'context.ratio'
  | 'workspace.name'
  | 'model.name'
  | 'model.thinkingDepth'
  | 'rates.tpm1m'
  | 'rates.tpm5m'
  | 'rates.rpm1m'
  | 'rates.rpm5m'

export interface HudTelemetryEnvelope {
  readonly snapshot: TelemetrySnapshot
  readonly advisory: TelemetryAdvisory
  readonly sources: Readonly<Partial<Record<TelemetrySourceKey, string>>>
  readonly failures: readonly ProviderFailure[]
}

export interface HudPublicConfig {
  readonly thresholds: HudThresholds
  readonly display: {
    readonly fields: readonly HudDisplayField[]
    readonly compact: boolean
  }
}

export interface HudSnapshotResponse extends HudTelemetryEnvelope {
  readonly config: HudPublicConfig
}
