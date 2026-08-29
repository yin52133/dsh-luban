#!/usr/bin/env node

import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'

const SCRIPT_ROOT = fileURLToPath(new URL('.', import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_ROOT, '..', '..')
const TEMPLATE_ROOT = join(REPOSITORY_ROOT, 'profiles')
const PROFILE_FILES = Object.freeze(['package.json', 'cordis.patch.yml', 'README.md'])
const PROFILE_NAMES = new Set(['win-debug', 'ubuntu-server'])

function pathIsWithin(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'))
}

function defaultDshHome(env = process.env, userHome = homedir()) {
  const configured = env.DSH_HOME?.trim()
  return resolve(
    configured === undefined || configured === '' ? join(userHome, '.dsh') : configured,
  )
}

export function profileSetupPlan(options = {}) {
  const profile = options.profile
  if (!PROFILE_NAMES.has(profile)) {
    throw new Error(
      `Unsupported profile ${JSON.stringify(profile)}; expected win-debug or ubuntu-server`,
    )
  }
  const dshHome = resolve(options.dshHome ?? defaultDshHome(options.env, options.userHome))
  if (dshHome === parse(dshHome).root) throw new Error('DSH_HOME cannot be a filesystem root')
  const source = join(TEMPLATE_ROOT, profile)
  const target = join(dshHome, 'profiles', profile)
  if (!pathIsWithin(dshHome, target) || target === dshHome) {
    throw new Error(`Profile target must stay inside DSH_HOME: ${target}`)
  }
  return {
    schemaVersion: 1,
    profile,
    dshHome,
    source,
    target,
    files: PROFILE_FILES,
    dryRun: options.apply !== true,
  }
}

async function validateTemplate(plan) {
  const manifest = JSON.parse(await readFile(join(plan.source, 'package.json'), 'utf8'))
  if (manifest.name !== `dsh-profile-${plan.profile}`) {
    throw new Error(`${plan.profile}: template package name is invalid`)
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (
    !Array.isArray(bundles) ||
    !bundles.includes('@deepseek-ai/dsh-base') ||
    !bundles.includes('@deepseek-ai/dsh-web-app')
  ) {
    throw new Error(`${plan.profile}: template must include the official base and web bundles`)
  }
  for (const file of plan.files) {
    const info = await stat(join(plan.source, file))
    if (!info.isFile()) throw new Error(`${plan.profile}: template entry is not a file: ${file}`)
  }
}

export async function setupProfile(options = {}) {
  const plan = profileSetupPlan(options)
  await validateTemplate(plan)
  if (plan.dryRun) return plan

  const profilesRoot = join(plan.dshHome, 'profiles')
  await mkdir(profilesRoot, { recursive: true })
  let created = false
  try {
    await mkdir(plan.target)
    created = true
    for (const file of plan.files) {
      await copyFile(join(plan.source, file), join(plan.target, file), constants.COPYFILE_EXCL)
    }
  } catch (error) {
    if (created && pathIsWithin(profilesRoot, plan.target)) {
      await rm(plan.target, { recursive: true, force: true })
    }
    if (error?.code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing profile: ${plan.target}`)
    }
    throw error
  }
  return { ...plan, dryRun: false }
}

function parseArgs(argv) {
  const options = {}
  let explicitDryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      return next
    }
    if (arg === '--profile') options.profile = value()
    else if (arg === '--dsh-home') options.dshHome = value()
    else if (arg === '--apply') options.apply = true
    else if (arg === '--dry-run') explicitDryRun = true
    else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (options.apply === true && explicitDryRun) {
    throw new Error('--apply and --dry-run are mutually exclusive')
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/deploy/setup-profile.mjs --profile <win-debug|ubuntu-server> [--dsh-home <path>] [--dry-run|--apply]',
    )
    return
  }
  const result = await setupProfile(options)
  console.log(JSON.stringify(result, null, 2))
  if (result.dryRun) console.log('Dry run only. Re-run with --apply to create the profile.')
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`setup-profile: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
