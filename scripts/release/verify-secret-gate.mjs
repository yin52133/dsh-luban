#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPOSITORY_ROOT } from './lib.mjs'

function parseArgs(argv) {
  const options = { verify: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--verify') options.verify = true
    else if (arg === '--dry-run') options.verify = false
    else if (arg === '--binary') {
      if (argv[index + 1] === undefined) throw new Error('--binary requires a value')
      options.binary = argv[index + 1]
      index += 1
    } else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

export function secretGatePlan(binary = 'gitleaks') {
  return {
    command: binary,
    args: [
      'dir',
      '<ephemeral-fixture>',
      '--config',
      resolve(REPOSITORY_ROOT, '.gitleaks.toml'),
      '--redact',
      '--no-banner',
    ],
    expectedExitCode: 1,
    dryRun: true,
  }
}

export async function verifySecretGate(binary = 'gitleaks') {
  const fixture = await mkdtemp(join(tmpdir(), 'luban-secret-gate-'))
  try {
    const syntheticToken = `${['gh', 'p_'].join('')}${randomBytes(27).toString('base64url')}`
    await writeFile(join(fixture, 'credential.txt'), `GITHUB_TOKEN=${syntheticToken}\n`, 'utf8')
    const args = [
      'dir',
      fixture,
      '--config',
      resolve(REPOSITORY_ROOT, '.gitleaks.toml'),
      '--redact',
      '--no-banner',
    ]
    const result = spawnSync(binary, args, { encoding: 'utf8', windowsHide: true })
    if (result.error?.code === 'ENOENT') throw new Error(`gitleaks binary was not found: ${binary}`)
    const diagnostic = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    if (result.status !== 1 || !/leaks found|Finding:/i.test(diagnostic)) {
      throw new Error(
        `Synthetic secret was not rejected as a leak (exit ${String(result.status)}): ${diagnostic.trim()}`,
      )
    }
    return { rejected: true, exitCode: result.status }
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(
      'Usage: node scripts/release/verify-secret-gate.mjs [--dry-run] [--verify] [--binary <path>]',
    )
    return
  }
  if (!options.verify) {
    console.log(JSON.stringify(secretGatePlan(options.binary), null, 2))
    console.log('Dry run only. Use --verify after installing the pinned gitleaks binary.')
    return
  }
  console.log(JSON.stringify(await verifySecretGate(options.binary), null, 2))
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`verify-secret-gate: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
