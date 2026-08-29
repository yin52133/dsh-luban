import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { resolveAuthConfig } from '../src/config.js'
import {
  HttpError,
  assertLoginOrigin,
  assertProxyBodySize,
  assertRequestOrigin,
  assertWebSocketOrigin,
  inspectRequestSecurity,
  isPublicStaticRequest,
  readBoundedForm,
  readBoundedJson,
  readCookie,
  safeReturnTo,
  singleHeader,
  stripCookie,
  wantsHtml,
} from '../src/http-security.js'

const hosts = new Set(['localhost', '127.0.0.1', 'proxy.example.test'])

describe('HTTP security primitives', () => {
  it('validates Host, network, and trusted proxy headers', () => {
    const config = resolveAuthConfig({
      trustProxy: true,
      allowedNetworks: ['192.0.2.0/24'],
      trustedProxyNetworks: ['127.0.0.1/32'],
    })
    const request = fakeRequest({
      headers: {
        host: '127.0.0.1:42600',
        'x-forwarded-host': 'proxy.example.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '192.0.2.20, 127.0.0.1',
      },
    })
    expect(inspectRequestSecurity(request, config, hosts)).toEqual({
      sourceIp: '192.0.2.20',
      authority: 'proxy.example.test',
      protocol: 'https',
      trustedProxy: true,
    })

    for (const badRequest of [
      fakeRequest({ headers: {} }),
      fakeRequest({ headers: { host: 'bad host' } }),
      fakeRequest({ headers: { host: 'attacker.invalid' } }),
      fakeRequest({ headers: { host: '127.0.0.1', 'x-forwarded-proto': 'ftp' } }),
      fakeRequest({ headers: { host: '127.0.0.1', 'x-forwarded-for': 'not-an-ip' } }),
    ]) {
      expect(() => inspectRequestSecurity(badRequest, config, hosts)).toThrow(HttpError)
    }
    const denied = fakeRequest({
      headers: { host: '127.0.0.1', 'x-forwarded-for': '198.51.100.4' },
    })
    expect(() => inspectRequestSecurity(denied, config, hosts)).toThrow(/network/u)
  })

  it('enforces origin and CSRF rules for mutations, login, and WebSocket', () => {
    const context = {
      sourceIp: '127.0.0.1',
      authority: 'localhost:42600',
      protocol: 'http' as const,
      trustedProxy: false,
    }
    expect(() =>
      assertRequestOrigin(fakeRequest({ method: 'GET', headers: {} }), context, false),
    ).not.toThrow()
    expect(() =>
      assertRequestOrigin(
        fakeRequest({ method: 'POST', headers: { origin: 'http://localhost:42600' } }),
        context,
        false,
      ),
    ).not.toThrow()
    expect(() =>
      assertRequestOrigin(fakeRequest({ method: 'POST', headers: {} }), context, true),
    ).not.toThrow()
    expect(() =>
      assertRequestOrigin(fakeRequest({ method: 'POST', headers: {} }), context, false),
    ).toThrow(/CSRF token/u)
    expect(() =>
      assertRequestOrigin(
        fakeRequest({ method: 'POST', headers: { origin: 'not a url' } }),
        context,
        true,
      ),
    ).toThrow(/origin/u)
    expect(() =>
      assertRequestOrigin(
        fakeRequest({
          method: 'POST',
          headers: { origin: 'http://attacker.invalid', 'sec-fetch-site': 'cross-site' },
        }),
        context,
        true,
      ),
    ).toThrow(/Cross-origin/u)
    expect(() =>
      assertRequestOrigin(
        fakeRequest({ method: 'POST', headers: { 'sec-fetch-site': 'same-site' } }),
        context,
        true,
      ),
    ).toThrow(/Cross-site/u)

    expect(() =>
      assertLoginOrigin(
        fakeRequest({ headers: { origin: 'http://localhost:42600', 'sec-fetch-site': 'none' } }),
        context,
      ),
    ).not.toThrow()
    expect(() => assertLoginOrigin(fakeRequest({ headers: { origin: 'null' } }), context)).toThrow(
      /login origin/u,
    )
    expect(() =>
      assertLoginOrigin(fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), context),
    ).toThrow(/Cross-site/u)

    expect(() =>
      assertWebSocketOrigin(
        fakeRequest({ headers: { origin: 'http://localhost:42600' } }),
        context,
      ),
    ).not.toThrow()
    expect(() => assertWebSocketOrigin(fakeRequest({ headers: {} }), context)).not.toThrow()
    expect(() =>
      assertWebSocketOrigin(fakeRequest({ headers: { origin: '::::' } }), context),
    ).toThrow(/WebSocket origin/u)
    expect(() =>
      assertWebSocketOrigin(
        fakeRequest({ headers: { origin: 'https://localhost:42600' } }),
        context,
      ),
    ).toThrow(/Cross-origin/u)
  })

  it('parses bounded JSON and form bodies with strict content metadata', async () => {
    await expect(
      readBoundedJson(
        bodyRequest('{"ok":true}', { 'content-type': 'application/json; charset=utf-8' }),
        128,
      ),
    ).resolves.toEqual({ ok: true })
    await expect(
      readBoundedJson(bodyRequest('{bad', { 'content-type': 'application/json' }), 128),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      readBoundedJson(bodyRequest('[]', { 'content-type': 'application/json' }), 128),
    ).rejects.toMatchObject({ status: 400 })
    await expect(readBoundedJson(bodyRequest('{}', {}), 128)).rejects.toMatchObject({ status: 415 })
    await expect(
      readBoundedJson(
        bodyRequest('{}', { 'content-type': 'application/json', 'content-length': '999' }),
        128,
      ),
    ).rejects.toMatchObject({ status: 413 })
    await expect(
      readBoundedJson(bodyRequest('x'.repeat(129), { 'content-type': 'application/json' }), 128),
    ).rejects.toMatchObject({ status: 413 })
    await expect(
      readBoundedForm(
        bodyRequest('user=admin&password=secret', {
          'content-type': 'application/x-www-form-urlencoded',
        }),
        128,
      ),
    ).resolves.toEqual({ user: 'admin', password: 'secret' })
    await expect(
      readBoundedForm(
        bodyRequest('user=a&user=b', { 'content-type': 'application/x-www-form-urlencoded' }),
        128,
      ),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('handles cookie, return target, static path, and header edge cases', () => {
    expect(readCookie('a=1; luban_session=token', 'luban_session')).toBe('token')
    expect(readCookie('luban_session=a; luban_session=b', 'luban_session')).toBeUndefined()
    expect(readCookie(undefined, 'luban_session')).toBeUndefined()
    expect(stripCookie('a=1; luban_session=secret; b=2', new Set(['luban_session']))).toBe(
      'a=1; b=2',
    )
    expect(stripCookie('luban_session=secret', new Set(['luban_session']))).toBeUndefined()
    expect(safeReturnTo('/tasks?q=one')).toBe('/tasks?q=one')
    expect(safeReturnTo('//attacker.invalid')).toBe('/')
    expect(safeReturnTo('/bad\r\nLocation:x')).toBe('/')
    expect(isPublicStaticRequest('GET', '/plugins/example.js')).toBe(true)
    expect(isPublicStaticRequest('HEAD', '/favicon.ico')).toBe(true)
    expect(isPublicStaticRequest('POST', '/assets/app.js')).toBe(false)
    expect(wantsHtml(fakeRequest({ headers: { accept: 'text/html,application/xhtml+xml' } }))).toBe(
      true,
    )
    expect(wantsHtml(fakeRequest({ headers: {} }))).toBe(false)
    expect(() =>
      singleHeader(fakeRequest({ headers: { 'x-test': ['a', 'b'] } }), 'x-test'),
    ).toThrow(/once/u)
    expect(() =>
      singleHeader(fakeRequest({ headers: { accept: 'bad\rvalue' } }), 'accept'),
    ).toThrow(/invalid/u)
    expect(() =>
      assertProxyBodySize(fakeRequest({ headers: { 'content-length': 'not-a-number' } }), 100),
    ).toThrow(/Content-Length/u)
  })
})

function fakeRequest(options: {
  readonly method?: string
  readonly headers: IncomingHttpHeaders
  readonly remoteAddress?: string
}): IncomingMessage {
  return {
    method: options.method ?? 'GET',
    headers: options.headers,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  } as IncomingMessage
}

function bodyRequest(body: string, headers: IncomingHttpHeaders): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body)]), {
    method: 'POST',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage
}
