import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AtomicJsonStore, LubanError, asAccountId, asSessionId } from 'dsh-luban-core'
import type { AccountSessionRegistry } from 'dsh-luban-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentRepository } from '../src/repository.js'
import { FileImageIngestService } from '../src/service.js'
import type { Config } from '../src/config.js'
import type { ClipboardAdapter, ImageProcessor, SessionImageInjector } from '../src/types.js'
import {
  MutableClock,
  PNG_BYTES,
  RecordingInjector,
  emptyClipboard,
  passThroughProcessor,
  testConfig,
} from './helpers.js'

const ACCOUNT = asAccountId('account-alice')
const OTHER_ACCOUNT = asAccountId('account-bob')
const ALICE_ACCOUNT_SESSIONS: AccountSessionRegistry = {
  bind: () => Promise.resolve(),
  ownerOf: () => Promise.resolve(ACCOUNT),
}

interface TestLedger {
  readonly version: 1
  readonly images: readonly Readonly<Record<string, unknown>>[]
}

interface TestLedgerStore {
  update(mutator: (current: TestLedger) => TestLedger | Promise<TestLedger>): Promise<TestLedger>
}

function rejectNextLedgerPublicationAfterMutation(
  ledgerPath: string,
): Readonly<{ mockRestore(): void }> {
  const prototype = AtomicJsonStore.prototype as TestLedgerStore
  return vi
    .spyOn(prototype, 'update')
    .mockImplementationOnce(async (mutator): Promise<TestLedger> => {
      const current = JSON.parse(await readFile(ledgerPath, 'utf8')) as TestLedger
      await mutator(current)
      throw new LubanError('E_IO', 'forced ledger publication failure')
    })
}

