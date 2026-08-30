import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AccountId, AuthService, BrowserTemplate } from 'dsh-luban-core'
import { asAccountId } from 'dsh-luban-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserHttpApi } from '../src/http-api.js'
import type {
  BrowserJobEvent,
  BrowserJobRequest,
  BrowserJobSnapshot,
  BrowserQueue,
} from '../src/types.js'

const closers: (() => Promise<void>)[] = []
const ALICE = asAccountId('alice')
const BOB = asAccountId('bob')

afterEach(async (): Promise<void> => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

describe('BrowserHttpApi', () => {
  it('checks AuthService before exposing queue state', async () => {
    const fake = fakeQueue()
    const api = new BrowserHttpApi(
      fake.queue,
      { templates: () => Promise.resolve([]) },
      auth(false),
    )
    const url = await listen(api)

    const response = await fetch(`${url}/luban-browser/jobs`)

    expect(response.status).toBe(401)
    expect(fake.list).not.toHaveBeenCalled()
  })

  it('accepts a bounded manual task but never trusts an automatic body flag', async () => {
    const fake = fakeQueue()
    const api = new BrowserHttpApi(
      fake.queue,
      { templates: (): Promise<BrowserTemplate[]> => Promise.resolve([]) },
      auth(true, ALICE),
    )
    const url = await listen(api)

    const response = await fetch(`${url}/luban-browser/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: { goal: 'Mock task' }, automatic: true }),
    })

    expect(response.status).toBe(202)
    expect(fake.enqueue).toHaveBeenCalledWith({
      accountId: ALICE,
      task: { goal: 'Mock task' },
      automatic: false,
    })
  })

  it('uses the authenticated account for job ID lookups', async () => {
    const fake = fakeQueue()
    const api = new BrowserHttpApi(
      fake.queue,
      { templates: (): Promise<BrowserTemplate[]> => Promise.resolve([]) },
      auth(true, BOB),
    )
    const url = await listen(api)

    const response = await fetch(`${url}/luban-browser/jobs/00000000-0000-0000-0000-000000000001`)

    expect(response.status).toBe(404)
    expect(fake.get).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001', BOB)
  })

  it('sends live job events only to the matching account stream', async () => {
    const fake = fakeQueue()
    const aliceApi = new BrowserHttpApi(
      fake.queue,
      { templates: (): Promise<BrowserTemplate[]> => Promise.resolve([]) },
      auth(true, ALICE),
    )
    const bobApi = new BrowserHttpApi(
      fake.queue,
      { templates: (): Promise<BrowserTemplate[]> => Promise.resolve([]) },
      auth(true, BOB),
    )
    const [aliceUrl, bobUrl] = await Promise.all([listen(aliceApi), listen(bobApi)])
    const [aliceResponse, bobResponse] = await Promise.all([
      fetch(`${aliceUrl}/luban-browser/events`),
      fetch(`${bobUrl}/luban-browser/events`),
    ])
    const aliceReader = aliceResponse.body?.getReader()
    const bobReader = bobResponse.body?.getReader()
    if (aliceReader === undefined || bobReader === undefined) throw new Error('Missing SSE reader')
    await Promise.all([aliceReader.read(), bobReader.read()])

    fake.emit(eventFor(ALICE, '00000000-0000-0000-0000-000000000001', 1))
    const aliceFrame = await aliceReader.read()
    expect(new TextDecoder().decode(aliceFrame.value)).toContain(
      '00000000-0000-0000-0000-000000000001',
    )

    const bobPending = bobReader.read()
    const bobEarly = await Promise.race([
      bobPending.then((): 'event' => 'event'),
      new Promise<'waiting'>((resolve): void => {
        setTimeout((): void => resolve('waiting'), 20)
      }),
    ])
    expect(bobEarly).toBe('waiting')
    fake.emit(eventFor(BOB, '00000000-0000-0000-0000-000000000002', 2))
    const bobFrame = await bobPending
    expect(new TextDecoder().decode(bobFrame.value)).toContain(
      '00000000-0000-0000-0000-000000000002',
    )

    await Promise.all([aliceReader.cancel(), bobReader.cancel()])
  })
})

function auth(allowed: boolean, accountId: AccountId = ALICE): AuthService {
  return {
    verify: vi.fn(() => Promise.resolve({ ok: true })),
    issueSession: vi.fn(() =>
      Promise.resolve({
        id: 'session',
        user: 'user',
        issuedAt: 1,
        expiresAt: 2,
        sourceIp: '127.0.0.1',
      }),
    ),
    revoke: vi.fn(() => Promise.resolve()),
    revokeAllFor: vi.fn(() => Promise.resolve()),
    middleware: () => () =>
      Promise.resolve(
        allowed
          ? { allowed: true, status: 200, user: String(accountId) }
          : { allowed: false, status: 401 },
      ),
    onChange: vi.fn(() => (): void => undefined),
    accountSessions: {
      bind: vi.fn(() => Promise.resolve()),
      ownerOf: vi.fn(() => Promise.resolve(null)),
    },
  }
}

function fakeQueue(): {
  readonly queue: BrowserQueue
  enqueue: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  emit: (event: BrowserJobEvent) => void
} {
  const job: BrowserJobSnapshot = {
    id: '00000000-0000-0000-0000-000000000001',
    accountId: ALICE,
    status: 'queued',
    task: { goal: 'Mock task' },
    automatic: false,
    createdAt: 1,
    progressStep: 0,
    screenshots: [],
  }
  const enqueue = vi.fn((_request: BrowserJobRequest): BrowserJobSnapshot => job)
  const list = vi.fn((accountId: AccountId): readonly BrowserJobSnapshot[] =>
    accountId === ALICE ? [job] : [],
  )
  const get = vi.fn((_id: string, accountId: AccountId): BrowserJobSnapshot | null =>
    accountId === ALICE ? job : null,
  )
  const listeners = new Set<(event: BrowserJobEvent) => void>()
  const queue: BrowserQueue = {
    enqueue,
    list,
    get,
    cancel: vi.fn(() => Promise.resolve(true)),
    wait: vi.fn(() => Promise.resolve(job)),
    subscribe: vi.fn(() => (): void => undefined),
    subscribeAll: vi.fn((listener: (event: BrowserJobEvent) => void): (() => void) => {
      listeners.add(listener)
      return (): void => {
        listeners.delete(listener)
      }
    }),
  }
  return {
    queue,
    enqueue,
    list,
    get,
    emit(event): void {
      for (const listener of listeners) listener(event)
    },
  }
}

function eventFor(accountId: AccountId, id: string, sequence: number): BrowserJobEvent {
  return {
    sequence,
    at: sequence,
    job: {
      id,
      accountId,
      status: 'queued',
      task: { accountId, goal: `${String(accountId)} task` },
      automatic: false,
      createdAt: sequence,
      progressStep: 0,
      screenshots: [],
    },
  }
}

async function listen(api: BrowserHttpApi): Promise<string> {
  const server = createServer((request, response): void => {
    void api.handler(request, response)
  })
  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  closers.push(async (): Promise<void> => {
    api.close()
    await new Promise<void>((resolve, reject): void => {
      server.close((error): void => (error === undefined ? resolve() : reject(error)))
    })
  })
  return `http://127.0.0.1:${String(port)}`
}
