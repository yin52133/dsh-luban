import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  AccountSessionRegistry,
  AuthService,
  TelemetryAggregator,
} from '@yin52133/dsh-luban-core'
import { asSessionId } from '@yin52133/dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import plugin from '../src/index.js'
import { ALICE, BOB, memoryAccountSessions } from './account-sessions.js'

function authentication(accountSessions: AccountSessionRegistry): AuthService {
  return {
    middleware: () => () =>
      Promise.resolve({
        allowed: true,
        status: 200,
        user: 'tester',
        account: { accountId: ALICE, username: 'tester', role: 'operator' },
      }),
    accountSessions,
  } as unknown as AuthService
}

describe('Cordis integration', (): void => {
  it('publishes the registered compaction event after a durable live-session compaction', async (): Promise<void> => {
    const workspace = await mkdtemp(join(tmpdir(), 'luban-context-cordis-'))
    const context = new Context()
    const sessionId = SessionId('context-cordis-agent')
    const accountSessions = memoryAccountSessions([[ALICE, asSessionId(sessionId)]])
    const append = vi.fn()
    const events = [1, 2, 3].map(
      (seq): SessionEvent =>
        ({ seq, data: { text: `Decision ${String(seq)} must remain` } }) as SessionEvent,
    )
    const session = {
      id: sessionId,
      header: { cwd: workspace },
      surface: { nodes: [1, 2, 3] },
      events,
      deriveEventMessage: (event: SessionEvent): unknown => event.data,
      append,
    } as unknown as Session
    const agent = { id: sessionId, status: 'idle', session } as Agent
    let agentIsLive = true
    const agents = {
      get: (id: ReturnType<typeof SessionId>): Agent | undefined =>
        agentIsLive && id === sessionId ? agent : undefined,
      list: (): readonly Agent[] => (agentIsLive ? [agent] : []),
    } as unknown as AgentRegistry
    const telemetry = {
      snapshot: (): Promise<never> => Promise.reject(new Error('not used by direct engine call')),
    } as unknown as TelemetryAggregator
    const published: unknown[] = []

    const webFiber = context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const agentsFiber = context.plugin({
      name: 'luban-context-test-agents',
      apply(ctx: Context): void {
        ctx.provide('agents', agents)
      },
    })
    const authFiber = context.plugin({
      name: 'luban-context-test-auth',
      apply(ctx: Context): void {
        ctx.provide('lubanAuth', authentication(accountSessions))
      },
    })
    const telemetryFiber = context.plugin({
      name: 'luban-context-test-telemetry',
      apply(ctx: Context): void {
        ctx.provide('lubanTelemetry', telemetry)
      },
    })
    const listSessions = vi.fn(() =>
      Promise.resolve([{ header: { id: sessionId, cwd: workspace } }]),
    )
    const sessionQueryFiber = context.plugin({
      name: 'luban-context-test-session-query',
      apply(ctx: Context): void {
        ctx.provide('sessionQuery', { listSessions })
      },
    })
    const unregisterEvent = context.on('luban.compaction.done', (payload): void => {
      published.push(payload)
    })

    try {
      await Promise.all([webFiber, agentsFiber, authFiber, telemetryFiber, sessionQueryFiber])
      const fiber = context.plugin(plugin, {
        trigger: { ratio: 0.5, minGapRounds: 1 },
        keepRecentTokens: 1,
      })
      await fiber

      const ref = {
        id: asSessionId(sessionId),
        segments: [
          { startSeq: 0, endSeq: 0, estTokens: 100 },
          { startSeq: 1, endSeq: 1, estTokens: 100 },
          { startSeq: 2, endSeq: 2, estTokens: 100 },
        ],
        atTurnBoundary: true,
      }
      await context.lubanCompaction.maybeCompact(ref, {
        context: { used: 90, max: 100, ratio: 0.9 },
        workspace: { name: workspace },
        model: { name: 'test-model', thinkingDepth: 'medium' },
        rates: { tpm1m: 0, tpm5m: 0, rpm1m: 0, rpm5m: 0 },
        at: 1,
      })

      const [audit] = await context.lubanCompaction.audit(asSessionId(sessionId))
      expect(audit).toBeDefined()
      expect(audit?.afterTokens).toBeLessThan(audit?.beforeTokens ?? 0)
      expect(published).toEqual([
        {
          accountId: ALICE,
          sessionId,
          strategy: 'summarize+virtualfile',
          beforeTokens: audit?.beforeTokens,
          afterTokens: audit?.afterTokens,
        },
      ])
      expect(append).toHaveBeenCalledOnce()
      await fiber.dispose()

      agentIsLive = false
      const restartedFiber = context.plugin(plugin, {
        trigger: { ratio: 0.5, minGapRounds: 1 },
        keepRecentTokens: 1,
      })
      await restartedFiber
      await expect(
        context.lubanCompaction.archives(asSessionId(sessionId), BOB),
      ).rejects.toMatchObject({ code: 'E_ACCOUNT_SCOPE_MISMATCH' })
      expect(listSessions).not.toHaveBeenCalled()
      const persistedEntries = await context.lubanCompaction.archives(asSessionId(sessionId), ALICE)
      expect(persistedEntries).not.toHaveLength(0)
      const persistedEntry = persistedEntries[0]
      if (persistedEntry === undefined) throw new Error('persisted archive entry is missing')
      await expect(
        context.lubanCompaction.replayFile(asSessionId(sessionId), persistedEntry.path, ALICE),
      ).resolves.toContain('Decision')
      expect(listSessions).toHaveBeenCalledOnce()
      await restartedFiber.dispose()
    } finally {
      unregisterEvent()
      await Promise.allSettled([
        telemetryFiber.dispose(),
        authFiber.dispose(),
        agentsFiber.dispose(),
        sessionQueryFiber.dispose(),
        webFiber.dispose(),
      ])
      await rm(workspace, { recursive: true, force: true })
    }
  }, 30_000)
})
