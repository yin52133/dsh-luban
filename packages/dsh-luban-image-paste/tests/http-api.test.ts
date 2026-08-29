import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthService } from '@luban/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImagePasteHttpApi } from '../src/http-api.js'
import { AttachmentRepository } from '../src/repository.js'
import { FileImageIngestService } from '../src/service.js'
import {
  MutableClock,
  PNG_BYTES,
  RecordingInjector,
  emptyClipboard,
  passThroughProcessor,
  testConfig,
} from './helpers.js'

function authentication(): AuthService {
  return {
    middleware: () => (request) =>
      Promise.resolve(
        request.cookie === 'session=ok'
          ? { allowed: true, status: 200, user: 'tester' }
          : { allowed: false, status: 401 },
      ),
  } as AuthService
}

async function json(response: Response): Promise<Readonly<Record<string, unknown>>> {
  return (await response.json()) as Readonly<Record<string, unknown>>
}

function image(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const candidate = value.image
  if (typeof candidate !== 'object' || candidate === null) throw new Error('missing image')
  return candidate as Readonly<Record<string, unknown>>
}

describe('authenticated image HTTP API', () => {
  let workspace = ''
  let server: Server
  let baseUrl = ''
  let clock: MutableClock
  let injector: RecordingInjector

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'luban-image-http-'))
    clock = new MutableClock(Date.UTC(2026, 7, 30))
    injector = new RecordingInjector()
    const repository = await AttachmentRepository.create({
      workspaceRoot: workspace,
      attachDir: '.luban/attachments',
      clock,
    })
    const service = new FileImageIngestService({
      repository,
      clipboard: emptyClipboard,
      injector,
      processor: passThroughProcessor,
      config: testConfig(workspace, { recentLimit: 2 }),
    })
    const api = new ImagePasteHttpApi(service, authentication())
    server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${String(address.port)}/luban-image-paste`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject): void => {
      server.close((error): void => (error === undefined ? resolve() : reject(error)))
    })
    if (workspace !== '') await rm(workspace, { recursive: true, force: true })
  })

  const authHeaders = Object.freeze({
    cookie: 'session=ok',
    'x-luban-csrf': 'csrf-token',
  })

  async function upload(
    name: string,
    source = 'paste',
  ): Promise<Readonly<Record<string, unknown>>> {
    const response = await fetch(
      `${baseUrl}/images?source=${encodeURIComponent(source)}&name=${encodeURIComponent(name)}`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'image/png' },
        body: new Blob([PNG_BYTES], { type: 'image/png' }),
      },
    )
    expect(response.status).toBe(201)
    return image(await json(response))
  }

  it('authenticates every route and validates upload MIME', async () => {
    await expect(fetch(`${baseUrl}/images`)).resolves.toMatchObject({ status: 401 })
    const mismatch = await fetch(`${baseUrl}/images?source=paste`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'image/jpeg' },
      body: new Blob([PNG_BYTES], { type: 'image/jpeg' }),
    })
    expect(mismatch.status).toBe(400)
    await expect(json(mismatch)).resolves.toHaveProperty('error')
  })

  it('uploads, lists, previews, injects, and reference-protects an image', async () => {
    const uploaded = await upload('scope.png', 'drop')
    const id = uploaded.id as string
    const listResponse = await fetch(`${baseUrl}/images`, { headers: authHeaders })
    expect(listResponse.status).toBe(200)
    const listed = await json(listResponse)
    expect(Array.isArray(listed.images)).toBe(true)
    const first = (listed.images as readonly unknown[])[0] as Readonly<Record<string, unknown>>
    expect(first).toMatchObject({ id, source: 'drop' })
    expect(typeof first.compression).toBe('object')

    const preview = await fetch(`${baseUrl}/images/${encodeURIComponent(id)}/content`, {
      headers: authHeaders,
    })
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(PNG_BYTES)

    const injection = await fetch(`${baseUrl}/images/${encodeURIComponent(id)}/inject`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', style: 'markdown' }),
    })
    expect(injection.status).toBe(200)
    expect(injector.calls).toHaveLength(1)
    expect(injector.calls[0]?.image.relPath).toBe(uploaded.relPath)

    const deletion = await fetch(`${baseUrl}/images/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
    expect(deletion.status).toBe(409)
  })

  it('serves Unicode attachment names with an ASCII and RFC 5987 disposition', async () => {
    const uploaded = await upload('示波器.png')
    const preview = await fetch(
      `${baseUrl}/images/${encodeURIComponent(uploaded.id as string)}/content`,
      { headers: authHeaders },
    )

    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-disposition')).toBe(
      `inline; filename="image.png"; filename*=UTF-8''${encodeURIComponent('示波器.png')}`,
    )
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it('deletes unreferenced images and performs reference-aware TTL cleanup', async () => {
    const deleted = await upload('delete-me.png')
    const deletion = await fetch(`${baseUrl}/images/${encodeURIComponent(deleted.id as string)}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
    expect(deletion.status).toBe(204)

    const orphan = await upload('expire-me.png')
    clock.value += 15 * 24 * 60 * 60 * 1_000
    const cleanup = await fetch(`${baseUrl}/cleanup`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false }),
    })
    expect(cleanup.status).toBe(200)
    const report = (await json(cleanup)).report as Readonly<Record<string, unknown>>
    expect(report.removed).toEqual([orphan.relPath])
  })

  it('bounds server-side recent image responses', async () => {
    await upload('first.png')
    clock.value += 1
    await upload('second.png')
    clock.value += 1
    await upload('third.png')

    const response = await fetch(`${baseUrl}/images`, { headers: authHeaders })
    expect(response.status).toBe(200)
    const body = await json(response)
    expect(body.images).toMatchObject([{ originalName: 'third' }, { originalName: 'second' }])
  })
})
