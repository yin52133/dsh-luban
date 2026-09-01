#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  npmInvocation,
  packedManifestIssues,
  pathIsWithin,
  readJson,
  readPackedManifest,
  REPOSITORY_ROOT,
  sha256,
  spawnDiagnostic,
} from './lib.mjs'
import { auditPackages } from './audit-packages.mjs'
import { validateRepository } from './validate-release.mjs'

const NPM_REGISTRY = 'https://registry.npmjs.org/'

function parseArgs(argv) {
  const options = { publish: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === '--root') options.root = value()
    else if (arg === '--artifacts') options.artifacts = value()
    else if (arg === '--publish') options.publish = true
    else if (arg === '--dry-run') options.publish = false
    else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

export async function verifyArtifactManifest(root, artifacts, expectedPackages) {
  if (!pathIsWithin(root, artifacts) || resolve(root) === resolve(artifacts)) {
    throw new Error('Artifact directory must stay inside the repository')
  }
  const release = await readJson(join(artifacts, 'release-manifest.json'))
  const rootManifest = await readJson(join(root, 'package.json'))
  if (release.schemaVersion !== 1) {
    throw new Error(`Unsupported artifact schema: ${String(release.schemaVersion)}`)
  }
  if (release.version !== rootManifest.version || release.tag !== `v${rootManifest.version}`) {
    throw new Error(`Artifact version/tag does not match root ${rootManifest.version}`)
  }
  if (!Array.isArray(release.packages) || release.packages.length === 0) {
    throw new Error('Artifact manifest has no packages')
  }

  const records = new Map()
  const files = new Set()
  for (const record of release.packages) {
    if (record === null || typeof record !== 'object') {
      throw new Error('Artifact package record must be an object')
    }
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      throw new Error('Artifact package name is required')
    }
    if (records.has(record.name)) throw new Error('Artifact package names must be unique')
    if (record.version !== release.version) {
      throw new Error(`${record.name}: artifact version is not fixed to ${release.version}`)
    }
    if (
      typeof record.file !== 'string' ||
      basename(record.file) !== record.file ||
      !record.file.endsWith('.tgz')
    ) {
      throw new Error(`${record.name}: artifact file must be a local .tgz basename`)
    }
    if (files.has(record.file)) throw new Error(`Duplicate artifact file: ${record.file}`)
    if (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
      throw new Error(`${record.name}: artifact checksum must be a lowercase SHA-256 digest`)
    }

    const content = await readFile(join(artifacts, record.file))
    if (sha256(content) !== record.sha256) {
      throw new Error(`${record.name}: artifact checksum mismatch`)
    }
    const packedManifest = readPackedManifest(content)
    const issues = packedManifestIssues(record, packedManifest)
    if (packedManifest.publishConfig !== undefined) {
      if (
        packedManifest.publishConfig === null ||
        typeof packedManifest.publishConfig !== 'object' ||
        Array.isArray(packedManifest.publishConfig) ||
        packedManifest.publishConfig.access !== 'public'
      ) {
        issues.push(`${record.name}: packed publishConfig.access must be public`)
      }
    }
    if (issues.length > 0) throw new Error(issues.join('\n'))
    files.add(record.file)
    records.set(record.name, record)
  }

  const order = expectedPackages ?? [...records.keys()]
  if (
    expectedPackages !== undefined &&
    (records.size !== expectedPackages.length ||
      expectedPackages.some((name) => !records.has(name)))
  ) {
    throw new Error(
      `Artifact packages do not match the validated repository: expected ${expectedPackages.join(', ')}, got ${[...records.keys()].join(', ')}`,
    )
  }
  return { ...release, packages: order.map((name) => records.get(name)) }
}

function runNpm(args, options = {}) {
  const invocation = npmInvocation([...args, '--registry', NPM_REGISTRY])
  return spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.inherit === true ? 'inherit' : 'pipe',
    timeout: 10 * 60_000,
  })
}

function publishedVersion(name, version) {
  const result = runNpm(['view', `${name}@${version}`, 'version', '--json'])
  if (result.status !== 0) return undefined
  try {
    const value = JSON.parse(result.stdout)
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function publishPackage(artifacts, record) {
  const result = runNpm(['publish', join(artifacts, record.file), '--access', 'public'], {
    cwd: artifacts,
    inherit: true,
  })
  if (result.status !== 0) {
    throw new Error(`${record.name}: npm publish failed: ${spawnDiagnostic(result)}`)
  }
}

export async function publishRelease(options = {}) {
  const root = resolve(options.root ?? REPOSITORY_ROOT)
  const metadata = await validateRepository(root)
  if (metadata.issues.length > 0) {
    throw new Error(
      `Release metadata is invalid:\n${metadata.issues.map((issue) => `- ${issue}`).join('\n')}`,
    )
  }
  if (options.artifacts === undefined) {
    if (options.publish === true) throw new Error('--artifacts is required with --publish')
    const audit = await auditPackages(root)
    if (audit.issues.length > 0) {
      throw new Error(
        `Package audit failed:\n${audit.issues.map((issue) => `- ${issue}`).join('\n')}`,
      )
    }
    return { dryRun: true, version: metadata.rootVersion, packages: audit.packages }
  }

  const artifacts = resolve(root, options.artifacts)
  const release = await verifyArtifactManifest(root, artifacts, metadata.packages)
  if (options.publish !== true) return { ...release, dryRun: true }
  if (process.env.LUBAN_RELEASE_APPROVED !== 'true') {
    throw new Error('Set LUBAN_RELEASE_APPROVED=true after reviewing the release artifacts')
  }

  const published = []
  const skipped = []
  for (const record of release.packages) {
    if (publishedVersion(record.name, record.version) === record.version) {
      skipped.push(record.name)
      continue
    }
    publishPackage(artifacts, record)
    if (publishedVersion(record.name, record.version) !== record.version) {
      throw new Error(`${record.name}: npm did not expose ${record.version} after publish`)
    }
    published.push(record.name)
  }
  return { dryRun: false, version: release.version, tag: release.tag, published, skipped }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/release/publish.mjs [--dry-run | --publish] [--artifacts <dir>]',
    )
    return
  }
  console.log(JSON.stringify(await publishRelease(options), null, 2))
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`publish: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
