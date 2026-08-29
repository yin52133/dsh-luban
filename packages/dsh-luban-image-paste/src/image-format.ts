import { LubanError } from '@luban/core'
import type { ImageMime } from './types.js'

export interface DetectedImage {
  readonly mime: ImageMime
  readonly extension: 'png' | 'jpg' | 'webp'
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  return signature.every((value, index): boolean => bytes[index] === value)
}

/** Determine the supported image type from bytes, never from a caller-controlled filename. */
export function detectImage(bytes: Uint8Array): DetectedImage {
  if (startsWith(bytes, PNG_SIGNATURE)) return { mime: 'image/png', extension: 'png' }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', extension: 'jpg' }
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return { mime: 'image/webp', extension: 'webp' }
  }
  throw new LubanError('E_INVALID_INPUT', 'Only PNG, JPEG, and WebP image bytes are accepted')
}

export function normalizeDeclaredMime(value: string): ImageMime | undefined {
  const mime = value.split(';', 1)[0]?.trim().toLowerCase()
  if (mime === '' || mime === undefined) return undefined
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp') return mime
  throw new LubanError(
    'E_INVALID_INPUT',
    'Content-Type must be image/png, image/jpeg, or image/webp',
  )
}

export function assertMimeMatches(bytes: Uint8Array, declared: string): DetectedImage {
  const detected = detectImage(bytes)
  const expected = normalizeDeclaredMime(declared)
  if (expected !== undefined && expected !== detected.mime) {
    throw new LubanError('E_INVALID_INPUT', 'Declared image MIME does not match its bytes')
  }
  return detected
}
