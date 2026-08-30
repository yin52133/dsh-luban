import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, type URL } from 'node:url'
import { LubanError } from 'dsh-luban-core'

export const HUD_RUNTIME_ARTIFACT_SCHEMA = 'dsh-luban/m07-hud-runtime-artifact/v1' as const

const HUD_PACKAGE_NAME = 'dsh-luban-hud'
const HUD_ENTRYPOINT = 'dist/index.js'
const MAX_ARTIFACT_FILES = 128
const MAX_ARTIFACT_FILE_BYTES = 10 * 1024 * 1024
const MAX_ARTIFACT_TOTAL_BYTES = 25 * 1024 * 1024
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const PACKAGE_VERSION =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const STATIC_MODULE_SPECIFIER =
  /(?:^|\n)[ \t]*(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["']([^"'\\\r\n]+)["']/gmu
const DYNAMIC_MODULE_SPECIFIER = /\bimport\s*\(\s*["']([^"'\\\r\n]+)["']\s*\)/gu
const DYNAMIC_IMPORT = /\bimport\s*\(/gu
const QUOTED_RELATIVE_JAVASCRIPT = /["']((?:\.\.?\/)[^"'\r\n]*?\.js)["']/gu

export interface HudRuntimeArtifactFile {
  readonly relativePath: string
  readonly sha256: string
  readonly bytes: number
}

export interface HudRuntimeArtifactIdentity {
  readonly schemaVersion: typeof HUD_RUNTIME_ARTIFACT_SCHEMA
  readonly packageName: typeof HUD_PACKAGE_NAME
  readonly packageVersion: string
  readonly entrypoint: typeof HUD_ENTRYPOINT
  readonly files: readonly HudRuntimeArtifactFile[]
  readonly bundleSha256: string
}

interface StableFile {
  readonly canonicalPath: string
  readonly bytes: Buffer
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function artifactUnavailable(message: string): never {
  throw new LubanError('E_UNAVAILABLE', message)
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function readStableFile(requestedPath: string, root: string, maximumBytes: number): StableFile {
  let initial: BigIntStats
  let canonicalPath: string
  try {
    initial = lstatSync(requestedPath, { bigint: true })
    canonicalPath = realpathSync(requestedPath)
  } catch {
    return artifactUnavailable('HUD runtime artifact contains an unreadable file')
  }
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size <= 0n ||
    initial.size > BigInt(maximumBytes) ||
    !samePath(canonicalPath, requestedPath) ||
    !isInside(root, canonicalPath)
  ) {
    return artifactUnavailable('HUD runtime artifact contains an unsafe file')
  }

  let descriptor: number | undefined
  let raw: Buffer
  try {
    const before = lstatSync(canonicalPath, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || !sameSnapshot(initial, before)) {
      return artifactUnavailable('HUD runtime artifact changed before inspection')
    }
    descriptor = openSync(canonicalPath, 'r')
    const opened = fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || !sameSnapshot(before, opened)) {
      return artifactUnavailable('HUD runtime artifact changed before inspection')
    }

    const expectedBytes = Number(opened.size)
    const buffer = Buffer.allocUnsafe(expectedBytes + 1)
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    const after = fstatSync(descriptor, { bigint: true })
    if (offset !== expectedBytes || !sameSnapshot(opened, after) || after.size !== BigInt(offset)) {
      return artifactUnavailable('HUD runtime artifact changed during inspection')
    }
    raw = buffer.subarray(0, offset)
  } catch (error: unknown) {
    if (error instanceof LubanError) throw error
    return artifactUnavailable('HUD runtime artifact could not be inspected')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }

  try {
    const final = lstatSync(requestedPath, { bigint: true })
    const finalCanonicalPath = realpathSync(requestedPath)
    if (
      !final.isFile() ||
      final.isSymbolicLink() ||
      !sameSnapshot(initial, final) ||
      !samePath(canonicalPath, finalCanonicalPath)
    ) {
      return artifactUnavailable('HUD runtime artifact changed after inspection')
    }
  } catch (error: unknown) {
    if (error instanceof LubanError) throw error
    return artifactUnavailable('HUD runtime artifact changed after inspection')
  }
  return Object.freeze({ canonicalPath, bytes: raw })
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index): boolean => key === sortedExpected[index])
  )
}

function validRelativeArtifactPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  const segments = value.split('/')
  return (
    segments[0] === 'dist' &&
    segments.length >= 2 &&
    segments.every(
      (segment): boolean =>
        segment !== '' && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/u.test(segment),
    ) &&
    value.endsWith('.js')
  )
}

function compareArtifactFiles(left: HudRuntimeArtifactFile, right: HudRuntimeArtifactFile): number {
  if (left.relativePath === right.relativePath) return 0
  return left.relativePath < right.relativePath ? -1 : 1
}

export function hudRuntimeArtifactBundleSha256(files: readonly HudRuntimeArtifactFile[]): string {
  return sha256(
    [...files]
      .sort(compareArtifactFiles)
      .map((file): string => `${file.relativePath}\0${file.sha256}\0${String(file.bytes)}\n`)
      .join(''),
  )
}

export function parseHudRuntimeArtifactIdentity(value: unknown): HudRuntimeArtifactIdentity {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, [
      'bundleSha256',
      'entrypoint',
      'files',
      'packageName',
      'packageVersion',
      'schemaVersion',
    ])
  ) {
    return artifactUnavailable('HUD runtime artifact identity is invalid')
  }
  const record = value as Record<string, unknown>
  if (
    record.schemaVersion !== HUD_RUNTIME_ARTIFACT_SCHEMA ||
    record.packageName !== HUD_PACKAGE_NAME ||
    typeof record.packageVersion !== 'string' ||
    record.packageVersion.length > 128 ||
    !PACKAGE_VERSION.test(record.packageVersion) ||
    record.entrypoint !== HUD_ENTRYPOINT ||
    !Array.isArray(record.files) ||
    record.files.length === 0 ||
    record.files.length > MAX_ARTIFACT_FILES ||
    typeof record.bundleSha256 !== 'string' ||
    !SHA256.test(record.bundleSha256)
  ) {
    return artifactUnavailable('HUD runtime artifact identity is invalid')
  }

  let totalBytes = 0
  const files: HudRuntimeArtifactFile[] = []
  const candidateFiles = record.files as unknown[]
  for (const candidate of candidateFiles) {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      !exactKeys(candidate, ['bytes', 'relativePath', 'sha256'])
    ) {
      return artifactUnavailable('HUD runtime artifact file identity is invalid')
    }
    const file = candidate as Record<string, unknown>
    if (
      !validRelativeArtifactPath(file.relativePath) ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) <= 0 ||
      (file.bytes as number) > MAX_ARTIFACT_FILE_BYTES
    ) {
      return artifactUnavailable('HUD runtime artifact file identity is invalid')
    }
    totalBytes += file.bytes as number
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
      return artifactUnavailable('HUD runtime artifact closure exceeds its size limit')
    }
    files.push(
      Object.freeze({
        relativePath: file.relativePath,
        sha256: file.sha256,
        bytes: file.bytes as number,
      }),
    )
  }
  const sorted = [...files].sort(compareArtifactFiles)
  if (
    !sorted.some((file): boolean => file.relativePath === HUD_ENTRYPOINT) ||
    sorted.some(
      (file, index): boolean => index > 0 && file.relativePath === sorted[index - 1]?.relativePath,
    ) ||
    files.some((file, index): boolean => file.relativePath !== sorted[index]?.relativePath) ||
    hudRuntimeArtifactBundleSha256(sorted) !== record.bundleSha256
  ) {
    return artifactUnavailable('HUD runtime artifact closure identity is invalid')
  }
  return Object.freeze({
    schemaVersion: HUD_RUNTIME_ARTIFACT_SCHEMA,
    packageName: HUD_PACKAGE_NAME,
    packageVersion: record.packageVersion,
    entrypoint: HUD_ENTRYPOINT,
    files: Object.freeze(sorted),
    bundleSha256: record.bundleSha256,
  })
}

function decodeJavascript(raw: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return artifactUnavailable('HUD runtime artifact contains invalid JavaScript text')
  }
}

