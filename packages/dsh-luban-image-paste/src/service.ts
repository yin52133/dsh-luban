import type {
  AccountId,
  CleanupReport,
  ImageIngestService,
  IngestedImage,
  SessionId,
} from 'dsh-luban-core'
import { LubanError } from 'dsh-luban-core'
import type { Config } from './config.js'
import { assertMimeMatches, detectImage } from './image-format.js'
import type { AttachmentRepository } from './repository.js'
import type {
  ClipboardAdapter,
  ImageInjectionOptions,
  ImageProcessor,
  ImageSource,
  InjectStyle,
  SessionImageInjector,
  StoredImage,
} from './types.js'

export interface FileImageIngestServiceOptions {
  readonly repository: AttachmentRepository
  readonly clipboard: ClipboardAdapter
  readonly injector: SessionImageInjector
  readonly processor: ImageProcessor
  readonly config: Config
}

export interface IngestOptions {
  /** Set by the authenticated service boundary, never by request input. */
  readonly accountId: AccountId
  readonly nameHint?: string
  readonly source: ImageSource
  readonly declaredMime?: string
}

class InjectionMutex {
  readonly #tails = new Map<string, Promise<void>>()

  public async run<Value>(key: string, work: () => Promise<Value>): Promise<Value> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release: (() => void) | undefined
    const current = new Promise<void>((resolve): void => {
      release = resolve
    })
    this.#tails.set(key, current)
    await previous
    try {
      return await work()
    } finally {
      release?.()
      if (this.#tails.get(key) === current) this.#tails.delete(key)
    }
  }
}

function requireAccountId(accountId: AccountId | undefined): AccountId {
  if (accountId === undefined) {
    throw new LubanError('E_AUTH_REQUIRED', 'Authenticated account context is required')
  }
  return accountId
}

/** M06 service: validate, optionally resize, persist, reference, and expire attachments. */
export class FileImageIngestService implements ImageIngestService {
  readonly #repository: AttachmentRepository
  readonly #clipboard: ClipboardAdapter
  readonly #injector: SessionImageInjector
  readonly #processor: ImageProcessor
  readonly #config: Config
  readonly #injections = new InjectionMutex()

  public constructor(options: FileImageIngestServiceOptions) {
    this.#repository = options.repository
    this.#clipboard = options.clipboard
    this.#injector = options.injector
    this.#processor = options.processor
    this.#config = options.config
  }

  public get maxBytes(): number {
    return this.#config.maxBytes
  }

  public get defaultInjectStyle(): InjectStyle {
    return this.#config.injectStyle
  }

  /** Prove that an acceptance runner is using this service's exact mounted state. */
  public matchesMount(repository: AttachmentRepository, config: Config): boolean {
    return this.#repository === repository && this.#config === config
  }

  public async fromBlob(
    blob: Blob,
    meta?: { readonly accountId?: AccountId; readonly nameHint?: string },
  ): Promise<IngestedImage> {
    return this.fromBlobWithSource(blob, {
      accountId: requireAccountId(meta?.accountId),
      source: 'paste',
      ...(meta?.nameHint === undefined ? {} : { nameHint: meta.nameHint }),
      ...(blob.type === '' ? {} : { declaredMime: blob.type }),
    })
  }

