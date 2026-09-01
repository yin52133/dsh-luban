import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CompactionContext,
  CompactionPlan,
  CompactionResult,
  CompactionSurfaceSnapshotIndex,
  CompactionStrategy,
  ContextSegment,
  SessionRef,
  TelemetrySnapshot,
} from '@yin52133/dsh-luban-core'
import { LubanError, asSessionId } from '@yin52133/dsh-luban-core'
import { ContextArchiveRepository } from '../src/archive.js'
import type { Config } from '../src/config.js'
import { DefaultCompactionEngine, type CompactionWorkspace } from '../src/engine.js'
import {
  SummarizeStrategy,
  SummarizeVirtualFileStrategy,
  VirtualFileStrategy,
} from '../src/strategies.js'
import { ALICE, BOB, memoryAccountSessions } from './account-sessions.js'

const config: Config = {
  trigger: { ratio: 0.8, minGapRounds: 2 },
  strategy: 'summarize+virtualfile',
  keepRecentTokens: 15,
  archiveDir: '.luban/context-archive',
  nightProfile: { trigger: { ratio: 0.7 }, keepRecentTokens: 10 },
}

const segments: readonly ContextSegment[] = [
  { startSeq: 0, endSeq: 0, estTokens: 10 },
  { startSeq: 1, endSeq: 1, estTokens: 10 },
  { startSeq: 2, endSeq: 2, estTokens: 10 },
  { startSeq: 3, endSeq: 3, estTokens: 10 },
]

function session(id = 'day-session'): SessionRef {
  return { id: asSessionId(id), segments, atTurnBoundary: true }
}

function telemetry(ratio: number | 'unknown'): TelemetrySnapshot {
  return {
    context: { used: ratio === 'unknown' ? 'unknown' : ratio * 100, max: 100, ratio },
    workspace: { name: 'workspace' },
    model: { name: 'model', thinkingDepth: 'medium' },
    rates: { tpm1m: 1, tpm5m: 1, rpm1m: 1, rpm5m: 1 },
    at: 1,
  }
}

class AlwaysFailStrategy implements CompactionStrategy {
  public readonly id = 'always-fail'
  public readonly executeCount = vi.fn<() => void>()

  public plan(input: {
    readonly segments: readonly ContextSegment[]
    readonly budgetTokens: number
  }): CompactionPlan {
    return new SummarizeStrategy().plan(input)
  }

  public execute(_plan: CompactionPlan, _context: CompactionContext): Promise<CompactionResult> {
    this.executeCount()
    return Promise.reject(new Error('summary backend failed'))
  }
}

