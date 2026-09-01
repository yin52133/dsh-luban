import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

export const RELEASE_DIR = dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = resolve(RELEASE_DIR, '..', '..')
export const POLICY_PATH = join(RELEASE_DIR, 'policy.json')
export const PACKAGE_SCOPE = '@yin52133/'
export const PACKAGE_REGISTRY = 'https://npm.pkg.github.com'
export const CORE_PACKAGE_NAME = `${PACKAGE_SCOPE}dsh-luban-core`

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function loadPolicy(path = POLICY_PATH) {
  const policy = await readJson(path)
  if (policy.schemaVersion !== 1)
    throw new Error(`Unsupported release policy schema: ${String(policy.schemaVersion)}`)
  return policy
}

export function isPublishable(manifest) {
  return manifest.private !== true
}

export async function discoverPackages(root = REPOSITORY_ROOT) {
  const packagesRoot = join(root, 'packages')
  const entries = await readdir(packagesRoot, { withFileTypes: true })
  const packages = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(packagesRoot, entry.name)
    try {
      const manifest = await readJson(join(directory, 'package.json'))
      packages.push({ directory, manifest })
    } catch (error) {
      if (error instanceof SyntaxError) throw error
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return packages.sort((left, right) => {
    const leftName = String(left.manifest.name)
    const rightName = String(right.manifest.name)
    if (leftName === CORE_PACKAGE_NAME) return rightName === CORE_PACKAGE_NAME ? 0 : -1
    if (rightName === CORE_PACKAGE_NAME) return 1
    return leftName.localeCompare(rightName)
  })
}

export function pathIsWithin(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'))
}

export function allowedPublishedPath(path, allowlist) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  return allowlist.some((allowed) => {
    const candidate = allowed.replaceAll('\\', '/')
    return candidate.endsWith('/') ? normalized.startsWith(candidate) : normalized === candidate
  })
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

export function npmInvocation(args) {
  if (process.platform !== 'win32') return { command: 'npm', args }

  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(npmCli)) {
    throw new Error(`Unable to locate npm CLI next to Node.js: ${npmCli}`)
  }
  return { command: process.execPath, args: [npmCli, ...args] }
}

export function pnpmInvocation(args) {
  if (process.platform !== 'win32') return { command: 'pnpm', args }
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', 'pnpm', ...args],
  }
}

function tarString(archive, offset, length) {
  const end = archive.indexOf(0, offset)
  const boundedEnd = end < 0 || end > offset + length ? offset + length : end
  return archive.subarray(offset, boundedEnd).toString('utf8').trim()
}

function tarSize(archive, offset) {
  const value = tarString(archive, offset, 12).replace(/\s+$/u, '')
  if (!/^[0-7]+$/u.test(value)) throw new Error('Packed tarball has an invalid entry size')
  const size = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error('Packed tarball entry size is outside the safe integer range')
  }
  return size
}

export function readPackedManifest(tarball) {
  let archive
  try {
    archive = gunzipSync(tarball, { maxOutputLength: 64 * 1024 * 1024 })
  } catch (error) {
    throw new Error('Package artifact is not a bounded gzip tarball', { cause: error })
  }

  let manifest
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const path = prefix === '' ? name : `${prefix}/${name}`
    const size = tarSize(header, 124)
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    if (contentEnd > archive.length) throw new Error('Packed tarball entry exceeds its archive')
    if (path === 'package/package.json') {
      if (manifest !== undefined) throw new Error('Package artifact contains duplicate manifests')
      try {
        manifest = JSON.parse(archive.subarray(contentStart, contentEnd).toString('utf8'))
      } catch (error) {
        throw new Error('Package artifact manifest is invalid JSON', { cause: error })
      }
    }
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  if (manifest === undefined || manifest === null || typeof manifest !== 'object') {
    throw new Error('Package artifact has no package/package.json object')
  }
  return manifest
}

export function packedManifestIssues(record, manifest) {
  const issues = []
  if (manifest.name !== record.name) {
    issues.push(`${record.name}: packed manifest name is ${String(manifest.name)}`)
  }
  if (manifest.version !== record.version) {
    issues.push(`${record.name}: packed manifest version is ${String(manifest.version)}`)
  }
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[section]
    if (dependencies === undefined) continue
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      issues.push(`${record.name}: packed ${section} must be an object`)
      continue
    }
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range !== 'string' || range.trim() === '') {
        issues.push(`${record.name}: packed ${section}.${name} must be a non-empty range`)
      } else if (range.startsWith('workspace:')) {
        issues.push(`${record.name}: packed ${section}.${name} retains ${range}`)
      }
    }
  }
  return issues
}

export function spawnDiagnostic(result) {
  const details = [result.error?.message, result.stderr, result.stdout]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .trim()
  return details || `process exited with status ${String(result.status)}`
}

export function extractChangelogSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const heading = new RegExp(`^## \\[${escaped}\\](?:\\s+-\\s+[^\\n]+)?\\s*$`, 'm')
  const match = heading.exec(changelog)
  if (match === null) throw new Error(`CHANGELOG.md has no section for ${version}`)
  const start = match.index
  const remainder = changelog.slice(start + match[0].length)
  const next = /^## \[/m.exec(remainder)
  const end = next === null ? changelog.length : start + match[0].length + next.index
  return changelog.slice(start, end).trimEnd() + '\n'
}

export function parseCommonArgs(argv) {
  const options = { packages: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === '--root') options.root = value()
    else if (arg === '--package' || arg === '--packages')
      options.packages.push(...value().split(',').filter(Boolean))
    else if (arg === '--json') options.json = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help') options.help = true
    else options.rest = [...(options.rest ?? []), arg]
  }
  return options
}

export function selectPackages(packages, names) {
  if (names.length === 0) return packages
  const selected = new Set(names)
  const result = packages.filter(
    ({ manifest, directory }) =>
      selected.has(manifest.name) || selected.has(directory.split(/[\\/]/).at(-1)),
  )
  const found = new Set(
    result.flatMap(({ manifest, directory }) => [manifest.name, directory.split(/[\\/]/).at(-1)]),
  )
  const missing = names.filter((name) => !found.has(name))
  if (missing.length > 0) throw new Error(`Unknown package selection: ${missing.join(', ')}`)
  return result
}
