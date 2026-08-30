import type {
  Clock,
  CompactionAuditRecord,
  CompactionContext,
  CompactionEngine,
  CompactionSurfaceSnapshotIndex,
  CompactionStrategy,
  LubanEventMap,
  SessionId,
  SessionRef,
  TelemetrySnapshot,
  Unsubscribe,
} from 'dsh-luban-core'
import { LubanError } from 'dsh-luban-core'
import type { ArchiveIndexEntry, ContextArchiveRepository } from './archive.js'
import type { Config } from './config.js'
import { VirtualFileStrategy } from './strategies.js'

export type CompactionTaskScope = 'night' | 'day'

export interface CompactionWorkspace {
  readonly context: CompactionContext
  readonly repository: ContextArchiveRepository
  snapshotSurface(): CompactionSurfaceSnapshotIndex
}

export interface CompactionContextFactory {
  create(session: SessionRef): Promise<CompactionWorkspace>
  open?(sessionId: SessionId): Promise<ContextArchiveRepository>
}

export interface CompactionCadence {
  readonly thresholdRatio: number
  readonly keepRecentTokens: number
  readonly minGapRounds: number
  readonly strategyId: string
}

export interface CompactionEventSink {
  emit(event: 'luban.compaction.done', payload: LubanEventMap['luban.compaction.done']): void
}

export interface CompactionEngineWithReplay extends CompactionEngine {
  markScope(sessionId: SessionId, scope: CompactionTaskScope): void
  profile(scope: CompactionTaskScope): CompactionCadence
  archives(sessionId: SessionId): Promise<readonly ArchiveIndexEntry[]>
  replay(sessionId: SessionId, startSeq: number, endSeq: number): Promise<string>
  replayFile(sessionId: SessionId, path: string): Promise<string>
}

