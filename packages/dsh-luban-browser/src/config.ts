import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserProfile } from '@luban/core'
import { BrowserError } from './errors.js'
import { DEFAULT_PASSED_ENVIRONMENT } from './security.js'

export interface Config {
  readonly engine?: 'browser-use'
  readonly kernel?: 'auto' | 'chrome' | 'edge' | 'chromium-headless'
  readonly headless?: boolean
  readonly userDataDir?: string
  readonly executablePath?: string
  readonly dataDir?: string
  readonly templatesDir?: string
  readonly defaults?: {
    readonly maxSteps?: number
    readonly timeoutSec?: number
    readonly allowDomains?: readonly string[]
  }
  readonly bridge?: {
    readonly runner?: 'uv'
    readonly python?: '3.12'
    readonly projectDir?: string
    readonly environmentDir?: string
    readonly passEnvironment?: readonly string[]
    readonly timeoutGraceSec?: number
  }
  readonly queue?: { readonly maxPending?: number }
  readonly taskboard?: { readonly autoRun?: boolean }
}

export interface ResolvedConfig {
  readonly dataDir: string
  readonly artifactsDir: string
  readonly profilesDir: string
  readonly templateDirectories: readonly string[]
  readonly profile: BrowserProfile & { readonly executablePath?: string }
  readonly defaults: {
    readonly maxSteps: number
    readonly timeoutSec: number
    readonly allowDomains: readonly string[]
  }
  readonly bridge: {
    readonly runner: 'uv'
    readonly python: '3.12'
    readonly projectDir: string
    readonly environmentDir: string
    readonly passEnvironment: readonly string[]
    readonly timeoutGraceSec: number
  }
  readonly maxPending: number
  readonly taskboardAutoRun: boolean
}

export function resolveConfig(config: Config = {}): ResolvedConfig {
  const configuredEngine: unknown = Reflect.get(config, 'engine')
  if (configuredEngine !== undefined && configuredEngine !== 'browser-use') {
    throw new BrowserError('E_BROWSER_INVALID_PROFILE', 'Only browser-use is supported')
  }
  const dataDir = expand(config.dataDir ?? join(homedir(), '.dsh', 'luban', 'browser'))
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const sourceBridge = resolve(moduleDirectory, '..', '..', '..', 'tools', 'browser-bridge')
  const bundledBridge = resolve(moduleDirectory, 'browser-bridge')
  const projectDir = expand(
    config.bridge?.projectDir ?? (existsSync(bundledBridge) ? bundledBridge : sourceBridge),
  )
  const bundledTemplates = resolve(moduleDirectory, 'templates')
  const sourceTemplates = resolve(moduleDirectory, '..', 'templates')
  const builtInTemplates = existsSync(bundledTemplates) ? bundledTemplates : sourceTemplates
  const userTemplates = expand(config.templatesDir ?? join(dataDir, 'templates'))
  const maxSteps = boundedInteger(config.defaults?.maxSteps ?? 30, 'maxSteps', 1, 500)
  const timeoutSec = boundedInteger(config.defaults?.timeoutSec ?? 300, 'timeoutSec', 1, 3600)
  const maxPending = boundedInteger(config.queue?.maxPending ?? 32, 'maxPending', 1, 1000)
  const timeoutGraceSec = boundedInteger(
    config.bridge?.timeoutGraceSec ?? 15,
    'timeoutGraceSec',
    1,
    300,
  )
  const allowDomains = stringArray(config.defaults?.allowDomains ?? [], 'allowDomains')
  const passEnvironment = stringArray(
    config.bridge?.passEnvironment ?? DEFAULT_PASSED_ENVIRONMENT,
    'passEnvironment',
  )
  const profile: ResolvedConfig['profile'] = {
    kernel: config.kernel ?? 'auto',
    ...(config.headless === undefined ? {} : { headless: config.headless }),
    ...(config.userDataDir === undefined ? {} : { userDataDir: expand(config.userDataDir) }),
    ...(config.executablePath === undefined
      ? {}
      : { executablePath: expand(config.executablePath) }),
  }
  return {
    dataDir,
    artifactsDir: join(dataDir, 'artifacts'),
    profilesDir: join(dataDir, 'profiles'),
    templateDirectories: [builtInTemplates, userTemplates],
    profile,
    defaults: { maxSteps, timeoutSec, allowDomains },
    bridge: {
      runner: 'uv',
      python: '3.12',
      projectDir,
      environmentDir: expand(config.bridge?.environmentDir ?? join(dataDir, 'uv-env')),
      passEnvironment,
      timeoutGraceSec,
    },
    maxPending,
    taskboardAutoRun: config.taskboard?.autoRun ?? false,
  }
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BrowserError(
      'E_BROWSER_INVALID_PROFILE',
      `${name} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    )
  }
  return value
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!isStringArray(value) || value.some((item) => item.trim() === '')) {
    throw new BrowserError('E_BROWSER_INVALID_PROFILE', `${name} must contain non-empty strings`)
  }
  return Object.freeze(value.map((item) => item.trim()))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function expand(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}
