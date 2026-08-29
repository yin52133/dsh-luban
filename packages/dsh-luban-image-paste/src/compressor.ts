import type { ImageMime, ImageProcessingResult, ImageProcessor } from './types.js'

interface SharpMetadata {
  readonly width?: number
  readonly height?: number
}

interface SharpPipeline {
  metadata(): Promise<SharpMetadata>
  rotate(): SharpPipeline
  resize(options: {
    readonly width: number
    readonly height: number
    readonly fit: 'inside'
    readonly withoutEnlargement: boolean
  }): SharpPipeline
  png(options: { readonly compressionLevel: number }): SharpPipeline
  jpeg(options: { readonly quality: number; readonly mozjpeg: boolean }): SharpPipeline
  webp(options: { readonly quality: number }): SharpPipeline
  toBuffer(): Promise<Uint8Array>
}

type SharpFactory = (input: Uint8Array, options: { readonly failOn: 'error' }) => SharpPipeline

const SHARP_MODULE = 'sharp'

export type SharpModuleLoader = () => Promise<unknown>

const loadSharp: SharpModuleLoader = () => import(SHARP_MODULE)

function failure(
  bytes: Uint8Array,
  status: 'unavailable' | 'failed',
  reason: string,
): ImageProcessingResult {
  return {
    bytes,
    report: {
      status,
      originalBytes: bytes.byteLength,
      outputBytes: bytes.byteLength,
      reason,
    },
  }
}

function sharpFactory(value: unknown): SharpFactory | undefined {
  if (typeof value === 'function') return value as SharpFactory
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = (value as Readonly<{ default?: unknown }>).default
  return typeof candidate === 'function' ? (candidate as SharpFactory) : undefined
}

/** Optional sharp-backed resize that reports load and decode failures distinctly. */
export class DynamicSharpProcessor implements ImageProcessor {
  readonly #loader: SharpModuleLoader

  public constructor(loader: SharpModuleLoader = loadSharp) {
    this.#loader = loader
  }

  public async process(
    bytes: Uint8Array,
    mime: ImageMime,
    options: { readonly enabled: boolean; readonly maxSidePx: number; readonly quality: number },
  ): Promise<ImageProcessingResult> {
    if (!options.enabled) {
      return {
        bytes,
        report: {
          status: 'disabled',
          originalBytes: bytes.byteLength,
          outputBytes: bytes.byteLength,
        },
      }
    }
    let factory: SharpFactory | undefined
    try {
      factory = sharpFactory(await this.#loader())
    } catch {
      return failure(bytes, 'unavailable', 'optional sharp peer is not installed or loadable')
    }
    if (factory === undefined) {
      return failure(bytes, 'unavailable', 'optional sharp peer has an incompatible export')
    }
    try {
      const image = factory(bytes, { failOn: 'error' })
      const metadata = await image.metadata()
      const width = metadata.width
      const height = metadata.height
      if (width === undefined || height === undefined) {
        return failure(bytes, 'failed', 'image dimensions are unavailable')
      }
      if (width <= options.maxSidePx && height <= options.maxSidePx) {
        // metadata() may succeed for truncated images, so force a full decode
        // before retaining bytes that do not require resizing.
        await image.toBuffer()
        return {
          bytes,
          report: {
            status: 'not-needed',
            originalBytes: bytes.byteLength,
            outputBytes: bytes.byteLength,
            width,
            height,
          },
        }
      }
      let pipeline = image.rotate().resize({
        width: options.maxSidePx,
        height: options.maxSidePx,
        fit: 'inside',
        withoutEnlargement: true,
      })
      if (mime === 'image/png') pipeline = pipeline.png({ compressionLevel: 9 })
      if (mime === 'image/jpeg')
        pipeline = pipeline.jpeg({ quality: options.quality, mozjpeg: true })
      if (mime === 'image/webp') pipeline = pipeline.webp({ quality: options.quality })
      const output = new Uint8Array(await pipeline.toBuffer())
      const outputMetadata = await factory(output, { failOn: 'error' }).metadata()
      const outputWidth = outputMetadata.width
      const outputHeight = outputMetadata.height
      if (
        outputWidth === undefined ||
        outputHeight === undefined ||
        outputWidth > options.maxSidePx ||
        outputHeight > options.maxSidePx
      ) {
        return failure(bytes, 'failed', 'resized image dimensions are unsafe')
      }
      return {
        bytes: output,
        report: {
          status: 'compressed',
          originalBytes: bytes.byteLength,
          outputBytes: output.byteLength,
          width: outputWidth,
          height: outputHeight,
        },
      }
    } catch {
      return failure(bytes, 'failed', 'sharp could not decode or resize the image')
    }
  }
}
