import { isAbsolute, normalize } from 'node:path'

export interface Config {
  readonly trigger: {
    readonly ratio: number
    readonly minGapRounds: number
  }
  readonly strategy: string
  readonly keepRecentTokens: number
  readonly archiveDir: string
  readonly nightProfile: {
    readonly trigger: { readonly ratio: number }
    readonly keepRecentTokens: number
  }
}

const DEFAULT_CONFIG: Config = Object.freeze({
  trigger: { ratio: 0.8, minGapRounds: 4 },
  strategy: 'summarize+virtualfile',
  keepRecentTokens: 24_000,
  archiveDir: '.luban/context-archive',
  nightProfile: { trigger: { ratio: 0.7 }, keepRecentTokens: 16_000 },
})

type ValidationResult<Value> =
  | { readonly value: Value }
  | {
      readonly issues: readonly {
        readonly message: string
        readonly path?: readonly PropertyKey[]
      }[]
    }

export interface StandardConfigSchema<Value> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: 'dsh-luban'
    validate(input: unknown): ValidationResult<Value>
  }
}

function objectValue(input: unknown): Readonly<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Readonly<Record<string, unknown>>)
    : {}
}

function ratio(value: unknown, fallback: number, label: string): number {
  const candidate = typeof value === 'number' ? value : fallback
  if (!Number.isFinite(candidate) || candidate <= 0 || candidate > 1) {
    throw new TypeError(`${label} must be greater than 0 and at most 1`)
  }
  return candidate
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  const candidate = typeof value === 'number' ? value : fallback
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new TypeError(`${label} must be a positive integer`)
  }
  return candidate
}

function archiveDirectory(value: unknown): string {
  const candidate = normalize(
    typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_CONFIG.archiveDir,
  )
  const first = candidate.split(/[\\/]/u)[0]
  if (candidate === '.' || isAbsolute(candidate) || first === '..') {
    throw new TypeError('archiveDir must stay inside each session workspace')
  }
  return candidate.replaceAll('\\', '/')
}

export function parseConfig(input: unknown): Config {
  const root = objectValue(input)
  const trigger = objectValue(root.trigger)
  const night = objectValue(root.nightProfile)
  const nightTrigger = objectValue(night.trigger)
  const strategy =
    typeof root.strategy === 'string' && root.strategy.trim() !== ''
      ? root.strategy.trim()
      : DEFAULT_CONFIG.strategy
  return {
    trigger: {
      ratio: ratio(trigger.ratio, DEFAULT_CONFIG.trigger.ratio, 'trigger.ratio'),
      minGapRounds: positiveInteger(
        trigger.minGapRounds,
        DEFAULT_CONFIG.trigger.minGapRounds,
        'trigger.minGapRounds',
      ),
    },
    strategy,
    keepRecentTokens: positiveInteger(
      root.keepRecentTokens,
      DEFAULT_CONFIG.keepRecentTokens,
      'keepRecentTokens',
    ),
    archiveDir: archiveDirectory(root.archiveDir),
    nightProfile: {
      trigger: {
        ratio: ratio(
          nightTrigger.ratio,
          DEFAULT_CONFIG.nightProfile.trigger.ratio,
          'nightProfile.trigger.ratio',
        ),
      },
      keepRecentTokens: positiveInteger(
        night.keepRecentTokens,
        DEFAULT_CONFIG.nightProfile.keepRecentTokens,
        'nightProfile.keepRecentTokens',
      ),
    },
  }
}

export const Config: StandardConfigSchema<Config> = Object.freeze({
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-luban' as const,
    validate(input: unknown): ValidationResult<Config> {
      try {
        return { value: parseConfig(input) }
      } catch (error: unknown) {
        return { issues: [{ message: error instanceof Error ? error.message : 'invalid config' }] }
      }
    },
  },
})
