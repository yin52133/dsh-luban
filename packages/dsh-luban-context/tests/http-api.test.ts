import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { AccountId, AuthMiddlewareDecision, AuthService } from '@yin52133/dsh-luban-core'
import { LubanError, asSessionId } from '@yin52133/dsh-luban-core'
import type { CompactionEngineWithReplay } from '../src/engine.js'
import { ContextHttpApi } from '../src/http-api.js'
import { ALICE, BOB, memoryAccountSessions } from './account-sessions.js'

function auth(accountId: AccountId = ALICE): AuthService {
  return {
    verify: vi.fn<AuthService['verify']>(),
    issueSession: vi.fn<AuthService['issueSession']>(),
    revoke: vi.fn<AuthService['revoke']>(),
    revokeAllFor: vi.fn<AuthService['revokeAllFor']>(),
    middleware: (): ReturnType<AuthService['middleware']> => () =>
      Promise.resolve({
        allowed: true,
        status: 200,
        user: String(accountId),
        account: { accountId, username: String(accountId), role: 'operator' },
      }),
    onChange: vi.fn<AuthService['onChange']>().mockReturnValue((): void => undefined),
    accountSessions: memoryAccountSessions(),
  }
}

describe('ContextHttpApi', () => {
  it('serves authenticated profiles, audit, replay, and scheduler scope control', async () => {
    const markScope = vi.fn<CompactionEngineWithReplay['markScope']>().mockResolvedValue()
    const replayFile = vi
      .fn<CompactionEngineWithReplay['replayFile']>()
      .mockResolvedValue('# exact historical context')
    const engine: CompactionEngineWithReplay = {
      register: vi.fn<CompactionEngineWithReplay['register']>(),
      use: vi.fn<CompactionEngineWithReplay['use']>(),
      maybeCompact: vi.fn<CompactionEngineWithReplay['maybeCompact']>(),
      audit: vi.fn<CompactionEngineWithReplay['audit']>().mockResolvedValue([]),
      markScope,
      profile: (scope) => ({
        thresholdRatio: scope === 'night' ? 0.7 : 0.8,
        keepRecentTokens: scope === 'night' ? 16_000 : 24_000,
        minGapRounds: 4,
        strategyId: 'summarize+virtualfile',
      }),
      archives: vi.fn<CompactionEngineWithReplay['archives']>().mockResolvedValue([]),
      replay: vi.fn<CompactionEngineWithReplay['replay']>().mockResolvedValue('# replayed context'),
      replayFile,
    }
    const api = new ContextHttpApi(engine, auth())
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    const root = `http://127.0.0.1:${String(address.port)}/luban-context`
    try {
      const profiles = (await (await fetch(`${root}/profiles`)).json()) as {
        readonly night: { readonly thresholdRatio: number }
      }
      expect(profiles.night.thresholdRatio).toBe(0.7)
      expect((await fetch(`${root}/sessions/s-1/audit`)).status).toBe(200)
      const replay = await fetch(`${root}/sessions/s-1/replay?startSeq=0&endSeq=2`)
      expect(await replay.text()).toBe('# replayed context')
      const exactReplay = await fetch(
        `${root}/sessions/s-1/replay?path=${encodeURIComponent('.luban/context/segment.md')}`,
      )
      expect(await exactReplay.text()).toBe('# exact historical context')
      expect(replayFile).toHaveBeenCalledWith(
        asSessionId('s-1'),
        '.luban/context/segment.md',
        ALICE,
      )
      expect(
        (await fetch(`${root}/sessions/s-1/scope?value=night`, { method: 'POST' })).status,
      ).toBe(204)
      expect(markScope).toHaveBeenCalledWith(asSessionId('s-1'), 'night', ALICE)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('uses the authenticated account and M01 session map for Alice/Bob history isolation', async () => {
    const aliceSession = asSessionId('alice-session')
    const sessions = memoryAccountSessions([[ALICE, aliceSession]])
    const scopedAuth: AuthService = {
      ...auth(),
      accountSessions: sessions,
      middleware: (): ReturnType<AuthService['middleware']> => (request) => {
        const accountId = request.cookie === 'account=bob' ? BOB : ALICE
        return Promise.resolve({
          allowed: true,
          status: 200 as const,
          user: String(accountId),
          account: { accountId, username: String(accountId), role: 'operator' },
        })
      },
    }
    const audit = vi.fn<CompactionEngineWithReplay['audit']>(async (sessionId, accountId) => {
      const owner = await sessions.ownerOf(sessionId)
      if (owner === null) throw new LubanError('E_NOT_FOUND', 'Session was not found')
      if (owner !== accountId) {
        throw new LubanError('E_ACCOUNT_SCOPE_MISMATCH', 'Session was not found')
      }
      return []
    })
    const api = new ContextHttpApi({ audit } as unknown as CompactionEngineWithReplay, scopedAuth)
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    const root = `http://127.0.0.1:${String(address.port)}/luban-context/sessions`
    try {
      expect(
        (await fetch(`${root}/alice-session/audit`, { headers: { cookie: 'account=alice' } }))
          .status,
      ).toBe(200)
      expect(
        (
          await fetch(`${root}/alice-session/audit?accountId=alice`, {
            headers: { cookie: 'account=bob' },
          })
        ).status,
      ).toBe(404)
      expect(
        (await fetch(`${root}/unbound-legacy/audit`, { headers: { cookie: 'account=alice' } }))
          .status,
      ).toBe(404)
      expect(audit).toHaveBeenCalledWith(aliceSession, ALICE)
      expect(audit).toHaveBeenCalledWith(aliceSession, BOB)
    } finally {
      api.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('fails closed when disposal races an in-flight authentication check', async (): Promise<void> => {
    let releaseAuth: ((decision: AuthMiddlewareDecision) => void) | undefined
    const decision = new Promise<AuthMiddlewareDecision>((resolve): void => {
      releaseAuth = resolve
    })
    const middleware = vi.fn(() => decision)
    const delayedAuth = {
      middleware: (): typeof middleware => middleware,
    } as unknown as AuthService
    const audit = vi.fn<CompactionEngineWithReplay['audit']>().mockResolvedValue([])
    const api = new ContextHttpApi({ audit } as unknown as CompactionEngineWithReplay, delayedAuth)
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    try {
      const pending = fetch(
        `http://127.0.0.1:${String(address.port)}/luban-context/sessions/s-1/audit`,
      )
      await vi.waitFor((): void => expect(middleware).toHaveBeenCalledOnce())
      api.dispose()
      releaseAuth?.({
        allowed: true,
        status: 200,
        user: 'alice',
        account: { accountId: ALICE, username: 'alice', role: 'operator' },
      })

      const response = await pending
      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'E_UNAVAILABLE' },
      })
      expect(audit).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
