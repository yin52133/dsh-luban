#!/usr/bin/env node

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { LubanError } from '@yin52133/dsh-luban-core'
import { SystemClipboardAdapter } from './clipboard.js'
import type { ClipboardAdapter } from './types.js'

const HELP = `Usage: luban-img [capture] [options]

Capture the local system clipboard and upload it to /luban-image-paste.

Options:
  --base-url <url>   API root (default: LUBAN_IMAGE_BASE_URL or loopback sidecar)
  --name <slug>      Attachment name hint
  --session <id>     Inject the uploaded image into this DSH session
  --style <style>    markdown or path (default: markdown)
  --help             Show this help

Authentication is read only from LUBAN_SESSION_COOKIE and LUBAN_CSRF_TOKEN.
`

const HTTP_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024

export interface CliDependencies {
  readonly clipboard?: ClipboardAdapter
  readonly fetch?: typeof fetch
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
}

function requiredEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = env[key]
  if (value === undefined || value.trim() === '') {
    throw new LubanError('E_AUTH_REQUIRED', `${key} is required`)
  }
  return value
}

function baseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error: unknown) {
    throw new LubanError('E_INVALID_INPUT', 'base URL is invalid', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LubanError('E_INVALID_INPUT', 'base URL must use http or https')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new LubanError('E_INVALID_INPUT', 'base URL must not contain credentials, query, or hash')
  }
  const path = url.pathname.replace(/\/+$/u, '')
  if (!path.endsWith('/luban-image-paste')) {
    throw new LubanError('E_INVALID_INPUT', 'base URL must end with /luban-image-paste')
  }
  url.pathname = path
  return url.toString().replace(/\/$/u, '')
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new LubanError('E_INVALID_INPUT', 'LUBAN_IMAGE_MAX_BYTES must be a positive integer')
  }
  return parsed
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new LubanError('E_UNAVAILABLE', 'Image API response is too large')
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new LubanError('E_UNAVAILABLE', 'Image API response is too large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(
    chunks.map((chunk): Buffer => Buffer.from(chunk)),
    total,
  ).toString('utf8')
}

async function responseJson(
  response: Response,
  operation: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel()
    throw new LubanError('E_UNAVAILABLE', `${operation} failed (${String(response.status)})`, {
      retriable: response.status >= 500,
    })
  }
  const text = await boundedResponseText(response)
  if (signal.aborted) throw signal.reason
  try {
    return JSON.parse(text) as unknown
  } catch (error: unknown) {
    throw new Error(`${operation} returned invalid JSON`, { cause: error })
  }
}

async function requestJson(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
  operation: string,
): Promise<unknown> {
  const controller = new AbortController()
  const timeoutError = new LubanError('E_TIMEOUT', `${operation} timed out`, {
    retriable: true,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject): void => {
    timer = setTimeout((): void => {
      controller.abort()
      reject(timeoutError)
    }, HTTP_TIMEOUT_MS)
    timer.unref()
  })
  try {
    const work = fetcher(input, { ...init, signal: controller.signal }).then(
      (response): Promise<unknown> => responseJson(response, operation, controller.signal),
    )
    return await Promise.race([work, timeout])
  } catch (error: unknown) {
    if (controller.signal.aborted) throw timeoutError
    if (error instanceof LubanError) throw error
    throw new LubanError('E_UNAVAILABLE', `${operation} request failed`, {
      retriable: true,
      cause: error,
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function uploadedId(value: unknown): string {
  if (typeof value !== 'object' || value === null) throw new Error('Upload returned invalid JSON')
  const image = (value as Readonly<Record<string, unknown>>).image
  if (typeof image !== 'object' || image === null) throw new Error('Upload returned no image')
  const id = (image as Readonly<Record<string, unknown>>).id
  if (typeof id !== 'string' || id === '') throw new Error('Upload returned no image id')
  return id
}

export async function run(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<unknown> {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      'base-url': { type: 'string' },
      name: { type: 'string' },
      session: { type: 'string' },
      style: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const command = parsed.positionals[0] ?? 'capture'
  if (parsed.positionals.length > 1 || (command !== 'capture' && command !== 'help')) {
    throw new LubanError('E_INVALID_INPUT', `Unknown command: ${command}`)
  }
  if (command === 'help' || parsed.values.help === true) return HELP

  const style = parsed.values.style ?? 'markdown'
  if (style !== 'markdown' && style !== 'path') {
    throw new LubanError('E_INVALID_INPUT', '--style must be markdown or path')
  }
  const env = dependencies.env ?? process.env
  const cookie = requiredEnvironment(env, 'LUBAN_SESSION_COOKIE')
  const csrf = requiredEnvironment(env, 'LUBAN_CSRF_TOKEN')
  const root = baseUrl(
    parsed.values['base-url'] ??
      env.LUBAN_IMAGE_BASE_URL ??
      'http://127.0.0.1:42600/luban-image-paste',
  )
  const maxBytes = positiveInteger(env.LUBAN_IMAGE_MAX_BYTES, 10 * 1024 * 1024)
  const clipboard =
    dependencies.clipboard ??
    new SystemClipboardAdapter({
      ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
      timeoutMs: 10_000,
      maxBytes,
    })
  const capture = await clipboard.capture()
  const query = new URLSearchParams({
    source: 'clipboard-cli',
    name: parsed.values.name ?? capture.nameHint,
  })
  const fetcher = dependencies.fetch ?? fetch
  const uploaded = await requestJson(
    fetcher,
    `${root}/images?${query.toString()}`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': capture.mime,
        cookie,
        'x-luban-csrf': csrf,
      },
      body: new Blob([Uint8Array.from(capture.bytes)], { type: capture.mime }),
    },
    'Image upload',
  )
  const session = parsed.values.session
  if (session === undefined) return uploaded

  return requestJson(
    fetcher,
    `${root}/images/${encodeURIComponent(uploadedId(uploaded))}/inject`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        cookie,
        'x-luban-csrf': csrf,
      },
      body: JSON.stringify({ sessionId: session, style }),
    },
    'Session injection',
  )
}

const entryPath = process.argv[1]
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  run(process.argv.slice(2)).then(
    (value): void => {
      process.stdout.write(
        typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
      )
    },
    (error: unknown): void => {
      process.stderr.write(`${error instanceof Error ? error.message : 'luban-img failed'}\n`)
      process.exitCode = 1
    },
  )
}
