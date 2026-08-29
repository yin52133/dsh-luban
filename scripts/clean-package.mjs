#!/usr/bin/env node

import { rm } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '..')
const packageDirectory = resolve(process.cwd())
const relativePackage = relative(repositoryRoot, packageDirectory)
const roots = new Set(['packages', 'profiles', 'tools'])
const firstSegment = relativePackage.split(sep)[0]

if (
  relativePackage === '' ||
  relativePackage.startsWith(`..${sep}`) ||
  firstSegment === undefined ||
  !roots.has(firstSegment)
) {
  throw new Error(`Refusing to clean outside a workspace package: ${packageDirectory}`)
}

const target = resolve(packageDirectory, 'dist')
if (basename(target) !== 'dist' || dirname(target) !== packageDirectory) {
  throw new Error(`Refusing unsafe clean target: ${target}`)
}

await rm(target, { recursive: true, force: true })
