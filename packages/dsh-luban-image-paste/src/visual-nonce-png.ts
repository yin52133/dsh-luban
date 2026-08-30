import { deflateSync, inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const NONCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const NONCE_LENGTH = 8
const GLYPH_WIDTH = 5
const GLYPH_HEIGHT = 7
const SCALE = 12
const PADDING = 24
const GAP = 12

const GLYPHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
})

export interface ValidatedNoncePng {
  readonly width: number
  readonly height: number
  readonly bytes: number
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value >>> 0)
  return bytes
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part): number => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  return concat([
    uint32(data.byteLength),
    typeBytes,
    data,
    uint32(crc32(concat([typeBytes, data]))),
  ])
}

function assertNonce(nonce: string): void {
  if (
    nonce.length !== NONCE_LENGTH ||
    Array.from(nonce).some((character): boolean => !NONCE_ALPHABET.includes(character))
  ) {
    throw new TypeError(`visual nonce must contain ${String(NONCE_LENGTH)} unambiguous characters`)
  }
}

/** Generate an acceptance code without punctuation or visually ambiguous glyphs. */
export function visualNonceFromRandomBytes(bytes: Uint8Array): string {
  if (bytes.byteLength < NONCE_LENGTH) throw new TypeError('visual nonce entropy is too short')
  return [...bytes.subarray(0, NONCE_LENGTH)]
    .map((value): string => NONCE_ALPHABET[value % NONCE_ALPHABET.length] ?? '')
    .join('')
}

/** Render the code as pixels only; the PNG contains no text or metadata chunks. */
export function renderVisualNoncePng(nonce: string): Uint8Array {
  assertNonce(nonce)
  const width = PADDING * 2 + nonce.length * GLYPH_WIDTH * SCALE + (nonce.length - 1) * GAP
  const height = PADDING * 2 + GLYPH_HEIGHT * SCALE
  const stride = width * 3
  const pixels = new Uint8Array(height * stride).fill(255)
  for (const [characterIndex, character] of Array.from(nonce).entries()) {
    const glyph = GLYPHS[character]
    if (glyph === undefined) throw new TypeError('visual nonce has no raster glyph')
    const originX = PADDING + characterIndex * (GLYPH_WIDTH * SCALE + GAP)
    for (const [row, pattern] of glyph.entries()) {
      for (const [column, pixel] of Array.from(pattern).entries()) {
        if (pixel !== '1') continue
        for (let dy = 0; dy < SCALE; dy += 1) {
          for (let dx = 0; dx < SCALE; dx += 1) {
            const offset =
              (PADDING + row * SCALE + dy) * stride + (originX + column * SCALE + dx) * 3
            pixels[offset] = 0
            pixels[offset + 1] = 0
            pixels[offset + 2] = 0
          }
        }
      }
    }
  }

  const rows = new Uint8Array(height * (stride + 1))
  for (let row = 0; row < height; row += 1) {
    const outputOffset = row * (stride + 1)
    rows[outputOffset] = 0
    rows.set(pixels.subarray(row * stride, (row + 1) * stride), outputOffset + 1)
  }
  const ihdr = new Uint8Array(13)
  const header = new DataView(ihdr.buffer)
  header.setUint32(0, width)
  header.setUint32(4, height)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const png = concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(rows, { level: 9 }))),
    pngChunk('IEND', new Uint8Array()),
  ])
  if (Buffer.from(png).includes(Buffer.from(nonce, 'ascii'))) {
    throw new Error('visual nonce unexpectedly appeared as PNG plaintext')
  }
  return png
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}

/** Fully validate the narrow PNG form emitted by the live visual acceptance renderer. */
export function validateVisualNoncePng(bytes: Uint8Array): ValidatedNoncePng {
  if (!sameBytes(bytes.subarray(0, PNG_SIGNATURE.byteLength), PNG_SIGNATURE)) {
    throw new TypeError('visual acceptance image is not a PNG')
  }
  let offset = PNG_SIGNATURE.byteLength
  let width: number | undefined
  let height: number | undefined
  let sawHeader = false
  let sawEnd = false
  const imageData: Uint8Array[] = []
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw new TypeError('visual acceptance PNG is truncated')
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
    const chunkEnd = offset + 12 + length
    if (chunkEnd > bytes.byteLength) throw new TypeError('visual acceptance PNG chunk is truncated')
    const typeBytes = bytes.subarray(offset + 4, offset + 8)
    const type = new TextDecoder('ascii', { fatal: true }).decode(typeBytes)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = new DataView(
      bytes.buffer,
      bytes.byteOffset + offset + 8 + length,
      4,
    ).getUint32(0)
    if (crc32(concat([typeBytes, data])) !== expectedCrc) {
      throw new TypeError('visual acceptance PNG checksum is invalid')
    }
    if (!sawHeader && type !== 'IHDR')
      throw new TypeError('visual acceptance PNG has no leading header')
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) throw new TypeError('visual acceptance PNG header is invalid')
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength)
      width = header.getUint32(0)
      height = header.getUint32(4)
      if (
        width < 1 ||
        height < 1 ||
        width > 2_048 ||
        height > 2_048 ||
        !sameBytes(data.subarray(8), Uint8Array.of(8, 2, 0, 0, 0))
      ) {
        throw new TypeError('visual acceptance PNG format is unsupported')
      }
      sawHeader = true
    } else if (type === 'IDAT') {
      imageData.push(data)
    } else if (type === 'IEND') {
      if (length !== 0) throw new TypeError('visual acceptance PNG end chunk is invalid')
      sawEnd = true
      offset = chunkEnd
      break
    } else {
      throw new TypeError('visual acceptance PNG contains an unexpected chunk')
    }
    offset = chunkEnd
  }
  if (!sawHeader || !sawEnd || offset !== bytes.byteLength || imageData.length === 0) {
    throw new TypeError('visual acceptance PNG structure is incomplete')
  }
  if (width === undefined || height === undefined) {
    throw new TypeError('visual acceptance PNG dimensions are unavailable')
  }
  const expectedLength = width * 3 + 1
  const decoded = new Uint8Array(
    inflateSync(concat(imageData), { maxOutputLength: height * expectedLength }),
  )
  if (decoded.byteLength !== height * expectedLength) {
    throw new TypeError('visual acceptance PNG raster length is invalid')
  }
  let hasWhite = false
  let hasBlack = false
  for (let row = 0; row < height; row += 1) {
    const rowOffset = row * expectedLength
    if (decoded[rowOffset] !== 0) throw new TypeError('visual acceptance PNG filter is invalid')
    for (let index = rowOffset + 1; index < rowOffset + expectedLength; index += 1) {
      const value = decoded[index]
      if (value === 0) hasBlack = true
      else if (value === 255) hasWhite = true
      else throw new TypeError('visual acceptance PNG contains an unexpected pixel value')
    }
  }
  if (!hasBlack || !hasWhite) throw new TypeError('visual acceptance PNG has no readable contrast')
  return { width, height, bytes: bytes.byteLength }
}
