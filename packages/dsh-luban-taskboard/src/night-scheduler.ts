import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Agent, AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId as DshSessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  AccountSessionRegistry,
  Actor,
  Clock,
  HostId,
  NightScheduler,
  NightTaskExecutor,
  NightTaskExecutorRoute,
  SchedulerStatus,
  SessionId,
  Task,
  TaskOutput,
} from 'dsh-luban-core'
import { LubanError, asActorId, asHostId, asSessionId, systemClock } from 'dsh-luban-core'
import type { NightConfig } from './config.js'
import type { DefaultAgentClaimService } from './claim-service.js'
import type { JsonTaskStore } from './task-store.js'

export type { NightTaskExecutor, NightTaskExecutorRoute } from 'dsh-luban-core'

interface DisposableNightTaskExecutor extends NightTaskExecutor {
  dispose?(): Promise<void>
}

interface NightExecutionReport {
  readonly acceptanceMet: boolean
  readonly summary: string
  readonly evidence: string
  readonly outputKind: TaskOutput['kind']
  readonly ref: string
}

interface NightExecutionReportState {
  calls: number
  callId?: string
  report?: NightExecutionReport
}

const NIGHT_RESULT_TOOL = 'luban_report_night_result'

function completedLastTurn(agent: Agent): number | undefined {
  let latest: { readonly turn: number; readonly completed: boolean } | undefined
  for (const event of agent.session.events) {
    if (event.type === 'turn/start') latest = { turn: event.data.turn, completed: false }
    if (event.type === 'turn/end') {
      latest = { turn: event.data.turn, completed: event.data.reason.kind === 'completed' }
    }
  }
  return latest?.completed === true ? latest.turn : undefined
}

function hasSuccessfulResultEvent(
  agent: Agent,
  state: NightExecutionReportState,
  completedTurn: number,
): boolean {
  if (state.callId === undefined) return false
  let callCount = 0
  let resultCount = 0
  let resultSucceeded = false
  for (const event of agent.session.events) {
    if (event.type === 'tool/call' && event.data.name === NIGHT_RESULT_TOOL) {
      callCount += 1
      if (event.data.callId !== state.callId || event.data.turn !== completedTurn) return false
    }
    if (event.type === 'tool/result' && event.data.message.source.callId === state.callId) {
      resultCount += 1
      const block = event.data.message.content[0]
      resultSucceeded = event.data.error === undefined && block.isError !== true
      if (event.data.turn !== completedTurn) return false
    }
  }
  return callCount === 1 && resultCount === 1 && resultSucceeded
}

function resultTool(
  sessionId: ReturnType<typeof DshSessionId>,
  state: NightExecutionReportState,
): ToolDefinition {
  return defineTool({
    name: NIGHT_RESULT_TOOL,
    description:
      'Report the final, evidence-backed result of one Luban night task exactly once. Calling this tool concludes the turn.',
    parameters: {
      acceptanceMet: {
        type: 'boolean',
        required: true,
        description: 'True only when every task acceptance criterion has been verified.',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'Concise outcome summary for the task card.',
      },
      evidence: {
        type: 'string',
        required: true,
        description: 'Concrete verification evidence, or the failed criterion and reason.',
      },
      outputKind: {
        type: 'string',
        enum: ['note', 'commit', 'artifact', 'link'] as const,
        required: true,
        description: 'Kind of durable output referenced by ref.',
      },
      ref: {
        type: 'string',
        required: true,
        description: 'Durable commit, artifact, link, note, or session reference.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          recorded: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.recorded ? 'Night result recorded.' : 'Night result rejected.',
        },
      ],
    },
    execute(args, execution): Promise<{ readonly recorded: boolean }> {
      state.calls += 1
      if (state.calls !== 1) {
        throw new LubanError('E_INVALID_INPUT', `${NIGHT_RESULT_TOOL} must be called exactly once`)
      }
      if (execution.agent?.id !== sessionId) {
        throw new LubanError('E_INVALID_INPUT', `${NIGHT_RESULT_TOOL} caller does not own this run`)
      }
      const summary = args.summary.trim()
      const evidence = args.evidence.trim()
      const ref = args.ref.trim()
      if (summary === '' || evidence === '' || ref === '') {
        throw new LubanError(
          'E_INVALID_INPUT',
          `${NIGHT_RESULT_TOOL} requires non-empty summary, evidence, and ref`,
        )
      }
      state.report = {
        acceptanceMet: args.acceptanceMet,
        summary,
        evidence,
        outputKind: args.outputKind,
        ref,
      }
      state.callId = execution.callId
      execution.concludeTurn()
      return Promise.resolve({ recorded: true })
    },
  })
}

