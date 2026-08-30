import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  SessionId as DshSessionId,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import type { Clock, SessionId, TelemetryProvider, TelemetrySnapshot } from '@luban/core'
import { systemClock } from '@luban/core'
import type { MonotonicClock, SlidingRateWindow } from './rate-window.js'
import { systemMonotonicClock } from './rate-window.js'

const FIVE_MINUTES_MS = 300_000
const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

export type AgentLookup = Pick<AgentRegistry, 'currentInitiator' | 'get' | 'list'>

/** Optional read face of DSH's rc2 session-projection capability seam. */
export interface SessionProjectionReader {
  snapshot(session: Session): {
    readonly values: Readonly<Record<string, unknown>>
  }
}

export type SessionProjectionResolver = () => SessionProjectionReader | undefined

interface ContextPressureProjection {
  readonly pressureTokens?: unknown
  readonly projectedTokens?: unknown
  readonly contextWindow?: unknown
}

interface ProjectedContext {
  readonly used: number | 'unknown'
  readonly max: number | 'unknown'
  readonly ratio: number | 'unknown'
}

/** Prefer causal attribution, then a running agent, then the newest registered agent. */
export function selectTelemetryAgent(agents: AgentLookup): Agent | undefined {
  try {
    const initiating = agents.currentInitiator()
    if (initiating !== undefined && agents.get(initiating.id) === initiating) return initiating
  } catch {
    // Registry teardown can make optional attribution unreadable; list fallback remains explicit.
  }
  const registered = agents.list()
  return registered.findLast((agent): boolean => agent.status === 'running') ?? registered.at(-1)
}

function telemetryAgentById(agents: AgentLookup, sessionId: SessionId): Agent | undefined {
  try {
    return agents.get(DshSessionId(sessionId))
  } catch {
    return undefined
  }
}

function tokenCountTotal(values: readonly unknown[]): number | 'unknown' {
  if (
    !values.every(
      (value): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    )
  ) {
    return 'unknown'
  }
  const total = values.reduce((sum, value): number => sum + value, 0)
  return Number.isSafeInteger(total) ? total : 'unknown'
}

function optionalTokenCount(value: unknown): unknown {
  return value === undefined ? 0 : value
}

function nonNegativeTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function positiveTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Read token-meter's official rc2 occupancy view without making the seam mandatory. */
function projectedContext(
  session: Session,
  resolveProjections: SessionProjectionResolver | undefined,
): ProjectedContext | undefined {
  if (resolveProjections === undefined) return undefined
  try {
    const reader = resolveProjections()
    if (reader === undefined) return undefined
    const values = reader.snapshot(session).values
    if (!Object.hasOwn(values, 'contextPressure')) return undefined
    const projection = values.contextPressure
    if (projection === null || typeof projection !== 'object') return undefined
    const context = projection as ContextPressureProjection
    const used =
      nonNegativeTokenCount(context.projectedTokens) ??
      nonNegativeTokenCount(context.pressureTokens) ??
      'unknown'
    const max = positiveTokenCount(context.contextWindow) ?? 'unknown'
    return {
      used,
      max,
      ratio: used === 'unknown' || max === 'unknown' ? 'unknown' : used / max,
    }
  } catch {
    // The optional service may disappear during plugin teardown; legacy telemetry remains safe.
    return undefined
  }
}

export function tokenUsageTotal(usage: TokenUsage): number | 'unknown' {
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    optionalTokenCount(usage.cacheReadTokens),
    optionalTokenCount(usage.cacheWriteTokens),
  ]
  // reasoningTokens is provider detail inside outputTokens and must not be double-counted.
  return tokenCountTotal(values)
}

/** Match DSH's request-pressure projection: output is not part of the request that produced it. */
export function contextPressureTotal(usage: TokenUsage): number | 'unknown' {
  return tokenCountTotal([
    usage.inputTokens,
    optionalTokenCount(usage.cacheReadTokens),
    optionalTokenCount(usage.cacheWriteTokens),
  ])
}

