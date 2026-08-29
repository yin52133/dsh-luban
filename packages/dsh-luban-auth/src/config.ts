import { homedir, hostname, networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import type { LubanAuthConfig } from './types.js'

export type Config = LubanAuthConfig

const DEFAULT_CONFIG: LubanAuthConfig = Object.freeze({
  host: '0.0.0.0',
  port: 42_600,
  upstream: 'http://127.0.0.1:3080',
  sessionTtlHours: 72,
  maxFailures: 5,
  lockoutMinutes: 15,
  loginRateLimitPerMinute: 10,
  usersFile: '~/.dsh/luban/auth/users.json',
  auditDirectory: '~/.dsh/luban/logs/auth',
  trustedHosts: [],
  allowedNetworks: [],
  trustProxy: false,
  trustedProxyNetworks: ['127.0.0.1/32', '::1/128'],
  secureCookies: 'auto',
  maxAuthBodyBytes: 64 * 1024,
  maxProxyBodyBytes: 64 * 1024 * 1024,
  bootstrapAdminUser: 'admin',
  bootstrapAdminPasswordEnv: 'LUBAN_ADMIN_PASSWORD',
})

export interface StandardSchemaIssue {
  readonly message: string
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[]
}

export interface StandardConfigSchema {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: 'dsh-luban-auth'
    readonly validate: (
      value: unknown,
    ) => { readonly value: LubanAuthConfig } | { readonly issues: readonly StandardSchemaIssue[] }
  }
}

/** Cordis-compatible Standard Schema v1 config with strict defaults and bounds. */
export const Config: StandardConfigSchema = Object.freeze({
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-luban-auth' as const,
    validate(value: unknown) {
      try {
        return { value: resolveAuthConfig(value) }
      } catch (error: unknown) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
})

export function resolveAuthConfig(value: unknown): LubanAuthConfig {
  const input = value === undefined || value === null ? {} : expectConfigRecord(value)
  assertKnownKeys(input)
  return {
    host: optionalEnum(input, 'host', ['127.0.0.1', '0.0.0.0'], DEFAULT_CONFIG.host),
    port: optionalInteger(input, 'port', 0, 65_535, DEFAULT_CONFIG.port),
    upstream: optionalString(input, 'upstream', DEFAULT_CONFIG.upstream),
    sessionTtlHours: optionalNumber(
      input,
      'sessionTtlHours',
      1,
      24 * 365,
      DEFAULT_CONFIG.sessionTtlHours,
    ),
    maxFailures: optionalInteger(input, 'maxFailures', 1, 100, DEFAULT_CONFIG.maxFailures),
    lockoutMinutes: optionalNumber(
      input,
      'lockoutMinutes',
      1,
      24 * 60,
      DEFAULT_CONFIG.lockoutMinutes,
    ),
    loginRateLimitPerMinute: optionalInteger(
      input,
      'loginRateLimitPerMinute',
      1,
      10,
      DEFAULT_CONFIG.loginRateLimitPerMinute,
    ),
    usersFile: optionalString(input, 'usersFile', DEFAULT_CONFIG.usersFile),
    auditDirectory: optionalString(input, 'auditDirectory', DEFAULT_CONFIG.auditDirectory),
    trustedHosts: optionalStringArray(input, 'trustedHosts', DEFAULT_CONFIG.trustedHosts),
    allowedNetworks: optionalStringArray(input, 'allowedNetworks', DEFAULT_CONFIG.allowedNetworks),
    trustProxy: optionalBoolean(input, 'trustProxy', DEFAULT_CONFIG.trustProxy),
    trustedProxyNetworks: optionalStringArray(
      input,
      'trustedProxyNetworks',
      DEFAULT_CONFIG.trustedProxyNetworks,
    ),
    secureCookies: optionalEnum(
      input,
      'secureCookies',
      ['auto', 'always', 'never'],
      DEFAULT_CONFIG.secureCookies,
    ),
    maxAuthBodyBytes: optionalInteger(
      input,
      'maxAuthBodyBytes',
      1_024,
      1024 * 1024,
      DEFAULT_CONFIG.maxAuthBodyBytes,
    ),
    maxProxyBodyBytes: optionalInteger(
      input,
      'maxProxyBodyBytes',
      1024 * 1024,
      1024 * 1024 * 1024,
      DEFAULT_CONFIG.maxProxyBodyBytes,
    ),
    bootstrapAdminUser: optionalString(
      input,
      'bootstrapAdminUser',
      DEFAULT_CONFIG.bootstrapAdminUser,
    ),
    bootstrapAdminPasswordEnv: optionalString(
      input,
      'bootstrapAdminPasswordEnv',
      DEFAULT_CONFIG.bootstrapAdminPasswordEnv,
    ),
  }
}

export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return resolve(homedir(), path.slice(2))
  }
  return resolve(path)
}

