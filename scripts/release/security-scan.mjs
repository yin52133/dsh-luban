#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPOSITORY_ROOT } from './lib.mjs'

function parseArgs(argv) {
  const options = { dryRun: false, mode: 'git' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--working-tree') options.mode = 'dir'
    else if (arg === '--root') {
      if (argv[index + 1] === undefined) throw new Error('--root requires a value')
      options.root = argv[index + 1]
      index += 1
    } else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

export function gitleaksInvocation(root, mode = 'git') {
  const common = ['--config', resolve(root, '.gitleaks.toml'), '--redact', '--verbose']
  return mode === 'dir' ? ['dir', root, ...common] : ['git', root, ...common]
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log('Usage: node scripts/release/security-scan.mjs [--dry-run] [--working-tree]')
    return
  }
  const root = resolve(options.root ?? REPOSITORY_ROOT)
  const args = gitleaksInvocation(root, options.mode)
  if (options.dryRun) {
    console.log(JSON.stringify({ command: 'gitleaks', args, dryRun: true }, null, 2))
    return
  }
  const result = spawnSync('gitleaks', args, { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error?.code === 'ENOENT')
    throw new Error('gitleaks is not installed; use pre-commit or the pinned CI action')
  if (result.status !== 0) process.exitCode = result.status ?? 1
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`security-scan: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