describe('DefaultCompactionEngine', () => {
  let directory = ''

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'luban-context-engine-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  function harness(
    activeConfig: Config = config,
    repositoryFactory: (
      options: ConstructorParameters<typeof ContextArchiveRepository>[0],
    ) => ContextArchiveRepository = (options): ContextArchiveRepository =>
      new ContextArchiveRepository(options),
  ): {
    readonly engine: DefaultCompactionEngine
    readonly inject: ReturnType<typeof vi.fn>
    readonly accountSessions: ReturnType<typeof memoryAccountSessions>
  } {
    const repositories = new Map<string, ContextArchiveRepository>()
    const accountSessions = memoryAccountSessions()
    const inject = vi
      .fn<(summary: string, files: readonly string[]) => Promise<void>>()
      .mockResolvedValue()
    const engine = new DefaultCompactionEngine({
      config: activeConfig,
      accountSessions,
      clock: { now: (): number => 1000 },
      factory: {
        create: (ref, accountId): Promise<CompactionWorkspace> => {
          let repository = repositories.get(ref.id)
          if (repository === undefined) {
            repository = repositoryFactory({
              workspace: directory,
              archiveDir: activeConfig.archiveDir,
              accountId,
              sessionId: ref.id,
              clock: { now: (): number => 1000 },
            })
            repositories.set(ref.id, repository)
          }
          return Promise.resolve({
            accountId,
            repository,
            snapshotSurface: (): CompactionSurfaceSnapshotIndex => ({
              totalTokens: ref.segments.reduce(
                (total, segment): number => total + segment.estTokens,
                0,
              ),
              entries: ref.segments.map((segment, index) => ({
                eventSeq: 100 + index,
                segment,
              })),
            }),
            context: {
              sessionId: ref.id,
              archiveDir: join(directory, activeConfig.archiveDir),
              read: (segment: ContextSegment): Promise<string> =>
                Promise.resolve(`Decision ${String(segment.startSeq)} must remain`),
              archive: (segment, content): Promise<string> => repository.archive(segment, content),
              summarize: (): Promise<string> => Promise.resolve('preserved decisions'),
              inject,
            },
          })
        },
      },
    })
    engine.register(new SummarizeStrategy())
    engine.register(new VirtualFileStrategy())
    engine.register(new SummarizeVirtualFileStrategy())
    return { engine, inject, accountSessions }
  }

  it('waits for threshold and the configured number of turn boundaries, then audits', async () => {
    const { engine, inject, accountSessions } = harness()
    const activeSession = session()
    await accountSessions.bind(ALICE, activeSession.id)
    await engine.maybeCompact(activeSession, telemetry(0.9))
    await expect(engine.audit(activeSession.id)).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    await engine.maybeCompact(activeSession, telemetry(0.9))
    expect(inject).toHaveBeenCalledTimes(1)
    const records = await engine.audit(activeSession.id)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      strategyId: 'summarize+virtualfile',
      beforeTokens: 40,
    })
    expect(records[0]?.accountId).toBe(ALICE)
    expect(await engine.archives(activeSession.id)).toHaveLength(3)

    await engine.maybeCompact(activeSession, telemetry(0.9))
    expect(await engine.audit(activeSession.id)).toHaveLength(1)
  })

  it('uses the more aggressive night cadence and allows explicit scope marking', async () => {
    const { engine, accountSessions } = harness()
    expect(engine.profile('day')).toMatchObject({ thresholdRatio: 0.8, keepRecentTokens: 15 })
    expect(engine.profile('night')).toMatchObject({ thresholdRatio: 0.7, keepRecentTokens: 10 })
    const sessionId = asSessionId('manual-night')
    await accountSessions.bind(ALICE, sessionId)
    await engine.markScope(sessionId, 'night', ALICE)
    await expect(engine.markScope(sessionId, 'day', BOB)).rejects.toMatchObject({
      code: 'E_ACCOUNT_SCOPE_MISMATCH',
    })
  })

  it('retries once and degrades to archive-only with an auditable strategy id', async () => {
    const activeConfig = { ...config, strategy: 'always-fail' }
    const { engine, accountSessions } = harness(activeConfig)
    const failing = new AlwaysFailStrategy()
    engine.register(failing)
    engine.use('always-fail')
    const fallbackSession = session('fallback')
    await accountSessions.bind(ALICE, fallbackSession.id)
    await engine.maybeCompact(fallbackSession, telemetry(0.9))
    await engine.maybeCompact(fallbackSession, telemetry(0.9))
    expect(failing.executeCount).toHaveBeenCalledTimes(2)
    expect((await engine.audit(asSessionId('fallback')))[0]?.strategyId).toBe(
      'always-fail:archive-fallback',
    )
    expect(await engine.archives(asSessionId('fallback'))).toHaveLength(3)
  })

  it('retries only audit persistence after compaction has changed the live surface', async () => {
    const activeSession = session('audit-recovery')
    const firstFailure = new Error('audit disk unavailable')
    const secondFailure = new Error('audit disk still unavailable')
    const failures = [firstFailure, secondFailure]
    let recordAuditCalls = 0
    const controlled = harness(
      {
        ...config,
        trigger: { ...config.trigger, minGapRounds: 1 },
      },
      (options): ContextArchiveRepository => {
        const repository = new ContextArchiveRepository(options)
        const persist = repository.recordAudit.bind(repository)
        repository.recordAudit = (record): Promise<void> => {
          const failure = failures[recordAuditCalls]
          recordAuditCalls += 1
          return failure === undefined ? persist(record) : Promise.reject(failure)
        }
        return repository
      },
    )
    await controlled.accountSessions.bind(ALICE, activeSession.id)

    const firstResult = await controlled.engine
      .maybeCompact(activeSession, telemetry(0.9))
      .catch((error: unknown): unknown => error)
    expect(firstResult).toBeInstanceOf(LubanError)
    expect(firstResult).toMatchObject({
      code: 'E_IO',
      retriable: true,
      message:
        'Compaction was applied to audit-recovery, but its audit could not be persisted: audit disk unavailable',
      details: {
        phase: 'audit-persistence',
        compactionApplied: true,
        auditPersisted: false,
        retryMode: 'audit-only',
        strategyId: 'summarize+virtualfile',
      },
    })
    expect((firstResult as Error).cause).toBe(firstFailure)

    const secondResult = await controlled.engine
      .maybeCompact(activeSession, telemetry(0.9))
      .catch((error: unknown): unknown => error)
    expect(secondResult).toBeInstanceOf(LubanError)
    expect((secondResult as Error).cause).toBe(secondFailure)
    expect(controlled.inject).toHaveBeenCalledOnce()

    await controlled.engine.maybeCompact(activeSession, telemetry(0.9))
    expect(recordAuditCalls).toBe(3)
    expect(controlled.inject).toHaveBeenCalledOnce()
    await expect(controlled.engine.audit(activeSession.id)).resolves.toHaveLength(1)
  })

  it('does not duplicate an audit when persistence committed before reporting failure', async () => {
    const reportedFailure = new Error('post-commit audit verification failed')
    let recordAuditCalls = 0
    const { engine, inject, accountSessions } = harness(
      {
        ...config,
        trigger: { ...config.trigger, minGapRounds: 1 },
      },
      (options): ContextArchiveRepository => {
        const repository = new ContextArchiveRepository(options)
        const persist = repository.recordAudit.bind(repository)
        repository.recordAudit = async (record): Promise<void> => {
          recordAuditCalls += 1
          await persist(record)
          if (recordAuditCalls === 1) throw reportedFailure
        }
        return repository
      },
    )
    const activeSession = session('audit-post-commit-failure')
    await accountSessions.bind(ALICE, activeSession.id)

    const failed = await engine
      .maybeCompact(activeSession, telemetry(0.9))
      .catch((error: unknown): unknown => error)
    expect(failed).toBeInstanceOf(LubanError)
    expect((failed as Error).cause).toBe(reportedFailure)

    await engine.maybeCompact(activeSession, telemetry(0.9))
    expect(recordAuditCalls).toBe(2)
    expect(inject).toHaveBeenCalledOnce()
    await expect(engine.audit(activeSession.id)).resolves.toHaveLength(1)
  })

  it('executes custom strategies without extra contracts and ignores unknown telemetry', async () => {
    const { engine, accountSessions } = harness()
    const execute = vi.fn<CompactionStrategy['execute']>(() =>
      Promise.resolve({
        beforeTokens: 40,
        afterTokens: 10,
        archiveFiles: [],
      }),
    )
    const custom: CompactionStrategy = {
      id: 'custom',
      plan: (input): CompactionPlan => new SummarizeStrategy().plan(input),
      execute,
    }
    const unregister = engine.register(custom)
    engine.use('custom')
    const customSession = session('custom')
    await accountSessions.bind(ALICE, customSession.id)
    await engine.maybeCompact(customSession, telemetry('unknown'))
    await engine.maybeCompact(customSession, telemetry('unknown'))
    await expect(engine.audit(asSessionId('custom'))).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    await engine.maybeCompact(customSession, telemetry(0.9))
    expect(execute).toHaveBeenCalledOnce()
    const [record] = await engine.audit(asSessionId('custom'))
    expect(record?.surfaceSnapshots).toMatchObject({
      kind: 'captured',
      before: { totalTokens: 40 },
      after: { totalTokens: 40 },
    })
    unregister()
    expect(() => engine.use('custom')).toThrow(/not registered/u)
  })

  it('skips unbound legacy sessions and rejects cross-account history access', async () => {
    const { engine, inject, accountSessions } = harness({
      ...config,
      trigger: { ...config.trigger, minGapRounds: 1 },
    })
    const legacy = session('unbound-legacy')
    await engine.maybeCompact(legacy, telemetry(0.9))
    expect(inject).not.toHaveBeenCalled()
    await expect(engine.audit(legacy.id, ALICE)).rejects.toMatchObject({ code: 'E_NOT_FOUND' })

    const aliceSession = session('alice-owned')
    await accountSessions.bind(ALICE, aliceSession.id)
    await engine.maybeCompact(aliceSession, telemetry(0.9))
    await expect(engine.audit(aliceSession.id, BOB)).rejects.toMatchObject({
      code: 'E_ACCOUNT_SCOPE_MISMATCH',
    })
    await expect(engine.archives(aliceSession.id, BOB)).rejects.toMatchObject({
      code: 'E_ACCOUNT_SCOPE_MISMATCH',
    })
  })
})
