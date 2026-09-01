import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AccountId,
  AuthMiddlewareRequest,
  AuthService,
  SessionId,
} from '@yin52133/dsh-luban-core'
import { asAccountId } from '@yin52133/dsh-luban-core'
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

const ALICE_ACCOUNT = asAccountId('account-alice')
const BOB_ACCOUNT = asAccountId('account-bob')

const SESSION_OWNERS = new Map<string, AccountId>([
  ['session-1', ALICE_ACCOUNT],
  ['session-live', ALICE_ACCOUNT],
  ['session-bob', BOB_ACCOUNT],
])

function authentication(): AuthService {
  return {
    middleware: () => (request: AuthMiddlewareRequest) =>
      Promise.resolve(
        request.cookie === 'session=ok'
          ? {
              allowed: true,
              status: 200,
              user: 'alice',
              account: { accountId: ALICE_ACCOUNT, username: 'alice', role: 'operator' },
            }
          : request.cookie === 'session=bob'
            ? {
                allowed: true,
                status: 200,
                user: 'bob',
                account: { accountId: BOB_ACCOUNT, username: 'bob', role: 'operator' },
              }
            : { allowed: false, status: 401 },
      ),
    accountSessions: {
      bind: (accountId: AccountId, sessionId: SessionId): Promise<void> => {
        SESSION_OWNERS.set(sessionId, accountId)
        return Promise.resolve()
      },
      ownerOf: (sessionId: SessionId): Promise<AccountId | null> =>
        Promise.resolve(SESSION_OWNERS.get(sessionId) ?? null),
    },
  } as unknown as AuthService
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

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'luban-image-http-'))
    clock = new MutableClock(Date.UTC(2026, 7, 30))
    injector = new RecordingInjector()
    const repository = await AttachmentRepository.create({
      workspaceRoot: workspace,
      attachDir: '.luban/attachments',
      clock,
    })
    const auth = authentication()
    service = new FileImageIngestService({
      repository,
      accountSessions: auth.accountSessions,
      clipboard: emptyClipboard,
      injector,
      processor: passThroughProcessor,
      config: testConfig(workspace, { recentLimit: 2 }),
    })
    const api = new ImagePasteHttpApi(service, auth)
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
  const bobHeaders = Object.freeze({
    cookie: 'session=bob',
    'x-luban-csrf': 'csrf-token',
  })

  async function upload(
    name: string,
    source = 'paste',
    headers: Readonly<Record<string, string>> = authHeaders,
    requestedAccountId?: AccountId,
  ): Promise<Readonly<Record<string, unknown>>> {
    const response = await fetch(
      `${baseUrl}/images?source=${encodeURIComponent(source)}&name=${encodeURIComponent(name)}${
        requestedAccountId === undefined
          ? ''
          : `&accountId=${encodeURIComponent(requestedAccountId)}`
      }`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'image/png' },
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

  it('isolates alice and bob records and ignores request account overrides', async () => {
    const aliceImage = await upload('alice-only.png')
    const aliceId = aliceImage.id as string
    const bobImage = await upload('bob-only.png', 'paste', bobHeaders, ALICE_ACCOUNT)
    const bobId = bobImage.id as string

    expect(aliceImage.accountId).toBe(ALICE_ACCOUNT)
    expect(bobImage.accountId).toBe(BOB_ACCOUNT)

    const aliceList = await json(
      await fetch(`${baseUrl}/images?accountId=${encodeURIComponent(BOB_ACCOUNT)}`, {
        headers: authHeaders,
      }),
    )
    expect(aliceList.images).toMatchObject([{ id: aliceId }])
    const bobList = await json(
      await fetch(`${baseUrl}/images?accountId=${encodeURIComponent(ALICE_ACCOUNT)}`, {
        headers: bobHeaders,
      }),
    )
    expect(bobList.images).toMatchObject([{ id: bobId }])

    await expect(
      fetch(`${baseUrl}/images/${encodeURIComponent(aliceId)}/content`, {
        headers: bobHeaders,
      }),
    ).resolves.toMatchObject({ status: 404 })
    await expect(
      fetch(`${baseUrl}/images/${encodeURIComponent(aliceId)}`, {
        method: 'DELETE',
        headers: bobHeaders,
      }),
    ).resolves.toMatchObject({ status: 404 })

    const crossAccountSession = await fetch(
      `${baseUrl}/images/${encodeURIComponent(aliceId)}/inject`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          accountId: BOB_ACCOUNT,
          sessionId: 'session-bob',
          style: 'markdown',
        }),
      },
    )
    expect(crossAccountSession.status).toBe(404)
    expect(injector.calls).toHaveLength(0)

    const bobCrossRecord = await fetch(`${baseUrl}/images/${encodeURIComponent(aliceId)}/inject`, {
      method: 'POST',
      headers: { ...bobHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: ALICE_ACCOUNT,
        sessionId: 'session-bob',
        style: 'markdown',
      }),
    })
    expect(bobCrossRecord.status).toBe(404)
    expect(injector.calls).toHaveLength(0)
  })

  it('limits authenticated cleanup to the current account', async () => {
    const aliceImage = await upload('alice-expired.png')
    const bobImage = await upload('bob-expired.png', 'paste', bobHeaders)
    clock.value += 15 * 24 * 60 * 60 * 1_000

    const bobCleanup = await fetch(`${baseUrl}/cleanup`, {
      method: 'POST',
      headers: { ...bobHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, accountId: ALICE_ACCOUNT }),
    })
    expect(bobCleanup.status).toBe(200)
    await expect(
      fetch(`${baseUrl}/images/${encodeURIComponent(aliceImage.id as string)}/content`, {
        headers: authHeaders,
      }),
    ).resolves.toMatchObject({ status: 200 })
    await expect(
      fetch(`${baseUrl}/images/${encodeURIComponent(bobImage.id as string)}/content`, {
        headers: bobHeaders,
      }),
    ).resolves.toMatchObject({ status: 404 })

    const aliceCleanup = await fetch(`${baseUrl}/cleanup`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, accountId: BOB_ACCOUNT }),
    })
    expect(aliceCleanup.status).toBe(200)
    await expect(
      fetch(`${baseUrl}/images/${encodeURIComponent(aliceImage.id as string)}/content`, {
        headers: authHeaders,
      }),
    ).resolves.toMatchObject({ status: 404 })
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
