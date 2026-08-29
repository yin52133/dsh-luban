import type { IngestedImage, SessionId } from '@luban/core'

export type ImageSource = IngestedImage['source']
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp'
export type InjectStyle = 'markdown' | 'path'

export type CompressionStatus = 'disabled' | 'not-needed' | 'compressed' | 'unavailable' | 'failed'

export interface CompressionReport {
  readonly status: CompressionStatus
  readonly originalBytes: number
  readonly outputBytes: number
  readonly width?: number
  readonly height?: number
  readonly reason?: string
}

export interface StoredImage extends IngestedImage {
  readonly id: string
  readonly mime: ImageMime
  readonly bytes: number
  readonly originalName: string
  readonly compression: CompressionReport
}

export interface ClipboardCapture {
  readonly bytes: Uint8Array
  readonly mime: ImageMime
  readonly nameHint: string
}

export interface ClipboardAdapter {
  capture(): Promise<ClipboardCapture>
}

export interface SessionImageInjector {
  inject(sessionId: SessionId, image: StoredImage, style: InjectStyle): Promise<void>
}

export interface ImageProcessingResult {
  readonly bytes: Uint8Array
  readonly report: CompressionReport
}

export interface ImageProcessor {
  process(
    bytes: Uint8Array,
    mime: ImageMime,
    options: {
      readonly enabled: boolean
      readonly maxSidePx: number
      readonly quality: number
    },
  ): Promise<ImageProcessingResult>
}
