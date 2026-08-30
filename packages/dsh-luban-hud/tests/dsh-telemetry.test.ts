import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TokenMeter, type ContextPressureProjection } from '@deepseek-ai/dsh-token-meter'
import { asSessionId, type TelemetrySnapshot } from '@luban/core'
import { describe, expect, it } from 'vitest'
import { DefaultTelemetryAggregator } from '../src/aggregator.js'
import {
  contextPressureTotal,
  DshContextEstimatorProvider,
  DshRateCollector,
  DshSessionTelemetryProvider,
  type AgentLookup,
  selectTelemetryAgent,
  tokenUsageTotal,
} from '../src/dsh-telemetry.js'
import { SlidingRateWindow, type MonotonicClock } from '../src/rate-window.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'compaction/prune': {
      shadowedRange: { start: number; end: number }
      shadowedSeqs: number[]
      shadowedTokenCount: number
    }
  }
}

class ManualClock implements MonotonicClock {
  public value = 300_000

  public now(): number {
    return this.value
  }
}

function session(idValue: string, cwd: string): Session {
  const id = SessionId(idValue)
  return Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    cwd,
  })
}

function agentFor(value: Session, options: Agent['options'] = {}): Agent {
  return {
    id: value.id,
    session: value,
    options,
    status: 'idle',
  } as Agent
}

function lookup(agent: Agent): AgentLookup {
  return {
    currentInitiator: (): Agent | undefined => undefined,
    get: (id): Agent | undefined => (id === agent.id ? agent : undefined),
    list: (): Agent[] => [agent],
  }
}

function appendAssistant(
  value: Session,
  usage?: TokenUsage,
  step = value.seq,
): SessionEvent<'assistant/message'> {
  return value.append(
    'assistant/message',
    {
      turn: 0,
      step,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'measured response' }],
        source: { provider: 'deepseek', model: 'deepseek-chat' },
      }),
      ...(usage === undefined ? {} : { usage }),
    },
    { surfaceOp: 'append' },
  )
}

function historicalSession(idValue: string, time: number, usage: TokenUsage): Session {
  const id = SessionId(idValue)
  const event: SessionEvent<'assistant/message'> = {
    type: 'assistant/message',
    seq: 0,
    time,
    data: {
      turn: 0,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'historical response' }],
        source: { provider: 'deepseek', model: 'deepseek-chat' },
      }),
      usage,
    },
    surfaceOp: 'append',
  }
  return { id, events: [event] } as unknown as Session
}

function publish(context: Context, value: Session, event: SessionEvent): void {
  context.emit('session/event', value, event)
}

function officialContext(
  projections: SessionProjectionRegistry,
  value: Session,
): ContextPressureProjection {
  const projection = projections.snapshot(value).values.contextPressure
  if (projection === undefined) throw new Error('token-meter contextPressure projection is missing')
  return projection
}

function expectWithinFivePercent(
  snapshot: TelemetrySnapshot,
  projection: ContextPressureProjection,
): void {
  const used = projection.projectedTokens ?? projection.pressureTokens
  if (used === undefined || projection.contextWindow === undefined) {
    throw new Error('official context occupancy is incomplete')
  }
  if (snapshot.context.used === 'unknown' || snapshot.context.max === 'unknown') {
    throw new Error('HUD context occupancy is incomplete')
  }
  const expectedRatio = used / projection.contextWindow
  const usedError = Math.abs(snapshot.context.used - used) / Math.max(used, 1)
  const maxError =
    Math.abs(snapshot.context.max - projection.contextWindow) / projection.contextWindow
  const ratioError =
    snapshot.context.ratio === 'unknown'
      ? Number.POSITIVE_INFINITY
      : Math.abs(snapshot.context.ratio - expectedRatio) / Math.max(expectedRatio, Number.EPSILON)
  expect(usedError).toBeLessThanOrEqual(0.05)
  expect(maxError).toBeLessThanOrEqual(0.05)
  expect(ratioError).toBeLessThanOrEqual(0.05)
}

