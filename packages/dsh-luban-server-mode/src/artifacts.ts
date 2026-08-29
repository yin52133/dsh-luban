import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ArtifactRef } from '@luban/core'
import { LubanError } from '@luban/core'

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export class ArtifactManager {
  readonly #root: string

  public constructor(root: string) {
    this.#root = resolve(root)
  }

  public jobDirectory(jobId: string): string {
    if (!/^[a-f0-9-]{36}$/u.test(jobId))
      throw new LubanError('E_INVALID_INPUT', 'job id is invalid')
    const directory = resolve(this.#root, jobId)
    if (!inside(this.#root, directory))
      throw new LubanError('E_INVALID_INPUT', 'job path escapes artifacts')
    return directory
  }

  public async discover(jobId: string): Promise<readonly ArtifactRef[]> {
    const directory = this.jobDirectory(jobId)
    try {
      const artifacts: ArtifactRef[] = []
      await this.#walk(directory, directory, artifacts)
      return artifacts.sort((left, right): number => left.name.localeCompare(right.name))
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT')
        return []
      throw error
    }
  }

  public resolveArtifact(jobId: string, artifact: ArtifactRef): string {
    const root = this.jobDirectory(jobId)
    const path = resolve(artifact.path)
    if (!inside(root, path))
      throw new LubanError('E_INVALID_INPUT', 'artifact path escapes its run')
    return path
  }

  public async secureFile(
    jobId: string,
    artifact: ArtifactRef,
  ): Promise<{ readonly path: string; readonly sizeBytes: number }> {
    const root = this.jobDirectory(jobId)
    const candidate = this.resolveArtifact(jobId, artifact)
    const metadata = await lstat(candidate)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new LubanError('E_NOT_FOUND', 'artifact is not a regular file')
    }
    const [resolvedRoot, resolvedFile] = await Promise.all([realpath(root), realpath(candidate)])
    if (!inside(resolvedRoot, resolvedFile)) {
      throw new LubanError('E_INVALID_INPUT', 'artifact resolves outside its run')
    }
    return { path: resolvedFile, sizeBytes: metadata.size }
  }

  public async prune(jobIds: readonly string[]): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    for (const jobId of jobIds) {
      await rm(this.jobDirectory(jobId), { recursive: true, force: true })
    }
  }

  async #walk(root: string, directory: string, output: ArtifactRef[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) continue
      if (metadata.isDirectory()) {
        await this.#walk(root, path, output)
      } else if (metadata.isFile()) {
        if (output.length >= 20_000) throw new LubanError('E_QUOTA_EXCEEDED', 'too many artifacts')
        output.push({
          name: relative(root, path).split(sep).join('/'),
          path,
          sizeBytes: metadata.size,
        })
      }
    }
  }
}

export interface SignedArtifactLink {
  readonly expires: number
  readonly signature: string
}

/** In-memory HMAC signer; links also require an authenticated M01 session. */
export class ArtifactLinkSigner {
  readonly #key: Buffer
  readonly #ttlSec: number
  readonly #now: () => number

  public constructor(options: {
    readonly key?: Buffer
    readonly ttlSec: number
    readonly now?: () => number
  }) {
    this.#key = options.key === undefined ? randomBytes(32) : Buffer.from(options.key)
    this.#ttlSec = options.ttlSec
    this.#now = options.now ?? Date.now
  }

  public sign(jobId: string, name: string): SignedArtifactLink {
    const expires = Math.floor(this.#now() / 1_000) + this.#ttlSec
    return { expires, signature: this.#digest(jobId, name, expires) }
  }

  public verify(jobId: string, name: string, expires: number, signature: string): boolean {
    const now = Math.floor(this.#now() / 1_000)
    if (!Number.isSafeInteger(expires) || expires < now || expires > now + this.#ttlSec)
      return false
    const expected = Buffer.from(this.#digest(jobId, name, expires), 'base64url')
    let supplied: Buffer
    try {
      supplied = Buffer.from(signature, 'base64url')
    } catch {
      return false
    }
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
  }

  #digest(jobId: string, name: string, expires: number): string {
    return createHmac('sha256', this.#key)
      .update(`${jobId}\0${name}\0${String(expires)}`)
      .digest('base64url')
  }
}

export function attachmentName(name: string): string {
  return basename(name).replaceAll(/[^\x20-\x7E]|["\\]/gu, '_') || 'artifact.bin'
}
