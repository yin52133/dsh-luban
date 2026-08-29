import { describe, expect, it } from 'vitest'
import { parseConfig, resolveHostId } from '../src/config.js'

describe('session share config', (): void => {
  it('normalizes peer origins while retaining only environment variable names', (): void => {
    const config = parseConfig({
      host: 'Ubuntu Build',
      ownerUser: 'alice',
      takeoverTimeoutSec: 30,
      peers: [
        {
          name: 'win-debug',
          baseUrl: 'https://win.example.test:42600/',
          credentialEnv: 'LUBAN_SESSION_SHARE_WIN_COOKIE',
        },
      ],
    })

    expect(resolveHostId(config.host)).toBe('ubuntu-build')
    expect(config.peers).toEqual([
      {
        name: 'win-debug',
        baseUrl: 'https://win.example.test:42600',
        credentialEnv: 'LUBAN_SESSION_SHARE_WIN_COOKIE',
      },
    ])
    expect(JSON.stringify(config)).not.toContain('luban_session=')
  })

  it.each([
    [{ ownerUser: 'Owner Name' }],
    [
      {
        peers: [{ name: 'win', baseUrl: 'http://user:secret@host', credentialEnv: 'PEER_COOKIE' }],
      },
    ],
    [
      {
        peers: [{ name: 'win', baseUrl: 'http://host?token=secret', credentialEnv: 'PEER_COOKIE' }],
      },
    ],
    [{ peers: [{ name: 'Win Host', baseUrl: 'http://host', credentialEnv: 'PEER_COOKIE' }] }],
    [{ peers: [{ name: 'win', baseUrl: 'http://host', credentialEnv: 'cookie' }] }],
    [
      {
        peers: [
          { name: 'win', baseUrl: 'http://one', credentialEnv: 'PEER_ONE' },
          { name: 'win', baseUrl: 'http://two', credentialEnv: 'PEER_TWO' },
        ],
      },
    ],
  ])('rejects unsafe peer config %#', (input): void => {
    expect(() => parseConfig(input)).toThrow(TypeError)
  })
})
