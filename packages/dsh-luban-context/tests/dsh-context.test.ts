import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import type { Clock } from '@luban/core'
import { DshCompactionContextFactory, sessionRefFromAgent } from '../src/dsh-context.js'
import { SummarizeVirtualFileStrategy } from '../src/strategies.js'

describe('DSH compaction boundary', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (path): Promise<void> => {
        await rm(path, { recursive: true, force: true })
      }),
    )
  })

  it('replaces only the old surface prefix while retaining redacted archives for replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luban-dsh-context-'))
    directories.push(directory)
    const id = SessionId('surface-session')
    const session = Session.create(id, [], {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      cwd: directory,
    })
    for (const text of [
      'Requirement: preserve constraint A; token=very-secret',
      'Decision: use the stable API',
      'Implementation details from the middle',
      'Recent user request must remain verbatim',
    ]) {
      session.append(
        'user/message',
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
        { surfaceOp: 'append' },
      )
    }
    const agent = {
      id,
      session,
      status: 'idle',
    } as unknown as Agent
    const agents = { get: (): Agent => agent } as unknown as AgentRegistry
    const clock: Clock = { now: (): number => 100 }
    const factory = new DshCompactionContextFactory(
      agents,
      {
        trigger: { ratio: 0.8, minGapRounds: 1 },
        strategy: 'summarize+virtualfile',
        keepRecentTokens: 10,
        archiveDir: '.luban/context-archive',
        nightProfile: { trigger: { ratio: 0.7 }, keepRecentTokens: 8 },
      },
      clock,
    )
    const ref = sessionRefFromAgent(agent)
    const workspace = await factory.create(ref)
    const strategy = new SummarizeVirtualFileStrategy()
    const result = await strategy.execute(
      strategy.plan({ segments: ref.segments, budgetTokens: 10 }),
      workspace.context,
    )
    expect(result.archiveFiles.length).toBeGreaterThan(0)
    expect(session.surface.nodes).toHaveLength(2)
    const derived = JSON.stringify(session.deriveMessages())
    expect(derived).toContain('stable API')
    expect(derived).toContain('Recent user request must remain verbatim')
    expect(derived).not.toContain('very-secret')
    const entry = (await workspace.repository.entries())[0]
    if (entry === undefined) throw new Error('archive entry missing')
    const replay = await workspace.repository.replay(entry.startSeq, entry.endSeq)
    expect(replay).toContain('Requirement')
    expect(replay).toContain('[REDACTED]')
    expect(await (await factory.open(ref.id)).entries()).toHaveLength(result.archiveFiles.length)
  })
})