function relativeModuleSpecifiers(source: string): readonly string[] {
  const dynamicMarkers = [...source.matchAll(DYNAMIC_IMPORT)].length
  const dynamicSpecifiers = [...source.matchAll(DYNAMIC_MODULE_SPECIFIER)].map(
    (match): string => match[1] ?? '',
  )
  if (dynamicMarkers !== dynamicSpecifiers.length) {
    return artifactUnavailable('HUD runtime artifact contains a non-literal dynamic import')
  }
  const staticSpecifiers = [...source.matchAll(STATIC_MODULE_SPECIFIER)].map(
    (match): string => match[1] ?? '',
  )
  const quotedRelativeSpecifiers = [...source.matchAll(QUOTED_RELATIVE_JAVASCRIPT)].map(
    (match): string => match[1] ?? '',
  )
  return Object.freeze(
    [...new Set([...staticSpecifiers, ...dynamicSpecifiers, ...quotedRelativeSpecifiers])].filter(
      (specifier): boolean => specifier.startsWith('.'),
    ),
  )
}

function resolveRelativeJavascriptImport(
  importingPath: string,
  specifier: string,
  distRoot: string,
): string {
  if (
    !/^(?:\.\.?\/)[A-Za-z0-9._/-]+\.js$/u.test(specifier) ||
    specifier.includes('//') ||
    specifier.split('/').some((segment): boolean => segment === '')
  ) {
    return artifactUnavailable('HUD runtime artifact contains an unsafe relative import')
  }
  const target = resolve(dirname(importingPath), specifier)
  if (!isInside(distRoot, target)) {
    return artifactUnavailable('HUD runtime artifact relative import escapes dist')
  }
  return target
}

