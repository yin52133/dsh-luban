import type { IngestedImage, SessionId } from 'dsh-luban-core'

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
  inject(
    sessionId: SessionId,
    image: StoredImage,
    style: InjectStyle,
    options?: ImageInjectionOptions,
  ): Promise<void>
}

export interface ImageInjectionOptions {
  readonly instruction?: string
  /** Called synchronously after message creation and before it enters the live Agent inbox. */
  readonly onPreparedMessage?: (messageId: string) => void
  /** Called at the final synchronous boundary immediately before followup. */
  readonly onBeforeQueueMessage?: (messageId: string) => void
  /** Caller-owned receipt updated synchronously after followup commits the message. */
  readonly queueReceipt?: ImageQueueReceipt
  /** Optional caller-owned cancellation checked at the final synchronous followup boundary. */
  readonly signal?: AbortSignal
}

export interface ImageQueueReceipt {
  queued: boolean
  messageId?: string
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
