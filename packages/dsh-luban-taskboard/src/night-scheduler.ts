import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { AgentHandle, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
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

/** Default DSH execution adapter using the rc2 AgentRegistry public factory. */
export class DshAgentNightExecutor implements NightTaskExecutor {
  readonly #agents: AgentRegistry
  readonly #handles = new Set<AgentHandle>()
  readonly #clock: Clock

  public constructor(agents: AgentRegistry, clock: Clock = systemClock) {
    this.#agents = agents
    this.#clock = clock
  }

  public async execute(task: Task, sessionId: ReturnType<typeof SessionId>): Promise<TaskOutput> {
    const handle = await this.#agents.create({
      sessionId,
      meta: {
        ...(task.workspace === undefined ? {} : { cwd: resolve(task.workspace) }),
      },
    })
    this.#handles.add(handle)
    try {
      const prompt = [
        `Luban autonomous task ${task.id}: ${task.title}`,
        task.description,
        `Acceptance criteria:\n${task.acceptance ?? '(missing)'}`,
        'Work only inside the configured workspace. Summarize verifiable outputs when finished.',
      ].join('\n\n')
      handle.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'dsh-luban-taskboard' },
        }),
      )
      await handle.agent.whenIdle()
      return {
        kind: 'note',
        ref: `session:${sessionId}`,
        summary: 'Autonomous DSH session reached idle; review its durable transcript and outputs.',
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