function localDateKey(epochMs: number): string {
  const value = new Date(epochMs)
  const year = String(value.getFullYear()).padStart(4, '0')
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function minuteOfDay(value: Date): number {
  return value.getHours() * 60 + value.getMinutes()
}

function parseClock(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

export function isInWindow(epochMs: number, window: string): boolean {
  const [fromValue, toValue] = window.split('-')
  if (fromValue === undefined || toValue === undefined) return false
  const now = minuteOfDay(new Date(epochMs))
  const from = parseClock(fromValue)
  const to = parseClock(toValue)
  return from <= to ? now >= from && now < to : now >= from || now < to
}

/**
 * In-process rc2 AgentRegistry adapter. It owns each AgentHandle; M03 owns the
 * containing profile process at the deployment boundary and must not be asked
 * to recursively launch another copy of that process from here.
 */
export class DshAgentNightExecutor implements NightTaskExecutor {
  readonly #agents: AgentRegistry
  readonly #handles = new Set<AgentHandle>()
  readonly #config: Pick<NightConfig, 'model' | 'toolAllowlist'>
  readonly #clock: Clock

  public constructor(
    agents: AgentRegistry,
    config: Pick<NightConfig, 'model' | 'toolAllowlist'>,
    clock: Clock = systemClock,
  ) {
    this.#agents = agents
    this.#config = config
    this.#clock = clock
  }

  public async execute(task: Task, sessionId: SessionId): Promise<TaskOutput> {
    const dshSessionId = DshSessionId(sessionId)
    const reportState: NightExecutionReportState = { calls: 0 }
    const handle = await this.#agents.create({
      sessionId: dshSessionId,
      meta: {
        ...(task.workspace === undefined ? {} : { cwd: resolve(task.workspace) }),
      },
      agentOptions: {
        provider: this.#config.model.provider,
        model: this.#config.model.id,
      },
      setup: (agentCtx): void => {
        agentCtx.tools.restrict({ allow: this.#config.toolAllowlist })
        agentCtx.tools.register(resultTool(dshSessionId, reportState))
      },
    })
    this.#handles.add(handle)
    try {
      const prompt = [
        `Luban autonomous task ${task.id}: ${task.title}`,
        task.description,
        `Acceptance criteria:\n${task.acceptance ?? '(missing)'}`,
        'Work only inside the configured workspace. Summarize verifiable outputs when finished.',
        `As the final action, call ${NIGHT_RESULT_TOOL} exactly once. Set acceptanceMet=true only after verifying every acceptance criterion and provide concrete evidence. If any criterion is unmet or cannot be verified, report acceptanceMet=false. Reaching idle without this report is a failure.`,
      ].join('\n\n')
      handle.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'dsh-luban-taskboard' },
        }),
      )
      await handle.agent.whenIdle()
      const completedTurn = completedLastTurn(handle.agent)
      if (completedTurn === undefined) {
        throw new LubanError('E_UNAVAILABLE', 'Night agent did not finish a completed turn', {
          retriable: true,
        })
      }
      const report = reportState.report
      if (
        reportState.calls !== 1 ||
        report === undefined ||
        !hasSuccessfulResultEvent(handle.agent, reportState, completedTurn)
      ) {
        throw new LubanError(
          'E_UNAVAILABLE',
          'Night agent did not submit one successful final result report',
          { retriable: true },
        )
      }
      if (!report.acceptanceMet) {
        throw new LubanError(
          'E_UNAVAILABLE',
          `Night task acceptance was not met: ${report.summary} (${report.evidence})`,
          { retriable: true },
        )
      }
      return {
        kind: report.outputKind,
        ref: report.ref,
        summary: `${report.summary} Evidence: ${report.evidence}`,
        at: this.#clock.now(),
        by: {
          kind: 'agent',
          id: asActorId(sessionId),
          ...(task.accountId === undefined ? {} : { accountId: task.accountId }),
        },
      }
    } finally {
      this.#handles.delete(handle)
      await handle.dispose()
    }
  }

  public async dispose(): Promise<void> {
    const handles = [...this.#handles]
    this.#handles.clear()
    await Promise.allSettled(handles.map(async (handle): Promise<void> => handle.dispose()))
  }
}

