#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const LOCK_PATH = resolve(SCRIPT_DIR, 'install-3rd-party.versions.json')
const EXPECTED_PACKAGES = ['dshmarket', 'dsh-better-sidebar', 'dsh-memory']
const PROFILE = /^[a-z0-9][a-z0-9-]*$/
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function parseArgs(argv) {
  const options = { apply: false, version: 'pinned' }
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
    else if (arg === '--apply') options.apply = true
    else if (arg === '--dry-run') options.apply = false
    else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

export async function loadVersionLock(path = LOCK_PATH) {
  const lock = JSON.parse(await readFile(path, 'utf8'))
  if (lock.schemaVersion !== 1 || typeof lock.packages !== 'object' || lock.packages === null) {
    throw new Error('Unsupported third-party version lock')
  }
  const names = Object.keys(lock.packages)
  if (
    names.length !== EXPECTED_PACKAGES.length ||
    EXPECTED_PACKAGES.some((name) => !names.includes(name))
  ) {
    throw new Error(`Version lock must contain exactly: ${EXPECTED_PACKAGES.join(', ')}`)
  }
  for (const [name, version] of Object.entries(lock.packages)) {
    if (!SEMVER.test(version))
      throw new Error(`Invalid locked version for ${name}: ${String(version)}`)
  }
  return lock
}

export function resolvePackageSpecs(lock, versionMode = 'pinned') {
  if (versionMode !== 'pinned' && versionMode !== 'latest' && !SEMVER.test(versionMode)) {
    throw new Error('Version must be pinned, latest, or an explicit semantic version')
  }
  return EXPECTED_PACKAGES.map((name) => {
    const version = versionMode === 'pinned' ? lock.packages[name] : versionMode
    return `${name}@${version}`
  })
}

export function dshInvocation(args, platform = process.platform, comSpec = process.env.ComSpec) {
  if (platform === 'win32') {
    return {
      command: comSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'dsh.cmd', ...args],
    }
  }
  return { command: 'dsh', args }
}

export async function installThirdParty(options = {}) {
  if (!['windows', 'ubuntu'].includes(options.platform))
    throw new Error('Platform must be windows or ubuntu')
  const profile =
    options.profile ?? (options.platform === 'windows' ? 'win-debug' : 'ubuntu-server')
  if (!PROFILE.test(profile)) throw new Error('Profile must match [a-z0-9][a-z0-9-]*')
  const lock = await loadVersionLock(options.lockPath ?? LOCK_PATH)
  const specs = resolvePackageSpecs(lock, options.version ?? 'pinned')
  const args = ['plugin', '--profile', profile, 'add', ...specs]
  const plan = {
    platform: options.platform,
    profile,
    specs,
    command: 'dsh',
    args,
    dryRun: options.apply !== true,
  }
  if (options.apply !== true) return plan

  const invocation = dshInvocation(args)
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: 'inherit',
    windowsHide: true,
    shell: false,
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
      'Usage: node scripts/install-3rd-party.mjs --platform windows|ubuntu [--profile <name>] [--version pinned|latest|<semver>] [--dry-run|--apply]',
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
