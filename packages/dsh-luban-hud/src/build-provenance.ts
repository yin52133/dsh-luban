import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LubanError } from 'dsh-luban-core'
import type { HudRuntimeArtifactIdentity } from './runtime-artifact.js'

declare const __DSH_LUBAN_HUD_BUILD_HEAD__: string | undefined
declare const __DSH_LUBAN_HUD_BUILD_ID__: string | undefined

export const HUD_BUILD_PROVENANCE_SCHEMA = 'dsh-luban/hud-build-provenance/v1' as const

const BUILD_MANIFEST = 'build-provenance.json'
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_ARTIFACTS = 512
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const NO_FOLLOW = constants.O_NOFOLLOW

export interface HudLoadedBuildIdentity {
  readonly gitHead: string
  readonly buildId: string
}

export interface HudBuildProvenance {
  readonly schemaVersion: typeof HUD_BUILD_PROVENANCE_SCHEMA
  readonly gitHead: string
  readonly buildId: string
  readonly dirty: false
  readonly runtime: 'repo-dist'
  readonly manifestSha256: string
  readonly runtimeBundleSha256: string
}

interface StableFile {
  readonly bytes: Buffer
  readonly metadata: BigIntStats
}

const LOADED_BUILD_IDENTITY: HudLoadedBuildIdentity | undefined =
  typeof __DSH_LUBAN_HUD_BUILD_HEAD__ === 'string' &&
  GIT_SHA.test(__DSH_LUBAN_HUD_BUILD_HEAD__) &&
  typeof __DSH_LUBAN_HUD_BUILD_ID__ === 'string' &&
  BUILD_ID.test(__DSH_LUBAN_HUD_BUILD_ID__)
    ? Object.freeze({
        gitHead: __DSH_LUBAN_HUD_BUILD_HEAD__,
        buildId: __DSH_LUBAN_HUD_BUILD_ID__,
      })
    : undefined

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === ''
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

function readStableFile(path: string, maximumBytes: number): StableFile {
  const before = lstatSync(path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1n ||
    before.size > BigInt(maximumBytes) ||
    !samePath(realpathSync(path), path)
  ) {
    throw new Error('build provenance file is invalid')
  }
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || !sameSnapshot(before, opened)) {
      throw new Error('build provenance file changed before read')
    }
    const bytes = readFileSync(descriptor)
    const openedAfter = fstatSync(descriptor, { bigint: true })
    const after = lstatSync(path, { bigint: true })
    if (
      bytes.byteLength !== Number(opened.size) ||
      !sameSnapshot(opened, openedAfter) ||
      !sameSnapshot(openedAfter, after) ||
      !samePath(realpathSync(path), path)
    ) {
      throw new Error('build provenance file changed during read')
    }
    return { bytes, metadata: openedAfter }
  } finally {
    closeSync(descriptor)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === expected.length && expected.every((key): boolean => Object.hasOwn(value, key))
  )
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

function safeArtifactPath(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 512 &&
    !containsControlCharacter(value) &&
    !value.includes('\\') &&
    value.split('/').every((part): boolean => part !== '' && part !== '.' && part !== '..')
  )
}

/** Parse the compact loaded-build identity carried by mounted HUD evidence. */
export function parseHudBuildProvenance(value: unknown): HudBuildProvenance {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'gitHead',
      'buildId',
      'dirty',
      'runtime',
      'manifestSha256',
      'runtimeBundleSha256',
    ]) ||
    value.schemaVersion !== HUD_BUILD_PROVENANCE_SCHEMA ||
    typeof value.gitHead !== 'string' ||
    !GIT_SHA.test(value.gitHead) ||
    typeof value.buildId !== 'string' ||
    !BUILD_ID.test(value.buildId) ||
    value.dirty !== false ||
    value.runtime !== 'repo-dist' ||
    typeof value.manifestSha256 !== 'string' ||
    !SHA256.test(value.manifestSha256) ||
    typeof value.runtimeBundleSha256 !== 'string' ||
    !SHA256.test(value.runtimeBundleSha256)
  ) {
    throw new TypeError('HUD build provenance is invalid')
  }
  return Object.freeze({
    schemaVersion: HUD_BUILD_PROVENANCE_SCHEMA,
    gitHead: value.gitHead,
    buildId: value.buildId,
    dirty: false,
    runtime: 'repo-dist',
    manifestSha256: value.manifestSha256,
    runtimeBundleSha256: value.runtimeBundleSha256,
  })
}

function collectDistributionPaths(directory: string, root = directory): readonly string[] {
  const paths: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name)
    const relativePath = relative(root, absolute).split(sep).join('/')
    if (entry.isSymbolicLink()) throw new Error('build distribution contains a symbolic link')
    if (entry.isDirectory()) {
      paths.push(...collectDistributionPaths(absolute, root))
      continue
    }
    if (!entry.isFile()) throw new Error('build distribution contains an unsupported entry')
    paths.push(relativePath)
  }
  return paths.sort((left, right): number => (left === right ? 0 : left < right ? -1 : 1))
}

