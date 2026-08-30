#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  discoverPackages,
  extractChangelogSection,
  isPublishable,
  loadPolicy,
  packedManifestIssues,
  pathIsWithin,
  pnpmInvocation,
  readPackedManifest,
  readJson,
  REPOSITORY_ROOT,
  selectPackages,
  sha256,
  spawnDiagnostic,
} from './lib.mjs'
import { validateRepository } from './validate-release.mjs'

function parseArgs(argv) {
  const options = { packages: [], prepare: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === '--root') options.root = value()
    else if (arg === '--output') options.output = value()
    else if (arg === '--tag') options.tag = value()
    else if (arg === '--package' || arg === '--packages')
      options.packages.push(...value().split(',').filter(Boolean))
    else if (arg === '--prepare') options.prepare = true
    else if (arg === '--dry-run') options.prepare = false
    else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function parsePackOutput(stdout) {
  const starts = [stdout.indexOf('{'), stdout.indexOf('[')].filter((value) => value >= 0)
  if (starts.length === 0) throw new Error(`pnpm pack returned no JSON: ${stdout.trim()}`)
  const parsed = JSON.parse(stdout.slice(Math.min(...starts)))
  return Array.isArray(parsed) ? parsed : [parsed]
}

export function releasePlan(version, tag, packages, policy) {
  if (tag !== `v${version}`) throw new Error(`Release tag ${tag} must exactly match v${version}`)
  return {
    schemaVersion: 1,
    version,
    tag,
    dshEngine: policy.dshEngine,
    testedDshVersion: policy.testedDshVersion,
    packages: packages.map(({ manifest }) => ({ name: manifest.name, version: manifest.version })),
  }
}

export async function packArtifacts(options = {}) {
  const root = resolve(options.root ?? REPOSITORY_ROOT)
  const rootManifest = await readJson(join(root, 'package.json'))
  const tag = options.tag ?? `v${rootManifest.version}`
  const policy = await loadPolicy()
  const packages = selectPackages(
    (await discoverPackages(root)).filter(({ manifest }) => isPublishable(manifest)),
    options.packages ?? [],
  )
  const plan = releasePlan(rootManifest.version, tag, packages, policy)

  const validation = await validateRepository(root, options.packages ?? [])
  if (validation.issues.length > 0)
    throw new Error(
      `Release metadata is invalid:\n${validation.issues.map((issue) => `- ${issue}`).join('\n')}`,
    )
  if (options.prepare !== true) return { ...plan, dryRun: true }

  const output = resolve(root, options.output ?? '.release-artifacts')
  if (!pathIsWithin(root, output) || output === root)
    throw new Error(`Artifact directory must stay inside the repository: ${output}`)
  try {
    const entries = await readdir(output)
    if (entries.length > 0) throw new Error(`Artifact directory must be empty: ${output}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await mkdir(output, { recursive: true })

  const records = []
  for (const { directory, manifest } of packages) {
    const invocation = pnpmInvocation(['pack', '--json', '--pack-destination', output])
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.status !== 0)
      throw new Error(`${manifest.name}: pnpm pack failed: ${spawnDiagnostic(result)}`)
    const packed = parsePackOutput(result.stdout)[0]
    const filename = basename(packed.filename)
    const content = await readFile(join(output, filename))
    const packedIssues = packedManifestIssues(
      { name: manifest.name, version: manifest.version },
      readPackedManifest(content),
    )
    if (packedIssues.length > 0) throw new Error(packedIssues.join('\n'))
    records.push({
      name: manifest.name,
      version: manifest.version,
      file: filename,
      sha256: sha256(content),
    })
  }

  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
  const notes = extractChangelogSection(changelog, rootManifest.version)
  const manifest = { ...plan, dryRun: false, packages: records }
  await writeFile(join(output, 'RELEASE_NOTES.md'), notes, { encoding: 'utf8', flag: 'wx' })
  await writeFile(join(output, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  return { ...manifest, output: relative(root, output).replaceAll('\\', '/') }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/release/pack-artifacts.mjs [--dry-run] [--prepare --output <dir>] [--tag vX.Y.Z] [--package <name>]',
    )
    return
  }
  const result = await packArtifacts(options)
  console.log(JSON.stringify(result, null, 2))
  if (result.dryRun) console.log('Dry run only. Use --prepare to create release tarballs.')
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`pack-artifacts: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
