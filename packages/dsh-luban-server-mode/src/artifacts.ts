import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ArtifactRef } from '@yin52133/dsh-luban-core'
import { LubanError } from '@yin52133/dsh-luban-core'
import { canonicalExistingWithin } from './path-boundary.js'

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
    const job = await this.#safeJobDirectory(jobId)
    if (job === undefined) return []
    const artifacts: ArtifactRef[] = []
    await this.#walk(job.lexical, job.lexical, artifacts)
    return artifacts.sort((left, right): number => left.name.localeCompare(right.name))
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
    const job = await this.#safeJobDirectory(jobId)
    if (job === undefined) throw new LubanError('E_NOT_FOUND', 'artifact run was not found')
    const candidate = this.resolveArtifact(jobId, artifact)
    const metadata = await lstat(candidate)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new LubanError('E_NOT_FOUND', 'artifact is not a regular file')
    }
    const resolvedFile = await realpath(candidate)
    if (!inside(job.canonical, resolvedFile)) {
      throw new LubanError('E_INVALID_INPUT', 'artifact resolves outside its run')
    }
    return { path: resolvedFile, sizeBytes: metadata.size }
  }

  public async prune(jobIds: readonly string[]): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    for (const jobId of jobIds) {
      const job = await this.#safeJobDirectory(jobId)
      if (job !== undefined) await rm(job.canonical, { recursive: true, force: true })
    }
  }

  async #safeJobDirectory(
    jobId: string,
  ): Promise<{ readonly lexical: string; readonly canonical: string } | undefined> {
    const lexical = this.jobDirectory(jobId)
    let metadata: Stats
    try {
      metadata = await lstat(lexical)
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
        return undefined
      }
      throw error
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new LubanError(
        'E_INVALID_INPUT',
        'artifact job directory cannot be a symbolic link, junction, or non-directory',
      )
    }
    const canonical = await canonicalExistingWithin(
      [this.#root],
      lexical,
      'artifact job directory resolves outside the artifact root',
    )
    return { lexical, canonical }
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
