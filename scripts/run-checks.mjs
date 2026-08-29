#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const pnpmEntry = process.env.npm_execpath
if (pnpmEntry === undefined || pnpmEntry === '') {
  throw new Error('Run this command through pnpm so npm_execpath is available')
}

const checks = [
  ['format', ['format:check']],
  ['lint', ['lint']],
  ['typecheck', ['typecheck']],
  ['build', ['build']],
  ['tests', ['test']],
  ['design', ['validate:design']],
  ['features', ['validate:features']],
  ['architecture', ['check:architecture']],
  ['package audit', ['pack:check']],
]

for (const [label, args] of checks) {
  console.log(`\n== ${label} ==`)
  const result = spawnSync(process.execPath, [pnpmEntry, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
