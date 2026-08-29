#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverPackages, pathIsWithin, REPOSITORY_ROOT } from './lib.mjs'

const TEMPLATE = resolve(REPOSITORY_ROOT, 'templates', 'market', 'awesome-dsh-plugin-entry.md.tpl')

function parseArgs(argv) {
  const options = { approve: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === '--package') options.package = value()
    else if (arg === '--category') options.category = value()
    else if (arg === '--output') options.output = value()
    else if (arg === '--approved-by') options.approvedBy = value()
    else if (arg === '--approve') options.approve = true
    else if (arg === '--dry-run') options.approve = false
    else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function render(template, values) {
  let output = template
  for (const [name, value] of Object.entries(values))
    output = output.replaceAll(`__${name}__`, String(value))
  const unresolved = output.match(/__[A-Z0-9_]+__/g)
  if (unresolved !== null) throw new Error(`Unresolved market template token: ${unresolved[0]}`)
  return output
}

export async function prepareMarketEntry(options = {}) {
  if (typeof options.package !== 'string' || options.package === '')
    throw new Error('--package is required')
  const packages = await discoverPackages(options.root ?? REPOSITORY_ROOT)
  const selected = packages.find((item) => item.manifest.name === options.package)
  if (selected === undefined) throw new Error(`Unknown package: ${options.package}`)
  const manifest = selected.manifest
  const repository =
    typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  const content = render(await readFile(TEMPLATE, 'utf8'), {
    PACKAGE_NAME: manifest.name,
    VERSION: manifest.version,
    DESCRIPTION: manifest.description ?? 'Description requires manual review.',
    REPOSITORY: repository ?? 'Repository URL requires manual review.',
    CATEGORY: options.category ?? 'developer-tools',
    DSH_ENGINE: manifest.engines?.dsh ?? 'Unknown; manual review required.',
    APPROVED_BY: options.approvedBy ?? '<pending>',
  })

  if (options.approve !== true) return { dryRun: true, package: manifest.name, content }
  if (typeof options.approvedBy !== 'string' || options.approvedBy.trim() === '')
    throw new Error('--approved-by is required with --approve')
  if (typeof options.output !== 'string' || options.output === '')
    throw new Error('--output is required with --approve')
  const root = resolve(options.root ?? REPOSITORY_ROOT)
  const output = resolve(root, options.output)
  if (!pathIsWithin(root, output) || output === root)
    throw new Error('Market output must stay inside the repository')
  await writeFile(output, content, { encoding: 'utf8', flag: 'wx' })
  return { dryRun: false, package: manifest.name, output }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/release/prepare-market-entry.mjs --package <name> [--dry-run] [--approve --approved-by <name> --output <file>]',
    )
    return
  }
  const result = await prepareMarketEntry(options)
  if (result.dryRun) {
    console.log(result.content)
    console.log('\nDry run only. This script never opens a PR or changes repository topics.')
  } else console.log(JSON.stringify(result, null, 2))
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`prepare-market-entry: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
