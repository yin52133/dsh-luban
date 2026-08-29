import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { DefaultTelemetryAggregator } from '../src/aggregator.js'
import {
  contextPressureTotal,
  DshContextEstimatorProvider,
  DshRateCollector,
  DshSessionTelemetryProvider,
  type AgentLookup,
  tokenUsageTotal,
} from '../src/dsh-telemetry.js'
import { SlidingRateWindow, type MonotonicClock } from '../src/rate-window.js'

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

function appendAssistant(value: Session, usage?: TokenUsage): SessionEvent<'assistant/message'> {
  return value.append(
    'assistant/message',
    {
      turn: 0,
      step: value.seq,
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

describe('rc2 DSH telemetry providers', (): void => {
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
