import { describe, expect, it, vi } from 'vitest'
import { createUpstreamAuthCookie, withUpstreamCookie } from '../src/upstream-auth.js'

describe('DSH upstream authentication', () => {
  it('exchanges the process token once, then renews after a Connection restart', () => {
    let token = 'first'
    const authorizeIndex = vi.fn(
      (
        request: { headers: { host: string }; url: string },
        response: {
          writeHead(status: number, headers: Record<string, string>): unknown
          end(): unknown
        },
      ) => {
        expect(request.headers.host).toBe('127.0.0.1:3080')
        expect(request.url).toContain(`token=${token}`)
        response.writeHead(303, {
          'set-cookie': `dsh-auth-host=${token}.signature; Path=/; HttpOnly`,
        })
        response.end()
        return false
      },
    )
    const connection = {
      authenticatedUrl: (url: string): string => `${url}/?token=${token}`,
      authorizeIndex,
    }
    const getCookie = createUpstreamAuthCookie(() => connection, new URL('http://127.0.0.1:3080'))
    expect(getCookie()).toBe('dsh-auth-host=first.signature')
    expect(getCookie()).toBe('dsh-auth-host=first.signature')
    expect(authorizeIndex).toHaveBeenCalledTimes(1)
    token = 'second'
    expect(getCookie()).toBe('dsh-auth-host=second.signature')
    expect(authorizeIndex).toHaveBeenCalledTimes(2)
  })

  it('fails closed when Connection is not ready and replaces browser-supplied DSH cookies', () => {
    expect(createUpstreamAuthCookie(() => undefined, new URL('http://127.0.0.1:3080'))).toThrow(
      'not ready',
    )
    expect(
      withUpstreamCookie(
        'luban_session=abc; dsh-auth-host=forged; theme=dark',
        'dsh-auth-host=owned',
      ),
    ).toBe('luban_session=abc; theme=dark; dsh-auth-host=owned')
  })
})
