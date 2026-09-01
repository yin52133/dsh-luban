import type { IncomingMessage, ServerResponse } from 'node:http'
import { LubanError } from './errors.js'

/** Parse a JSON request with the common plugin body limits and diagnostics. */
export async function readJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
  bodyRequired = false,
): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new LubanError('E_INVALID_INPUT', 'Content-Type must be application/json')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const raw of request as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.from(raw)
    total += chunk.byteLength
    if (total > maximumBytes) {
      throw new LubanError('E_INVALID_INPUT', 'Request body is too large')
    }
    chunks.push(chunk)
  }
  if (bodyRequired && total === 0) {
    throw new LubanError('E_INVALID_INPUT', 'Request body is required')
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error: unknown) {
    throw new LubanError('E_INVALID_INPUT', 'Request body is not valid JSON', { cause: error })
  }
}

export function objectRecord(
  value: unknown,
  label = 'request body',
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LubanError('E_INVALID_INPUT', `${label} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

export function setPrivateResponseHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')
  response.statusCode = status
  setPrivateResponseHeaders(response)
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('content-length', String(encoded.byteLength))
  response.end(encoded)
}

export function sendNoContent(response: ServerResponse): void {
  response.statusCode = 204
  setPrivateResponseHeaders(response)
  response.end()
}
