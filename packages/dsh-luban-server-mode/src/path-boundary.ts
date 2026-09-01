import { lstatSync, realpathSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { LubanError } from '@yin52133/dsh-luban-core'

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null
    ? (Reflect.get(error, 'code') as string | undefined)
    : undefined
}

export function pathIsWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export function pathsEqual(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === ''
}

/** Resolve links in every existing ancestor while preserving a missing suffix. */
export async function canonicalPath(candidate: string): Promise<string> {
  let cursor = resolve(candidate)
  const suffix: string[] = []
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...suffix.reverse())
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      suffix.push(basename(cursor))
      cursor = parent
    }
  }
}

function canonicalPathSync(candidate: string): string {
  let cursor = resolve(candidate)
  const suffix: string[] = []
  for (;;) {
    try {
      return resolve(realpathSync(cursor), ...suffix.reverse())
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      suffix.push(basename(cursor))
      cursor = parent
    }
  }
}

export async function canonicalWithin(
  root: string,
  candidate: string,
  message: string,
): Promise<string> {
  if (!pathIsWithin(root, candidate)) throw new LubanError('E_INVALID_INPUT', message)
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    canonicalPath(root),
    canonicalPath(candidate),
  ])
  if (!pathIsWithin(canonicalRoot, canonicalCandidate)) {
    throw new LubanError('E_INVALID_INPUT', message)
  }
  return canonicalCandidate
}

export function canonicalWithinSync(root: string, candidate: string, message: string): string {
  if (!pathIsWithin(root, candidate)) throw new LubanError('E_INVALID_INPUT', message)
  const canonicalRoot = canonicalPathSync(root)
  const canonicalCandidate = canonicalPathSync(candidate)
  if (!pathIsWithin(canonicalRoot, canonicalCandidate)) {
    throw new LubanError('E_INVALID_INPUT', message)
  }
  return canonicalCandidate
}

export async function canonicalExistingWithin(
  roots: readonly string[],
  candidate: string,
  message: string,
): Promise<string> {
  if (!roots.some((root): boolean => pathIsWithin(root, candidate))) {
    throw new LubanError('E_INVALID_INPUT', message)
  }
  const [canonicalCandidate, canonicalRoots] = await Promise.all([
    realpath(resolve(candidate)),
    Promise.all(roots.map(canonicalPath)),
  ])
  if (!canonicalRoots.some((root): boolean => pathIsWithin(root, canonicalCandidate))) {
    throw new LubanError('E_INVALID_INPUT', message)
  }
  return canonicalCandidate
}

export async function canonicalExistingDirectoryWithin(
  roots: readonly string[],
  candidate: string,
  message: string,
): Promise<string> {
  const canonical = await canonicalExistingWithin(roots, candidate, message)
  if (!(await lstat(canonical)).isDirectory()) {
    throw new LubanError('E_INVALID_INPUT', message)
  }
  return canonical
}

export function canonicalExistingDirectoryWithinSync(
  roots: readonly string[],
  candidate: string,
  message: string,
): string {
  if (!roots.some((root): boolean => pathIsWithin(root, candidate))) {
    throw new LubanError('E_INVALID_INPUT', message)
  }
  const canonicalCandidate = realpathSync(resolve(candidate))
  const canonicalRoots = roots.map(canonicalPathSync)
  if (!canonicalRoots.some((root): boolean => pathIsWithin(root, canonicalCandidate))) {
    throw new LubanError('E_INVALID_INPUT', message)
  }
  if (!lstatSync(canonicalCandidate).isDirectory()) {
    throw new LubanError('E_INVALID_INPUT', message)
  }
  return canonicalCandidate
}

/** Require a previously canonicalized path to keep the same filesystem identity. */
export async function stableCanonicalPath(candidate: string, message: string): Promise<string> {
  const canonical = await canonicalPath(candidate)
  if (!pathsEqual(candidate, canonical)) throw new LubanError('E_INVALID_INPUT', message)
  return canonical
}

export async function stableCanonicalDirectory(
  candidate: string,
  message: string,
): Promise<string> {
  const canonical = await stableCanonicalPath(candidate, message)
  if (!(await lstat(canonical)).isDirectory()) {
    throw new LubanError('E_INVALID_INPUT', message)
  }
  return canonical
}

export async function rejectSymbolicLink(candidate: string, message: string): Promise<void> {
  try {
    if ((await lstat(candidate)).isSymbolicLink()) {
      throw new LubanError('E_INVALID_INPUT', message)
    }
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
}
