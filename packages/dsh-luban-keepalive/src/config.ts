import { homedir } from 'node:os'
import { resolve } from 'node:path'

export type KeepaliveStrategy = 'auto' | 'tmux' | 'service'

export interface Config {
  readonly strategy: KeepaliveStrategy
  readonly patrolIntervalSec: number
  readonly commandTimeoutSec: number
  readonly ledgerFile: string
  readonly bootRestore: boolean
  readonly alertToTaskboard: boolean
}

const DEFAULT_CONFIG: Config = Object.freeze({
  strategy: 'auto',
  patrolIntervalSec: 60,
  commandTimeoutSec: 15,
  ledgerFile: '~/.dsh/luban/keepalive/ledger.json',
  bootRestore: true,
  alertToTaskboard: true,
})

const MAX_PATROL_INTERVAL_SEC = 300

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

function record(input: unknown): Readonly<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Readonly<Record<string, unknown>>)
    : {}
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}

export function parseConfig(input: unknown): Config {
  const root = record(input)
  const strategy = root.strategy ?? DEFAULT_CONFIG.strategy
  if (strategy !== 'auto' && strategy !== 'tmux' && strategy !== 'service') {
    throw new TypeError('strategy must be auto, tmux, or service')
  }
  const rawLedger = root.ledgerFile ?? DEFAULT_CONFIG.ledgerFile
  if (typeof rawLedger !== 'string' || rawLedger.trim() === '') {
    throw new TypeError('ledgerFile must be a non-empty string')
  }
  const patrolIntervalSec = positiveInteger(
    root.patrolIntervalSec,
    DEFAULT_CONFIG.patrolIntervalSec,
    'patrolIntervalSec',
  )
  if (patrolIntervalSec > MAX_PATROL_INTERVAL_SEC) {
    throw new TypeError(`patrolIntervalSec must be at most ${String(MAX_PATROL_INTERVAL_SEC)}`)
  }
  return {
    strategy,
    patrolIntervalSec,
    commandTimeoutSec: positiveInteger(
      root.commandTimeoutSec,
      DEFAULT_CONFIG.commandTimeoutSec,
      'commandTimeoutSec',
    ),
    ledgerFile: rawLedger.trim(),
    bootRestore:
      typeof root.bootRestore === 'boolean' ? root.bootRestore : DEFAULT_CONFIG.bootRestore,
    alertToTaskboard:
      typeof root.alertToTaskboard === 'boolean'
        ? root.alertToTaskboard
        : DEFAULT_CONFIG.alertToTaskboard,
  }
}

export function resolveUserPath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2))
  return resolve(path)
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
