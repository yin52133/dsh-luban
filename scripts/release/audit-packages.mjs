#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  allowedPublishedPath,
  discoverPackages,
  isPublishable,
  loadPolicy,
  parseCommonArgs,
  pnpmInvocation,
  REPOSITORY_ROOT,
  selectPackages,
  spawnDiagnostic,
} from './lib.mjs'

function exportedRuntimePaths(manifest) {
  const paths = new Set()
  if (typeof manifest.main === 'string') paths.add(manifest.main.replace(/^\.\//, ''))
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === 'string') {
      if (value.endsWith('.js')) paths.add(value.replace(/^\.\//, ''))
    } else if (value !== null && typeof value === 'object' && typeof value.default === 'string') {
      paths.add(value.default.replace(/^\.\//, ''))
    }
  }
  return paths
}

export function auditPackedFiles(manifest, packedPaths, policy) {
  const issues = []
  const normalized = packedPaths.map((path) => path.replaceAll('\\', '/').replace(/^package\//, ''))
  for (const path of normalized) {
    if (!allowedPublishedPath(path, policy.packAllowlist))
      issues.push(`${manifest.name}: packed disallowed path ${path}`)
  }
  for (const required of exportedRuntimePaths(manifest)) {
    if (!normalized.includes(required))
      issues.push(`${manifest.name}: packed payload is missing runtime export ${required}`)
  }
  if (manifest.dsh?.client !== undefined) {
    const value = manifest.exports?.['./client']
    const clientPath = (typeof value === 'string' ? value : value?.default)?.replace(/^\.\//, '')
    if (clientPath !== undefined && !normalized.includes(clientPath))
      issues.push(`${manifest.name}: packed payload is missing client bundle ${clientPath}`)
  }
  return issues
}

function parsePackOutput(stdout) {
  const starts = [stdout.indexOf('{'), stdout.indexOf('[')].filter((value) => value >= 0)
  if (starts.length === 0) throw new Error(`pnpm pack returned no JSON: ${stdout.trim()}`)
  const parsed = JSON.parse(stdout.slice(Math.min(...starts)))
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function assertLazyClient(directory, manifest) {
  if (manifest.dsh?.client === undefined) return []
  const value = manifest.exports?.['./client']
  const clientPath = (typeof value === 'string' ? value : value?.default)?.replace(/^\.\//, '')
  if (clientPath === undefined) return [`${manifest.name}: client export has no default path`]
  try {
    const bundle = await readFile(join(directory, clientPath), 'utf8')
    const expectedId = JSON.stringify(manifest.name)
    if (
      !bundle.includes('window.__ModuleLoader__.load') ||
      !bundle.includes(`id: ${expectedId}`) ||
      !bundle.includes('factory:')
    ) {
      return [`${manifest.name}: ${clientPath} is not a DSH lazy-CJS loader registration`]
    }
    return []
  } catch (error) {
    if (error?.code === 'ENOENT')
      return [`${manifest.name}: client artifact does not exist: ${clientPath}`]
    throw error
  }
}

export async function auditPackages(
  root = REPOSITORY_ROOT,
  packageSelection = [],
  staticOnly = false,
) {
  const policy = await loadPolicy()
  const packages = selectPackages(
    (await discoverPackages(root)).filter(({ manifest }) => isPublishable(manifest)),
    packageSelection,
  )
  const issues = []
  for (const { directory, manifest } of packages) {
    if (!Array.isArray(manifest.files)) {
      issues.push(`${manifest.name}: files allowlist is missing`)
      continue
    }
    for (const path of manifest.files) {
      if (!policy.packageFiles.includes(path))
        issues.push(`${manifest.name}: manifest files contains disallowed entry ${String(path)}`)
    }
    if (staticOnly) continue

    const invocation = pnpmInvocation(['pack', '--dry-run', '--json'])
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.status !== 0) {
      issues.push(`${manifest.name}: pnpm pack --dry-run failed: ${spawnDiagnostic(result)}`)
      continue
    }
    const records = parsePackOutput(result.stdout)
    const files = records[0]?.files?.map((file) => file.path) ?? []
    issues.push(...auditPackedFiles(manifest, files, policy))
    issues.push(...(await assertLazyClient(directory, manifest)))
  }
  return { packages: packages.map((item) => item.manifest.name), issues }
}

async function main() {
  const options = parseCommonArgs(process.argv.slice(2))
  const staticOnlyIndex = (options.rest ?? []).indexOf('--static-only')
  const staticOnly = staticOnlyIndex >= 0
  const unknown = (options.rest ?? []).filter((arg) => arg !== '--static-only')
  if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`)
  const result = await auditPackages(
    resolve(options.root ?? REPOSITORY_ROOT),
    options.packages,
    staticOnly,
  )
  if (options.json === true) console.log(JSON.stringify(result, null, 2))
  else if (result.issues.length === 0)
    console.log(`Package dry-run audit passed: ${result.packages.length} packages.`)
  else for (const issue of result.issues) console.error(`- ${issue}`)
  if (result.issues.length > 0) process.exitCode = 1
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`audit-packages: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
