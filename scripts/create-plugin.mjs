#!/usr/bin/env node

import { lstat, mkdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStagedDirectoryPublisher, safeChildPath } from './path-boundary.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..')
const DEFAULT_TEMPLATE_ROOT = resolve(REPOSITORY_ROOT, 'templates', 'plugin')
const MODULE_NAME = /^[a-z0-9][a-z0-9-]*$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const PACKAGE_SCOPE = '@yin52133/'

const HOST_FILES = new Map([
  ['package.host.json.tpl', 'package.json'],
  ['cordis.patch.yml.tpl', 'cordis.patch.yml'],
  ['README.md.tpl', 'README.md'],
  ['LICENSE.tpl', 'LICENSE'],
  ['THIRD-PARTY-NOTICES.md.tpl', 'THIRD-PARTY-NOTICES.md'],
  ['tsconfig.json.tpl', 'tsconfig.json'],
  ['vitest.config.ts.tpl', 'vitest.config.ts'],
  ['tsdown.host.config.ts.tpl', 'tsdown.config.ts'],
  ['src/index.ts.tpl', 'src/index.ts'],
  ['tests/host-lifecycle.test.ts.tpl', 'tests/host-lifecycle.test.ts'],
])

const CLIENT_FILES = new Map([
  ['package.client.json.tpl', 'package.json'],
  ['tsdown.client.config.ts.tpl', 'tsdown.config.ts'],
  ['src/client/index.ts.tpl', 'src/client/index.ts'],
  ['tests/client-bundle.test.ts.tpl', 'tests/client-bundle.test.ts'],
])

function usage() {
  return `Usage: node scripts/create-plugin.mjs --name <module> [options]

Options:
  --client                 Include the optional rc2 lazy-CJS browser half.
  --description <text>     One-line package description.
  --output <path>          Target path (default: packages/dsh-luban-<module>).
  --version <semver>       Initial package version (default: 0.1.0).
  --dsh-engine <range>     engines.dsh range (default: >=0.1.1-rc.1).
  --write                  Create files. Without this flag the command is a dry run.
  --dry-run                Explicitly request the default non-writing mode.
  --help                    Show this message.

The target must stay inside the selected workspace and must not already exist.
Existing files are never overwritten.`
}

function parseCli(argv) {
  const options = { client: false, dryRun: true }
  let explicitWrite = false
  let explicitDryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      return value
    }
    switch (arg) {
      case '--name':
        options.name = next()
        break
      case '--description':
        options.description = next()
        break
      case '--output':
        options.output = next()
        break
      case '--version':
        options.version = next()
        break
      case '--dsh-engine':
        options.dshEngine = next()
        break
      case '--client':
        options.client = true
        break
      case '--write':
        options.dryRun = false
        explicitWrite = true
        break
      case '--dry-run':
        options.dryRun = true
        explicitDryRun = true
        break
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }
  if (explicitWrite && explicitDryRun) {
    throw new Error('--write and --dry-run are mutually exclusive')
  }
  return options
}

function assertOneLine(label, value) {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} must be a non-empty single line`)
  }
}

function assertInside(root, target) {
  const rel = relative(root, target)
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`Output must be a child of the workspace: ${target}`)
  }
}

async function assertAvailableTarget(target) {
  try {
    await lstat(target)
  } catch (error) {
    if (typeof error === 'object' && error !== null && error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`Refusing to overwrite existing target: ${target}`)
}

function render(source, values, sourceName) {
  let output = source
  for (const [token, value] of Object.entries(values))
    output = output.replaceAll(`__${token}__`, value)
  const unresolved = output.match(/__[A-Z0-9_]+__/g)
  if (unresolved !== null) throw new Error(`Unresolved token in ${sourceName}: ${unresolved[0]}`)
  return output
}

/**
 * Generate one DSH bundle package without overwriting existing files.
 * @param {object} input generation options
 * @returns {Promise<{target: string, files: string[], dryRun: boolean}>} generation summary
 */
export async function generatePlugin(input) {
  const name = input.name
  if (typeof name !== 'string' || !MODULE_NAME.test(name)) {
    throw new Error('Module name must match [a-z0-9][a-z0-9-]*')
  }

  const description = input.description ?? `DSH Luban ${name} plugin`
  const version = input.version ?? '0.1.0'
  const dshEngine = input.dshEngine ?? '>=0.1.1-rc.1'
  assertOneLine('Description', description)
  assertOneLine('DSH engine range', dshEngine)
  if (!VERSION.test(version)) throw new Error(`Invalid semantic version: ${version}`)

  const workspaceRoot = resolve(input.workspaceRoot ?? REPOSITORY_ROOT)
  const templateRoot = resolve(input.templateRoot ?? DEFAULT_TEMPLATE_ROOT)
  const target = resolve(workspaceRoot, input.output ?? `packages/dsh-luban-${name}`)
  assertInside(workspaceRoot, target)
  const safeTarget = await safeChildPath(workspaceRoot, target, 'Plugin output')
  await assertAvailableTarget(safeTarget.target)

  const packageDirectoryName = `dsh-luban-${name}`
  const packageName = `${PACKAGE_SCOPE}${packageDirectoryName}`
  const pluginId = `luban-${name}`
  const values = {
    MODULE_NAME: name,
    PACKAGE_DIRECTORY_NAME: packageDirectoryName,
    PACKAGE_NAME: packageName,
    PACKAGE_NAME_JSON: JSON.stringify(packageName),
    PLUGIN_ID: pluginId,
    PLUGIN_ID_JSON: JSON.stringify(pluginId),
    DESCRIPTION: description,
    DESCRIPTION_JSON: JSON.stringify(description),
    VERSION: version,
    VERSION_JSON: JSON.stringify(version),
    DSH_ENGINE: dshEngine,
    DSH_ENGINE_JSON: JSON.stringify(dshEngine),
  }

  const selected = new Map(HOST_FILES)
  if (input.client === true) {
    selected.delete('package.host.json.tpl')
    selected.delete('tsdown.host.config.ts.tpl')
    for (const [source, destination] of CLIENT_FILES) selected.set(source, destination)
  }

  const rendered = []
  for (const [sourceName, destination] of selected) {
    const source = await readFile(resolve(templateRoot, sourceName), 'utf8')
    rendered.push({ destination, content: render(source, values, sourceName) })
  }
  rendered.sort((left, right) => left.destination.localeCompare(right.destination))

  if (input.dryRun !== false) {
    return { target, files: rendered.map((item) => item.destination), dryRun: true }
  }

  await mkdir(workspaceRoot, { recursive: true })
  const publisher = await createStagedDirectoryPublisher(workspaceRoot, target, 'Plugin output')
  try {
    for (const item of rendered) await publisher.writeText(item.destination, item.content)
    await publisher.publish()
  } catch (error) {
    await publisher.abort()
    throw error
  }
  return { target, files: rendered.map((item) => item.destination), dryRun: false }
}

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.help === true) {
    console.log(usage())
    return
  }
  if (options.name === undefined) throw new Error('--name is required')
  const result = await generatePlugin(options)
  console.log(JSON.stringify(result, null, 2))
  if (result.dryRun) console.log('Dry run only. Re-run with --write to create the package.')
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`create-plugin: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
