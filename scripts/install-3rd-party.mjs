#!/usr/bin/env node

import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, parse, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const LOCK_PATH = resolve(SCRIPT_DIR, 'install-3rd-party.versions.json')
const REGISTRY = 'https://registry.npmjs.org/'
const EXPECTED_IDENTITIES = Object.freeze([
  Object.freeze({
    name: 'dshmarket',
    repository: 'git+https://github.com/dsh-market/dsh-market.git',
  }),
  Object.freeze({
    name: 'dsh-better-sidebar',
    repository: 'https://github.com/omdsh-dev/DSH-better-sidebar',
  }),
  Object.freeze({
    name: '@furongjun1999/dsh-memory',
    repository: 'git+https://github.com/FuRongJun-1999/dsh-memory.git',
  }),
])
const LOCK_KEYS = ['packages', 'registry', 'schemaVersion', 'verifiedAt']
const PACKAGE_KEYS = ['integrity', 'license', 'name', 'repository', 'version']
const PROFILE = /^[a-z0-9][a-z0-9-]*$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const INTEGRITY = /^sha512-([A-Za-z0-9+/]+={0,2})$/
const MAX_REGISTRY_METADATA_BYTES = 1_000_000

function parseArgs(argv) {
  const options = { apply: false, version: 'pinned' }
  let explicitApply = false
  let explicitDryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === '--platform') options.platform = value()
    else if (arg === '--profile') options.profile = value()
    else if (arg === '--version') options.version = value()
    else if (arg === '--dsh-home') options.dshHome = value()
    else if (arg === '--approved-by') options.approvedBy = value()
    else if (arg === '--approve-unpinned') options.approveUnpinned = true
    else if (arg === '--apply') {
      explicitApply = true
      options.apply = true
    } else if (arg === '--dry-run') {
      explicitDryRun = true
      options.apply = false
    } else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (explicitApply && explicitDryRun) {
    throw new Error('--apply and --dry-run are mutually exclusive')
  }
  return options
}

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
  )
}

function validIntegrity(value) {
  if (typeof value !== 'string') return false
  const match = INTEGRITY.exec(value)
  if (match === null) return false
  try {
    return Buffer.from(match[1], 'base64').byteLength === 64
  } catch {
    return false
  }
}

export async function loadVersionLock(path = LOCK_PATH) {
  const lock = JSON.parse(await readFile(path, 'utf8'))
  if (!exactKeys(lock, LOCK_KEYS) || lock.schemaVersion !== 2 || !Array.isArray(lock.packages)) {
    throw new Error('Unsupported third-party version lock')
  }
  if (lock.registry !== REGISTRY) {
    throw new Error(`Version lock registry must be ${REGISTRY}`)
  }
  if (typeof lock.verifiedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lock.verifiedAt)) {
    throw new Error('Version lock verifiedAt must use YYYY-MM-DD')
  }
  if (lock.packages.length !== EXPECTED_IDENTITIES.length) {
    throw new Error(`Version lock must contain exactly ${EXPECTED_IDENTITIES.length} packages`)
  }
  for (let index = 0; index < EXPECTED_IDENTITIES.length; index += 1) {
    const record = lock.packages[index]
    const expected = EXPECTED_IDENTITIES[index]
    if (!exactKeys(record, PACKAGE_KEYS)) {
      throw new Error(`Version lock package ${index + 1} has unsupported fields`)
    }
    if (record.name !== expected.name || record.repository !== expected.repository) {
      throw new Error(`Version lock package identity mismatch at position ${index + 1}`)
    }
    if (!SEMVER.test(record.version)) {
      throw new Error(`Invalid locked version for ${record.name}: ${String(record.version)}`)
    }
    if (!validIntegrity(record.integrity)) {
      throw new Error(`Invalid locked integrity for ${record.name}`)
    }
    if (record.license !== 'MIT') {
      throw new Error(`Locked license for ${record.name} must be MIT`)
    }
  }
  return lock
}

