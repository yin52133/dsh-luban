#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  npmInvocation,
  pathIsWithin,
  readJson,
  REPOSITORY_ROOT,
  sha256,
  spawnDiagnostic,
} from './lib.mjs'
import { auditPackages } from './audit-packages.mjs'
import { validateRepository } from './validate-release.mjs'

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
  if (!pathIsWithin(root, artifacts) || resolve(root) === resolve(artifacts))
    throw new Error('Artifact directory must stay inside the repository')
  const release = await readJson(join(artifacts, 'release-manifest.json'))
  const rootManifest = await readJson(join(root, 'package.json'))
  if (release.schemaVersion !== 1)
    throw new Error(`Unsupported artifact schema: ${String(release.schemaVersion)}`)
  if (release.version !== rootManifest.version || release.tag !== `v${rootManifest.version}`) {
    throw new Error(`Artifact version/tag does not match root ${rootManifest.version}`)
  }
  if (!Array.isArray(release.packages) || release.packages.length === 0)
    throw new Error('Artifact manifest has no packages')
  const names = []
  const files = new Set()
  for (const record of release.packages) {
    if (record === null || typeof record !== 'object')
      throw new Error('Artifact package record must be an object')
    if (typeof record.name !== 'string' || record.name.trim() === '')
      throw new Error('Artifact package name is required')
    if (record.version !== release.version)
      throw new Error(`${record.name}: artifact version is not fixed to ${release.version}`)
    if (
      typeof record.file !== 'string' ||
      basename(record.file) !== record.file ||
      !record.file.endsWith('.tgz')
    ) {
      throw new Error(`${record.name}: artifact file must be a local .tgz basename`)
    }
    if (files.has(record.file)) throw new Error(`Duplicate artifact file: ${record.file}`)
    if (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256))
      throw new Error(`${record.name}: artifact checksum must be a lowercase SHA-256 digest`)
    names.push(record.name)
    files.add(record.file)
    const content = await readFile(resolve(artifacts, record.file))
    if (sha256(content) !== record.sha256)
      throw new Error(`${record.name}: artifact checksum mismatch`)
  }
  if (new Set(names).size !== names.length) throw new Error('Artifact package names must be unique')
  if (expectedPackages !== undefined) {
    const expected = [...expectedPackages].sort()
    const actual = [...names].sort()
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Artifact packages do not match the validated repository: expected ${expected.join(', ')}, got ${actual.join(', ')}`,
      )
    }
  }
  return release
}

function assertPublishAuthority(rootVersion) {
  const expectedRef = `refs/tags/v${rootVersion}`
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('Actual publish is allowed only in GitHub Actions CI')
  if (process.env.GITHUB_REF !== expectedRef)
    throw new Error(`Actual publish requires ${expectedRef}`)
  if (process.env.LUBAN_RELEASE_APPROVED !== 'true')
    throw new Error('Protected release environment approval is missing')
  if (!process.env.NODE_AUTH_TOKEN) throw new Error('NODE_AUTH_TOKEN is required for npm publish')
}

function assertVersionIsUnused(name, version) {
  const invocation = npmInvocation(['view', `${name}@${version}`, 'version', '--json'])
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status === 0) throw new Error(`${name}@${version} already exists on npm`)
  const diagnostic = spawnDiagnostic(result)
  if (!/E404|404 Not Found/i.test(diagnostic))
    throw new Error(`Unable to prove ${name}@${version} is unpublished: ${diagnostic.trim()}`)
}

export async function publishRelease(options = {}) {
  const root = resolve(options.root ?? REPOSITORY_ROOT)
  const metadata = await validateRepository(root)
  if (metadata.issues.length > 0)
    throw new Error(
      `Release metadata is invalid:\n${metadata.issues.map((issue) => `- ${issue}`).join('\n')}`,
    )

  if (options.artifacts === undefined) {
    if (options.publish === true) throw new Error('--artifacts is required with --publish')
    const packAudit = await auditPackages(root)
    if (packAudit.issues.length > 0)
      throw new Error(
        `Package audit failed:\n${packAudit.issues.map((issue) => `- ${issue}`).join('\n')}`,
      )
    return {
      dryRun: true,
      version: metadata.rootVersion,
      packages: packAudit.packages,
      artifacts: 'not supplied',
    }
  }

  const artifacts = resolve(root, options.artifacts)
  const release = await verifyArtifactManifest(root, artifacts, metadata.packages)
  if (options.publish !== true)
    return { dryRun: true, version: release.version, tag: release.tag, packages: release.packages }

  assertPublishAuthority(release.version)
  for (const record of release.packages) assertVersionIsUnused(record.name, record.version)
  for (const record of release.packages) {
    const invocation = npmInvocation([
      'publish',
      join(artifacts, record.file),
      '--access',
      'public',
      '--provenance',
    ])
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'inherit',
      env: process.env,
    })
    if (result.status !== 0)
      throw new Error(
        `npm publish failed for ${record.name}; stop and reconcile the partial release manually`,
      )
  }
  return { dryRun: false, version: release.version, tag: release.tag, packages: release.packages }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/release/publish.mjs [--dry-run] [--artifacts <dir>] [--publish]',
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
