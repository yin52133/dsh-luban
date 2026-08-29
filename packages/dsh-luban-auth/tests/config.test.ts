import { describe, expect, it } from 'vitest'
import {
  Config,
  expandHomePath,
  localHostnames,
  parseUpstream,
  resolveAuthConfig,
} from '../src/config.js'
import { isIpAllowed } from '../src/http-security.js'

describe('authentication config', () => {
  it('applies secure defaults through Standard Schema v1', () => {
    const result = Config['~standard'].validate(undefined)
    expect('value' in result).toBe(true)
    if (!('value' in result)) return
    expect(result.value).toMatchObject({
      host: '0.0.0.0',
      port: 42_600,
      upstream: 'http://127.0.0.1:3080',
      sessionTtlHours: 72,
      maxFailures: 5,
      loginRateLimitPerMinute: 10,
      trustProxy: false,
    })
  })

  it('rejects typos, unsafe numeric values, and non-loopback upstreams', () => {
    expect(() => resolveAuthConfig({ prot: 123 })).toThrow(/unknown config field/u)
    expect(() => resolveAuthConfig({ port: 65_536 })).toThrow(/port/u)
    expect(() => resolveAuthConfig({ loginRateLimitPerMinute: 11 })).toThrow(/loginRate/u)
    expect(() => parseUpstream('http://192.0.2.20:3080')).toThrow(/loopback/u)
    expect(() => parseUpstream('file:///tmp/socket')).toThrow(/http or https/u)
    expect(() => parseUpstream('http://127.0.0.1:3080/base')).toThrow(/origin URL/u)
  })

  it('expands home paths and recognizes local/trusted hosts', () => {
    expect(expandHomePath('~/.dsh/luban/auth/users.json')).not.toContain('~')
    const hosts = localHostnames(['auth.example.test:42600'])
    expect(hosts.has('localhost')).toBe(true)
    expect(hosts.has('auth.example.test')).toBe(true)
  })

  it('matches IPv4 and IPv6 CIDRs without broadening malformed entries', () => {
    expect(isIpAllowed('192.0.2.9', ['192.0.2.0/24'])).toBe(true)
    expect(isIpAllowed('198.51.100.9', ['192.0.2.0/24'])).toBe(false)
    expect(isIpAllowed('2001:db8::10', ['2001:db8::/64'])).toBe(true)
    expect(isIpAllowed('2001:db9::10', ['2001:db8::/64'])).toBe(false)
    expect(isIpAllowed('127.0.0.1', ['invalid/24'])).toBe(false)
    expect(isIpAllowed('203.0.113.8', [])).toBe(true)
  })
})