function ratioOf(telemetry: TelemetrySnapshot): number | undefined {
  const value = telemetry.context.ratio
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Serialized per-session engine with retry, archive-only fallback, and durable audit. */
export class DefaultCompactionEngine implements CompactionEngineWithReplay {
  readonly #config: Config
  readonly #factory: CompactionContextFactory
  readonly #clock: Clock
  readonly #events: CompactionEventSink | undefined
  readonly #strategies = new Map<string, CompactionStrategy>()
  readonly #scopeBySession = new Map<SessionId, CompactionTaskScope>()
  readonly #strategyByScope = new Map<CompactionTaskScope, string>()
  readonly #repositories = new Map<SessionId, ContextArchiveRepository>()
  readonly #inFlight = new Set<SessionId>()
  readonly #roundsSinceCompaction = new Map<SessionId, number>()

  public constructor(options: {
    readonly config: Config
    readonly factory: CompactionContextFactory
    readonly clock: Clock
    readonly events?: CompactionEventSink
  }) {
    this.#config = options.config
    this.#factory = options.factory
    this.#clock = options.clock
    this.#events = options.events
    this.#strategyByScope.set('day', options.config.strategy)
    this.#strategyByScope.set('night', options.config.strategy)
  }

  public register(strategy: CompactionStrategy): Unsubscribe {
    if (strategy.id.trim() === '')
      throw new LubanError('E_INVALID_INPUT', 'Strategy id cannot be blank')
    if (this.#strategies.has(strategy.id)) {
      throw new LubanError(
        'E_VERSION_CONFLICT',
        `Compaction strategy ${strategy.id} is already registered`,
      )
    }
    this.#strategies.set(strategy.id, strategy)
    return (): void => {
      if (this.#strategies.get(strategy.id) === strategy) this.#strategies.delete(strategy.id)
    }
  }

  public use(strategyId: string, scope?: { readonly taskScope?: CompactionTaskScope }): void {
    if (!this.#strategies.has(strategyId)) {
      throw new LubanError('E_NOT_FOUND', `Compaction strategy ${strategyId} is not registered`)
    }
    this.#strategyByScope.set(scope?.taskScope ?? 'day', strategyId)
  }

  public markScope(sessionId: SessionId, scope: CompactionTaskScope): void {
    this.#scopeBySession.set(sessionId, scope)
  }

  public profile(scope: CompactionTaskScope): CompactionCadence {
    return scope === 'night'
      ? {
          thresholdRatio: this.#config.nightProfile.trigger.ratio,
          keepRecentTokens: this.#config.nightProfile.keepRecentTokens,
          minGapRounds: this.#config.trigger.minGapRounds,
          strategyId: this.#strategyByScope.get('night') ?? this.#config.strategy,
        }
      : {
          thresholdRatio: this.#config.trigger.ratio,
          keepRecentTokens: this.#config.keepRecentTokens,
          minGapRounds: this.#config.trigger.minGapRounds,
          strategyId: this.#strategyByScope.get('day') ?? this.#config.strategy,
        }
  }

  public async maybeCompact(session: SessionRef, telemetry: TelemetrySnapshot): Promise<void> {
    if (!session.atTurnBoundary) return
    const rounds = (this.#roundsSinceCompaction.get(session.id) ?? 0) + 1
    this.#roundsSinceCompaction.set(session.id, rounds)
    if (this.#inFlight.has(session.id)) return
    const ratio = ratioOf(telemetry)
    const scope = this.#scope(session.id)
    const profile = this.profile(scope)
    if (ratio === undefined || ratio < profile.thresholdRatio) return
    if (rounds < profile.minGapRounds || session.segments.length < 2) return
    const strategy = this.#strategies.get(profile.strategyId)
    if (strategy === undefined) {
      throw new LubanError(
        'E_UNAVAILABLE',
        `Active compaction strategy ${profile.strategyId} is unavailable`,
      )
    }
    this.#inFlight.add(session.id)
    try {
      const workspace = await this.#factory.create(session)
      this.#repositories.set(session.id, workspace.repository)
      const plan = strategy.plan({
        segments: session.segments,
        budgetTokens: profile.keepRecentTokens,
      })
      if (plan.summarize.length === 0 && plan.archive.length === 0) return
      const beforeSurface = workspace.snapshotSurface()
      let result: Awaited<ReturnType<CompactionStrategy['execute']>> | undefined
      let failure: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          result = await strategy.execute(plan, workspace.context)
          break
        } catch (error: unknown) {
          failure = error
        }
      }
      let strategyId = strategy.id
      let auditedPlan = plan
      if (result === undefined) {
        const fallback = this.#strategies.get('virtualfile') ?? new VirtualFileStrategy()
        const fallbackPlan = fallback.plan({
          segments: session.segments,
          budgetTokens: profile.keepRecentTokens,
        })
        try {
          result = await fallback.execute(fallbackPlan, workspace.context)
          strategyId = `${strategy.id}:archive-fallback`
          auditedPlan = { ...fallbackPlan, strategyId }
        } catch (fallbackError: unknown) {
          throw new LubanError(
            'E_IO',
            `Compaction failed after retry and archive fallback for ${session.id}`,
            {
              retriable: true,
              cause: fallbackError,
              details: { primary: failure instanceof Error ? failure.message : 'unknown failure' },
            },
          )
        }
      }
      const audit: CompactionAuditRecord = {
        sessionId: session.id,
        at: this.#clock.now(),
        strategyId,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
        archiveFiles: result.archiveFiles,
        plan: auditedPlan,
        surfaceSnapshots: {
          kind: 'captured',
          before: beforeSurface,
          after: workspace.snapshotSurface(),
        },
      }
      await workspace.repository.recordAudit(audit)
      this.#roundsSinceCompaction.set(session.id, 0)
      this.#events?.emit('luban.compaction.done', {
        sessionId: session.id,
        strategy: strategyId,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
      })
    } finally {
      this.#inFlight.delete(session.id)
    }
  }

  public async audit(sessionId: SessionId): Promise<readonly CompactionAuditRecord[]> {
    return (await this.#repository(sessionId)).audit()
  }

  public async archives(sessionId: SessionId): Promise<readonly ArchiveIndexEntry[]> {
    return (await this.#repository(sessionId)).entries()
  }

  public async replay(sessionId: SessionId, startSeq: number, endSeq: number): Promise<string> {
    return (await this.#repository(sessionId)).replay(startSeq, endSeq)
  }

  public async replayFile(sessionId: SessionId, path: string): Promise<string> {
    return (await this.#repository(sessionId)).replayPath(path)
  }

  #scope(sessionId: SessionId): CompactionTaskScope {
    return (
      this.#scopeBySession.get(sessionId) ??
      (String(sessionId).startsWith('luban-night-') ? 'night' : 'day')
    )
  }

  #repository(sessionId: SessionId): Promise<ContextArchiveRepository> {
    const repository = this.#repositories.get(sessionId)
    if (repository !== undefined) return Promise.resolve(repository)
    if (this.#factory.open === undefined) {
      throw new LubanError('E_NOT_FOUND', `No archive is registered for session ${sessionId}`)
    }
    return this.#factory.open(sessionId).then((opened): ContextArchiveRepository => {
      this.#repositories.set(sessionId, opened)
      return opened
    })
  }
}
