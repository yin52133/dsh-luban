import { standardConfigSchema } from '@yin52133/dsh-luban-core'

export type { StandardConfigSchema } from '@yin52133/dsh-luban-core'

export const HUD_FIELDS = ['context', 'workspace', 'model', 'thinking', 'tpm', 'rpm'] as const

export type HudDisplayField = (typeof HUD_FIELDS)[number]

export interface HudThresholds {
  readonly warn: number
  readonly danger: number
  readonly critical: number
}

export interface Config {
  readonly refreshSec: number
  readonly thresholds: HudThresholds
  readonly display: {
    readonly fields: readonly HudDisplayField[]
    readonly compact: boolean
  }
  readonly history: {
    readonly enabled: boolean
    readonly retainMinutes: number
  }
}

const DEFAULT_CONFIG: Config = Object.freeze({
  refreshSec: 1,
  thresholds: { warn: 0.7, danger: 0.85, critical: 0.95 },
  display: { fields: HUD_FIELDS, compact: false },
  history: { enabled: true, retainMinutes: 60 },
})

function objectValue(input: unknown): Readonly<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Readonly<Record<string, unknown>>)
    : {}
}

function numberInRange(
  input: unknown,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (input === undefined) return fallback
  if (typeof input !== 'number' || !Number.isFinite(input) || input < minimum || input > maximum) {
    throw new TypeError(`${label} must be between ${String(minimum)} and ${String(maximum)}`)
  }
  return input
}

function threshold(input: unknown, fallback: number, label: string): number {
  if (input === undefined) return fallback
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0 || input > 1) {
    throw new TypeError(`${label} must be greater than 0 and no greater than 1`)
  }
  return input
}

function fields(input: unknown): readonly HudDisplayField[] {
  if (input === undefined) return DEFAULT_CONFIG.display.fields
  if (!Array.isArray(input)) throw new TypeError('display.fields must be an array')
  const valid = new Set<string>(HUD_FIELDS)
  if (
    !input.every((value): value is HudDisplayField => typeof value === 'string' && valid.has(value))
  ) {
    throw new TypeError(`display.fields must contain only: ${HUD_FIELDS.join(', ')}`)
  }
  return [...new Set(input)]
}

export function parseConfig(input: unknown): Config {
  const root = objectValue(input)
  const rawThresholds = objectValue(root.thresholds)
  const rawDisplay = objectValue(root.display)
  const rawHistory = objectValue(root.history)
  const thresholds: HudThresholds = {
    warn: threshold(rawThresholds.warn, DEFAULT_CONFIG.thresholds.warn, 'thresholds.warn'),
    danger: threshold(rawThresholds.danger, DEFAULT_CONFIG.thresholds.danger, 'thresholds.danger'),
    critical: threshold(
      rawThresholds.critical,
      DEFAULT_CONFIG.thresholds.critical,
      'thresholds.critical',
    ),
  }
  if (!(thresholds.warn < thresholds.danger && thresholds.danger < thresholds.critical)) {
    throw new TypeError('thresholds must satisfy warn < danger < critical')
  }
  return {
    refreshSec: numberInRange(root.refreshSec, DEFAULT_CONFIG.refreshSec, 'refreshSec', 1, 60),
    thresholds,
    display: {
      fields: fields(rawDisplay.fields),
      compact:
        typeof rawDisplay.compact === 'boolean'
          ? rawDisplay.compact
          : DEFAULT_CONFIG.display.compact,
    },
    history: {
      enabled:
        typeof rawHistory.enabled === 'boolean'
          ? rawHistory.enabled
          : DEFAULT_CONFIG.history.enabled,
      retainMinutes: numberInRange(
        rawHistory.retainMinutes,
        DEFAULT_CONFIG.history.retainMinutes,
        'history.retainMinutes',
        1,
        1_440,
      ),
    },
  }
}

export const Config = standardConfigSchema(parseConfig)