  public async fromBlobWithSource(blob: Blob, options: IngestOptions): Promise<StoredImage> {
    if (!Number.isSafeInteger(blob.size) || blob.size <= 0) {
      throw new LubanError('E_INVALID_INPUT', 'Image must not be empty')
    }
    if (blob.size > this.#config.maxBytes) {
      throw new LubanError('E_INVALID_INPUT', 'Image exceeds maxBytes')
    }
    return this.#ingest(new Uint8Array(await blob.arrayBuffer()), {
      ...options,
      declaredMime: options.declaredMime ?? blob.type,
    })
  }

  public async fromClipboard(accountId?: AccountId): Promise<IngestedImage> {
    const owner = requireAccountId(accountId)
    const capture = await this.#clipboard.capture()
    return this.#ingest(capture.bytes, {
      accountId: owner,
      source: 'clipboard-cli',
      nameHint: capture.nameHint,
      declaredMime: capture.mime,
    })
  }

  public async inject(
    sessionId: SessionId,
    image: IngestedImage,
    style: InjectStyle,
  ): Promise<void> {
    const accountId = requireAccountId(image.accountId)
    const match = await this.#repository.findByIdentity(accountId, image.relPath, image.sha256)
    if (match === null) throw new LubanError('E_NOT_FOUND', 'Stored image was not found')
    await this.injectById(accountId, sessionId, match.id, style)
  }

  public async injectById(
    accountId: AccountId,
    sessionId: SessionId,
    id: string,
    style: InjectStyle = this.#config.injectStyle,
    options?: ImageInjectionOptions,
  ): Promise<StoredImage> {
    return this.#injections.run(
      `${accountId}\0${id}\0${sessionId}`,
      async (): Promise<StoredImage> => {
        const { image } = await this.#repository.content(accountId, id)
        const added = await this.#repository.addReference(accountId, id, sessionId)
        try {
          await this.#injector.inject(sessionId, image, style, options)
        } catch (error: unknown) {
          if (added) {
            try {
              await this.#repository.removeReference(accountId, id, sessionId)
            } catch (rollbackError: unknown) {
              throw new LubanError(
                'E_IO',
                'Image injection failed and its reference rollback failed',
                {
                  cause: error,
                  details: {
                    rollback: rollbackError instanceof Error ? rollbackError.message : 'unknown',
                  },
                },
              )
            }
          }
          throw error
        }
        const updated = await this.#repository.get(accountId, id)
        if (updated === null) throw new LubanError('E_IO', 'Injected image metadata disappeared')
        return updated
      },
    )
  }

  public recent(filter?: {
    readonly accountId?: AccountId
    readonly sessionId?: SessionId
  }): Promise<readonly IngestedImage[]> {
    return this.#repository.list(
      requireAccountId(filter?.accountId),
      filter?.sessionId,
      this.#config.recentLimit,
    )
  }

  public listRecords(accountId: AccountId, sessionId?: SessionId): Promise<readonly StoredImage[]> {
    return this.#repository.list(accountId, sessionId, this.#config.recentLimit)
  }

  public content(
    accountId: AccountId,
    id: string,
  ): Promise<{ readonly image: StoredImage; readonly bytes: Uint8Array }> {
    return this.#repository.content(accountId, id)
  }

  public delete(accountId: AccountId, id: string): Promise<void> {
    return this.#repository.delete(accountId, id)
  }

  /** Process-level maintenance entry used only by the mounted retention timer. */
  public cleanup(dryRun = false): Promise<CleanupReport> {
    return this.#repository.cleanupAllAccounts(this.#config.retainDays, dryRun)
  }

  public cleanupForAccount(accountId: AccountId, dryRun = false): Promise<CleanupReport> {
    return this.#repository.cleanup(accountId, this.#config.retainDays, dryRun)
  }

  async #ingest(bytes: Uint8Array, options: IngestOptions): Promise<StoredImage> {
    if (bytes.byteLength === 0) throw new LubanError('E_INVALID_INPUT', 'Image must not be empty')
    if (bytes.byteLength > this.#config.maxBytes) {
      throw new LubanError('E_INVALID_INPUT', 'Image exceeds maxBytes')
    }
    const detected = assertMimeMatches(bytes, options.declaredMime ?? '')
    const processed = await this.#processor.process(bytes, detected.mime, {
      enabled: this.#config.compression,
      maxSidePx: this.#config.maxSidePx,
      quality: this.#config.compressionQuality,
    })
    if (this.#config.compression) {
      if (processed.report.status === 'unavailable') {
        throw new LubanError(
          'E_UNAVAILABLE',
          'Image compression is enabled but the optional sharp peer is unavailable',
          { retriable: true },
        )
      }
      if (processed.report.status === 'failed') {
        throw new LubanError('E_INVALID_INPUT', 'Image could not be decoded or resized safely')
      }
      if (processed.report.status === 'disabled') {
        throw new LubanError('E_IO', 'Image processor unexpectedly disabled safety checks')
      }
      if (
        processed.report.width === undefined ||
        processed.report.height === undefined ||
        processed.report.width > this.#config.maxSidePx ||
        processed.report.height > this.#config.maxSidePx
      ) {
        throw new LubanError('E_IO', 'Image processor did not enforce maxSidePx')
      }
    }
    if (processed.bytes.byteLength > this.#config.maxBytes) {
      throw new LubanError('E_INVALID_INPUT', 'Processed image exceeds maxBytes')
    }
    const processedType = detectImage(processed.bytes)
    if (processedType.mime !== detected.mime) {
      throw new LubanError('E_IO', 'Image processor changed the declared output format')
    }
    return this.#repository.store({
      accountId: options.accountId,
      bytes: processed.bytes,
      extension: processedType.extension,
      mime: processedType.mime,
      source: options.source,
      ...(options.nameHint === undefined ? {} : { nameHint: options.nameHint }),
      compression: processed.report,
    })
  }
}
