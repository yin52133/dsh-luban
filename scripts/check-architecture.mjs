#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const packagesDirectory = join(root, 'packages')
const findings = []
const corePackageName = '@yin52133/dsh-luban-core'
const packagePrefix = '@yin52133/dsh-luban-'
const allowedRuntimeDependencies = new Set([
  corePackageName,
  'argon2',
  'serialport',
  'sharp',
  'yaml',
])

async function sourceFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
    else if (/\.(?:ts|tsx|js|mjs)$/u.test(entry.name)) files.push(path)
  }
  return files
}

for (const entry of await readdir(packagesDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const directory = join(packagesDirectory, entry.name)
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (entry.name === 'core') {
    if (manifest.name !== corePackageName) {
      findings.push(`core: package name must be ${corePackageName}`)
    }
    continue
  }
  if (manifest.name === corePackageName) {
    findings.push(`${corePackageName}: must use the packages/core directory`)
    continue
  }
  if (!String(manifest.name).startsWith(packagePrefix)) continue

  const suffix = String(manifest.name).slice(packagePrefix.length)
  const expectedId = `luban-${suffix}`
  if (basename(directory) !== `dsh-luban-${suffix}`) {
    findings.push(`${manifest.name}: directory must match package name`)
  }
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    findings.push(`${manifest.name}: missing dsh.bundle.patch`)
  }
  if (manifest.exports?.['./cordis.patch.yml'] !== './cordis.patch.yml') {
    findings.push(`${manifest.name}: missing cordis patch export`)
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (!allowedRuntimeDependencies.has(dependency)) {
      findings.push(`${manifest.name}: unapproved runtime dependency ${dependency}`)
    }
    if (dependency.startsWith('@deepseek-ai/')) {
      findings.push(`${manifest.name}: DSH packages must be peer dependencies (${dependency})`)
    }
  }

  const patch = await readFile(join(directory, 'cordis.patch.yml'), 'utf8')
  if (!patch.includes(`id: ${expectedId}`) || !patch.includes(`name: '${manifest.name}'`)) {
    findings.push(`${manifest.name}: cordis patch must use id ${expectedId}`)
  }
  for (const file of await sourceFiles(join(directory, 'src'))) {
    const source = await readFile(file, 'utf8')
    if (/['"`]\/luban\//u.test(source))
      findings.push(`${manifest.name}: legacy /luban/ route in ${file}`)
    const implementationImport = /from\s+['"]@yin52133\/dsh-luban-(?!core['"])[^'"]+['"]/u.exec(
      source,
    )
    if (implementationImport !== null) {
      findings.push(
        `${manifest.name}: cross-plugin implementation import ${implementationImport[0]}`,
      )
    }
  }
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`- ${finding}`)
  process.exitCode = 1
} else {
  console.log('Architecture boundaries valid.')
}