describe('rc2 DSH telemetry providers', (): void => {
  it('selects the current initiator, then newest running, then newest registered agent', (): void => {
    const initiator = agentFor(session('hud-initiator', resolve('workspace-root', 'initiator')))
    const runningOld = {
      ...agentFor(session('hud-running-old', resolve('workspace-root', 'running-old'))),
      status: 'running',
    } as Agent
    const runningNew = {
      ...agentFor(session('hud-running-new', resolve('workspace-root', 'running-new'))),
      status: 'running',
    } as Agent
    const newest = agentFor(session('hud-newest-idle', resolve('workspace-root', 'newest')))
    let current: Agent | undefined = initiator
    let registered: Agent[] = [initiator, runningOld, runningNew, newest]
    const agents: AgentLookup = {
      currentInitiator: (): Agent | undefined => current,
      get: (id): Agent | undefined => registered.find((agent): boolean => agent.id === id),
      list: (): Agent[] => registered,
    }

    expect(selectTelemetryAgent(agents)).toBe(initiator)
    current = undefined
    expect(selectTelemetryAgent(agents)).toBe(runningNew)
    registered = [
      initiator,
      { ...runningOld, status: 'idle' },
      { ...runningNew, status: 'idle' },
      newest,
    ]
    expect(selectTelemetryAgent(agents)).toBe(newest)
  })

  it('uses official request/usage fields before the estimator', async (): Promise<void> => {
    const workspaceRoot = resolve('workspace-root')
    const value = session('hud-official', resolve(workspaceRoot, 'firmware', 'app'))
    value.append('request/context', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      contextWindow: 1_000,
    })
    value.append('request/header', {
      header: {
        config: {
          provider: 'deepseek',
          model: 'deepseek-reasoner',
          reasoningEffort: ReasoningEffortId('high'),
        },
      },
      reason: 'initial',
    })
    appendAssistant(value, {
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: 20,
    })
    const agents = lookup(agentFor(value))
    const aggregator = new DefaultTelemetryAggregator({ refreshMs: 1_000, providerTimeoutMs: 100 })
    aggregator.register(new DshSessionTelemetryProvider(agents, workspaceRoot))
    aggregator.register(new DshContextEstimatorProvider(agents))

    const envelope = await aggregator.envelope()
    expect(envelope.snapshot).toMatchObject({
      context: { used: 115, max: 1_000, ratio: 0.115 },
      workspace: { name: 'firmware/app' },
      model: { name: 'deepseek-reasoner', thinkingDepth: 'high' },
    })
    expect(envelope.sources['context.used']).toBe('dsh-session')
    expect(
      contextPressureTotal({
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      }),
    ).toBe(115)
  })

  it('tracks the real rc2 token-meter projection across append and compaction', async (): Promise<void> => {
    const context = new Context()
    const projectionFiber = context.plugin(SessionProjectionRegistry)
    await projectionFiber
    const meterFiber = context.plugin(TokenMeter)
    await meterFiber

    try {
      const value = session('hud-official-projection', resolve('workspace-root'))
      publish(
        context,
        value,
        value.append('request/context', {
          provider: 'deepseek',
          model: 'deepseek-chat',
          contextWindow: 4_096,
        }),
      )
      publish(
        context,
        value,
        value.append('request/header', {
          header: { config: { provider: 'deepseek', model: 'deepseek-chat' } },
          reason: 'initial',
        }),
      )
      publish(context, value, value.append('turn/start', { turn: 0 }))
      publish(
        context,
        value,
        value.append(
          'user/message',
          createUserMessage({
            content: [{ type: 'text', text: 'initial prompt '.repeat(20) }],
            source: { kind: 'user' },
          }),
          { surfaceOp: 'append' },
        ),
      )

      const projections = context.sessionProjections
      const meter = context.tokenMeter
      const resolveProjections = (): SessionProjectionRegistry => projections
      const agents = lookup(agentFor(value))
      const aggregator = new DefaultTelemetryAggregator({
        refreshMs: 1_000,
        providerTimeoutMs: 100,
      })
      aggregator.register(
        new DshSessionTelemetryProvider(agents, resolve('workspace-root'), resolveProjections),
      )
      aggregator.register(new DshContextEstimatorProvider(agents, resolveProjections))

      const beforeUsageProjection = officialContext(projections, value)
      expect(beforeUsageProjection).toEqual({ contextWindow: 4_096 })
      expect((await aggregator.snapshotFor(asSessionId(value.id))).context).toEqual({
        used: 'unknown',
        max: 4_096,
        ratio: 'unknown',
      })

      publish(context, value, value.append('step/start', { turn: 0, step: 0 }))
      publish(
        context,
        value,
        appendAssistant(
          value,
          {
            inputTokens: 700,
            outputTokens: 50,
            cacheReadTokens: 100,
            cacheWriteTokens: 20,
          },
          0,
        ),
      )
      publish(context, value, value.append('step/end', { turn: 0, step: 0 }))
      publish(context, value, value.append('turn/end', { turn: 0, reason: { kind: 'completed' } }))

      const initialProjection = officialContext(projections, value)
      expect(initialProjection.projectedTokens).toBeGreaterThan(
        initialProjection.pressureTokens ?? Number.POSITIVE_INFINITY,
      )
      const initialHud = await aggregator.snapshotFor(asSessionId(value.id))
      expectWithinFivePercent(initialHud, initialProjection)
      expect(initialHud.context.used).toBe(initialProjection.projectedTokens)
      const initialUsed = initialProjection.projectedTokens ?? 0

      const appended = value.append(
        'user/message',
        createUserMessage({
          content: [{ type: 'text', text: 'new surface context '.repeat(40) }],
          source: { kind: 'plugin', plugin: 'hud-test' },
        }),
        { surfaceOp: 'append' },
      )
      publish(context, value, appended)
      const appendedProjection = officialContext(projections, value)
      const appendedHud = await aggregator.snapshotFor(asSessionId(value.id))
      expectWithinFivePercent(appendedHud, appendedProjection)
      expect(appendedProjection.projectedTokens).toBeGreaterThan(initialUsed)

      const beforeCompaction = meter.measure(value)
      const shadowed = beforeCompaction.nodes.slice(0, 2)
      const start = shadowed.at(0)?.seq
      const end = shadowed.at(-1)?.seq
      if (start === undefined || end === undefined) throw new Error('surface prefix is missing')
      const shadowedSeqs = shadowed.map((node): number => node.seq)
      const shadowedTokenCount = shadowed.reduce((total, node): number => total + node.tokens, 0)
      publish(
        context,
        value,
        value.append('compaction/prune', {
          shadowedRange: { start, end },
          shadowedSeqs,
          shadowedTokenCount,
        }),
      )
      const replacement = value.append(
        'user/message',
        createUserMessage({
          content: [{ type: 'text', text: 'compact summary' }],
          source: { kind: 'plugin', plugin: 'hud-test' },
        }),
        {
          surfaceOp: { op: 'replace', start, end },
          sourceEventSeqs: shadowedSeqs,
        },
      )
      publish(context, value, replacement)
      const compactedProjection = officialContext(projections, value)
      const compactedHud = await aggregator.snapshotFor(asSessionId(value.id))
      expectWithinFivePercent(compactedHud, compactedProjection)
      expect(compactedProjection.projectedTokens).toBeLessThan(
        appendedProjection.projectedTokens ?? Number.NEGATIVE_INFINITY,
      )
      expect(meter.measure(value).surfaceTokens).toBeLessThan(beforeCompaction.surfaceTokens)
    } finally {
      await Promise.allSettled([meterFiber.dispose(), projectionFiber.dispose()])
    }
  })

  it('samples the requested session instead of the global newest-agent selection', async (): Promise<void> => {
    const targetSession = session('hud-target', resolve('workspace-root', 'target'))
    targetSession.append('request/context', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      contextWindow: 100,
    })
    appendAssistant(targetSession, { inputTokens: 90, outputTokens: 1 })
    const newestSession = session('hud-newest', resolve('workspace-root', 'newest'))
    newestSession.append('request/context', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      contextWindow: 1_000,
    })
    appendAssistant(newestSession, { inputTokens: 10, outputTokens: 1 })
    const targetAgent = agentFor(targetSession)
    const newestAgent = agentFor(newestSession)
    const agents: AgentLookup = {
      currentInitiator: (): Agent | undefined => undefined,
      get: (id): Agent | undefined =>
        id === targetAgent.id ? targetAgent : id === newestAgent.id ? newestAgent : undefined,
      list: (): Agent[] => [targetAgent, newestAgent],
    }
    const aggregator = new DefaultTelemetryAggregator({ refreshMs: 1_000, providerTimeoutMs: 100 })
    aggregator.register(new DshSessionTelemetryProvider(agents, resolve('workspace-root')))
    aggregator.register(new DshContextEstimatorProvider(agents))

    expect((await aggregator.snapshot()).context.ratio).toBe(0.01)
    const target = await aggregator.snapshotFor(asSessionId(targetAgent.id))
    expect(target.context).toEqual({ used: 90, max: 100, ratio: 0.9 })
    expect(target.workspace.name).toBe('target')
  })

  it('falls back to a content estimate while retaining the official context maximum', async (): Promise<void> => {
    const value = session('hud-estimate', resolve('workspace-root'))
    value.append('request/context', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      contextWindow: 4_096,
    })
    value.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'x'.repeat(400) }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    const agents = lookup(agentFor(value))
    const aggregator = new DefaultTelemetryAggregator({ refreshMs: 1_000, providerTimeoutMs: 100 })
    aggregator.register(new DshSessionTelemetryProvider(agents))
    aggregator.register(new DshContextEstimatorProvider(agents))

    const envelope = await aggregator.envelope()
    expect(envelope.snapshot.context.used).not.toBe('unknown')
    expect(envelope.snapshot.context.max).toBe(4_096)
    expect(envelope.snapshot.context.ratio).not.toBe('unknown')
    expect(envelope.sources['context.used']).toBe('dsh-token-estimator')
  })

  it('keeps invalid official usage unknown and contains estimator failures', async (): Promise<void> => {
    const invalid = session('hud-invalid-usage', resolve('workspace-root'))
    invalid.append('request/context', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      contextWindow: 1_000,
    })
    appendAssistant(invalid, { inputTokens: -1, outputTokens: 10 })
    const official = new DefaultTelemetryAggregator({ refreshMs: 1_000, providerTimeoutMs: 100 })
    official.register(new DshSessionTelemetryProvider(lookup(agentFor(invalid))))
    const officialEnvelope = await official.envelope()
    expect(officialEnvelope.snapshot.context).toEqual({
      used: 'unknown',
      max: 1_000,
      ratio: 'unknown',
    })
    expect(contextPressureTotal({ inputTokens: -1, outputTokens: 10 })).toBe('unknown')
    expect(tokenUsageTotal({ inputTokens: 5, outputTokens: Number.NaN })).toBe('unknown')
    expect(tokenUsageTotal({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 })).toBe(
      'unknown',
    )
    expect(
      tokenUsageTotal({
        inputTokens: 5,
        outputTokens: 1,
        cacheReadTokens: null,
      } as unknown as TokenUsage),
    ).toBe('unknown')

    const brokenId = SessionId('hud-broken-estimator')
    const brokenSession = {
      id: brokenId,
      requestHeader: (): never => {
        throw new Error('estimator failed token=private-value')
      },
    } as unknown as Session
    const estimator = new DefaultTelemetryAggregator({ refreshMs: 1_000, providerTimeoutMs: 100 })
    estimator.register(new DshContextEstimatorProvider(lookup(agentFor(brokenSession))))
    const estimatorEnvelope = await estimator.envelope()
    expect(estimatorEnvelope.snapshot.context.used).toBe('unknown')
    expect(estimatorEnvelope.failures).toEqual([
      { providerId: 'dsh-token-estimator', message: 'Telemetry provider unavailable' },
    ])
  })

  it('reconciles disjoint token usage into monotonic 1m/5m windows without double-counting reasoning', (): void => {
    const monotonic = new ManualClock()
    const epoch = { now: (): number => Date.now() }
    const window = new SlidingRateWindow(monotonic)
    const collector = new DshRateCollector({ window, clock: epoch, monotonicClock: monotonic })
    const value = session('hud-rates', resolve('workspace-root'))
    appendAssistant(value, {
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 10,
      reasoningTokens: 15,
    })
    collector.adopt(value)
    expect(window.snapshot()).toEqual({ tpm1m: 110, tpm5m: 22, rpm1m: 1, rpm5m: 0.2 })

    monotonic.value += 61_000
    expect(window.snapshot()).toEqual({ tpm1m: 0, tpm5m: 22, rpm1m: 0, rpm5m: 0.2 })
    const live = appendAssistant(value, { inputTokens: 40, outputTokens: 10 })
    collector.observe(value, live)
    expect(window.snapshot()).toEqual({ tpm1m: 50, tpm5m: 32, rpm1m: 1, rpm5m: 0.4 })

    monotonic.value -= 1_000
    window.record(10, 1)
    expect(window.snapshot()).toEqual({ tpm1m: 60, tpm5m: 34, rpm1m: 2, rpm5m: 0.6 })

    monotonic.value += 301_001
    expect(window.snapshot()).toEqual({ tpm1m: 0, tpm5m: 0, rpm1m: 0, rpm5m: 0 })
  })

  it('preserves interleaved historical timestamps across sessions and propagates unknown TPM', (): void => {
    const monotonic = new ManualClock()
    monotonic.value = 1_000
    const epochNow = 1_000_000
    const window = new SlidingRateWindow(monotonic)
    const collector = new DshRateCollector({
      window,
      clock: { now: (): number => epochNow },
      monotonicClock: monotonic,
    })
    collector.adopt(
      historicalSession('hud-recent-history', epochNow - 10_000, {
        inputTokens: 8,
        outputTokens: 2,
      }),
    )
    collector.adopt(
      historicalSession('hud-old-history', epochNow - 240_000, {
        inputTokens: 320,
        outputTokens: 80,
      }),
    )
    expect(window.snapshot()).toEqual({ tpm1m: 10, tpm5m: 82, rpm1m: 1, rpm5m: 0.4 })

    window.record('unknown', 1)
    expect(window.snapshot()).toEqual({
      tpm1m: 'unknown',
      tpm5m: 'unknown',
      rpm1m: 2,
      rpm5m: 0.6,
    })
  })
})