/** Verify the loaded HUD module and its complete distribution against a create-once build manifest. */
export function inspectHudBuildProvenance(
  entrypointUrl: URL,
  runtimeArtifact: HudRuntimeArtifactIdentity,
  loadedIdentity: HudLoadedBuildIdentity | undefined = LOADED_BUILD_IDENTITY,
): HudBuildProvenance {
  try {
    if (
      entrypointUrl.protocol !== 'file:' ||
      entrypointUrl.username !== '' ||
      entrypointUrl.password !== '' ||
      entrypointUrl.search !== '' ||
      entrypointUrl.hash !== '' ||
      loadedIdentity === undefined
    ) {
      throw new Error('loaded HUD build identity is unavailable')
    }
    const entrypoint = fileURLToPath(entrypointUrl)
    const distribution = resolve(dirname(entrypoint))
    const packageRoot = resolve(distribution, '..')
    if (
      !samePath(entrypoint, resolve(distribution, 'index.js')) ||
      !samePath(realpathSync(distribution), distribution) ||
      !samePath(realpathSync(packageRoot), packageRoot)
    ) {
      throw new Error('loaded HUD entrypoint is outside package dist')
    }
    const manifestPath = resolve(distribution, BUILD_MANIFEST)
    const manifestFile = readStableFile(manifestPath, MAX_MANIFEST_BYTES)
    const decoded: unknown = JSON.parse(manifestFile.bytes.toString('utf8'))
    if (
      !isRecord(decoded) ||
      !hasExactKeys(decoded, ['schemaVersion', 'gitHead', 'buildId', 'dirty', 'artifacts']) ||
      decoded.schemaVersion !== HUD_BUILD_PROVENANCE_SCHEMA ||
      typeof decoded.gitHead !== 'string' ||
      !GIT_SHA.test(decoded.gitHead) ||
      typeof decoded.buildId !== 'string' ||
      !BUILD_ID.test(decoded.buildId) ||
      decoded.dirty !== false ||
      decoded.gitHead !== loadedIdentity.gitHead ||
      decoded.buildId !== loadedIdentity.buildId ||
      !Array.isArray(decoded.artifacts) ||
      decoded.artifacts.length < 1 ||
      decoded.artifacts.length > MAX_ARTIFACTS
    ) {
      throw new Error('HUD build manifest identity is invalid')
    }
    const artifactPaths = new Set<string>()
    const artifacts = new Map<string, { readonly sha256: string; readonly bytes: number }>()
    let totalBytes = 0
    for (const candidate of decoded.artifacts) {
      if (
        !isRecord(candidate) ||
        !hasExactKeys(candidate, ['path', 'sha256', 'bytes']) ||
        typeof candidate.path !== 'string' ||
        !safeArtifactPath(candidate.path) ||
        candidate.path === BUILD_MANIFEST ||
        artifactPaths.has(candidate.path) ||
        typeof candidate.sha256 !== 'string' ||
        !SHA256.test(candidate.sha256) ||
        typeof candidate.bytes !== 'number' ||
        !Number.isSafeInteger(candidate.bytes) ||
        candidate.bytes < 1 ||
        candidate.bytes > MAX_ARTIFACT_BYTES
      ) {
        throw new Error('HUD build manifest artifact is invalid')
      }
      const artifactPath = resolve(distribution, ...candidate.path.split('/'))
      const artifactRelative = relative(distribution, artifactPath)
      if (
        isAbsolute(artifactRelative) ||
        artifactRelative === '..' ||
        artifactRelative.startsWith(`..${sep}`)
      ) {
        throw new Error('HUD build artifact escaped distribution')
      }
      const artifact = readStableFile(artifactPath, MAX_ARTIFACT_BYTES)
      if (
        artifact.bytes.byteLength !== candidate.bytes ||
        sha256(artifact.bytes) !== candidate.sha256
      ) {
        throw new Error('HUD build artifact digest mismatch')
      }
      totalBytes += candidate.bytes
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
        throw new Error('HUD build artifact budget exceeded')
      }
      artifactPaths.add(candidate.path)
      artifacts.set(candidate.path, { sha256: candidate.sha256, bytes: candidate.bytes })
    }
    const currentPaths = collectDistributionPaths(distribution).filter(
      (path): boolean => path !== BUILD_MANIFEST,
    )
    if (
      currentPaths.length !== artifactPaths.size ||
      currentPaths.some((path): boolean => !artifactPaths.has(path))
    ) {
      throw new Error('HUD distribution contents do not match build manifest')
    }
    for (const runtimeFile of runtimeArtifact.files) {
      if (!runtimeFile.relativePath.startsWith('dist/')) {
        throw new Error('HUD runtime closure path is outside distribution')
      }
      const path = runtimeFile.relativePath.slice('dist/'.length)
      if (!safeArtifactPath(path)) {
        throw new Error('HUD runtime closure path is invalid')
      }
      const artifact = artifacts.get(path)
      if (artifact === undefined) {
        throw new Error('HUD runtime closure is absent from build manifest')
      }
      if (artifact.sha256 !== runtimeFile.sha256 || artifact.bytes !== runtimeFile.bytes) {
        throw new Error('HUD runtime closure does not match build manifest')
      }
    }
    const manifestAfter = readStableFile(manifestPath, MAX_MANIFEST_BYTES)
    if (
      !sameSnapshot(manifestFile.metadata, manifestAfter.metadata) ||
      sha256(manifestAfter.bytes) !== sha256(manifestFile.bytes)
    ) {
      throw new Error('HUD build manifest changed during inspection')
    }
    return Object.freeze({
      schemaVersion: HUD_BUILD_PROVENANCE_SCHEMA,
      gitHead: loadedIdentity.gitHead,
      buildId: loadedIdentity.buildId,
      dirty: false,
      runtime: 'repo-dist',
      manifestSha256: sha256(manifestFile.bytes),
      runtimeBundleSha256: runtimeArtifact.bundleSha256,
    })
  } catch (error: unknown) {
    throw new LubanError('E_UNAVAILABLE', 'HUD is not a clean loaded build of repository HEAD', {
      retriable: true,
      cause: error,
    })
  }
}