function latestUsage(session: Session): TokenUsage | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events.at(index)
    if (event === undefined) continue
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      return event.data.usage
    }
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
      return event.data.chunk.usage
    }
  }
  return undefined
}

function textTokens(value: string): number {
  return Math.ceil(value.length / CHARS_PER_TOKEN)
}

function estimateContentTokens(blocks: readonly ContentBlock[]): number {
  return blocks.reduce((tokens, block): number => {
    if (block.type === 'text' || block.type === 'reasoning') {
      return tokens + textTokens(block.text) + BLOCK_OVERHEAD
    }
    if (block.type === 'tool-call') {
      return tokens + textTokens(block.name) + textTokens(block.arguments) + BLOCK_OVERHEAD
    }
    if (block.type === 'tool-result') {
      return tokens + estimateContentTokens(block.content) + BLOCK_OVERHEAD
    }
    return tokens + textTokens(JSON.stringify(block)) + BLOCK_OVERHEAD
  }, 0)
}

export function estimateSessionTokens(session: Session): number {
  const header = session.requestHeader()
  const systemTokens = header?.system === undefined ? 0 : textTokens(header.system) + ROLE_OVERHEAD
  const toolsTokens =
    header?.tools === undefined || header.tools.length === 0
      ? 0
      : textTokens(JSON.stringify(header.tools)) + BLOCK_OVERHEAD
  const messageTokens = session
    .deriveMessages()
    .reduce(
      (tokens, message): number => tokens + estimateContentTokens(message.content) + ROLE_OVERHEAD,
      0,
    )
  const total = systemTokens + toolsTokens + messageTokens
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new TypeError('Session token estimate is outside the supported range')
  }
  return total
}

export function displayWorkspace(cwd: string | undefined, root = process.cwd()): string {
  if (cwd === undefined || cwd.trim() === '') return 'unknown'
  const absolute = resolve(cwd)
  const relativePath = relative(resolve(root), absolute)
  if (relativePath === '') return '.'
  if (
    isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith('..\\') ||
    relativePath.startsWith('../')
  ) {
    return basename(absolute)
  }
  return relativePath.replaceAll('\\', '/')
}

/** Official rc2 Session fields: usage, context window, workspace, model, and reasoning effort. */
export class DshSessionTelemetryProvider implements TelemetryProvider {
  public readonly id = 'dsh-session'
  readonly #agents: AgentLookup
  readonly #workspaceRoot: string
  readonly #resolveProjections: SessionProjectionResolver | undefined

  public constructor(
    agents: AgentLookup,
    workspaceRoot = process.cwd(),
    resolveProjections?: SessionProjectionResolver,
  ) {
    this.#agents = agents
    this.#workspaceRoot = workspaceRoot
    this.#resolveProjections = resolveProjections
  }

  public capabilities(): readonly ['context', 'workspace', 'model'] {
    return ['context', 'workspace', 'model']
  }

  public sample(): Promise<Partial<TelemetrySnapshot>> {
    return this.#sampleAgent(selectTelemetryAgent(this.#agents))
  }

  public sampleForSession(sessionId: SessionId): Promise<Partial<TelemetrySnapshot>> {
    return this.#sampleAgent(telemetryAgentById(this.#agents, sessionId))
  }

