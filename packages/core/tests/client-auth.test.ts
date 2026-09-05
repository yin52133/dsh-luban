import { afterEach, describe, expect, it, vi } from 'vitest'
import { csrfHeaders } from '../src/client/auth.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('browser mutation authentication', () => {
  it('passes only the server token to the mutation caller', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ csrfToken: 'test-csrf' }))
    vi.stubGlobal('fetch', request)
    await expect(csrfHeaders()).resolves.toEqual({ 'x-luban-csrf': 'test-csrf' })
    expect(request.mock.calls[0]?.[0]).toBe('/luban-auth/session')
    const init = request.mock.calls[0]?.[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
  it.each([401, 403])(
    'reports an expired login (%s) instead of silently proceeding',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })))
      await expect(csrfHeaders()).rejects.toThrow('登录已失效')
    },
  )
  it.each([{}, { csrfToken: '' }, { csrfToken: 1 }, null])(
    'rejects missing tokens: %j',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)))
      await expect(csrfHeaders()).rejects.toThrow('登录验证信息不完整')
    },
  )
  it('reports unavailable authentication without continuing a mutation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))
    await expect(csrfHeaders()).rejects.toThrow('503')
  })
  it('aborts stalled session requests and reports a retryable timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            })
          }),
      ),
    )
    const result = expect(csrfHeaders()).rejects.toThrow('登录验证超时')
    await vi.advanceTimersByTimeAsync(10_000)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })
})
