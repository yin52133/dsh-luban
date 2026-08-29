import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Agent, AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  Actor,
  Clock,
  HostId,
  NightScheduler,
  SchedulerStatus,
  Task,
  TaskOutput,
} from '@luban/core'
import { LubanError, asActorId, asHostId, asSessionId, systemClock } from '@luban/core'
import type { NightConfig } from './config.js'
import type { DefaultAgentClaimService } from './claim-service.js'
import type { JsonTaskStore } from './task-store.js'

export interface NightTaskExecutor {
  execute(task: Task, sessionId: ReturnType<typeof SessionId>): Promise<TaskOutput>
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
  sessionId: ReturnType<typeof SessionId>,
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

  public async execute(task: Task, sessionId: ReturnType<typeof SessionId>): Promise<TaskOutput> {
    const reportState: NightExecutionReportState = { calls: 0 }
    const handle = await this.#agents.create({
      sessionId,
      meta: {
        ...(task.workspace === undefined ? {} : { cwd: resolve(task.workspace) }),
      },
      agentOptions: {
        provider: this.#config.model.provider,
        model: this.#config.model.id,
      },
      setup: (agentCtx): void => {
        agentCtx.tools.restrict({ allow: this.#config.toolAllowlist })
        agentCtx.tools.register(resultTool(sessionId, reportState))
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
        by: { kind: 'agent', id: asActorId(sessionId) },
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
  readonly #executor: NightTaskExecutor | undefined
  readonly #config: NightConfig
  readonly #hostScope: 'win' | 'ubuntu'
  readonly #hostId: HostId
  readonly #clock: Clock
  #timer: ReturnType<typeof setInterval> | undefined
  #running = false
  #lastStatus: SchedulerStatus = { windowActive: false, quotaUsed: 0, circuit: 'ok' }

  public constructor(options: {
    readonly store: JsonTaskStore
    readonly claims: DefaultAgentClaimService
    readonly executor?: NightTaskExecutor
    readonly config: NightConfig
    readonly hostScope: 'win' | 'ubuntu'
    readonly hostId?: HostId
    readonly clock?: Clock
  }) {
    this.#store = options.store
    this.#claims = options.claims
    this.#executor = options.executor
    this.#config = options.config
    this.#hostScope = options.hostScope
    this.#hostId = options.hostId ?? asHostId(this.#hostScope)
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

  public async triggerOnce(): Promise<void> {
    if (!this.#config.enabled) throw new LubanError('E_UNAVAILABLE', 'Night scheduler is disabled')
    if (this.#running) return
    this.#running = true
    try {
      const now = this.#clock.now()
      const dateKey = localDateKey(now)
      let state = await this.#store.updateScheduler((current) =>
        current.dateKey === dateKey
          ? current
          : { dateKey, quotaUsed: 0, consecutiveFailures: 0, circuit: 'ok' },
      )
      const windowActive = isInWindow(now, this.#config.window)
      this.#lastStatus = { windowActive, quotaUsed: state.quotaUsed, circuit: state.circuit }
      if (!windowActive || state.circuit === 'open' || state.quotaUsed >= this.#config.dailyQuota)
        return
      if (!this.#config.hostScopeWhitelist.includes(this.#hostScope)) return
      if (this.#executor === undefined) {
        throw new LubanError('E_UNAVAILABLE', 'No DSH night executor is available')
      }

      const sessionId = SessionId(`luban-night-${randomUUID()}`)
      const claimSessionId = asSessionId(sessionId)
      const actor: Actor = {
        kind: 'agent',
        id: asActorId(sessionId),
        displayName: 'Luban Night Scheduler',
      }
      const claim = await this.#claims.claim(
        { statuses: ['todo'], tags: this.#config.tagWhitelist, requireAcceptance: true },
        { actor, sessionId: claimSessionId, host: this.#hostId },
      )
      if (!claim.ok) return
      try {
        const output = await this.#executor.execute(claim.task, sessionId)
        await this.#claims.complete(claim.task.id, output, { autoDone: true })
        state = await this.#store.updateScheduler((current) => ({
          ...current,
          quotaUsed: current.quotaUsed + 1,
          consecutiveFailures: 0,
          circuit: 'ok',
        }))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Autonomous execution failed'
        await this.#claims.fail(claim.task.id, message)
        state = await this.#store.updateScheduler((current) => {
          const consecutiveFailures = current.consecutiveFailures + 1
          return {
            ...current,
            consecutiveFailures,
            circuit:
              consecutiveFailures >= this.#config.circuitBreaker.maxConsecutiveFailures
                ? 'open'
                : 'ok',
          }
        })
      }
      this.#lastStatus = {
        windowActive,
        quotaUsed: state.quotaUsed,
        circuit: state.circuit,
      }
    } finally {
      this.#running = false
    }
  }

  public async dispose(): Promise<void> {
    this.stop()
    await this.#executor?.dispose?.()
  }

  async #refreshStatus(): Promise<void> {
    const now = this.#clock.now()
    const state = await this.#store.schedulerLedger()
    this.#lastStatus = {
      windowActive: isInWindow(now, this.#config.window),
      quotaUsed: state.dateKey === localDateKey(now) ? state.quotaUsed : 0,
      circuit: state.dateKey === localDateKey(now) ? state.circuit : 'ok',
    }
  }
}
