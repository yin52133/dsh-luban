import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELEASE_DIR = dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = resolve(RELEASE_DIR, '..', '..')
export const POLICY_PATH = join(RELEASE_DIR, 'policy.json')

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
  return packages.sort((left, right) =>
    String(left.manifest.name).localeCompare(String(right.manifest.name)),
  )
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