/** Safety-bounded autonomous loop: disabled by default, quota and breaker are durable. */
export class DefaultNightScheduler implements NightScheduler {
  readonly #store: JsonTaskStore
  readonly #claims: DefaultAgentClaimService
  readonly #executor: DisposableNightTaskExecutor | undefined
  readonly #config: NightConfig
  readonly #hostScope: 'win' | 'ubuntu'
  readonly #hostId: HostId
  readonly #accountSessions: AccountSessionRegistry | undefined
  readonly #clock: Clock
  readonly #taskExecutors = new Map<string, NightTaskExecutorRoute>()
  #timer: ReturnType<typeof setInterval> | undefined
  #running = false
  #lastStatus: SchedulerStatus = { windowActive: false, quotaUsed: 0, circuit: 'ok' }

  public constructor(options: {
    readonly store: JsonTaskStore
    readonly claims: DefaultAgentClaimService
    readonly executor?: DisposableNightTaskExecutor
    readonly config: NightConfig
    readonly hostScope: 'win' | 'ubuntu'
    readonly hostId?: HostId
    readonly accountSessions?: AccountSessionRegistry
    readonly clock?: Clock
  }) {
    this.#store = options.store
    this.#claims = options.claims
    this.#executor = options.executor
    this.#config = options.config
    this.#hostScope = options.hostScope
    this.#hostId = options.hostId ?? asHostId(this.#hostScope)
    this.#accountSessions = options.accountSessions
    this.#clock = options.clock ?? systemClock
  }

