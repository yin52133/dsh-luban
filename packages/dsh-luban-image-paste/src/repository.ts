import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  AccountId,
  CleanupReport,
  Clock,
  JsonCodec,
  SessionId,
} from '@yin52133/dsh-luban-core'
import { AtomicJsonStore, LubanError, asAccountId, asSessionId } from '@yin52133/dsh-luban-core'
import type { CompressionReport, ImageMime, ImageSource, StoredImage } from './types.js'

interface ImageLedger {
  readonly version: 1
  readonly images: readonly StoredImage[]
}

interface DirectoryIdentity {
  readonly device: number | bigint
  readonly inode: number | bigint
  readonly birthtimeMs: number | bigint
}

const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000
const UPLOAD_TEMP_NAME =
  /^\.upload-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/iu
const GENERATED_IMAGE_NAME = /^\d{8}-.+-[1-9]\d*\.(?:png|jpg|webp)$/u

export interface StoreImageInput {
  /** Ownership is assigned by the authenticated service boundary. */
  readonly accountId: AccountId
  readonly bytes: Uint8Array
  readonly extension: 'png' | 'jpg' | 'webp'
  readonly mime: ImageMime
  readonly source: ImageSource
  readonly nameHint?: string
  readonly compression: CompressionReport
}

export interface AttachmentRepositoryOptions {
  readonly workspaceRoot: string
  readonly attachDir: string
  readonly clock: Clock
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = (error as Readonly<{ code?: unknown }>).code
  return typeof value === 'string' ? value : undefined
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${label} is invalid`)
  return value
}

function integerValue(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as number
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child !== '' && !child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child)
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === ''
}

function directoryIdentity(info: Awaited<ReturnType<typeof lstat>>): DirectoryIdentity {
  return {
    device: info.dev,
    inode: info.ino,
    birthtimeMs: info.birthtimeMs,
  }
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeMs === right.birthtimeMs
  )
}

function compressionReport(value: unknown): CompressionReport {
  const row = record(value, 'compression')
  const status = row.status
  if (
    status !== 'disabled' &&
    status !== 'not-needed' &&
    status !== 'compressed' &&
    status !== 'unavailable' &&
    status !== 'failed'
  ) {
    throw new TypeError('compression.status is invalid')
  }
  const width =
    row.width === undefined ? undefined : integerValue(row.width, 'compression.width', 1)
  const height =
    row.height === undefined ? undefined : integerValue(row.height, 'compression.height', 1)
  const reason =
    row.reason === undefined ? undefined : stringValue(row.reason, 'compression.reason')
  return {
    status,
    originalBytes: integerValue(row.originalBytes, 'compression.originalBytes', 1),
    outputBytes: integerValue(row.outputBytes, 'compression.outputBytes', 1),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(reason === undefined ? {} : { reason }),
  }
}

function storedImage(value: unknown, workspaceRoot: string, attachRoot: string): StoredImage {
  const row = record(value, 'image')
  const id = stringValue(row.id, 'image.id')
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(id)) throw new TypeError('image.id is invalid')
  const relPath = stringValue(row.relPath, 'image.relPath').replaceAll('\\', '/')
  const absPath = resolve(workspaceRoot, relPath)
  if (!isInside(attachRoot, absPath)) throw new TypeError('image.relPath leaves attachDir')
  const sha256 = stringValue(row.sha256, 'image.sha256')
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new TypeError('image.sha256 is invalid')
  const source = row.source
  if (source !== 'paste' && source !== 'drop' && source !== 'clipboard-cli') {
    throw new TypeError('image.source is invalid')
  }
  const mime = row.mime
  if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') {
    throw new TypeError('image.mime is invalid')
  }
  if (
    !Array.isArray(row.referencedBy) ||
    !row.referencedBy.every((item) => typeof item === 'string')
  ) {
    throw new TypeError('image.referencedBy is invalid')
  }
  return {
    ...(row.accountId === undefined
      ? {}
      : { accountId: asAccountId(stringValue(row.accountId, 'image.accountId')) }),
    id,
    relPath,
    absPath,
    sha256,
    source,
    referencedBy: [...new Set(row.referencedBy)].map(asSessionId),
    createdAt: integerValue(row.createdAt, 'image.createdAt'),
    mime,
    bytes: integerValue(row.bytes, 'image.bytes', 1),
    originalName: stringValue(row.originalName, 'image.originalName'),
    compression: compressionReport(row.compression),
  }
}

function ledgerCodec(workspaceRoot: string, attachRoot: string): JsonCodec<ImageLedger> {
  return {
    decode(value: unknown): ImageLedger {
      const row = record(value, 'image ledger')
      if (row.version !== 1 || !Array.isArray(row.images)) {
        throw new TypeError('image ledger format is invalid')
      }
      return {
        version: 1,
        images: row.images.map((item) => storedImage(item, workspaceRoot, attachRoot)),
      }
    },
    encode(value: ImageLedger): unknown {
      return value
    },
  }
}

function safeSlug(nameHint: string | undefined): string {
  const trimmed = nameHint?.trim()
  const withoutExtension = basename(
    trimmed === undefined || trimmed === '' ? 'image' : trimmed,
  ).replace(/\.[^.]+$/u, '')
  const slug = withoutExtension
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 60)
  const candidate = slug === '' ? 'image' : slug
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(candidate)
    ? `image-${candidate}`
    : candidate
}

function dateStamp(epoch: number): string {
  const date = new Date(epoch)
  return [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
  ].join('')
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

/** Durable attachment repository with canonical workspace boundaries and atomic file publication. */
export class AttachmentRepository {
  readonly #workspaceRoot: string
  readonly #attachRoot: string
  readonly #clock: Clock
  readonly #store: AtomicJsonStore<ImageLedger>
  readonly #identity: DirectoryIdentity

  private constructor(
    workspaceRoot: string,
    attachRoot: string,
    clock: Clock,
    store: AtomicJsonStore<ImageLedger>,
    identity: DirectoryIdentity,
  ) {
    this.#workspaceRoot = workspaceRoot
    this.#attachRoot = attachRoot
    this.#clock = clock
    this.#store = store
    this.#identity = identity
  }

  public static async create(options: AttachmentRepositoryOptions): Promise<AttachmentRepository> {
    const workspaceInfo = await stat(options.workspaceRoot).catch((error: unknown) => {
      throw new LubanError('E_IO', 'workspaceRoot is unavailable', { cause: error })
    })
    if (!workspaceInfo.isDirectory())
      throw new LubanError('E_INVALID_INPUT', 'workspaceRoot must be a directory')
    const workspaceRoot = await realpath(options.workspaceRoot)
    const requestedAttachRoot = resolve(workspaceRoot, options.attachDir)
    if (!isInside(workspaceRoot, requestedAttachRoot)) {
      throw new LubanError('E_INVALID_INPUT', 'attachDir must stay inside workspaceRoot')
    }
    await mkdir(requestedAttachRoot, { recursive: true, mode: 0o700 })
    const attachRoot = await realpath(requestedAttachRoot)
    if (!isInside(workspaceRoot, attachRoot)) {
      throw new LubanError('E_INVALID_INPUT', 'attachDir resolves outside workspaceRoot')
    }
    const attachInfo = await lstat(attachRoot)
    if (!attachInfo.isDirectory() || attachInfo.isSymbolicLink()) {
      throw new LubanError('E_INVALID_INPUT', 'attachDir must resolve to a directory')
    }
    const identity = directoryIdentity(attachInfo)
    const store = new AtomicJsonStore<ImageLedger>({
      filePath: resolve(attachRoot, '.luban-image-index.json'),
      codec: ledgerCodec(workspaceRoot, attachRoot),
      initial: (): ImageLedger => ({ version: 1, images: [] }),
      backupCount: 3,
    })
    const ledger = await store.read()
    const repository = new AttachmentRepository(
      workspaceRoot,
      attachRoot,
      options.clock,
      store,
      identity,
    )
    await repository.#assertRoot()
    await repository.#recoverOrphans(ledger)
    return repository
  }

  public get workspaceRoot(): string {
    return this.#workspaceRoot
  }

  public get attachRoot(): string {
    return this.#attachRoot
  }

  public async store(input: StoreImageInput): Promise<StoredImage> {
    await this.#assertRoot()
    const createdAt = this.#clock.now()
    const originalName = safeSlug(input.nameHint)
    const stem = `${dateStamp(createdAt)}-${originalName}`
    const temporary = resolve(this.#attachRoot, `.upload-${randomUUID()}.tmp`)
    let target: string | undefined
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(input.bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }

      await this.#assertRoot()
      for (let sequence = 1; sequence <= 100_000; sequence += 1) {
        const candidate = resolve(
          this.#attachRoot,
          `${stem}-${String(sequence)}.${input.extension}`,
        )
        try {
          await link(temporary, candidate)
          target = candidate
          break
        } catch (error: unknown) {
          if (errorCode(error) !== 'EEXIST') throw error
        }
      }
      if (target === undefined) {
        throw new LubanError('E_IO', `No attachment filename is available for ${stem}`)
      }
      await rm(temporary, { force: true })

      const relPath = relative(this.#workspaceRoot, target).replaceAll('\\', '/')
      const image: StoredImage = {
        accountId: input.accountId,
        id: randomUUID(),
        relPath,
        absPath: target,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        source: input.source,
        referencedBy: [],
        createdAt,
        mime: input.mime,
        bytes: input.bytes.byteLength,
        originalName,
        compression: input.compression,
      }
      await this.#assertRoot()
      await this.#store.update((ledger): ImageLedger => ({
        version: 1,
        images: [image, ...ledger.images],
      }))
      await this.#assertRoot()
      return image
    } catch (error: unknown) {
      await this.#bestEffortRemove(temporary)
      if (target !== undefined) await this.#bestEffortRemove(target)
      throw error
    }
  }

  public async list(
    accountId: AccountId,
    sessionId?: SessionId,
    limit = 50,
  ): Promise<readonly StoredImage[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new LubanError('E_INVALID_INPUT', 'recent image limit must be between 1 and 500')
    }
    await this.#assertRoot()
    const ledger = await this.#store.read()
    await this.#assertRoot()
    return ledger.images
      .filter(
        (image): boolean =>
          image.accountId === accountId &&
          (sessionId === undefined || image.referencedBy.includes(sessionId)),
      )
      .toSorted((left, right): number => right.createdAt - left.createdAt)
      .slice(0, limit)
  }

  public async findByIdentity(
    accountId: AccountId,
    relPath: string,
    sha256: string,
  ): Promise<StoredImage | null> {
    await this.#assertRoot()
    const ledger = await this.#store.read()
    await this.#assertRoot()
    return (
      ledger.images.find(
        (image): boolean =>
          image.accountId === accountId && image.relPath === relPath && image.sha256 === sha256,
      ) ?? null
    )
  }

  public async get(accountId: AccountId, id: string): Promise<StoredImage | null> {
    await this.#assertRoot()
    const ledger = await this.#store.read()
    await this.#assertRoot()
    return (
      ledger.images.find((image): boolean => image.accountId === accountId && image.id === id) ??
      null
    )
  }

  public async content(
    accountId: AccountId,
    id: string,
  ): Promise<{ readonly image: StoredImage; readonly bytes: Uint8Array }> {
    const image = await this.get(accountId, id)
    if (image === null) throw new LubanError('E_NOT_FOUND', `Image ${id} was not found`)
    if (!(await regularFile(image.absPath))) {
      throw new LubanError('E_NOT_FOUND', `Attachment ${image.relPath} is unavailable`)
    }
    await this.#assertRoot()
    const resolved = await realpath(image.absPath)
    if (!isInside(this.#attachRoot, resolved)) {
      throw new LubanError('E_IO', 'Attachment resolves outside attachDir')
    }
    const bytes = new Uint8Array(await readFile(resolved))
    const checksum = createHash('sha256').update(bytes).digest('hex')
    if (checksum !== image.sha256) {
      throw new LubanError('E_IO', `Attachment checksum changed for ${image.relPath}`)
    }
    return { image, bytes }
  }

  public async addReference(
    accountId: AccountId,
    id: string,
    sessionId: SessionId,
  ): Promise<boolean> {
    let added = false
    await this.#assertRoot()
    await this.#store.update((ledger): ImageLedger => {
      if (
        !ledger.images.some((image): boolean => image.accountId === accountId && image.id === id)
      ) {
        throw new LubanError('E_NOT_FOUND', `Image ${id} was not found`)
      }
      const images = ledger.images.map((image): StoredImage => {
        if (image.accountId !== accountId || image.id !== id) return image
        if (image.referencedBy.includes(sessionId)) return image
        added = true
        return { ...image, referencedBy: [...image.referencedBy, sessionId] }
      })
      return { version: 1, images }
    })
    await this.#assertRoot()
    return added
  }

  public async removeReference(
    accountId: AccountId,
    id: string,
    sessionId: SessionId,
  ): Promise<void> {
    await this.#assertRoot()
    await this.#store.update((ledger): ImageLedger => ({
      version: 1,
      images: ledger.images.map((image): StoredImage =>
        image.accountId === accountId && image.id === id
          ? {
              ...image,
              referencedBy: image.referencedBy.filter((value): boolean => value !== sessionId),
            }
          : image,
      ),
    }))
    await this.#assertRoot()
  }

  public async delete(accountId: AccountId, id: string): Promise<void> {
    await this.#assertRoot()
    let deleted: StoredImage | undefined
    await this.#store.update((ledger): ImageLedger => {
      const image = ledger.images.find(
        (candidate): boolean => candidate.accountId === accountId && candidate.id === id,
      )
      if (image === undefined) throw new LubanError('E_NOT_FOUND', `Image ${id} was not found`)
      if (image.referencedBy.length > 0) {
        throw new LubanError('E_INVALID_TRANSITION', 'Referenced attachments cannot be deleted')
      }
      deleted = image
      return {
        version: 1,
        images: ledger.images.filter(
          (candidate): boolean => candidate.accountId !== accountId || candidate.id !== id,
        ),
      }
    })
    if (deleted === undefined) {
      throw new LubanError('E_IO', `Image ${id} deletion was not committed`)
    }
    if (await regularFile(deleted.absPath)) {
      await this.#assertRoot()
      await rm(deleted.absPath)
    }
    await this.#assertRoot()
  }

  public async cleanup(
    accountId: AccountId,
    retainDays: number,
    dryRun = false,
  ): Promise<CleanupReport> {
    return this.#cleanup(retainDays, dryRun, accountId)
  }

  /** Sweep every owned account for the process-level retention timer; legacy unowned rows remain. */
  public async cleanupAllAccounts(retainDays: number, dryRun = false): Promise<CleanupReport> {
    return this.#cleanup(retainDays, dryRun)
  }

  async #cleanup(
    retainDays: number,
    dryRun: boolean,
    accountId?: AccountId,
  ): Promise<CleanupReport> {
    const cutoff = this.#clock.now() - retainDays * 24 * 60 * 60 * 1_000
    await this.#assertRoot()
    const initial = await this.#store.read()
    await this.#assertRoot()
    const candidates = initial.images
      .filter(
        (image): boolean =>
          image.accountId !== undefined &&
          (accountId === undefined || image.accountId === accountId) &&
          image.createdAt < cutoff &&
          image.referencedBy.length === 0,
      )
      .map((image): string => image.relPath)
    const retainedReferenced = initial.images
      .filter(
        (image): boolean =>
          image.accountId !== undefined &&
          (accountId === undefined || image.accountId === accountId) &&
          image.createdAt < cutoff &&
          image.referencedBy.length > 0,
      )
      .map((image): string => image.relPath)
    if (dryRun || candidates.length === 0) {
      return { candidates, removed: [], retainedReferenced, errors: [] }
    }

    const committed: StoredImage[] = []
    await this.#store.update((ledger): ImageLedger => {
      const kept: StoredImage[] = []
      for (const image of ledger.images) {
        if (
          image.accountId === undefined ||
          (accountId !== undefined && image.accountId !== accountId) ||
          image.createdAt >= cutoff ||
          image.referencedBy.length > 0
        ) {
          kept.push(image)
          continue
        }
        committed.push(image)
      }
      return { version: 1, images: kept }
    })

    const removed: string[] = []
    const errors: { path: string; message: string }[] = []
    for (const image of committed) {
      try {
        if (await regularFile(image.absPath)) {
          await this.#assertRoot()
          await rm(image.absPath)
        }
        removed.push(image.relPath)
      } catch (error: unknown) {
        errors.push({
          path: image.relPath,
          message: error instanceof Error ? error.message : 'Unable to remove attachment',
        })
      }
    }
    await this.#assertRoot()
    return { candidates, removed, retainedReferenced, errors }
  }

  async #assertRoot(): Promise<void> {
    try {
      const [info, resolved] = await Promise.all([
        lstat(this.#attachRoot),
        realpath(this.#attachRoot),
      ])
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !samePath(this.#attachRoot, resolved) ||
        !sameDirectoryIdentity(this.#identity, directoryIdentity(info))
      ) {
        throw new Error('attachment directory identity changed')
      }
    } catch (error: unknown) {
      throw new LubanError('E_IO', 'Attachment directory identity changed or is unavailable', {
        cause: error,
      })
    }
  }

  async #bestEffortRemove(path: string): Promise<void> {
    try {
      await this.#assertRoot()
      if (!isInside(this.#attachRoot, path)) return
      await rm(path, { force: true })
    } catch {
      // Preserve the primary failure and never remove through an unverified root.
    }
  }

  async #recoverOrphans(ledger: ImageLedger): Promise<void> {
    const indexedPaths = new Set(ledger.images.map((image): string => image.absPath))
    const cutoff = this.#clock.now() - ORPHAN_GRACE_MS
    const entries = await readdir(this.#attachRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!UPLOAD_TEMP_NAME.test(entry.name) && !GENERATED_IMAGE_NAME.test(entry.name)) continue
      const candidate = resolve(this.#attachRoot, entry.name)
      if (indexedPaths.has(candidate)) continue
      const info = await lstat(candidate).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return null
        throw error
      })
      if (info === null || !info.isFile() || info.isSymbolicLink() || info.mtimeMs > cutoff)
        continue
      await this.#assertRoot()
      const resolved = await realpath(candidate).catch((error: unknown) => {
        if (errorCode(error) === 'ENOENT') return null
        throw error
      })
      if (resolved === null || !isInside(this.#attachRoot, resolved)) continue
      await rm(resolved, { force: true })
    }
  }
}
