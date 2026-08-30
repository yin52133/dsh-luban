import type {
  AccountId,
  AccountSessionRegistry,
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
  readonly accountId: AccountId
  readonly context: CompactionContext
  readonly repository: ContextArchiveRepository
  snapshotSurface(): CompactionSurfaceSnapshotIndex
}

export interface CompactionContextFactory {
  create(session: SessionRef, accountId: AccountId): Promise<CompactionWorkspace>
  open?(sessionId: SessionId, accountId: AccountId): Promise<ContextArchiveRepository>
}

export interface CompactionCadence {
  readonly thresholdRatio: number
  readonly keepRecentTokens: number
  readonly minGapRounds: number
  readonly strategyId: string
}

export interface CompactionEventSink {
  emit(event: 'luban.compaction.done', payload: AccountCompactionDoneEvent): void
}

export type AccountCompactionDoneEvent = LubanEventMap['luban.compaction.done'] & {
  readonly accountId: AccountId
}

export interface CompactionEngineWithReplay extends CompactionEngine {
  markScope(sessionId: SessionId, scope: CompactionTaskScope, accountId?: AccountId): Promise<void>
  profile(scope: CompactionTaskScope): CompactionCadence
  audit(sessionId: SessionId, accountId?: AccountId): Promise<readonly CompactionAuditRecord[]>
  archives(sessionId: SessionId, accountId?: AccountId): Promise<readonly ArchiveIndexEntry[]>
  replay(
    sessionId: SessionId,
    startSeq: number,
    endSeq: number,
    accountId?: AccountId,
  ): Promise<string>
  replayFile(sessionId: SessionId, path: string, accountId?: AccountId): Promise<string>
}

function ratioOf(telemetry: TelemetrySnapshot): number | undefined {
  const value = telemetry.context.ratio
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function ownedSessionKey(accountId: AccountId, sessionId: SessionId): string {
  const account = String(accountId)
  return `${String(account.length)}:${account}${String(sessionId)}`
}

/** Serialized per-session engine with retry, archive-only fallback, and durable audit. */
export class DefaultCompactionEngine implements CompactionEngineWithReplay {
  readonly #config: Config
  readonly #factory: CompactionContextFactory
  readonly #accountSessions: AccountSessionRegistry
  readonly #clock: Clock
  readonly #events: CompactionEventSink | undefined
  readonly #strategies = new Map<string, CompactionStrategy>()
  readonly #scopeBySession = new Map<string, CompactionTaskScope>()
  readonly #strategyByScope = new Map<CompactionTaskScope, string>()
  readonly #repositories = new Map<string, ContextArchiveRepository>()
  readonly #inFlight = new Set<string>()
  readonly #roundsSinceCompaction = new Map<string, number>()

  public constructor(options: {
    readonly config: Config
    readonly factory: CompactionContextFactory
    readonly accountSessions: AccountSessionRegistry
    readonly clock: Clock
    readonly events?: CompactionEventSink
  }) {
    this.#config = options.config
    this.#factory = options.factory
    this.#accountSessions = options.accountSessions
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

  public async markScope(
    sessionId: SessionId,
    scope: CompactionTaskScope,
    expectedAccountId?: AccountId,
  ): Promise<void> {
    const accountId = await this.#requireOwner(sessionId, expectedAccountId)
    this.#scopeBySession.set(ownedSessionKey(accountId, sessionId), scope)
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
    const accountId = await this.#accountSessions.ownerOf(session.id)
    if (accountId === null) return
    const sessionKey = ownedSessionKey(accountId, session.id)
    const rounds = (this.#roundsSinceCompaction.get(sessionKey) ?? 0) + 1
    this.#roundsSinceCompaction.set(sessionKey, rounds)
    if (this.#inFlight.has(sessionKey)) return
    const ratio = ratioOf(telemetry)
    const scope = this.#scope(accountId, session.id)
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
    this.#inFlight.add(sessionKey)
    try {
      const workspace = await this.#factory.create(session, accountId)
      if (workspace.accountId !== accountId) {
        throw new LubanError(
          'E_ACCOUNT_SCOPE_MISMATCH',
          `Compaction workspace does not belong to session ${session.id}`,
        )
      }
      this.#repositories.set(sessionKey, workspace.repository)
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
        accountId,
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
      this.#roundsSinceCompaction.set(sessionKey, 0)
      this.#events?.emit('luban.compaction.done', {
        accountId,
        sessionId: session.id,
        strategy: strategyId,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
      })
    } finally {
      this.#inFlight.delete(sessionKey)
    }
  }

  public async audit(
    sessionId: SessionId,
    accountId?: AccountId,
  ): Promise<readonly CompactionAuditRecord[]> {
    return (await this.#repository(sessionId, accountId)).audit()
  }

  public async archives(
    sessionId: SessionId,
    accountId?: AccountId,
  ): Promise<readonly ArchiveIndexEntry[]> {
    return (await this.#repository(sessionId, accountId)).entries()
  }

  public async replay(
    sessionId: SessionId,
    startSeq: number,
    endSeq: number,
    accountId?: AccountId,
  ): Promise<string> {
    return (await this.#repository(sessionId, accountId)).replay(startSeq, endSeq)
  }

  public async replayFile(
    sessionId: SessionId,
    path: string,
    accountId?: AccountId,
  ): Promise<string> {
    return (await this.#repository(sessionId, accountId)).replayPath(path)
  }

  #scope(accountId: AccountId, sessionId: SessionId): CompactionTaskScope {
    return (
      this.#scopeBySession.get(ownedSessionKey(accountId, sessionId)) ??
      (String(sessionId).startsWith('luban-night-') ? 'night' : 'day')
    )
  }

  async #repository(
    sessionId: SessionId,
    expectedAccountId?: AccountId,
  ): Promise<ContextArchiveRepository> {
    const accountId = await this.#requireOwner(sessionId, expectedAccountId)
    const sessionKey = ownedSessionKey(accountId, sessionId)
    const repository = this.#repositories.get(sessionKey)
    if (repository !== undefined) return Promise.resolve(repository)
    if (this.#factory.open === undefined) {
      throw new LubanError('E_NOT_FOUND', `No archive is registered for session ${sessionId}`)
    }
    return this.#factory.open(sessionId, accountId).then((opened): ContextArchiveRepository => {
      this.#repositories.set(sessionKey, opened)
      return opened
    })
  }

  async #requireOwner(sessionId: SessionId, expectedAccountId?: AccountId): Promise<AccountId> {
    const owner = await this.#accountSessions.ownerOf(sessionId)
    if (owner === null) throw new LubanError('E_NOT_FOUND', `Session ${sessionId} was not found`)
    if (expectedAccountId !== undefined && owner !== expectedAccountId) {
      throw new LubanError('E_ACCOUNT_SCOPE_MISMATCH', `Session ${sessionId} was not found`)
    }
    return owner
  }
}