  public start(): void {
    if (this.#timer !== undefined || !this.#config.enabled) return
    this.#timer = setInterval((): void => {
      void this.triggerOnce().catch((): undefined => undefined)
    }, 60_000)
    this.#timer.unref()
    void this.#refreshStatus()
  }

  public stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
  }

  public status(): SchedulerStatus {
    return this.#lastStatus
  }

  /** Register one exclusive executor for tasks matched by this route. */
  public registerTaskExecutor(route: NightTaskExecutorRoute): () => void {
    const id = route.id.trim()
    if (id === '') {
      throw new LubanError('E_INVALID_INPUT', 'Night task executor route id is required')
    }
    if (this.#taskExecutors.has(id)) {
      throw new LubanError('E_INVALID_INPUT', `Night task executor route already exists: ${id}`)
    }
    const registered = { ...route, id }
    this.#taskExecutors.set(id, registered)
    return (): void => {
      if (this.#taskExecutors.get(id) === registered) this.#taskExecutors.delete(id)
    }
  }

  public async triggerOnce(): Promise<void> {
    if (!this.#config.enabled) throw new LubanError('E_UNAVAILABLE', 'Night scheduler is disabled')
    if (this.#running) return
    this.#running = true
    try {
      const now = this.#clock.now()
      const dateKey = localDateKey(now)
      const windowActive = isInWindow(now, this.#config.window)
      let snapshot = await this.#store.nightSchedulerSnapshot(dateKey)
      this.#lastStatus = {
        windowActive,
        quotaUsed: snapshot.quotaAllocated,
        circuit: snapshot.scheduler.circuit,
      }
      if (
        !windowActive ||
        snapshot.scheduler.circuit === 'open' ||
        snapshot.quotaAllocated >= this.#config.dailyQuota
      ) {
        return
      }
      if (!this.#config.hostScopeWhitelist.includes(this.#hostScope)) return
      if (this.#executor === undefined && this.#taskExecutors.size === 0) {
        throw new LubanError('E_UNAVAILABLE', 'No DSH night executor is available')
      }

      const sessionId = asSessionId(`luban-night-${randomUUID()}`)
      const actor: Actor = {
        kind: 'agent',
        id: asActorId(sessionId),
        displayName: 'Luban Night Scheduler',
      }
      const claim = await this.#claims.claimNight(
        { statuses: ['todo'], tags: this.#config.tagWhitelist, requireAcceptance: true },
        { actor, sessionId, host: this.#hostId, executionOwner: 'night-scheduler' },
        { dateKey, dailyQuota: this.#config.dailyQuota },
      )
      snapshot = { scheduler: claim.scheduler, quotaAllocated: claim.quotaAllocated }
      this.#lastStatus = {
        windowActive,
        quotaUsed: snapshot.quotaAllocated,
        circuit: snapshot.scheduler.circuit,
      }
      if (!claim.ok) return
      const expectedClaim = claim.task.claim
      if (expectedClaim === undefined || expectedClaim === null) {
        throw new LubanError('E_IO', 'Claimed night task is missing its claim identity')
      }
      try {
        if (claim.task.accountId !== undefined) {
          await this.#accountSessions?.bind(claim.task.accountId, sessionId)
        }
        const executor = this.#executorFor(claim.task)
        if (executor === undefined) {
          throw new LubanError('E_UNAVAILABLE', 'No night executor matches the claimed task')
        }
        const output = await executor.execute(claim.task, sessionId)
        const settled = await this.#claims.completeNight(claim.task.id, output, {
          autoDone: true,
          expectedClaim,
          dailyQuota: this.#config.dailyQuota,
        })
        snapshot = { scheduler: settled.scheduler, quotaAllocated: settled.quotaAllocated }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Autonomous execution failed'
        try {
          const settled = await this.#claims.failNight(claim.task.id, message, {
            expectedClaim,
            maxConsecutiveFailures: this.#config.circuitBreaker.maxConsecutiveFailures,
          })
          snapshot = { scheduler: settled.scheduler, quotaAllocated: settled.quotaAllocated }
        } catch (failureError: unknown) {
          if (!isClaimConflict(failureError)) throw failureError
          snapshot = await this.#store.nightSchedulerSnapshot(dateKey)
        }
      }
      this.#lastStatus = {
        windowActive,
        quotaUsed: snapshot.quotaAllocated,
        circuit: snapshot.scheduler.circuit,
      }
    } finally {
      this.#running = false
    }
  }

  public async dispose(): Promise<void> {
    this.stop()
    this.#taskExecutors.clear()
    await this.#executor?.dispose?.()
  }

  #executorFor(task: Task): NightTaskExecutor | undefined {
    const matches: NightTaskExecutorRoute[] = []
    for (const route of this.#taskExecutors.values()) {
      let matched: boolean
      try {
        matched = route.matches(task)
      } catch (error: unknown) {
        throw new LubanError(
          'E_INVALID_INPUT',
          `Night task executor route failed while matching: ${route.id}`,
          { cause: error },
        )
      }
      if (matched) matches.push(route)
    }
    if (matches.length > 1) {
      throw new LubanError(
        'E_INVALID_INPUT',
        `Multiple night task executors match task ${task.id}: ${matches
          .map((route) => route.id)
          .join(', ')}`,
      )
    }
    return matches[0]?.executor ?? this.#executor
  }

  async #refreshStatus(): Promise<void> {
    const now = this.#clock.now()
    const snapshot = await this.#store.nightSchedulerSnapshot(localDateKey(now))
    this.#lastStatus = {
      windowActive: isInWindow(now, this.#config.window),
      quotaUsed: snapshot.quotaAllocated,
      circuit: snapshot.scheduler.circuit,
    }
  }
}

function isClaimConflict(error: unknown): boolean {
  return error instanceof LubanError && error.code === 'E_VERSION_CONFLICT'
}