  #sampleAgent(agent: Agent | undefined): Promise<Partial<TelemetrySnapshot>> {
    if (agent === undefined) return Promise.resolve({})
    const requestContext = agent.session.requestContext()
    const requestHeader = agent.session.requestHeader()
    const officialContext = projectedContext(agent.session, this.#resolveProjections)
    const usage = officialContext === undefined ? latestUsage(agent.session) : undefined
    const used =
      officialContext?.used ?? (usage === undefined ? 'unknown' : contextPressureTotal(usage))
    const max =
      officialContext?.max ??
      (requestContext?.contextWindow !== undefined &&
      Number.isFinite(requestContext.contextWindow) &&
      requestContext.contextWindow > 0
        ? requestContext.contextWindow
        : 'unknown')
    const ratio =
      officialContext?.ratio ?? (used === 'unknown' || max === 'unknown' ? 'unknown' : used / max)
    const model = requestHeader?.config.model ?? requestContext?.model ?? agent.options.model
    const reasoning = requestHeader?.config.reasoningEffort
    return Promise.resolve({
      context: { used, max, ratio },
      workspace: { name: displayWorkspace(agent.session.header.cwd, this.#workspaceRoot) },
      model: {
        name: model === undefined || model.trim() === '' ? 'unknown' : model,
        thinkingDepth: reasoning === undefined ? 'unknown' : String(reasoning),
      },
    })
  }
}

/** Content-only estimator used strictly after the official session provider leaves `used` unknown. */
export class DshContextEstimatorProvider implements TelemetryProvider {
  public readonly id = 'dsh-token-estimator'
  readonly #agents: AgentLookup
  readonly #resolveProjections: SessionProjectionResolver | undefined

  public constructor(agents: AgentLookup, resolveProjections?: SessionProjectionResolver) {
    this.#agents = agents
    this.#resolveProjections = resolveProjections
  }

  public capabilities(): readonly ['context'] {
    return ['context']
  }

  public sample(): Promise<Partial<TelemetrySnapshot>> {
    return this.#sampleAgent(selectTelemetryAgent(this.#agents))
  }

  public sampleForSession(sessionId: SessionId): Promise<Partial<TelemetrySnapshot>> {
    return this.#sampleAgent(telemetryAgentById(this.#agents, sessionId))
  }

  #sampleAgent(agent: Agent | undefined): Promise<Partial<TelemetrySnapshot>> {
    const hasOfficialProjection =
      agent !== undefined && projectedContext(agent.session, this.#resolveProjections) !== undefined
    return Promise.resolve(
      agent === undefined || hasOfficialProjection
        ? {}
        : {
            context: {
              used: estimateSessionTokens(agent.session),
              max: 'unknown',
              ratio: 'unknown',
            },
          },
    )
  }
}

/** Replays recent rc2 assistant usage once, then ingests the live session/event feed by sequence. */
export class DshRateCollector {
  readonly #window: SlidingRateWindow
  readonly #clock: Clock
  readonly #monotonicClock: MonotonicClock
  readonly #lastSequence = new Map<
    string,
    { readonly sequence: number; readonly touchedAt: number }
  >()

  public constructor(options: {
    readonly window: SlidingRateWindow
    readonly clock?: Clock
    readonly monotonicClock?: MonotonicClock
  }) {
    this.#window = options.window
    this.#clock = options.clock ?? systemClock
    this.#monotonicClock = options.monotonicClock ?? systemMonotonicClock
  }

  public adopt(session: Session): void {
    for (const event of session.events) this.#observe(session, event, false)
  }

  public observe(session: Session, event: SessionEvent): void {
    this.#observe(session, event, true)
  }

  public dispose(session: Session): void {
    const previous = this.#lastSequence.get(session.id)
    if (previous === undefined) return
    this.#lastSequence.set(session.id, {
      sequence: previous.sequence,
      touchedAt: this.#monotonicClock.now(),
    })
  }

  #observe(session: Session, event: SessionEvent, live: boolean): void {
    const now = this.#monotonicClock.now()
    this.#pruneSessions(now, session.id)
    const previous = this.#lastSequence.get(session.id)?.sequence ?? -1
    if (event.seq <= previous) return
    this.#lastSequence.set(session.id, { sequence: event.seq, touchedAt: now })
    if (event.type !== 'assistant/message') return
    const tokens =
      event.data.usage === undefined ? ('unknown' as const) : tokenUsageTotal(event.data.usage)
    if (live) {
      this.#window.record(tokens, 1)
      return
    }
    const age = Math.max(0, this.#clock.now() - event.time)
    if (age > FIVE_MINUTES_MS) return
    const mapped = now - age
    this.#window.record(tokens, 1, mapped)
  }

  #pruneSessions(now: number, activeSessionId: string): void {
    for (const [sessionId, state] of this.#lastSequence) {
      if (sessionId !== activeSessionId && now - state.touchedAt > FIVE_MINUTES_MS) {
        this.#lastSequence.delete(sessionId)
      }
    }
  }
}
