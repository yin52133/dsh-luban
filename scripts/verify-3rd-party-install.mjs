#!/usr/bin/env node

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, parse, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MANIFEST_LIMIT = 1024 * 1024
const WORKSPACE_LIMIT = 64 * 1024
const LICENSE_LIMIT = 1024 * 1024
const LICENSE_NAMES = Object.freeze(['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license'])
const EXPECTED_ENV = 'LUBAN_THIRD_PARTY_EXPECTED'
const BUILD_ENV = 'LUBAN_THIRD_PARTY_BUILD_EXPECTED'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function expectedRecords(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be non-empty`)
  const names = new Set()
  return value.map((record) => {
    if (
      !isRecord(record) ||
      typeof record.name !== 'string' ||
      typeof record.version !== 'string' ||
      !/^(?:@?[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(record.name) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(record.version)
    ) {
      throw new Error(`${label} contains an invalid package identity`)
    }
    if (names.has(record.name)) throw new Error(`${label} contains a duplicate package`)
    names.add(record.name)
    return Object.freeze({ name: record.name, version: record.version })
  })
}

async function boundedFile(path, limit, label) {
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > limit) {
    throw new Error(`${label} must be a bounded regular file`)
  }
  const content = await readFile(path)
  if (content.byteLength > limit) throw new Error(`${label} exceeds its size limit`)
  return content
}

async function jsonFile(path, label) {
  const raw = await boundedFile(path, MANIFEST_LIMIT, label)
  try {
    const value = JSON.parse(raw.toString('utf8'))
    if (!isRecord(value)) throw new Error('not an object')
    return value
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error })
  }
}

async function defaultManifestResolver(profileRoot, name) {
  const requireFromProfile = createRequire(join(profileRoot, 'package.json'))
  try {
    return requireFromProfile.resolve(`${name}/package.json`)
  } catch {
    const directManifest = join(profileRoot, 'node_modules', ...name.split('/'), 'package.json')
    try {
      const manifest = await jsonFile(directManifest, `${name} manifest`)
      if (manifest.name === name) return directManifest
    } catch {
      // Fall back to walking from the package entry when one is exported for require().
    }
    let directory = dirname(requireFromProfile.resolve(name))
    for (let depth = 0; depth < 12; depth += 1) {
      const candidate = join(directory, 'package.json')
      try {
        const manifest = await jsonFile(candidate, `${name} manifest`)
        if (manifest.name === name) return candidate
      } catch {
        // Keep walking toward the package root.
      }
      const parent = dirname(directory)
      if (parent === directory || directory === parse(directory).root) break
      directory = parent
    }
  }
  throw new Error(`Unable to resolve installed package ${name}`)
}

function allowBuildMap(workspace) {
  const lines = workspace.split(/\r?\n/u)
  const header = lines.findIndex((line) => /^allowBuilds:\s*(?:#.*)?$/u.test(line))
  if (header < 0 || lines.slice(header + 1).some((line) => /^allowBuilds:/u.test(line))) {
    throw new Error('pnpm-workspace.yaml must contain one allowBuilds mapping')
  }
  const entries = new Map()
  for (const line of lines.slice(header + 1)) {
    if (line.trim() === '' || /^\s+#/u.test(line)) continue
    if (!/^\s/u.test(line)) break
    const match =
      /^\s{2,}((?:"[^"]+")|(?:'[^']+')|(?:[^:#][^:]*)):\s*(true|false)\s*(?:#.*)?$/u.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error('allowBuilds contains an unsupported entry')
    }
    const key = match[1].replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2').trim()
    if (entries.has(key)) throw new Error(`allowBuilds contains duplicate ${key}`)
    entries.set(key, match[2] === 'true')
  }
  return entries
}

async function licenseAttestation(packageRoot, name) {
  for (const filename of LICENSE_NAMES) {
    try {
      const content = await boundedFile(
        join(packageRoot, filename),
        LICENSE_LIMIT,
        `${name} license`,
      )
      return Object.freeze({ filename, sha256: createHash('sha256').update(content).digest('hex') })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw new Error(`${name} has no installed LICENSE file`)
}

/** Verify the installed profile independently of the install command's exit status. */
export async function verifyThirdPartyProfile(options, dependencies = {}) {
  const profileRoot = await realpath(resolve(options.profileRoot))
  const expected = expectedRecords(options.expected, 'expected packages')
  const buildExpected = expectedRecords(options.buildExpected, 'expected build packages')
  const profile = await jsonFile(join(profileRoot, 'package.json'), 'profile manifest')
  const profileDependencies = isRecord(profile.dependencies) ? profile.dependencies : {}
  const bundles = Array.isArray(profile.dsh?.profile?.bundles) ? profile.dsh.profile.bundles : []
  const resolveManifest =
    dependencies.resolveManifest ?? ((name) => defaultManifestResolver(profileRoot, name))
  const requireFromProfile = createRequire(join(profileRoot, 'package.json'))
  const loadPackage = dependencies.loadPackage ?? ((name) => requireFromProfile(name))

  const installed = []
  for (const record of expected) {
    if (profileDependencies[record.name] !== record.version) {
      throw new Error(`${record.name} is not saved at the exact accepted version`)
    }
    if (bundles.filter((name) => name === record.name).length !== 1) {
      throw new Error(`${record.name} must occur exactly once in dsh.profile.bundles`)
    }
    const manifestPath = await realpath(await resolveManifest(record.name))
    const manifest = await jsonFile(manifestPath, `${record.name} manifest`)
    if (
      manifest.name !== record.name ||
      manifest.version !== record.version ||
      typeof manifest.dsh?.bundle?.patch !== 'string' ||
      manifest.dsh.bundle.patch.trim() === '' ||
      manifest.license !== 'MIT'
    ) {
      throw new Error(`${record.name} installed manifest does not match the accepted bundle`)
    }
    if (record.name === 'dsh-better-sidebar' && manifest.dependencies?.['node-pty'] !== '^1.1.0') {
      throw new Error('Installed dsh-better-sidebar crossed the reviewed node-pty boundary')
    }
    installed.push(
      Object.freeze({
        name: record.name,
        version: record.version,
        bundle: true,
        license: await licenseAttestation(dirname(manifestPath), record.name),
      }),
    )
  }

  const workspace = (
    await boundedFile(
      join(profileRoot, 'pnpm-workspace.yaml'),
      WORKSPACE_LIMIT,
      'pnpm workspace policy',
    )
  ).toString('utf8')
  const allowed = allowBuildMap(workspace)
  for (const record of buildExpected) {
    const exact = `${record.name}@${record.version}`
    const competingRule = [...allowed].some(
      ([key, enabled]) =>
        enabled === true &&
        (key === record.name || key.startsWith(`${record.name}@`)) &&
        key !== exact,
    )
    if (allowed.get(exact) !== true || competingRule) {
      throw new Error(`allowBuilds must approve only the exact ${exact} build identity`)
    }
  }

  if (buildExpected.length !== 1 || buildExpected[0]?.name !== 'node-pty') {
    throw new Error('The verifier supports the locked node-pty build boundary only')
  }
  const buildRecord = buildExpected[0]
  const buildManifestPath = await realpath(await resolveManifest(buildRecord.name))
  const buildManifest = await jsonFile(buildManifestPath, `${buildRecord.name} manifest`)
  if (
    buildManifest.name !== buildRecord.name ||
    buildManifest.version !== buildRecord.version ||
    buildManifest.license !== 'MIT'
  ) {
    throw new Error('Installed node-pty does not match the accepted build identity')
  }
  const nativeModule = await loadPackage(buildRecord.name)
  if (!isRecord(nativeModule) || typeof nativeModule.spawn !== 'function') {
    throw new Error('Installed node-pty native module did not load')
  }

  return Object.freeze({
    schemaVersion: 1,
    profile: typeof profile.name === 'string' ? profile.name.slice(0, 128) : 'unknown',
    installed: Object.freeze(installed),
    build: Object.freeze({
      name: buildRecord.name,
      version: buildRecord.version,
      loaded: true,
      license: await licenseAttestation(dirname(buildManifestPath), buildRecord.name),
    }),
  })
}

function parseEnvironment(name) {
  const raw = process.env[name]
  if (raw === undefined || Buffer.byteLength(raw, 'utf8') > 16 * 1024) {
    throw new Error(`${name} is missing or too large`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${name} is invalid JSON`, { cause: error })
  }
}

async function main() {
  const report = await verifyThirdPartyProfile({
    profileRoot: process.cwd(),
    expected: parseEnvironment(EXPECTED_ENV),
    buildExpected: parseEnvironment(BUILD_ENV),
  })
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      `verify-3rd-party-install: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  })
}
