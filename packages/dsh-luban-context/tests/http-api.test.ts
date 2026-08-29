import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { AuthService } from '@luban/core'
import { asSessionId } from '@luban/core'
import type { CompactionEngineWithReplay } from '../src/engine.js'
import { ContextHttpApi } from '../src/http-api.js'

function auth(): AuthService {
  return {
    verify: vi.fn<AuthService['verify']>(),
    issueSession: vi.fn<AuthService['issueSession']>(),
    revoke: vi.fn<AuthService['revoke']>(),
    revokeAllFor: vi.fn<AuthService['revokeAllFor']>(),
    middleware: (): ReturnType<AuthService['middleware']> => () =>
      Promise.resolve({
        allowed: true,
        status: 200,
        user: 'operator',
      }),
    onChange: vi.fn<AuthService['onChange']>().mockReturnValue((): void => undefined),
  }
}

describe('ContextHttpApi', () => {
  it('serves authenticated profiles, audit, replay, and scheduler scope control', async () => {
    const markScope = vi.fn<CompactionEngineWithReplay['markScope']>()
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
      expect(replayFile).toHaveBeenCalledWith(asSessionId('s-1'), '.luban/context/segment.md')
      expect(
        (await fetch(`${root}/sessions/s-1/scope?value=night`, { method: 'POST' })).status,
      ).toBe(204)
      expect(markScope).toHaveBeenCalledWith(asSessionId('s-1'), 'night')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
