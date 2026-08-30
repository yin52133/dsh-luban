import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthService } from 'dsh-luban-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImagePasteHttpApi } from '../src/http-api.js'
import type {
  MountedVisualAcceptanceOptions,
  VisualAcceptanceEvidence,
} from '../src/live-visual-acceptance.js'
import { MountedVisualAcceptanceService } from '../src/live-visual-acceptance.js'
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
  let service: FileImageIngestService
  let visualRun: ReturnType<
    typeof vi.fn<(options: MountedVisualAcceptanceOptions) => Promise<VisualAcceptanceEvidence>>
  >

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'luban-image-http-'))
    clock = new MutableClock(Date.UTC(2026, 7, 30))
    injector = new RecordingInjector()
    const repository = await AttachmentRepository.create({
      workspaceRoot: workspace,
      attachDir: '.luban/attachments',
      clock,
    })
    service = new FileImageIngestService({
      repository,
      clipboard: emptyClipboard,
      injector,
      processor: passThroughProcessor,
      config: testConfig(workspace, { recentLimit: 2 }),
    })
    visualRun = vi.fn((options: MountedVisualAcceptanceOptions) =>
      Promise.resolve({
        schemaVersion: 2,
        featureId: 'M06-F003',
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        execution: 'production',
        evidenceKind: 'live',
        status: 'pass',
        acceptancePassed: true,
        session: { requestedId: options.sessionId },
        platform: {
          target: 'windows',
          runtimePlatform: 'win32',
          arch: 'x64',
          node: 'v22.0.0',
        },
        checks: [],
        cleanup: 'not-needed',
        providerRawResponse: 'provider-secret-response',
        startedAt: new Date(1).toISOString(),
        finishedAt: new Date(2).toISOString(),
      } as unknown as VisualAcceptanceEvidence),
    )
    const api = new ImagePasteHttpApi(service, authentication(), { run: visualRun })
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

  it('exposes an authenticated mounted visual entry only for explicit live requests', async () => {
    await expect(
      fetch(`${baseUrl}/visual-acceptance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ live: true, sessionId: 'session-live' }),
      }),
    ).resolves.toMatchObject({ status: 401 })
    const planned = await fetch(`${baseUrl}/visual-acceptance`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ live: false, sessionId: 'session-live' }),
    })
    expect(planned.status).toBe(400)
    expect(visualRun).not.toHaveBeenCalled()

    const live = await fetch(`${baseUrl}/visual-acceptance`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ live: true, sessionId: 'session-live', timeoutMs: 10_000 }),
    })
    expect(live.status).toBe(200)
    expect(visualRun).toHaveBeenCalledExactlyOnceWith({
      live: true,
      sessionId: 'session-live',
      timeoutMs: 10_000,
    })
    const liveBody = await json(live)
    expect(liveBody).toMatchObject({
      evidence: { execution: 'test-double', evidenceKind: 'simulated' },
    })
    expect(JSON.stringify(liveBody)).not.toContain('provider-secret-response')
  })

  it('does not let a mounted production runner be replaced after API construction', async () => {
    const mounted = new MountedVisualAcceptanceService(
      { agents: { get: (): undefined => undefined } } as unknown as Context,
      workspace,
    )
    const hardenedApi = new ImagePasteHttpApi(service, authentication(), mounted)
    const replacedRun = vi.fn(() => Promise.resolve({} as VisualAcceptanceEvidence))
    Object.defineProperty(mounted, 'run', { configurable: true, value: replacedRun })
    const hardenedServer = createServer((request, response): void => {
      void hardenedApi.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      hardenedServer.once('error', reject)
      hardenedServer.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = hardenedServer.address() as AddressInfo
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/luban-image-paste/visual-acceptance`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ live: true, sessionId: 'session-live' }),
        },
      )

      expect(response.status).toBe(200)
      expect(replacedRun).not.toHaveBeenCalled()
      await expect(json(response)).resolves.toMatchObject({
        evidence: {
          execution: 'production',
          evidenceKind: 'live',
          status: 'blocked',
          session: { requestedId: 'session-live' },
        },
      })
    } finally {
      await new Promise<void>((resolve, reject): void => {
        hardenedServer.close((error): void => (error === undefined ? resolve() : reject(error)))
      })
    }
  })

  it('does not let the production runner prototype be replaced after API construction', async () => {
    const mounted = new MountedVisualAcceptanceService(
      { agents: { get: (): undefined => undefined } } as unknown as Context,
      workspace,
    )
    const hardenedApi = new ImagePasteHttpApi(service, authentication(), mounted)
    const replacement = vi
      .spyOn(MountedVisualAcceptanceService.prototype, 'run')
      .mockResolvedValue({
        schemaVersion: 2,
        featureId: 'M06-F003',
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        execution: 'production',
        evidenceKind: 'live',
        status: 'pass',
        acceptancePassed: true,
        platform: {
          target: 'windows',
          runtimePlatform: 'win32',
          arch: 'x64',
          node: 'v22.0.0',
        },
        checks: [],
        cleanup: 'pass',
        startedAt: new Date(1).toISOString(),
        finishedAt: new Date(2).toISOString(),
      })
    const hardenedServer = createServer((request, response): void => {
      void hardenedApi.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      hardenedServer.once('error', reject)
      hardenedServer.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = hardenedServer.address() as AddressInfo
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/luban-image-paste/visual-acceptance`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ live: true, sessionId: 'session-live' }),
        },
      )

      expect(response.status).toBe(200)
      expect(replacement).not.toHaveBeenCalled()
      await expect(json(response)).resolves.toMatchObject({
        evidence: {
          execution: 'production',
          evidenceKind: 'live',
          status: 'blocked',
          acceptancePassed: false,
        },
      })
    } finally {
      await new Promise<void>((resolve, reject): void => {
        hardenedServer.close((error): void => (error === undefined ? resolve() : reject(error)))
      })
    }
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
