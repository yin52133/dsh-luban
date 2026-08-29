import { hostname } from 'node:os'
import { asHostId, type HostId } from '@luban/core'

export interface PeerConfig {
  readonly name: string
  readonly baseUrl: string
  /** Name of an environment variable containing the complete M01 Cookie header. */
  readonly credentialEnv: string
}

export interface Config {
  readonly host: string
  readonly ownerUser: string
  readonly takeoverTimeoutSec: number
  readonly peerRefreshSec: number
  readonly requestTimeoutSec: number
  readonly replayLimit: number
  readonly peers: readonly PeerConfig[]
}

const DEFAULT_CONFIG: Config = Object.freeze({
  host: 'auto',
  ownerUser: 'owner',
  takeoverTimeoutSec: 120,
  peerRefreshSec: 10,
  requestTimeoutSec: 10,
  replayLimit: 256,
  peers: [],
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

function record(input: unknown): Readonly<Record<string, unknown>> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Readonly<Record<string, unknown>>)
    : {}
}

function nonEmptyString(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (value === undefined) return fallback
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${label} must be an integer from ${String(minimum)} to ${String(maximum)}`)
  }
  return value
}

function peerConfig(value: unknown, index: number): PeerConfig {
  const row = record(value)
  const label = `peers[${String(index)}]`
  const name = nonEmptyString(row.name, '', `${label}.name`)
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(name)) {
    throw new TypeError(`${label}.name must contain only lowercase host-safe characters`)
  }
  const rawBaseUrl = nonEmptyString(row.baseUrl, '', `${label}.baseUrl`)
  let parsed: URL
  try {
    parsed = new URL(rawBaseUrl)
  } catch {
    throw new TypeError(`${label}.baseUrl must be an absolute URL`)
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError(`${label}.baseUrl must be an HTTP(S) URL without credentials or query data`)
  }
  const credentialEnv = nonEmptyString(row.credentialEnv, '', `${label}.credentialEnv`)
  if (!/^[A-Z][A-Z0-9_]{2,127}$/u.test(credentialEnv)) {
    throw new TypeError(`${label}.credentialEnv must be an uppercase environment variable name`)
  }
  return {
    name,
    baseUrl: parsed.href.replace(/\/$/u, ''),
    credentialEnv,
  }
}

export function parseConfig(input: unknown): Config {
  const root = record(input)
  const peers = root.peers ?? DEFAULT_CONFIG.peers
  if (!Array.isArray(peers)) throw new TypeError('peers must be an array')
  const parsedPeers = peers.map(peerConfig)
  const peerNames = new Set(parsedPeers.map((peer): string => peer.name))
  if (peerNames.size !== parsedPeers.length) throw new TypeError('peer names must be unique')
  const ownerUser = nonEmptyString(root.ownerUser, DEFAULT_CONFIG.ownerUser, 'ownerUser')
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(ownerUser)) {
    throw new TypeError(
      'ownerUser must match an M01 username: 3-64 lowercase letters, digits, dot, dash, or underscore',
    )
  }

  return {
    host: nonEmptyString(root.host, DEFAULT_CONFIG.host, 'host'),
    ownerUser,
    takeoverTimeoutSec: boundedInteger(
      root.takeoverTimeoutSec,
      DEFAULT_CONFIG.takeoverTimeoutSec,
      5,
      3_600,
      'takeoverTimeoutSec',
    ),
    peerRefreshSec: boundedInteger(
      root.peerRefreshSec,
      DEFAULT_CONFIG.peerRefreshSec,
      2,
      300,
      'peerRefreshSec',
    ),
    requestTimeoutSec: boundedInteger(
      root.requestTimeoutSec,
      DEFAULT_CONFIG.requestTimeoutSec,
      1,
      60,
      'requestTimeoutSec',
    ),
    replayLimit: boundedInteger(
      root.replayLimit,
      DEFAULT_CONFIG.replayLimit,
      16,
      4_096,
      'replayLimit',
    ),
    peers: parsedPeers,
  }
}

export function resolveHostId(configured: string): HostId {
  const raw = configured === 'auto' ? hostname() : configured
  const normalized = raw
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80)
  if (normalized === '') throw new TypeError('host does not contain a usable identifier')
  return asHostId(normalized)
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