export function parseUpstream(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('luban-auth: upstream must use http or https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('luban-auth: upstream must not contain credentials')
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new TypeError('luban-auth: upstream must resolve through a loopback hostname')
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new TypeError('luban-auth: upstream must be an origin URL without a path or query')
  }
  return url
}

export function localHostnames(extra: readonly string[]): ReadonlySet<string> {
  const values = new Set<string>(['localhost', '127.0.0.1', '::1', hostname().toLowerCase()])
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const item of interfaces ?? []) values.add(item.address.toLowerCase())
  }
  for (const value of extra) values.add(normalizeConfiguredHost(value))
  return values
}

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'host',
  'port',
  'upstream',
  'sessionTtlHours',
  'maxFailures',
  'lockoutMinutes',
  'loginRateLimitPerMinute',
  'usersFile',
  'auditDirectory',
  'trustedHosts',
  'allowedNetworks',
  'trustProxy',
  'trustedProxyNetworks',
  'secureCookies',
  'maxAuthBodyBytes',
  'maxProxyBodyBytes',
  'bootstrapAdminUser',
  'bootstrapAdminPasswordEnv',
])

function expectConfigRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('luban-auth: config must be an object')
  }
  return value as Record<string, unknown>
}

function assertKnownKeys(input: Record<string, unknown>): void {
  const unknown = Object.keys(input).find((key) => !CONFIG_KEYS.has(key))
  if (unknown !== undefined) throw new TypeError(`luban-auth: unknown config field ${unknown}`)
}

function optionalString(input: Record<string, unknown>, key: string, fallback: string): string {
  const value = input[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`luban-auth: ${key} must be a non-empty string`)
  }
  return value
}

function optionalStringArray(
  input: Record<string, unknown>,
  key: string,
  fallback: readonly string[],
): readonly string[] {
  const value = input[key]
  if (value === undefined || value === null) return fallback
  if (!Array.isArray(value)) {
    throw new TypeError(`luban-auth: ${key} must be an array of non-empty strings`)
  }
  const result: string[] = []
  for (const item of value as unknown[]) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new TypeError(`luban-auth: ${key} must be an array of non-empty strings`)
    }
    result.push(item)
  }
  return result
}

function optionalBoolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`luban-auth: ${key} must be a boolean`)
  return value
}

function optionalNumber(
  input: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const value = input[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `luban-auth: ${key} must be between ${String(minimum)} and ${String(maximum)}`,
    )
  }
  return value
}

function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const value = optionalNumber(input, key, minimum, maximum, fallback)
  if (!Number.isSafeInteger(value)) throw new TypeError(`luban-auth: ${key} must be an integer`)
  return value
}

function optionalEnum<const Value extends string>(
  input: Record<string, unknown>,
  key: string,
  values: readonly Value[],
  fallback: Value,
): Value {
  const value = input[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !values.includes(value as Value)) {
    throw new TypeError(`luban-auth: ${key} must be one of ${values.join(', ')}`)
  }
  return value as Value
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function normalizeConfiguredHost(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') throw new TypeError('luban-auth: trustedHosts cannot contain an empty host')
  try {
    return new URL(`http://${trimmed}`).hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  } catch (error: unknown) {
    throw new TypeError(`luban-auth: invalid trusted host ${JSON.stringify(value)}`, {
      cause: error,
    })
  }
}
