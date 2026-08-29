import { describe, expect, it, vi } from 'vitest'
import { run } from '../src/cli.js'
import { acceptedImageFile, uploadImage } from '../src/client/index.js'
import type { ClipboardAdapter } from '../src/types.js'
import { PNG_BYTES } from './helpers.js'

function clipboard(): ClipboardAdapter {
  return {
    capture: () => Promise.resolve({ bytes: PNG_BYTES, mime: 'image/png', nameHint: 'clipboard' }),
  }
}

describe('browser capture helpers', () => {
  it('accepts only bounded supported browser files', () => {
    expect(acceptedImageFile(new File([PNG_BYTES], 'scope.png', { type: 'image/png' }))).toBe(true)
    expect(acceptedImageFile(new File([PNG_BYTES], 'scope.gif', { type: 'image/gif' }))).toBe(false)
    expect(acceptedImageFile(new File([], 'empty.png', { type: 'image/png' }))).toBe(false)
    expect(
      acceptedImageFile(
        new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'huge.png', {
          type: 'image/png',
        }),
      ),
    ).toBe(false)
  })

  it('times out when an authenticated upload response body stalls', async () => {
    vi.useFakeTimers()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: 'csrf' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(new TextEncoder().encode('{'))
            },
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetcher)
    try {
      const pending = uploadImage(
        new File([PNG_BYTES], 'scope.png', { type: 'image/png' }),
        'paste',
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(fetcher).toHaveBeenCalledTimes(2)
      const assertion = expect(pending).rejects.toThrow('Image upload timed out')
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})

describe('luban-img CLI with fake clipboard and HTTP transport', () => {
  it('uploads local bytes and sends cookie plus CSRF on both writes', async () => {
    const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = []
    const fetcher = vi.fn(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        calls.push({ url, init })
        const body = url.endsWith('/inject')
          ? { image: { id: 'image-1', referencedBy: ['session-1'] } }
          : { image: { id: 'image-1', referencedBy: [] } }
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      },
    )
    await run(['capture', '--name', 'scope', '--session', 'session-1', '--style', 'path'], {
      clipboard: clipboard(),
      fetch: fetcher,
      env: {
        LUBAN_SESSION_COOKIE: 'luban_session=secret-cookie',
        LUBAN_CSRF_TOKEN: 'csrf-secret',
      },
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:42600/luban-image-paste/images?source=clipboard-cli&name=scope',
    )
    expect(calls[1]?.url).toBe('http://127.0.0.1:42600/luban-image-paste/images/image-1/inject')
    for (const call of calls) {
      const headers = new Headers(call.init?.headers)
      expect(headers.get('cookie')).toBe('luban_session=secret-cookie')
      expect(headers.get('x-luban-csrf')).toBe('csrf-secret')
    }
    expect(calls[0]?.init?.body).toBeInstanceOf(Blob)
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ sessionId: 'session-1', style: 'path' }))
  })

  it('prints help without touching the clipboard or requiring credentials', async () => {
    const capture = vi.fn(() => Promise.reject(new Error('must not run')))
    await expect(run(['--help'], { clipboard: { capture }, env: {} })).resolves.toContain(
      '/luban-image-paste',
    )
    expect(capture).not.toHaveBeenCalled()
  })

  it('requires environment-only credentials before clipboard capture', async () => {
    const capture = vi.fn(() =>
      Promise.resolve({
        bytes: PNG_BYTES,
        mime: 'image/png' as const,
        nameHint: 'clipboard',
      }),
    )
    await expect(run([], { clipboard: { capture }, env: {} })).rejects.toMatchObject({
      code: 'E_AUTH_REQUIRED',
    })
    expect(capture).not.toHaveBeenCalled()
  })

  it('rejects credential-bearing or wrong-path base URLs', async () => {
    const env = {
      LUBAN_SESSION_COOKIE: 'session=ok',
      LUBAN_CSRF_TOKEN: 'csrf',
    }
    await expect(
      run(['--base-url', 'http://user:pass@localhost/luban-image-paste'], {
        clipboard: clipboard(),
        env,
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    await expect(
      run(['--base-url', 'http://localhost/luban/auth/login'], {
        clipboard: clipboard(),
        env,
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
  })

  it('bounds API responses and does not expose an error body to the terminal', async () => {
    const env = {
      LUBAN_SESSION_COOKIE: 'session=ok',
      LUBAN_CSRF_TOKEN: 'csrf',
    }
    await expect(
      run([], {
        clipboard: clipboard(),
        env,
        fetch: () =>
          Promise.resolve(
            new Response(`secret-token\n\u001B[31m${'x'.repeat(70_000)}`, { status: 500 }),
          ),
      }),
    ).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
      message: 'Image upload failed (500)',
    })

    await expect(
      run([], {
        clipboard: clipboard(),
        env,
        fetch: () => Promise.resolve(new Response('x'.repeat(70_000), { status: 200 })),
      }),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE', message: 'Image API response is too large' })
  })

  it('times out when API headers arrive but the response body stalls', async () => {
    vi.useFakeTimers()
    try {
      const pending = run([], {
        clipboard: clipboard(),
        env: {
          LUBAN_SESSION_COOKIE: 'session=ok',
          LUBAN_CSRF_TOKEN: 'csrf',
        },
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller): void {
                  controller.enqueue(new TextEncoder().encode('{'))
                },
              }),
              { status: 200 },
            ),
          ),
      })
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'E_TIMEOUT',
        message: 'Image upload timed out',
      })
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