describe('attachment repository and ingest service', () => {
  let workspace = ''
  let clock: MutableClock
  let repository: AttachmentRepository

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'luban-image-paste-'))
    clock = new MutableClock(Date.UTC(2026, 7, 30, 1, 2, 3))
    repository = await AttachmentRepository.create({
      workspaceRoot: workspace,
      attachDir: '.luban/attachments',
      clock,
    })
  })

  afterEach(async () => {
    if (workspace !== '') await rm(workspace, { recursive: true, force: true })
  })

  function service(
    injector: SessionImageInjector = new RecordingInjector(),
    clipboard: ClipboardAdapter = emptyClipboard,
    processor: ImageProcessor = passThroughProcessor,
    config: Partial<Config> = {},
    accountSessions: AccountSessionRegistry = ALICE_ACCOUNT_SESSIONS,
  ): FileImageIngestService {
    return new FileImageIngestService({
      repository,
      accountSessions,
      injector,
      clipboard,
      processor,
      config: testConfig(workspace, config),
    })
  }

  it('attests only the exact repository and config mounted into the service', async () => {
    const config = Object.freeze(testConfig(workspace))
    const ingest = new FileImageIngestService({
      repository,
      accountSessions: ALICE_ACCOUNT_SESSIONS,
      injector: new RecordingInjector(),
      clipboard: emptyClipboard,
      processor: passThroughProcessor,
      config,
    })
    const otherRepository = await AttachmentRepository.create({
      workspaceRoot: workspace,
      attachDir: '.luban/other-attachments',
      clock,
    })

    expect(ingest.matchesMount(repository, config)).toBe(true)
    expect(ingest.matchesMount(otherRepository, config)).toBe(false)
    expect(ingest.matchesMount(repository, { ...config })).toBe(false)
  })

  it('publishes safe, sequential workspace-relative files and durable metadata', async () => {
    const ingest = service()
    const first = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      accountId: ACCOUNT,
      source: 'paste',
      nameHint: '../../CON.png',
    })
    const second = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      accountId: ACCOUNT,
      source: 'drop',
      nameHint: '../../CON.png',
    })
    expect(first.relPath).toMatch(/^\.luban\/attachments\/20260830-image-con-1\.png$/u)
    expect(second.relPath).toMatch(/^\.luban\/attachments\/20260830-image-con-2\.png$/u)
    expect(first.absPath.startsWith(workspace)).toBe(true)
    expect(new Uint8Array(await readFile(first.absPath))).toEqual(PNG_BYTES)
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u)
    await expect(ingest.listRecords(ACCOUNT)).resolves.toHaveLength(2)
    expect((await readdir(repository.attachRoot)).some((name) => name.startsWith('.upload-'))).toBe(
      false,
    )
  })

  it('keeps legacy unowned rows invisible instead of claiming them on access', async () => {
    const ingest = service()
    const legacy = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      accountId: ACCOUNT,
      source: 'paste',
      nameHint: 'legacy',
    })
    const ledgerPath = join(repository.attachRoot, '.luban-image-index.json')
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      images: Record<string, unknown>[]
    }
    const first = ledger.images[0]
    if (first === undefined) throw new Error('missing legacy fixture')
    delete first.accountId
    await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`, 'utf8')
    repository = await AttachmentRepository.create({
      workspaceRoot: workspace,
      attachDir: '.luban/attachments',
      clock,
    })

    await expect(repository.list(ACCOUNT)).resolves.toEqual([])
    await expect(repository.list(OTHER_ACCOUNT)).resolves.toEqual([])
    await expect(repository.get(ACCOUNT, legacy.id)).resolves.toBeNull()
    await expect(repository.cleanup(ACCOUNT, 0, false)).resolves.toEqual({
      candidates: [],
      removed: [],
      retainedReferenced: [],
      errors: [],
    })
    await expect(readFile(legacy.absPath)).resolves.toEqual(Buffer.from(PNG_BYTES))
  })

  it('allocates unique names under concurrent ingestion', async () => {
    const ingest = service()
    const images = await Promise.all(
      Array.from({ length: 8 }, () =>
        ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
          accountId: ACCOUNT,
          source: 'drop',
          nameHint: 'scope.png',
        }),
      ),
    )
    expect(new Set(images.map((image) => image.relPath))).toHaveLength(8)
  })

  it('validates MIME, size, and processor output before persistence', async () => {
    const ingest = service()
    await expect(
      ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/jpeg' }), {
        accountId: ACCOUNT,
        source: 'paste',
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })

    const invalidProcessor: ImageProcessor = {
      process: () =>
        Promise.resolve({
          bytes: Uint8Array.of(1, 2, 3),
          report: {
            status: 'compressed',
            originalBytes: PNG_BYTES.byteLength,
            outputBytes: 3,
          },
        }),
    }
    await expect(
      service(new RecordingInjector(), emptyClipboard, invalidProcessor).fromBlobWithSource(
        new Blob([PNG_BYTES], { type: 'image/png' }),
        { accountId: ACCOUNT, source: 'paste' },
      ),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
  })

  it('fails closed when compression is unavailable, decoding fails, or bounds are unverifiable', async () => {
    const unavailable: ImageProcessor = {
      process: (bytes) =>
        Promise.resolve({
          bytes,
          report: {
            status: 'unavailable',
            originalBytes: bytes.byteLength,
            outputBytes: bytes.byteLength,
          },
        }),
    }
    const failed: ImageProcessor = {
      process: (bytes) =>
        Promise.resolve({
          bytes,
          report: {
            status: 'failed',
            originalBytes: bytes.byteLength,
            outputBytes: bytes.byteLength,
          },
        }),
    }
    const unsafe: ImageProcessor = {
      process: (bytes) =>
        Promise.resolve({
          bytes,
          report: {
            status: 'not-needed',
            originalBytes: bytes.byteLength,
            outputBytes: bytes.byteLength,
            width: 2_001,
            height: 1_000,
          },
        }),
    }
    const input = new Blob([PNG_BYTES], { type: 'image/png' })

    await expect(
      service(new RecordingInjector(), emptyClipboard, unavailable, {
        compression: true,
      }).fromBlobWithSource(input, { accountId: ACCOUNT, source: 'paste' }),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE', retriable: true })
    await expect(
      service(new RecordingInjector(), emptyClipboard, failed, {
        compression: true,
      }).fromBlobWithSource(input, { accountId: ACCOUNT, source: 'paste' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    await expect(
      service(new RecordingInjector(), emptyClipboard, unsafe, {
        compression: true,
        maxSidePx: 2_000,
      }).fromBlobWithSource(input, { accountId: ACCOUNT, source: 'paste' }),
    ).rejects.toMatchObject({ code: 'E_IO' })
    await expect(repository.list(ACCOUNT)).resolves.toHaveLength(0)
  })

  it('cleans temporary and unpublished target files when ledger publication fails', async () => {
    await writeFile(join(repository.attachRoot, '.luban-image-index.json'), '{invalid json')
    await expect(
      service().fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
        accountId: ACCOUNT,
        source: 'paste',
        nameHint: 'must-not-leak',
      }),
    ).rejects.toMatchObject({ code: 'E_IO' })
    const files = await readdir(repository.attachRoot)
    expect(files.filter((name) => name.startsWith('.upload-'))).toEqual([])
    expect(files.filter((name) => name.endsWith('-must-not-leak-1.png'))).toEqual([])
  })

  it('keeps delete metadata and content when ledger publication fails after mutation', async () => {
    const image = await service().fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      accountId: ACCOUNT,
      source: 'paste',
      nameHint: 'delete-publication-failure',
    })
    const publication = rejectNextLedgerPublicationAfterMutation(
      join(repository.attachRoot, '.luban-image-index.json'),
    )

    try {
      await expect(repository.delete(ACCOUNT, image.id)).rejects.toMatchObject({
        code: 'E_IO',
        message: 'forced ledger publication failure',
      })
    } finally {
      publication.mockRestore()
    }

    await expect(repository.get(ACCOUNT, image.id)).resolves.toMatchObject({ id: image.id })
    await expect(readFile(image.absPath)).resolves.toEqual(Buffer.from(PNG_BYTES))
  })

  it('keeps cleanup metadata and content when ledger publication fails after mutation', async () => {
    const image = await service().fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      accountId: ACCOUNT,
      source: 'drop',
      nameHint: 'cleanup-publication-failure',
    })
    clock.value += 15 * 24 * 60 * 60 * 1_000
    const publication = rejectNextLedgerPublicationAfterMutation(
      join(repository.attachRoot, '.luban-image-index.json'),
    )

    try {
      await expect(repository.cleanup(ACCOUNT, 14, false)).rejects.toMatchObject({
        code: 'E_IO',
        message: 'forced ledger publication failure',
      })
    } finally {
      publication.mockRestore()
    }

    await expect(repository.get(ACCOUNT, image.id)).resolves.toMatchObject({ id: image.id })
    await expect(readFile(image.absPath)).resolves.toEqual(Buffer.from(PNG_BYTES))
  })

  it('captures the CLI clipboard through an injected fake adapter', async () => {
    const clipboard: ClipboardAdapter = {
      capture: () =>
        Promise.resolve({ bytes: PNG_BYTES, mime: 'image/png', nameHint: 'clipboard' }),
    }
    const image = await service(new RecordingInjector(), clipboard).fromClipboard(ACCOUNT)
    expect(image.source).toBe('clipboard-cli')
    expect(image.relPath).toContain('clipboard-1.png')
  })

  it('injects by real stored identity, protects references, and detects file changes', async () => {
    const injector = new RecordingInjector()
    const ingest = service(injector)
    const image = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      accountId: ACCOUNT,
      source: 'paste',
      nameHint: 'schematic',
    })
    const sessionId = asSessionId('session-1')
    const injected = await ingest.injectById(ACCOUNT, sessionId, image.id, 'path')
    expect(injected.referencedBy).toEqual([sessionId])
    expect(injector.calls).toHaveLength(1)
    expect(injector.calls[0]?.style).toBe('path')
    await expect(ingest.delete(ACCOUNT, image.id)).rejects.toMatchObject({
      code: 'E_INVALID_TRANSITION',
    })

    const other = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      accountId: ACCOUNT,
      source: 'drop',
      nameHint: 'modified',
    })
    await writeFile(other.absPath, Uint8Array.of(...PNG_BYTES, 1))
    await expect(ingest.injectById(ACCOUNT, sessionId, other.id)).rejects.toMatchObject({
      code: 'E_IO',
    })
  })

  it('rejects public service injection into another account session', async () => {
    const aliceSession = asSessionId('session-alice')
    const bobSession = asSessionId('session-bob')
    const accountSessions: AccountSessionRegistry = {
      bind: () => Promise.resolve(),
      ownerOf: (sessionId) =>
        Promise.resolve(
          sessionId === aliceSession ? ACCOUNT : sessionId === bobSession ? OTHER_ACCOUNT : null,
        ),
    }
    const injector = new RecordingInjector()
    const ingest = service(injector, emptyClipboard, passThroughProcessor, {}, accountSessions)
    const image = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      accountId: ACCOUNT,
      source: 'paste',
    })

    await expect(ingest.inject(aliceSession, image, 'markdown')).resolves.toBeUndefined()
    await expect(ingest.inject(bobSession, image, 'markdown')).rejects.toMatchObject({
      code: 'E_ACCOUNT_SCOPE_MISMATCH',
      message: `Session ${bobSession} belongs to account ${OTHER_ACCOUNT}, not ${ACCOUNT}`,
    })
    expect(injector.calls.map((call) => call.sessionId)).toEqual([aliceSession])
    expect((await repository.get(ACCOUNT, image.id))?.referencedBy).toEqual([aliceSession])
  })

  it('rolls back a newly-added reference when DSH injection fails', async () => {
    const injector: SessionImageInjector = {
      inject: () => Promise.reject(new Error('fake session failure')),
    }
    const ingest = service(injector)
    const image = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      accountId: ACCOUNT,
      source: 'paste',
    })
    await expect(ingest.injectById(ACCOUNT, asSessionId('missing'), image.id)).rejects.toThrow(
      'fake session failure',
    )
    const refreshed = await repository.get(ACCOUNT, image.id)
    expect(refreshed?.referencedBy).toEqual([])
  })

  it('preserves the queue receipt and reference when post-queue metadata refresh fails', async () => {
    const injector: SessionImageInjector = {
      inject(_sessionId, _image, _style, options): Promise<void> {
        if (options?.queueReceipt !== undefined) {
          options.queueReceipt.queued = true
          options.queueReceipt.messageId = 'queued-message'
        }
        return Promise.resolve()
      },
    }
    const ingest = service(injector)
    const image = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      accountId: ACCOUNT,
      source: 'paste',
    })
    const sessionId = asSessionId('post-queue-refresh-failure')
    const originalGet = repository.get.bind(repository)
    let getCalls = 0
    const get = vi.spyOn(repository, 'get').mockImplementation(async (accountId, id) => {
      getCalls += 1
      if (getCalls === 2) throw new Error('metadata refresh failed after queue commit')
      return originalGet(accountId, id)
    })
    const queueReceipt = { queued: false }

    await expect(
      ingest.injectById(ACCOUNT, sessionId, image.id, 'path', { queueReceipt }),
    ).rejects.toThrow('metadata refresh failed after queue commit')
    expect(queueReceipt).toEqual({ queued: true, messageId: 'queued-message' })
    get.mockRestore()
    expect((await repository.get(ACCOUNT, image.id))?.referencedBy).toEqual([sessionId])
  })

  it('serializes same-session injection so a failed rollback cannot erase a success', async () => {
    let call = 0
    let markStarted: (() => void) | undefined
    let releaseFailure: (() => void) | undefined
    const started = new Promise<void>((resolve): void => {
      markStarted = resolve
    })
    const failureGate = new Promise<void>((resolve): void => {
      releaseFailure = resolve
    })
    const injector: SessionImageInjector = {
      async inject(): Promise<void> {
        call += 1
        if (call !== 1) return
        markStarted?.()
        await failureGate
        throw new Error('first injection failed')
      },
    }
    const ingest = service(injector)
    const image = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      accountId: ACCOUNT,
      source: 'paste',
    })
    const sessionId = asSessionId('concurrent-session')
    const first = ingest.injectById(ACCOUNT, sessionId, image.id)
    await started
    const second = ingest.injectById(ACCOUNT, sessionId, image.id)
    releaseFailure?.()

    await expect(first).rejects.toThrow('first injection failed')
    await expect(second).resolves.toMatchObject({ referencedBy: [sessionId] })
    expect((await repository.get(ACCOUNT, image.id))?.referencedBy).toEqual([sessionId])
  })

  it('bounds recent results without hiding older records from identity injection', async () => {
    const injector = new RecordingInjector()
    const ingest = service(injector, emptyClipboard, passThroughProcessor, { recentLimit: 2 })
    const images = []
    for (const name of ['first', 'second', 'third']) {
      images.push(
        await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
          accountId: ACCOUNT,
          source: 'paste',
          nameHint: name,
        }),
      )
      clock.value += 1
    }

    await expect(ingest.listRecords(ACCOUNT)).resolves.toMatchObject([
      { originalName: 'third' },
      { originalName: 'second' },
    ])
    const oldest = images[0]
    if (oldest === undefined) throw new Error('missing oldest fixture')
    await ingest.inject(asSessionId('older-session'), oldest, 'markdown')
    expect(injector.calls[0]?.image.id).toBe(oldest.id)
  })

  it('rejects operations after the canonical attachment directory is replaced', async () => {
    const displaced = `${repository.attachRoot}-original`
    await rename(repository.attachRoot, displaced)
    await mkdir(repository.attachRoot, { recursive: true })

    await expect(repository.list(ACCOUNT)).rejects.toMatchObject({ code: 'E_IO' })
    await expect(
      repository.store({
        accountId: ACCOUNT,
        bytes: PNG_BYTES,
        extension: 'png',
        mime: 'image/png',
        source: 'paste',
        compression: {
          status: 'disabled',
          originalBytes: PNG_BYTES.byteLength,
          outputBytes: PNG_BYTES.byteLength,
        },
      }),
    ).rejects.toMatchObject({ code: 'E_IO' })
  })

  it('recovers only stale, unindexed plugin-owned crash artifacts', async () => {
    const indexed = await service().fromBlobWithSource(
      new Blob([PNG_BYTES], { type: 'image/png' }),
      { accountId: ACCOUNT, source: 'paste', nameHint: 'indexed' },
    )
    const staleTemp = join(
      repository.attachRoot,
      '.upload-00000000-0000-4000-8000-000000000000.tmp',
    )
    const staleGenerated = join(repository.attachRoot, '20260828-crashed-1.png')
    const freshGenerated = join(repository.attachRoot, '20260830-fresh-1.png')
    const manual = join(repository.attachRoot, 'manual.png')
    await Promise.all(
      [staleTemp, staleGenerated, freshGenerated, manual].map((path) => writeFile(path, PNG_BYTES)),
    )
    const old = new Date(clock.now() - 2 * 24 * 60 * 60 * 1_000)
    const fresh = new Date(clock.now())
    await Promise.all([
      utimes(staleTemp, old, old),
      utimes(staleGenerated, old, old),
      utimes(indexed.absPath, old, old),
      utimes(manual, old, old),
      utimes(freshGenerated, fresh, fresh),
    ])

    repository = await AttachmentRepository.create({
      workspaceRoot: workspace,
      attachDir: '.luban/attachments',
      clock,
    })

    await expect(readFile(staleTemp)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(staleGenerated)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(freshGenerated)).resolves.toEqual(Buffer.from(PNG_BYTES))
    await expect(readFile(manual)).resolves.toEqual(Buffer.from(PNG_BYTES))
    await expect(readFile(indexed.absPath)).resolves.toEqual(Buffer.from(PNG_BYTES))
  })

  it('reports TTL candidates, removes only unreferenced files, and retains references', async () => {
    const injector = new RecordingInjector()
    const ingest = service(injector)
    const referenced = await ingest.fromBlobWithSource(
      new Blob([PNG_BYTES], { type: 'image/png' }),
      { accountId: ACCOUNT, source: 'paste', nameHint: 'referenced' },
    )
    const orphan = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      accountId: ACCOUNT,
      source: 'drop',
      nameHint: 'orphan',
    })
    await ingest.injectById(ACCOUNT, asSessionId('session-1'), referenced.id)
    clock.value += 15 * 24 * 60 * 60 * 1_000

    await expect(ingest.cleanupForAccount(ACCOUNT, true)).resolves.toEqual({
      candidates: [orphan.relPath],
      removed: [],
      retainedReferenced: [referenced.relPath],
      errors: [],
    })
    const report = await ingest.cleanupForAccount(ACCOUNT, false)
    expect(report.removed).toEqual([orphan.relPath])
    expect(await repository.get(ACCOUNT, orphan.id)).toBeNull()
    expect(await repository.get(ACCOUNT, referenced.id)).not.toBeNull()
    await expect(readFile(orphan.absPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
