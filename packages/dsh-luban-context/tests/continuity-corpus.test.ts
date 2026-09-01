import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import type { Clock, TelemetrySnapshot } from '@yin52133/dsh-luban-core'
import { asSessionId } from '@yin52133/dsh-luban-core'
import type { Config } from '../src/config.js'
import { DshCompactionContextFactory, sessionRefFromAgent } from '../src/dsh-context.js'
import { DefaultCompactionEngine } from '../src/engine.js'
import {
  SummarizeStrategy,
  SummarizeVirtualFileStrategy,
  VirtualFileStrategy,
} from '../src/strategies.js'
import { ALICE, memoryAccountSessions } from './account-sessions.js'

const CONFIG: Config = {
  trigger: { ratio: 0.8, minGapRounds: 1 },
  strategy: 'summarize+virtualfile',
  keepRecentTokens: 1,
  archiveDir: '.luban/context-archive',
  nightProfile: { trigger: { ratio: 0.7 }, keepRecentTokens: 1 },
}

const HIGH_USAGE: TelemetrySnapshot = {
  context: { used: 90, max: 100, ratio: 0.9 },
  workspace: { name: 'continuity-corpus' },
  model: { name: 'deterministic-local-summary', thinkingDepth: 'medium' },
  rates: { tpm1m: 0, tpm5m: 0, rpm1m: 0, rpm5m: 0 },
  at: 1,
}

function append(session: Session, text: string): void {
  session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'continuity-corpus' },
    }),
    { surfaceOp: 'append' },
  )
}

function visibleContext(session: Session): string {
  return JSON.stringify(session.deriveMessages())
}

describe('deterministic bilingual compaction continuity corpus', (): void => {
  const directories: string[] = []

  afterEach(async (): Promise<void> => {
    await Promise.all(
      directories.splice(0).map(async (directory): Promise<void> => {
        await rm(directory, { recursive: true, force: true })
      }),
    )
  })

  it('preserves decisions and recent text while every compacted generation remains replayable', async (): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'luban-context-continuity-'))
    directories.push(directory)
    const id = SessionId('bilingual-continuity')
    const coreId = asSessionId(id)
    const session = Session.create(id, [], {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      cwd: directory,
    })
    const roundOne = [
      'Requirement AUTH_ROUTE: login must stay at /luban-auth/login; /luban/auth/login must be rejected.',
      '决定 DB_ENGINE：夜间索引必须使用 SQLite WAL，不得改为内存存储。',
      'Constraint RELEASE_GUARD: must never publish or tag without human approval.',
      'Transient note: the first parser experiment used a disposable fixture.',
      'Recent requirement PY_ENV: 用户要求必须使用 uv 搭建 Python 环境。',
    ] as const
    for (const message of roundOne) append(session, message)

    const agent = { id, session, status: 'idle' } as unknown as Agent
    const agents = {
      get: (candidate: ReturnType<typeof SessionId>): Agent | undefined =>
        candidate === id ? agent : undefined,
    } as unknown as AgentRegistry
    const clock: Clock = { now: (): number => 100 }
    const accountSessions = memoryAccountSessions([[ALICE, coreId]])
    const factory = new DshCompactionContextFactory(agents, CONFIG, clock, accountSessions)
    const engine = new DefaultCompactionEngine({
      config: CONFIG,
      factory,
      accountSessions,
      clock,
    })
    engine.register(new SummarizeStrategy())
    engine.register(new VirtualFileStrategy())
    engine.register(new SummarizeVirtualFileStrategy())

    await engine.maybeCompact(sessionRefFromAgent(agent), HIGH_USAGE)

    const [firstAudit] = await engine.audit(coreId)
    expect(firstAudit).toBeDefined()
    expect(firstAudit?.plan.keep).toHaveLength(1)
    expect(firstAudit?.archiveFiles).toHaveLength(roundOne.length - 1)
    const firstSurface = visibleContext(session)
    expect(firstSurface).toContain('/luban-auth/login')
    expect(firstSurface).toContain('SQLite WAL')
    expect(firstSurface).toContain('never publish or tag')
    expect(firstSurface).toContain(roundOne.at(-1))
    const firstReplay = (
      await Promise.all(
        (firstAudit?.archiveFiles ?? []).map(async (path): Promise<string> =>
          engine.replayFile(coreId, path),
        ),
      )
    ).join('\n')
    for (const source of roundOne.slice(0, -1)) expect(firstReplay).toContain(source)

    const roundTwo = [
      'Decision RETRY_POLICY: night retries exactly once before archive-only fallback.',
      '约束 CHECKPOINT：每完成一个阶段必须提交 commit。',
      'RECENT_R2: Keep the diagnostic port at 42602 verbatim.',
    ] as const
    for (const message of roundTwo) append(session, message)

    await engine.maybeCompact(sessionRefFromAgent(agent), { ...HIGH_USAGE, at: 2 })

    const audits = await engine.audit(coreId)
    expect(audits).toHaveLength(2)
    const secondAudit = audits[1]
    expect(secondAudit).toBeDefined()
    expect(secondAudit?.plan.keep).toHaveLength(1)
    const finalSurface = visibleContext(session)
    for (const fact of [
      '/luban-auth/login',
      'SQLite WAL',
      'never publish or tag',
      '必须使用 uv',
      'retries exactly once',
      '每完成一个阶段必须提交 commit',
      roundTwo.at(-1),
    ]) {
      expect(finalSurface).toContain(fact)
    }
    const secondReplay = (
      await Promise.all(
        (secondAudit?.archiveFiles ?? []).map(async (path): Promise<string> =>
          engine.replayFile(coreId, path),
        ),
      )
    ).join('\n')
    expect(secondReplay).toContain(roundOne.at(-1))
    expect(secondReplay).toContain(roundTwo[0])
    expect(secondReplay).toContain(roundTwo[1])
  })
})
