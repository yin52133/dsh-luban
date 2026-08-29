import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AuthService, BrowserTemplate } from '@luban/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserHttpApi } from '../src/http-api.js'
import type { BrowserJobRequest, BrowserJobSnapshot, BrowserQueue } from '../src/types.js'

const closers: (() => Promise<void>)[] = []

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
      auth(true),
    )
    const url = await listen(api)

    const response = await fetch(`${url}/luban-browser/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: { goal: 'Mock task' }, automatic: true }),
    })

    expect(response.status).toBe(202)
    expect(fake.enqueue).toHaveBeenCalledWith({ task: { goal: 'Mock task' }, automatic: false })
  })
})

function auth(allowed: boolean): AuthService {
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
        allowed ? { allowed: true, status: 200, user: 'user' } : { allowed: false, status: 401 },
      ),
    onChange: vi.fn(() => (): void => undefined),
  }
}

function fakeQueue(): {
  readonly queue: BrowserQueue
  enqueue: ReturnType<typeof vi.fn>
  list: ReturnType<typeof vi.fn>
} {
  const job: BrowserJobSnapshot = {
    id: '00000000-0000-0000-0000-000000000001',
    status: 'queued',
    task: { goal: 'Mock task' },
    automatic: false,
    createdAt: 1,
    progressStep: 0,
    screenshots: [],
  }
  const enqueue = vi.fn((_request: BrowserJobRequest): BrowserJobSnapshot => job)
  const list = vi.fn((): readonly BrowserJobSnapshot[] => [job])
  const queue: BrowserQueue = {
    enqueue,
    list,
    get: vi.fn(() => job),
    cancel: vi.fn(() => Promise.resolve(true)),
    wait: vi.fn(() => Promise.resolve(job)),
    subscribe: vi.fn(() => (): void => undefined),
  }
  return { queue, enqueue, list }
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