export function resolvePackageSpecs(lock, versionMode = 'pinned') {
  if (versionMode !== 'pinned' && versionMode !== 'latest' && !SEMVER.test(versionMode)) {
    throw new Error('Version must be pinned, latest, or an explicit semantic version')
  }
  return lock.packages.map((record) => {
    const version = versionMode === 'pinned' ? record.version : versionMode
    return `${record.name}@${version}`
  })
}

function repositoryUrl(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.url === 'string') {
    return value.url
  }
  return undefined
}

function registryMetadataUrl(name, version) {
  return new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, REGISTRY).href
}

async function fetchRegistryMetadata(fetcher, record, requestedVersion) {
  const url = registryMetadataUrl(record.name, requestedVersion)
  let response
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: globalThis.AbortSignal?.timeout?.(15_000),
    })
  } catch (error) {
    throw new Error(
      `Unable to verify registry metadata for ${record.name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (response === null || typeof response !== 'object' || response.ok !== true) {
    throw new Error(
      `Unable to verify registry metadata for ${record.name}: HTTP ${String(response?.status ?? 'unknown')}`,
    )
  }
  const contentLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_REGISTRY_METADATA_BYTES) {
    throw new Error(`Registry metadata for ${record.name} exceeds the size limit`)
  }
  const body = await response.text()
  if (Buffer.byteLength(body, 'utf8') > MAX_REGISTRY_METADATA_BYTES) {
    throw new Error(`Registry metadata for ${record.name} exceeds the size limit`)
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`Registry returned invalid JSON metadata for ${record.name}`)
  }
}

export async function verifyRegistryPackages(
  lock,
  versionMode = 'pinned',
  fetcher = globalThis.fetch,
) {
  if (versionMode !== 'pinned' && versionMode !== 'latest' && !SEMVER.test(versionMode)) {
    throw new Error('Version must be pinned, latest, or an explicit semantic version')
  }
  if (typeof fetcher !== 'function') throw new Error('A registry fetch implementation is required')
  const verified = []
  for (const record of lock.packages) {
    const requestedVersion = versionMode === 'pinned' ? record.version : versionMode
    const metadata = await fetchRegistryMetadata(fetcher, record, requestedVersion)
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Error(`Registry metadata for ${record.name} must be an object`)
    }
    if (metadata.name !== record.name) {
      throw new Error(`Registry package name mismatch for ${record.name}`)
    }
    if (!SEMVER.test(metadata.version)) {
      throw new Error(`Registry version is invalid for ${record.name}`)
    }
    if (requestedVersion !== 'latest' && metadata.version !== requestedVersion) {
      throw new Error(`Registry version mismatch for ${record.name}`)
    }
    if (metadata.license !== record.license) {
      throw new Error(`Registry license mismatch for ${record.name}`)
    }
    const repository = repositoryUrl(metadata.repository)
    if (repository !== record.repository) {
      throw new Error(`Registry repository mismatch for ${record.name}`)
    }
    const integrity = metadata.dist?.integrity
    if (!validIntegrity(integrity)) {
      throw new Error(`Registry integrity is invalid for ${record.name}`)
    }
    if (versionMode === 'pinned' && integrity !== record.integrity) {
      throw new Error(`Registry integrity mismatch for ${record.name}`)
    }
    verified.push({
      name: record.name,
      version: metadata.version,
      integrity,
      license: record.license,
      repository: record.repository,
    })
  }
  return verified
}

export function dshInvocation(args, targetPlatform, comSpec = process.env.ComSpec) {
  if (targetPlatform === 'windows') {
    return {
      command: comSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'dsh.cmd', ...args],
    }
  }
  if (targetPlatform === 'ubuntu') return { command: 'dsh', args }
  throw new Error('Platform must be windows or ubuntu')
}

export function canonicalDshHome(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--dsh-home must be a non-empty absolute path')
  }
  if (!isAbsolute(value)) throw new Error('--dsh-home must be an absolute path')
  const canonical = resolve(value)
  if (canonical === parse(canonical).root) throw new Error('--dsh-home cannot be a filesystem root')
  return canonical
}

function approvalActor(value, required) {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--approved-by is required with --apply')
  }
  const actor = value.trim()
  const hasControlCharacter = [...actor].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
  if (actor.length > 128 || hasControlCharacter) {
    throw new Error('--approved-by must be a printable value of at most 128 characters')
  }
  return actor
}

function assertTargetHost(targetPlatform, runtimePlatform = process.platform) {
  const expected = targetPlatform === 'windows' ? 'win32' : 'linux'
  if (runtimePlatform !== expected) {
    throw new Error(
      `Refusing ${targetPlatform} installation from ${runtimePlatform}; run it on the target host`,
    )
  }
}

export async function installThirdParty(options = {}) {
  if (!['windows', 'ubuntu'].includes(options.platform))
    throw new Error('Platform must be windows or ubuntu')
  const profile =
    options.profile ?? (options.platform === 'windows' ? 'win-debug' : 'ubuntu-server')
  if (!PROFILE.test(profile)) throw new Error('Profile must match [a-z0-9][a-z0-9-]*')
  const lock = await loadVersionLock(options.lockPath ?? LOCK_PATH)
  const versionMode = options.version ?? 'pinned'
  const requestedSpecs = resolvePackageSpecs(lock, versionMode)
  const requestedArgs = ['plugin', '--profile', profile, 'add', ...requestedSpecs]
  const dshHome = options.dshHome === undefined ? undefined : canonicalDshHome(options.dshHome)
  const approvedBy = approvalActor(options.approvedBy, options.apply === true)
  const dryRunPlan = {
    platform: options.platform,
    profile,
    registry: lock.registry,
    packages: lock.packages,
    specs: requestedSpecs,
    command: 'dsh',
    args: requestedArgs,
    invocation: dshInvocation(requestedArgs, options.platform, options.comSpec),
    dshHome,
    approvedBy,
    approveUnpinned: options.approveUnpinned === true,
    supplyChain: {
      mode: versionMode === 'pinned' ? 'pinned' : 'unpinned-request',
      verified: false,
      reason: 'dry-run does not access the registry',
    },
    dryRun: options.apply !== true,
  }
  if (options.apply !== true) return dryRunPlan

  if (dshHome === undefined) throw new Error('--dsh-home is required with --apply')
  assertTargetHost(options.platform)
  if (versionMode !== 'pinned' && options.approveUnpinned !== true) {
    throw new Error('--approve-unpinned is required to apply latest or an explicit version')
  }
  const packages = await verifyRegistryPackages(lock, versionMode, options.fetcher)
  const specs = packages.map((record) => `${record.name}@${record.version}`)
  const args = ['plugin', '--profile', profile, 'add', ...specs]
  const invocation = dshInvocation(args, options.platform, options.comSpec)
  const plan = {
    ...dryRunPlan,
    packages,
    specs,
    args,
    invocation,
    supplyChain: {
      mode: versionMode === 'pinned' ? 'pinned' : 'registry-resolved',
      verified: true,
    },
  }
  const runner = options.runner ?? spawnSync
  const result = runner(invocation.command, invocation.args, {
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
    env: { ...process.env, DSH_HOME: dshHome, npm_config_registry: lock.registry },
  })
  if (result.error?.code === 'ENOENT') throw new Error('dsh executable was not found on PATH')
  if (result.status !== 0)
    throw new Error(`dsh plugin add failed with exit code ${String(result.status)}`)
  return { ...plan, dryRun: false }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/install-3rd-party.mjs --platform windows|ubuntu [--profile <name>] [--version pinned|latest|<semver>] [--dsh-home <absolute-path>] [--approved-by <actor>] [--approve-unpinned] [--dry-run|--apply]',
    )
    return
  }
  console.log(JSON.stringify(await installThirdParty(options), null, 2))
  if (options.apply !== true)
    console.log('Dry run only. Use --apply to install the packages into the profile.')
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`install-3rd-party: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
