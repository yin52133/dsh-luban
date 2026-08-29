import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CompactionContext,
  CompactionPlan,
  CompactionResult,
  CompactionStrategy,
  ContextSegment,
  SessionRef,
  TelemetrySnapshot,
} from '@luban/core'
import { asSessionId } from '@luban/core'
import { ContextArchiveRepository } from '../src/archive.js'
import type { Config } from '../src/config.js'
import { DefaultCompactionEngine } from '../src/engine.js'
import {
  SummarizeStrategy,
  SummarizeVirtualFileStrategy,
  VirtualFileStrategy,
} from '../src/strategies.js'

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

  function harness(activeConfig: Config = config): {
    readonly engine: DefaultCompactionEngine
    readonly inject: ReturnType<typeof vi.fn>
  } {
    const repositories = new Map<string, ContextArchiveRepository>()
    const inject = vi
      .fn<(summary: string, files: readonly string[]) => Promise<void>>()
      .mockResolvedValue()
    const engine = new DefaultCompactionEngine({
      config: activeConfig,
      clock: { now: (): number => 1000 },
      factory: {
        create: (
          ref,
        ): Promise<{
          readonly repository: ContextArchiveRepository
          readonly context: CompactionContext & { read(segment: ContextSegment): Promise<string> }
        }> => {
          let repository = repositories.get(ref.id)
          if (repository === undefined) {
            repository = new ContextArchiveRepository({
              workspace: directory,
              archiveDir: activeConfig.archiveDir,
              sessionId: ref.id,
              clock: { now: (): number => 1000 },
            })
            repositories.set(ref.id, repository)
          }
          return Promise.resolve({
            repository,
            context: {
              sessionId: ref.id,
              archiveDir: join(directory, activeConfig.archiveDir),
              read: (segment): Promise<string> =>
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
    return { engine, inject }
  }

  it('waits for threshold and the configured number of turn boundaries, then audits', async () => {
    const { engine, inject } = harness()
    await engine.maybeCompact(session(), telemetry(0.9))
    await expect(engine.audit(session().id)).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    await engine.maybeCompact(session(), telemetry(0.9))
    expect(inject).toHaveBeenCalledTimes(1)
    const records = await engine.audit(session().id)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      strategyId: 'summarize+virtualfile',
      beforeTokens: 40,
    })
    expect(await engine.archives(session().id)).toHaveLength(3)

    await engine.maybeCompact(session(), telemetry(0.9))
    expect(await engine.audit(session().id)).toHaveLength(1)
  })

  it('uses the more aggressive night cadence and allows explicit scope marking', () => {
    const { engine } = harness()
    expect(engine.profile('day')).toMatchObject({ thresholdRatio: 0.8, keepRecentTokens: 15 })
    expect(engine.profile('night')).toMatchObject({ thresholdRatio: 0.7, keepRecentTokens: 10 })
    engine.markScope(asSessionId('manual-night'), 'night')
  })

  it('retries once and degrades to archive-only with an auditable strategy id', async () => {
    const activeConfig = { ...config, strategy: 'always-fail' }
    const { engine } = harness(activeConfig)
    const failing = new AlwaysFailStrategy()
    engine.register(failing)
    engine.use('always-fail')
    await engine.maybeCompact(session('fallback'), telemetry(0.9))
    await engine.maybeCompact(session('fallback'), telemetry(0.9))
    expect(failing.executeCount).toHaveBeenCalledTimes(2)
    expect((await engine.audit(asSessionId('fallback')))[0]?.strategyId).toBe(
      'always-fail:archive-fallback',
    )
    expect(await engine.archives(asSessionId('fallback'))).toHaveLength(3)
  })

  it('registers custom strategies without modifying the engine and ignores unknown telemetry', async () => {
    const { engine } = harness()
    const custom: CompactionStrategy = {
      id: 'custom',
      plan: (input): CompactionPlan => new SummarizeStrategy().plan(input),
      execute: (): Promise<CompactionResult> =>
        Promise.resolve({
          beforeTokens: 40,
          afterTokens: 10,
          archiveFiles: [],
        }),
    }
    const unregister = engine.register(custom)
    engine.use('custom')
    await engine.maybeCompact(session('custom'), telemetry('unknown'))
    await engine.maybeCompact(session('custom'), telemetry('unknown'))
    await expect(engine.audit(asSessionId('custom'))).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    unregister()
    expect(() => engine.use('custom')).toThrow(/not registered/u)
  })
})