function inspectRuntimeArtifact(entrypointUrl: URL): HudRuntimeArtifactIdentity {
  if (
    entrypointUrl.protocol !== 'file:' ||
    entrypointUrl.username !== '' ||
    entrypointUrl.password !== '' ||
    entrypointUrl.search !== '' ||
    entrypointUrl.hash !== ''
  ) {
    return artifactUnavailable('HUD runtime artifact entrypoint must be a local file URL')
  }
  const entrypointPath = fileURLToPath(entrypointUrl)
  const packageRoot = resolve(dirname(entrypointPath), '..')
  const canonicalPackageRoot = realpathSync(packageRoot)
  const distRoot = resolve(canonicalPackageRoot, 'dist')
  const expectedEntrypoint = resolve(distRoot, 'index.js')
  let rootMetadata: BigIntStats
  let distMetadata: BigIntStats
  try {
    rootMetadata = lstatSync(canonicalPackageRoot, { bigint: true })
    distMetadata = lstatSync(distRoot, { bigint: true })
  } catch {
    return artifactUnavailable('HUD runtime artifact package directories are unavailable')
  }
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    !distMetadata.isDirectory() ||
    distMetadata.isSymbolicLink() ||
    !samePath(packageRoot, canonicalPackageRoot) ||
    !samePath(entrypointPath, expectedEntrypoint) ||
    !samePath(realpathSync(distRoot), distRoot)
  ) {
    return artifactUnavailable('HUD runtime artifact package boundary is invalid')
  }

  const packageJson = readStableFile(
    resolve(canonicalPackageRoot, 'package.json'),
    canonicalPackageRoot,
    MAX_PACKAGE_JSON_BYTES,
  )
  let packageValue: unknown
  try {
    packageValue = JSON.parse(packageJson.bytes.toString('utf8'))
  } catch {
    return artifactUnavailable('HUD runtime artifact package metadata is invalid')
  }
  if (packageValue === null || typeof packageValue !== 'object' || Array.isArray(packageValue)) {
    return artifactUnavailable('HUD runtime artifact package metadata is invalid')
  }
  const packageRecord = packageValue as Record<string, unknown>
  if (
    packageRecord.name !== HUD_PACKAGE_NAME ||
    typeof packageRecord.version !== 'string' ||
    packageRecord.version.length > 128 ||
    !PACKAGE_VERSION.test(packageRecord.version)
  ) {
    return artifactUnavailable('HUD runtime artifact package identity is invalid')
  }
  const packageJsonSha256 = sha256(packageJson.bytes)

  const pending = [expectedEntrypoint]
  const visited = new Set<string>()
  const files: HudRuntimeArtifactFile[] = []
  let totalBytes = 0
  while (pending.length > 0) {
    const requestedPath = pending.shift()
    if (requestedPath === undefined) break
    const stable = readStableFile(requestedPath, distRoot, MAX_ARTIFACT_FILE_BYTES)
    const relativePath = relative(canonicalPackageRoot, stable.canonicalPath).replaceAll(sep, '/')
    if (!validRelativeArtifactPath(relativePath)) {
      return artifactUnavailable('HUD runtime artifact contains an invalid relative path')
    }
    if (visited.has(relativePath)) continue
    if (visited.size >= MAX_ARTIFACT_FILES) {
      return artifactUnavailable('HUD runtime artifact closure exceeds its file limit')
    }
    visited.add(relativePath)
    totalBytes += stable.bytes.length
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
      return artifactUnavailable('HUD runtime artifact closure exceeds its size limit')
    }
    files.push(
      Object.freeze({
        relativePath,
        sha256: sha256(stable.bytes),
        bytes: stable.bytes.length,
      }),
    )
    const source = decodeJavascript(stable.bytes)
    for (const specifier of relativeModuleSpecifiers(source)) {
      pending.push(resolveRelativeJavascriptImport(stable.canonicalPath, specifier, distRoot))
    }
  }
  const sortedFiles = Object.freeze([...files].sort(compareArtifactFiles))
  const packageJsonAfter = readStableFile(
    resolve(canonicalPackageRoot, 'package.json'),
    canonicalPackageRoot,
    MAX_PACKAGE_JSON_BYTES,
  )
  if (
    packageJsonAfter.bytes.length !== packageJson.bytes.length ||
    sha256(packageJsonAfter.bytes) !== packageJsonSha256
  ) {
    return artifactUnavailable('HUD runtime artifact package metadata changed during inspection')
  }
  for (const file of sortedFiles) {
    const verified = readStableFile(
      resolve(canonicalPackageRoot, ...file.relativePath.split('/')),
      distRoot,
      MAX_ARTIFACT_FILE_BYTES,
    )
    const verifiedRelativePath = relative(canonicalPackageRoot, verified.canonicalPath).replaceAll(
      sep,
      '/',
    )
    if (
      verifiedRelativePath !== file.relativePath ||
      verified.bytes.length !== file.bytes ||
      sha256(verified.bytes) !== file.sha256
    ) {
      return artifactUnavailable('HUD runtime artifact closure changed during inspection')
    }
  }
  let rootAfter: BigIntStats
  let distAfter: BigIntStats
  try {
    rootAfter = lstatSync(canonicalPackageRoot, { bigint: true })
    distAfter = lstatSync(distRoot, { bigint: true })
  } catch {
    return artifactUnavailable('HUD runtime artifact package boundary changed during inspection')
  }
  if (
    !sameSnapshot(rootMetadata, rootAfter) ||
    !sameSnapshot(distMetadata, distAfter) ||
    !samePath(realpathSync(canonicalPackageRoot), canonicalPackageRoot) ||
    !samePath(realpathSync(distRoot), distRoot)
  ) {
    return artifactUnavailable('HUD runtime artifact package boundary changed during inspection')
  }
  return parseHudRuntimeArtifactIdentity({
    schemaVersion: HUD_RUNTIME_ARTIFACT_SCHEMA,
    packageName: HUD_PACKAGE_NAME,
    packageVersion: packageRecord.version,
    entrypoint: HUD_ENTRYPOINT,
    files: sortedFiles,
    bundleSha256: hudRuntimeArtifactBundleSha256(sortedFiles),
  })
}

/** Hash the loaded HUD ESM entrypoint and every relative JavaScript import in its package closure. */
export function inspectHudRuntimeArtifact(entrypointUrl: URL): HudRuntimeArtifactIdentity {
  try {
    return inspectRuntimeArtifact(entrypointUrl)
  } catch (error: unknown) {
    if (error instanceof LubanError) throw error
    return artifactUnavailable('HUD runtime artifact could not be inspected')
  }
}
