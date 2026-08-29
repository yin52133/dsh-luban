import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@luban/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  ): FileImageIngestService {
    return new FileImageIngestService({
      repository,
      injector,
      clipboard,
      processor,
      config: testConfig(workspace, config),
    })
  }

  it('publishes safe, sequential workspace-relative files and durable metadata', async () => {
    const ingest = service()
    const first = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      source: 'paste',
      nameHint: '../../CON.png',
    })
    const second = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      source: 'drop',
      nameHint: '../../CON.png',
    })
    expect(first.relPath).toMatch(/^\.luban\/attachments\/20260830-image-con-1\.png$/u)
    expect(second.relPath).toMatch(/^\.luban\/attachments\/20260830-image-con-2\.png$/u)
    expect(first.absPath.startsWith(workspace)).toBe(true)
    expect(new Uint8Array(await readFile(first.absPath))).toEqual(PNG_BYTES)
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u)
    await expect(ingest.listRecords()).resolves.toHaveLength(2)
    expect((await readdir(repository.attachRoot)).some((name) => name.startsWith('.upload-'))).toBe(
      false,
    )
  })

  it('allocates unique names under concurrent ingestion', async () => {
    const ingest = service()
    const images = await Promise.all(
      Array.from({ length: 8 }, () =>
        ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
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
        { source: 'paste' },
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
      }).fromBlobWithSource(input, { source: 'paste' }),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE', retriable: true })
    await expect(
      service(new RecordingInjector(), emptyClipboard, failed, {
        compression: true,
      }).fromBlobWithSource(input, { source: 'paste' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    await expect(
      service(new RecordingInjector(), emptyClipboard, unsafe, {
        compression: true,
        maxSidePx: 2_000,
      }).fromBlobWithSource(input, { source: 'paste' }),
    ).rejects.toMatchObject({ code: 'E_IO' })
    await expect(repository.list()).resolves.toHaveLength(0)
  })

  it('cleans temporary and unpublished target files when ledger publication fails', async () => {
    await writeFile(join(repository.attachRoot, '.luban-image-index.json'), '{invalid json')
    await expect(
      service().fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
        source: 'paste',
        nameHint: 'must-not-leak',
      }),
    ).rejects.toMatchObject({ code: 'E_IO' })
    const files = await readdir(repository.attachRoot)
    expect(files.filter((name) => name.startsWith('.upload-'))).toEqual([])
    expect(files.filter((name) => name.endsWith('-must-not-leak-1.png'))).toEqual([])
  })

  it('captures the CLI clipboard through an injected fake adapter', async () => {
    const clipboard: ClipboardAdapter = {
      capture: () =>
        Promise.resolve({ bytes: PNG_BYTES, mime: 'image/png', nameHint: 'clipboard' }),
    }
    const image = await service(new RecordingInjector(), clipboard).fromClipboard()
    expect(image.source).toBe('clipboard-cli')
    expect(image.relPath).toContain('clipboard-1.png')
  })

  it('injects by real stored identity, protects references, and detects file changes', async () => {
    const injector = new RecordingInjector()
    const ingest = service(injector)
    const image = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      source: 'paste',
      nameHint: 'schematic',
    })
    const sessionId = asSessionId('session-1')
    const injected = await ingest.injectById(sessionId, image.id, 'path')
    expect(injected.referencedBy).toEqual([sessionId])
    expect(injector.calls).toHaveLength(1)
    expect(injector.calls[0]?.style).toBe('path')
    await expect(ingest.delete(image.id)).rejects.toMatchObject({
      code: 'E_INVALID_TRANSITION',
    })

    const other = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      source: 'drop',
      nameHint: 'modified',
    })
    await writeFile(other.absPath, Uint8Array.of(...PNG_BYTES, 1))
    await expect(ingest.injectById(sessionId, other.id)).rejects.toMatchObject({ code: 'E_IO' })
  })

  it('rolls back a newly-added reference when DSH injection fails', async () => {
    const injector: SessionImageInjector = {
      inject: () => Promise.reject(new Error('fake session failure')),
    }
    const ingest = service(injector)
    const image = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      source: 'paste',
    })
    await expect(ingest.injectById(asSessionId('missing'), image.id)).rejects.toThrow(
      'fake session failure',
    )
    const refreshed = await repository.get(image.id)
    expect(refreshed?.referencedBy).toEqual([])
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
      source: 'paste',
    })
    const sessionId = asSessionId('concurrent-session')
    const first = ingest.injectById(sessionId, image.id)
    await started
    const second = ingest.injectById(sessionId, image.id)
    releaseFailure?.()

    await expect(first).rejects.toThrow('first injection failed')
    await expect(second).resolves.toMatchObject({ referencedBy: [sessionId] })
    expect((await repository.get(image.id))?.referencedBy).toEqual([sessionId])
  })

  it('bounds recent results without hiding older records from identity injection', async () => {
    const injector = new RecordingInjector()
    const ingest = service(injector, emptyClipboard, passThroughProcessor, { recentLimit: 2 })
    const images = []
    for (const name of ['first', 'second', 'third']) {
      images.push(
        await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
          source: 'paste',
          nameHint: name,
        }),
      )
      clock.value += 1
    }

    await expect(ingest.listRecords()).resolves.toMatchObject([
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

    await expect(repository.list()).rejects.toMatchObject({ code: 'E_IO' })
    await expect(
      repository.store({
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
      { source: 'paste', nameHint: 'indexed' },
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
      { source: 'paste', nameHint: 'referenced' },
    )
    const orphan = await ingest.fromBlobWithSource(new Blob([PNG_BYTES], { type: 'image/png' }), {
      source: 'drop',
      nameHint: 'orphan',
    })
    await ingest.injectById(asSessionId('session-1'), referenced.id)
    clock.value += 15 * 24 * 60 * 60 * 1_000

    await expect(ingest.cleanup(true)).resolves.toEqual({
      candidates: [orphan.relPath],
      removed: [],
      retainedReferenced: [referenced.relPath],
      errors: [],
    })
    const report = await ingest.cleanup(false)
    expect(report.removed).toEqual([orphan.relPath])
    expect(await repository.get(orphan.id)).toBeNull()
    expect(await repository.get(referenced.id)).not.toBeNull()
    await expect(readFile(orphan.absPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
