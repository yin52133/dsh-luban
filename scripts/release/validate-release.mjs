#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  discoverPackages,
  isPublishable,
  loadPolicy,
  parseCommonArgs,
  readJson,
  REPOSITORY_ROOT,
  selectPackages,
} from './lib.mjs'

const PLUGIN_README_SECTIONS = [
  ['features', /^## (?:功能亮点|Features?)(?:\s|$)/im],
  ['install', /^## (?:安装|Install(?:ation)?)(?:\s|$)/im],
  ['configuration', /^## (?:配置|Configuration)(?:\s|$)/im],
  ['demo', /^## (?:截图|演示|Demo|Screenshots?)(?:\s|$)/im],
  ['compatibility', /^## (?:兼容性|Compatibility)(?:\s|$)/im],
  ['platform', /^## (?:平台支持|Platform Support)(?:\s|$)/im],
  ['license', /^## (?:License|许可|License 与致谢)(?:\s|$)/im],
]

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function hasString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function parseSemver(value) {
  if (typeof value !== 'string') return undefined
  const match = SEMVER.exec(value)
  if (match === null) return undefined
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && /^0\d/.test(identifier))) {
    return undefined
  }
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  }
}

function compareSemver(left, right) {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue
    const leftIsNumeric = /^\d+$/.test(leftIdentifier)
    const rightIsNumeric = /^\d+$/.test(rightIdentifier)
    if (leftIsNumeric && rightIsNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1
    }
    if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function parseMinimumRange(value) {
  if (typeof value !== 'string' || !value.startsWith('>=')) return undefined
  return parseSemver(value.slice(2))
}

export function validateDshEngineRange(value, policy) {
  const repositoryFloor = parseMinimumRange(policy.dshEngine)
  const testedVersion = parseSemver(policy.testedDshVersion)
  if (
    repositoryFloor === undefined ||
    testedVersion === undefined ||
    compareSemver(repositoryFloor, testedVersion) > 0
  ) {
    throw new Error('Release policy has an invalid DSH floor or tested version')
  }

  const packageFloor = parseMinimumRange(value)
  if (packageFloor === undefined) return 'must use the canonical >=<semver> form'
  if (compareSemver(packageFloor, repositoryFloor) < 0) {
    return `must not be lower than repository floor ${policy.dshEngine}`
  }
  if (compareSemver(packageFloor, testedVersion) > 0) {
    return `must include tested DSH ${policy.testedDshVersion}`
  }
  return undefined
}

function validateFiles(manifest, policy, label, issues) {
  if (!Array.isArray(manifest.files) || manifest.files.some((value) => typeof value !== 'string')) {
    issues.push(`${label}: files must be a string allowlist`)
    return
  }
  const allowed = new Set(policy.packageFiles)
  for (const value of manifest.files) {
    if (!allowed.has(value)) issues.push(`${label}: files contains disallowed entry ${value}`)
  }
  for (const required of ['dist/', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    if (!manifest.files.includes(required)) issues.push(`${label}: files is missing ${required}`)
  }
  if (manifest.dsh?.bundle !== undefined && !manifest.files.includes('cordis.patch.yml')) {
    issues.push(`${label}: bundle package must publish cordis.patch.yml`)
  }
}

function validateManifest(manifest, rootVersion, policy, label, issues) {
  if (!hasString(manifest.name)) issues.push(`${label}: name is required`)
  if (manifest.version !== rootVersion)
    issues.push(`${label}: version ${String(manifest.version)} must equal root ${rootVersion}`)
  if (manifest.license !== 'MIT') issues.push(`${label}: license must be MIT`)
  if (!hasString(manifest.repository?.url ?? manifest.repository))
    issues.push(`${label}: repository is required`)
  if (manifest.engines?.node !== policy.nodeEngine)
    issues.push(`${label}: engines.node must be ${policy.nodeEngine}`)
  const dshEngineIssue = validateDshEngineRange(manifest.engines?.dsh, policy)
  if (dshEngineIssue !== undefined) issues.push(`${label}: engines.dsh ${dshEngineIssue}`)
  if (!hasString(manifest.exports?.['./package.json']))
    issues.push(`${label}: exports["./package.json"] is required`)
  validateFiles(manifest, policy, label, issues)

  if (String(manifest.name).startsWith('dsh-luban-')) {
    if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml')
      issues.push(`${label}: dsh.bundle.patch must be ./cordis.patch.yml`)
    if (manifest.exports?.['./cordis.patch.yml'] !== './cordis.patch.yml')
      issues.push(`${label}: exports["./cordis.patch.yml"] is required`)
  }

  if (manifest.dsh?.client !== undefined) {
    const clientExport = manifest.exports?.['./client']
    const clientDefault = typeof clientExport === 'string' ? clientExport : clientExport?.default
    if (manifest.dsh.client.platform !== 'web')
      issues.push(`${label}: dsh.client.platform must be web`)
    if (!hasString(clientDefault))
      issues.push(`${label}: dsh.client requires exports["./client"].default`)
    if (manifest.dsh.client.inject !== undefined && !Array.isArray(manifest.dsh.client.inject)) {
      issues.push(`${label}: dsh.client.inject must be an array`)
    }
  }
}

function validatePackageReadme(manifest, readme, label, issues) {
  if (String(manifest.name).startsWith('dsh-luban-')) {
    for (const [section, pattern] of PLUGIN_README_SECTIONS) {
      if (!pattern.test(readme)) issues.push(`${label}: README is missing ${section} section`)
    }
    if (!readme.includes('0.1.1-rc.2'))
      issues.push(`${label}: README must record tested DSH 0.1.1-rc.2`)
  } else {
    if (!/^## (?:Compatibility|兼容性)(?:\s|$)/im.test(readme))
      issues.push(`${label}: README is missing compatibility section`)
    if (!/^## (?:License|许可)(?:\s|$)/im.test(readme))
      issues.push(`${label}: README is missing license section`)
  }
}

export async function validateRepository(root = REPOSITORY_ROOT, packageSelection = []) {
  const issues = []
  const policy = await loadPolicy()
  const rootManifest = await readJson(join(root, 'package.json'))
  const rootVersion = rootManifest.version
  if (!hasString(rootVersion)) issues.push('package.json: root version is required')

  const packages = selectPackages(
    (await discoverPackages(root)).filter(({ manifest }) => isPublishable(manifest)),
    packageSelection,
  )
  for (const { directory, manifest } of packages) {
    const label = String(manifest.name ?? directory)
    validateManifest(manifest, rootVersion, policy, label, issues)
    try {
      validatePackageReadme(
        manifest,
        await readFile(join(directory, 'README.md'), 'utf8'),
        label,
        issues,
      )
    } catch (error) {
      if (error?.code === 'ENOENT') issues.push(`${label}: README.md is required`)
      else throw error
    }
  }

  const rootReadme = await readFile(join(root, 'README.md'), 'utf8')
  for (const [label, pattern] of [
    ['positioning', /^## 项目定位(?:\s|$)/m],
    ['documentation navigation', /^## 文档导航(?:\s|$)/m],
    ['quick start', /^## (?:快速开始|Quick Start)(?:\s|$)/im],
    ['license', /^## (?:许可|License)(?:\s|$)/im],
  ]) {
    if (!pattern.test(rootReadme)) issues.push(`README.md: missing ${label} section`)
  }
  if (!/Windows/i.test(rootReadme) || !/Ubuntu/i.test(rootReadme))
    issues.push('README.md: both Windows and Ubuntu modes must be described')

  try {
    const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
    if (!/^# Changelog\b/m.test(changelog)) issues.push('CHANGELOG.md: missing # Changelog heading')
    if (!/^## \[Unreleased\]/m.test(changelog))
      issues.push('CHANGELOG.md: missing [Unreleased] section')
    if (
      !new RegExp(`^## \\[${String(rootVersion).replaceAll('.', '\\.')}\\]`, 'm').test(changelog)
    ) {
      issues.push(`CHANGELOG.md: missing [${rootVersion}] section`)
    }
  } catch (error) {
    if (error?.code === 'ENOENT') issues.push('CHANGELOG.md is required')
    else throw error
  }

  return {
    rootVersion,
    testedDshVersion: policy.testedDshVersion,
    packages: packages.map((item) => item.manifest.name),
    issues,
  }
}

async function main() {
  const options = parseCommonArgs(process.argv.slice(2))
  if ((options.rest ?? []).length > 0) throw new Error(`Unknown option: ${options.rest[0]}`)
  const result = await validateRepository(
    resolve(options.root ?? REPOSITORY_ROOT),
    options.packages,
  )
  if (options.json === true) console.log(JSON.stringify(result, null, 2))
  else if (result.issues.length === 0)
    console.log(
      `Release metadata valid: ${result.packages.length} packages at ${result.rootVersion}; tested DSH ${result.testedDshVersion}.`,
    )
  else for (const issue of result.issues) console.error(`- ${issue}`)
  if (result.issues.length > 0) process.exitCode = 1
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`validate-release: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
