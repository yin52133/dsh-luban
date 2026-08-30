#!/usr/bin/env node

import { basename, relative, resolve, sep } from 'node:path'
import { pathToFileURL, URL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { discoverPackages, pathIsWithin, REPOSITORY_ROOT } from './lib.mjs'

export const MARKET_CATEGORIES = Object.freeze([
  'agi',
  'ui',
  'usage',
  'theme',
  'model',
  'identity',
  'session',
  'memory',
  'tools',
  'browser',
  'vision',
  'voice',
  'docs',
  'skill',
  'workflow',
  'git',
  'notify',
  'dev',
  'security',
  'remote',
  'market',
  'fun',
])

const CATEGORY_SET = new Set(MARKET_CATEGORIES)
const GITHUB_REPOSITORY =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u
const BRANCH = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9._-])?$/u
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/u

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
    else if (arg === '--branch') options.branch = value()
    else if (arg === '--description-zh') options.descriptionZh = value()
    else if (arg === '--output') options.output = value()
    else if (arg === '--approved-by') options.approvedBy = value()
    else if (arg === '--approve') options.approve = true
    else if (arg === '--dry-run') options.approve = false
    else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function repositoryUrl(repository) {
  const value = typeof repository === 'string' ? repository : repository?.url
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Package repository must point to GitHub')
  }
  const normalized = value.trim().replace(/^git\+/u, '')
  let url
  try {
    url = new URL(normalized)
  } catch (error) {
    throw new Error('Package repository URL is invalid', { cause: error })
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Package repository must be a credential-free GitHub HTTPS URL')
  }
  const match = GITHUB_REPOSITORY.exec(`https://github.com${url.pathname.replace(/\/$/u, '')}`)
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error('Package repository must identify one GitHub owner and repository')
  }
  return { owner: match[1], repository: match[2] }
}

function packageSubdirectory(root, selected) {
  const directory = relative(resolve(root), resolve(selected.directory)).replaceAll(sep, '/')
  if (!/^packages\/[A-Za-z0-9_.-]+$/u.test(directory)) {
    throw new Error('Market entries must identify one packages/<name> monorepo subdirectory')
  }
  const declared = selected.manifest.repository?.directory
  if (declared !== undefined && declared !== directory) {
    throw new Error('Package repository.directory does not match its workspace directory')
  }
  return directory
}

function oneLineDescription(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/u.test(value)) {
    throw new Error(`${label} must be one non-empty line`)
  }
  const normalized = value.trim()
  if (normalized.length > 500) throw new Error(`${label} must not exceed 500 characters`)
  return /[.!?。！？]$/u.test(normalized) ? normalized : `${normalized}.`
}

function marketFilename(owner, repository, subdirectory) {
  const suffix = subdirectory.replaceAll('/', '-')
  const components = [owner, repository, suffix]
  if (!components.every((value) => SAFE_SEGMENT.test(value))) {
    throw new Error('Repository identity cannot be represented as an upstream market filename')
  }
  return `${owner}__${repository}--${suffix}.yml`
}

function marketRecord(input) {
  const url = `https://github.com/${input.owner}/${input.repository}/tree/${input.branch}/${input.subdirectory}`
  return {
    url,
    name: `${input.owner}/${input.repository}#${basename(input.subdirectory)}`,
    category: input.category,
    description: {
      en: input.descriptionEn,
      ...(input.descriptionZh === undefined ? {} : { zh: input.descriptionZh }),
    },
  }
}

function stringifyMarketRecord(entry) {
  const descriptions = Object.entries(entry.description)
    .map(([locale, description]) => `  ${locale}: ${JSON.stringify(description)}`)
    .join('\n')
  return [
    `url: ${entry.url}`,
    `name: ${entry.name}`,
    `category: ${entry.category}`,
    'description:',
    descriptions,
    '',
  ].join('\n')
}

export async function prepareMarketEntry(options = {}) {
  if (typeof options.package !== 'string' || options.package.trim() === '') {
    throw new Error('--package is required')
  }
  if (typeof options.category !== 'string' || !CATEGORY_SET.has(options.category)) {
    throw new Error(`--category must be one of: ${MARKET_CATEGORIES.join(', ')}`)
  }
  const branch = options.branch ?? 'mainline'
  if (typeof branch !== 'string' || !BRANCH.test(branch) || branch.includes('..')) {
    throw new Error('--branch is invalid')
  }

  const root = resolve(options.root ?? REPOSITORY_ROOT)
  const packages = await discoverPackages(root)
  const selected = packages.find((item) => item.manifest.name === options.package.trim())
  if (selected === undefined) throw new Error(`Unknown package: ${options.package}`)
  if (selected.manifest.dsh?.bundle?.patch === undefined) {
    throw new Error(`${selected.manifest.name} is not an installable dsh.bundle package`)
  }

  const identity = repositoryUrl(selected.manifest.repository)
  const subdirectory = packageSubdirectory(root, selected)
  const descriptionEn = oneLineDescription(selected.manifest.description, 'English description')
  const descriptionZh =
    options.descriptionZh === undefined
      ? undefined
      : oneLineDescription(options.descriptionZh, 'Chinese description')
  const filename = marketFilename(identity.owner, identity.repository, subdirectory)
  const entry = marketRecord({
    ...identity,
    subdirectory,
    branch,
    category: options.category,
    descriptionEn,
    descriptionZh,
  })
  const content = stringifyMarketRecord(entry)
  const sourceIdentity = {
    owner: identity.owner,
    repository: identity.repository,
    subdirectory,
    branch,
    version: selected.manifest.version,
  }

  if (options.approve !== true) {
    return {
      dryRun: true,
      package: selected.manifest.name,
      filename,
      entry,
      content,
      sourceIdentity,
    }
  }
  if (typeof options.approvedBy !== 'string' || options.approvedBy.trim() === '') {
    throw new Error('--approved-by is required with --approve')
  }
  if (typeof options.output !== 'string' || options.output.trim() === '') {
    throw new Error('--output is required with --approve')
  }
  const output = resolve(root, options.output)
  if (!pathIsWithin(root, output) || output === root) {
    throw new Error('Market output must stay inside the repository')
  }
  if (basename(output) !== filename) {
    throw new Error(`Market output filename must be ${filename}`)
  }
  await writeFile(output, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return {
    dryRun: false,
    package: selected.manifest.name,
    filename,
    output,
    approvedBy: options.approvedBy.trim(),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/release/prepare-market-entry.mjs --package <name> --category <category> [--branch mainline] [--description-zh <text>] [--dry-run] [--approve --approved-by <name> --output <expected.yml>]',
    )
    console.log(`Categories: ${MARKET_CATEGORIES.join(', ')}`)
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
