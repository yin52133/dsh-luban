import { isAbsolute, normalize, resolve } from 'node:path'
import type { InjectStyle } from './types.js'

export interface Config {
  readonly workspaceRoot: string
  readonly attachDir: string
  readonly maxBytes: number
  readonly maxSidePx: number
  readonly compression: boolean
  readonly compressionQuality: number
  readonly retainDays: number
  readonly recentLimit: number
  readonly cleanupIntervalMinutes: number
  readonly injectStyle: InjectStyle
  readonly clipboardTimeoutMs: number
}

const DEFAULT_CONFIG: Config = Object.freeze({
  workspaceRoot: '.',
  attachDir: '.luban/attachments',
  maxBytes: 10 * 1024 * 1024,
  maxSidePx: 2_000,
  compression: true,
  compressionQuality: 82,
  retainDays: 14,
  recentLimit: 50,
  cleanupIntervalMinutes: 60,
  injectStyle: 'markdown',
  clipboardTimeoutMs: 10_000,
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
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('luban-image-paste config must be an object')
  }
  return input as Readonly<Record<string, unknown>>
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(
      `${label} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    )
  }
  return value as number
}

function safeAttachDir(value: unknown): string {
  const candidate =
    typeof value === 'string' && value.trim() !== ''
      ? normalize(value.trim())
      : DEFAULT_CONFIG.attachDir
  if (candidate === '.' || isAbsolute(candidate) || candidate.split(/[\\/]/u)[0] === '..') {
    throw new TypeError('attachDir must be a child directory inside workspaceRoot')
  }
  return candidate.replaceAll('\\', '/')
}

export function parseConfig(input: unknown): Config {
  const root = objectValue(input)
  const workspaceRoot =
    typeof root.workspaceRoot === 'string' && root.workspaceRoot.trim() !== ''
      ? resolve(root.workspaceRoot.trim())
      : resolve(DEFAULT_CONFIG.workspaceRoot)
  const injectStyle = root.injectStyle ?? DEFAULT_CONFIG.injectStyle
  if (injectStyle !== 'markdown' && injectStyle !== 'path') {
    throw new TypeError('injectStyle must be markdown or path')
  }
  if (root.compression !== undefined && typeof root.compression !== 'boolean') {
    throw new TypeError('compression must be a boolean')
  }
  return {
    workspaceRoot,
    attachDir: safeAttachDir(root.attachDir),
    maxBytes: boundedInteger(
      root.maxBytes,
      DEFAULT_CONFIG.maxBytes,
      1_024,
      100 * 1024 * 1024,
      'maxBytes',
    ),
    maxSidePx: boundedInteger(root.maxSidePx, DEFAULT_CONFIG.maxSidePx, 128, 16_384, 'maxSidePx'),
    compression:
      typeof root.compression === 'boolean' ? root.compression : DEFAULT_CONFIG.compression,
    compressionQuality: boundedInteger(
      root.compressionQuality,
      DEFAULT_CONFIG.compressionQuality,
      1,
      100,
      'compressionQuality',
    ),
    retainDays: boundedInteger(root.retainDays, DEFAULT_CONFIG.retainDays, 1, 3_650, 'retainDays'),
    recentLimit: boundedInteger(
      root.recentLimit,
      DEFAULT_CONFIG.recentLimit,
      1,
      500,
      'recentLimit',
    ),
    cleanupIntervalMinutes: boundedInteger(
      root.cleanupIntervalMinutes,
      DEFAULT_CONFIG.cleanupIntervalMinutes,
      1,
      7 * 24 * 60,
      'cleanupIntervalMinutes',
    ),
    injectStyle,
    clipboardTimeoutMs: boundedInteger(
      root.clipboardTimeoutMs,
      DEFAULT_CONFIG.clipboardTimeoutMs,
      1_000,
      60_000,
      'clipboardTimeoutMs',
    ),
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
