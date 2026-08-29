#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPOSITORY_ROOT } from './lib.mjs'

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  if (args.some((arg) => !['--apply', '--dry-run', '--help'].includes(arg)))
    throw new Error('Unknown option')
  if (args.includes('--help')) {
    console.log('Usage: node scripts/release/install-hooks.mjs [--dry-run] [--apply]')
    return
  }
  const command = process.platform === 'win32' ? 'pre-commit.exe' : 'pre-commit'
  const commandArgs = ['install', '--hook-type', 'pre-commit']
  if (!apply) {
    console.log(
      JSON.stringify({ command, args: commandArgs, cwd: REPOSITORY_ROOT, dryRun: true }, null, 2),
    )
    console.log('Dry run only. Use --apply to modify the local Git hook.')
    return
  }
  const result = spawnSync(command, commandArgs, {
    cwd: resolve(REPOSITORY_ROOT),
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error?.code === 'ENOENT') throw new Error('pre-commit is not installed')
  if (result.status !== 0) process.exitCode = result.status ?? 1
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`install-hooks: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
