import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { standardConfigSchema, type HostScope } from 'dsh-luban-core'

export type { StandardConfigSchema } from 'dsh-luban-core'

export interface NightConfig {
  readonly enabled: boolean
  readonly window: string
  readonly dailyQuota: number
  readonly hostScopeWhitelist: readonly Exclude<HostScope, 'any'>[]
  readonly tagWhitelist: readonly string[]
  readonly model: {
    readonly provider: string
    readonly id: string
  }
  readonly toolAllowlist: readonly string[]
  readonly circuitBreaker: {
    readonly maxConsecutiveFailures: number
  }
}

export interface Config {
  readonly store: {
    readonly dir: string
  }
  readonly hostScope: HostScope | 'auto'
  readonly claim: {
    readonly requireAcceptance: boolean
  }
  readonly night: NightConfig
}

const DEFAULT_CONFIG: Config = Object.freeze({
  store: { dir: '~/.dsh/luban/taskboard' },
  hostScope: 'auto',
  claim: { requireAcceptance: true },
  night: {
    enabled: false,
    window: '23:30-06:30',
    dailyQuota: 5,
    hostScopeWhitelist: ['ubuntu'] as const,
    tagWhitelist: ['auto-ok'],
    model: { provider: '', id: '' },
    toolAllowlist: [],
    circuitBreaker: { maxConsecutiveFailures: 3 },
  },
})

function objectValue(input: unknown): Readonly<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Readonly<Record<string, unknown>>)
    : {}
}

function booleanValue(input: unknown, fallback: boolean): boolean {
  return typeof input === 'boolean' ? input : fallback
}

function positiveInteger(input: unknown, fallback: number): number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input > 0 ? input : fallback
}

function stringList(input: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(input) && input.every((value): value is string => typeof value === 'string')
    ? [...new Set(input.map((value): string => value.trim()).filter(Boolean))]
    : fallback
}

function trimmedString(input: unknown): string {
  return typeof input === 'string' ? input.trim() : ''
}

export function parseConfig(input: unknown): Config {
  const root = objectValue(input)
  const store = objectValue(root.store)
  const claim = objectValue(root.claim)
  const night = objectValue(root.night)
  const nightModel = objectValue(night.model)
  const breaker = objectValue(night.circuitBreaker)
  const rawScope = root.hostScope
  const hostScope: Config['hostScope'] =
    rawScope === 'win' || rawScope === 'ubuntu' || rawScope === 'any' || rawScope === 'auto'
      ? rawScope
      : DEFAULT_CONFIG.hostScope
  const scopes = stringList(
    night.hostScopeWhitelist,
    DEFAULT_CONFIG.night.hostScopeWhitelist,
  ).filter((value): value is 'win' | 'ubuntu' => value === 'win' || value === 'ubuntu')
  const window = typeof night.window === 'string' ? night.window : DEFAULT_CONFIG.night.window
  if (!/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/u.test(window)) {
    throw new TypeError('night.window must use HH:mm-HH:mm')
  }
  const rawDir =
    typeof store.dir === 'string' && store.dir.trim() !== ''
      ? store.dir.trim()
      : DEFAULT_CONFIG.store.dir
  const nightEnabled = booleanValue(night.enabled, false)
  const model = {
    provider: trimmedString(nightModel.provider),
    id: trimmedString(nightModel.id),
  }
  if (nightEnabled && (model.provider === '' || model.id === '')) {
    throw new TypeError(
      'night.model.provider and night.model.id are required when night mode is enabled',
    )
  }

  return {
    store: { dir: rawDir },
    hostScope,
    claim: { requireAcceptance: booleanValue(claim.requireAcceptance, true) },
    night: {
      enabled: nightEnabled,
      window,
      dailyQuota: positiveInteger(night.dailyQuota, DEFAULT_CONFIG.night.dailyQuota),
      hostScopeWhitelist: scopes.length > 0 ? scopes : DEFAULT_CONFIG.night.hostScopeWhitelist,
      tagWhitelist: stringList(night.tagWhitelist, DEFAULT_CONFIG.night.tagWhitelist),
      model,
      toolAllowlist: stringList(night.toolAllowlist, DEFAULT_CONFIG.night.toolAllowlist),
      circuitBreaker: {
        maxConsecutiveFailures: positiveInteger(
          breaker.maxConsecutiveFailures,
          DEFAULT_CONFIG.night.circuitBreaker.maxConsecutiveFailures,
        ),
      },
    },
  }
}

export function resolveStoreDirectory(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

export const Config = standardConfigSchema(parseConfig)
