import { describe, expect, it, vi } from 'vitest'
import { DynamicSharpProcessor } from '../src/compressor.js'
import { PNG_BYTES } from './helpers.js'

describe('optional sharp processor', () => {
  it('retains the original with explicit unavailable status when sharp cannot load', async () => {
    const processor = new DynamicSharpProcessor(() => Promise.reject(new Error('not installed')))
    await expect(
      processor.process(PNG_BYTES, 'image/png', {
        enabled: true,
        maxSidePx: 2_000,
        quality: 82,
      }),
    ).resolves.toEqual({
      bytes: PNG_BYTES,
      report: {
        status: 'unavailable',
        originalBytes: PNG_BYTES.byteLength,
        outputBytes: PNG_BYTES.byteLength,
        reason: 'optional sharp peer is not installed or loadable',
      },
    })
  })

  it('does not load an optional peer when compression is disabled', async () => {
    const loader = vi.fn(() => Promise.reject(new Error('must not load')))
    const processor = new DynamicSharpProcessor(loader)
    await expect(
      processor.process(PNG_BYTES, 'image/png', {
        enabled: false,
        maxSidePx: 2_000,
        quality: 82,
      }),
    ).resolves.toMatchObject({ report: { status: 'disabled' } })
    expect(loader).not.toHaveBeenCalled()
  })

  it('distinguishes an installed decoder failure from an unavailable peer', async () => {
    const factory = (): Readonly<Record<string, unknown>> => ({
      metadata: () => Promise.reject(new Error('corrupt image')),
    })
    const processor = new DynamicSharpProcessor(() => Promise.resolve(factory))
    await expect(
      processor.process(PNG_BYTES, 'image/png', {
        enabled: true,
        maxSidePx: 2_000,
        quality: 82,
      }),
    ).resolves.toMatchObject({
      bytes: PNG_BYTES,
      report: { status: 'failed', reason: 'sharp could not decode or resize the image' },
    })
  })

  it('fully decodes a small image before reporting that resize is not needed', async () => {
    const toBuffer = vi.fn(() => Promise.reject(new Error('premature end of JPEG image')))
    const factory = (): Readonly<Record<string, unknown>> => ({
      metadata: () => Promise.resolve({ width: 64, height: 64 }),
      toBuffer,
    })
    const processor = new DynamicSharpProcessor(() => Promise.resolve(factory))

    await expect(
      processor.process(Uint8Array.of(0xff, 0xd8, 0xff, 0), 'image/jpeg', {
        enabled: true,
        maxSidePx: 2_000,
        quality: 82,
      }),
    ).resolves.toMatchObject({
      report: { status: 'failed', reason: 'sharp could not decode or resize the image' },
    })
    expect(toBuffer).toHaveBeenCalledOnce()
  })

  it('fails closed for a real truncated JPEG whose dimensions remain readable', async () => {
    const sharpModule = await import('sharp')
    const complete = await sharpModule
      .default({
        create: {
          width: 64,
          height: 64,
          channels: 3,
          background: { r: 1, g: 2, b: 3 },
        },
      })
      .jpeg()
      .toBuffer()
    const truncated = new Uint8Array(complete.subarray(0, complete.byteLength - 10))
    await expect(
      sharpModule.default(truncated, { failOn: 'error' }).metadata(),
    ).resolves.toMatchObject({ width: 64, height: 64 })

    const processor = new DynamicSharpProcessor(() => Promise.resolve(sharpModule))
    await expect(
      processor.process(truncated, 'image/jpeg', {
        enabled: true,
        maxSidePx: 2_000,
        quality: 82,
      }),
    ).resolves.toMatchObject({
      report: { status: 'failed', reason: 'sharp could not decode or resize the image' },
    })
  })

  it('rejects resized output whose decoded dimensions still exceed maxSidePx', async () => {
    const resized = Uint8Array.of(...PNG_BYTES, 1)
    const firstPipeline: Record<string, unknown> = {
      metadata: () => Promise.resolve({ width: 4_000, height: 3_000 }),
      toBuffer: () => Promise.resolve(resized),
    }
    firstPipeline.rotate = (): unknown => firstPipeline
    firstPipeline.resize = (): unknown => firstPipeline
    firstPipeline.png = (): unknown => firstPipeline
    const outputPipeline = {
      metadata: () => Promise.resolve({ width: 2_001, height: 1_500 }),
    }
    const factory = vi
      .fn()
      .mockImplementationOnce(() => firstPipeline)
      .mockImplementationOnce(() => outputPipeline)
    const processor = new DynamicSharpProcessor(() => Promise.resolve(factory))
    await expect(
      processor.process(PNG_BYTES, 'image/png', {
        enabled: true,
        maxSidePx: 2_000,
        quality: 82,
      }),
    ).resolves.toMatchObject({
      bytes: PNG_BYTES,
      report: { status: 'failed', reason: 'resized image dimensions are unsafe' },
    })
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
