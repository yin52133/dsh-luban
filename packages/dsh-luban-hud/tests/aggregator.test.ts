import type { TelemetryProvider, TelemetrySnapshot } from '@luban/core'
import { asSessionId } from '@luban/core'
import { describe, expect, it, vi } from 'vitest'
import { DefaultTelemetryAggregator } from '../src/aggregator.js'
import { parseConfig } from '../src/config.js'
import type { MonotonicClock } from '../src/rate-window.js'

class ManualClock implements MonotonicClock {
  public value = 0

  public now(): number {
    return this.value
  }
}

function provider(
  id: string,
  capabilities: ReturnType<TelemetryProvider['capabilities']>,
  sample: () => Promise<Partial<TelemetrySnapshot>>,
): TelemetryProvider {
  return { id, capabilities: (): typeof capabilities => capabilities, sample }
}

describe('DefaultTelemetryAggregator', (): void => {
  it('samples providers concurrently, keeps first field owner, and contains one failure', async (): Promise<void> => {
    const monotonic = new ManualClock()
    const started: string[] = []
    const diagnostics: string[] = []
    let releaseContext: (() => void) | undefined
    let releaseModel: (() => void) | undefined
    const contextReady = new Promise<void>((resolve): void => {
      releaseContext = resolve
    })
    const modelReady = new Promise<void>((resolve): void => {
      releaseModel = resolve
    })
    const aggregator = new DefaultTelemetryAggregator({
      monotonicClock: monotonic,
      clock: { now: (): number => 1234 },
      refreshMs: 1_000,
      providerTimeoutMs: 1_000,
      onError: (error): void => {
        diagnostics.push(error instanceof Error ? error.message : String(error))
      },
    })
    aggregator.register(
      provider('official', ['context'], async (): Promise<Partial<TelemetrySnapshot>> => {
        started.push('official')
        await contextReady
        return { context: { used: 80, max: 'unknown', ratio: 'unknown' } }
      }),
    )
    aggregator.register(
      provider('broken', ['workspace'], (): Promise<Partial<TelemetrySnapshot>> => {
        started.push('broken')
        return Promise.reject(new Error('provider\noffline token=secret-value'))
      }),
    )
    aggregator.register(
      provider('fallback', ['context', 'model'], async (): Promise<Partial<TelemetrySnapshot>> => {
        started.push('fallback')
        await modelReady
        return {
          context: { used: 99, max: 100, ratio: 'unknown' },
          model: { name: 'deepseek-chat', thinkingDepth: 'high' },
        }
      }),
    )

    const pending = aggregator.envelope()
    await vi.waitFor((): void => expect(started).toEqual(['official', 'broken', 'fallback']))
    releaseContext?.()
    releaseModel?.()
    const envelope = await pending

    expect(envelope.snapshot).toMatchObject({
      context: { used: 80, max: 100, ratio: 0.8 },
      workspace: { name: 'unknown' },
      model: { name: 'deepseek-chat', thinkingDepth: 'high' },
      at: 1234,
    })
    expect(envelope.sources).toMatchObject({
      'context.used': 'official',
      'context.max': 'fallback',
      'context.ratio': 'official+fallback',
    })
    expect(envelope.failures).toEqual([
      { providerId: 'broken', message: 'Telemetry provider unavailable' },
    ])
    expect(diagnostics).toEqual([
      'Telemetry provider broken failed: provider offline token=[REDACTED]',
    ])
    expect(diagnostics.join(' ')).not.toContain('secret-value')
    expect(envelope.advisory).toMatchObject({ level: 'warn', compactionSuggested: false })
    expect(Object.isFrozen(envelope.snapshot.context)).toBe(true)
    expect(Object.isFrozen(envelope.failures)).toBe(true)
  })

  it('coalesces cached reads and emits a critical compaction suggestion on transition', async (): Promise<void> => {
    const monotonic = new ManualClock()
    let ratio = 0.5
    const sample = vi.fn((): Promise<Partial<TelemetrySnapshot>> =>
      Promise.resolve({ context: { used: ratio * 100, max: 100, ratio } }),
    )
    const aggregator = new DefaultTelemetryAggregator({
      monotonicClock: monotonic,
      refreshMs: 1_000,
      providerTimeoutMs: 100,
    })
    aggregator.register(provider('context', ['context'], sample))
    const advisories: string[] = []
    aggregator.subscribeAdvisory((advisory): void => void advisories.push(advisory.level))

    const first = await aggregator.snapshot()
    expect((await aggregator.snapshot()).at).toBe(first.at)
    expect(sample).toHaveBeenCalledTimes(1)
    ratio = 0.96
    monotonic.value = 1_001
    const critical = await aggregator.envelope()
    expect(critical.advisory).toEqual({
      level: 'critical',
      message: 'Context is critically full; M08 compaction is recommended',
      compactionSuggested: true,
    })
    expect(advisories).toEqual(['normal', 'critical'])
  })

  it('samples one requested session without replacing or publishing the cached HUD snapshot', async (): Promise<void> => {
    const monotonic = new ManualClock()
    const globalSample = vi.fn((): Promise<Partial<TelemetrySnapshot>> =>
      Promise.resolve({ workspace: { name: 'global-workspace' } }),
    )
    const sessionSample = vi.fn(
      (sessionId: ReturnType<typeof asSessionId>): Promise<Partial<TelemetrySnapshot>> =>
        Promise.resolve({ workspace: { name: `session:${sessionId}` } }),
    )
    const aggregator = new DefaultTelemetryAggregator({
      monotonicClock: monotonic,
      refreshMs: 1_000,
      providerTimeoutMs: 100,
    })
    aggregator.register({
      id: 'session-aware',
      capabilities: (): readonly ['workspace'] => ['workspace'],
      sample: globalSample,
      sampleForSession: sessionSample,
    })
    const published: TelemetrySnapshot[] = []
    aggregator.subscribe((snapshot): void => void published.push(snapshot))

    expect((await aggregator.snapshot()).workspace.name).toBe('global-workspace')
    const targeted = await aggregator.snapshotFor(asSessionId('target-session'))
    expect(targeted.workspace.name).toBe('session:target-session')
    expect((await aggregator.snapshot()).workspace.name).toBe('global-workspace')
    expect(globalSample).toHaveBeenCalledTimes(1)
    expect(sessionSample).toHaveBeenCalledExactlyOnceWith('target-session')
    expect(published).toHaveLength(1)
    expect(aggregator.history()).toHaveLength(1)
  })

  it('times out a hung provider without suppressing healthy fields', async (): Promise<void> => {
    const aggregator = new DefaultTelemetryAggregator({ refreshMs: 1_000, providerTimeoutMs: 10 })
    aggregator.register(
      provider(
        'hung',
        ['context'],
        (): Promise<Partial<TelemetrySnapshot>> =>
          new Promise((_resolve): void => {
            // Intentionally unresolved to verify bounded provider sampling.
          }),
      ),
    )
    aggregator.register(
      provider('workspace', ['workspace'], (): Promise<Partial<TelemetrySnapshot>> =>
        Promise.resolve({ workspace: { name: 'packages/hud' } }),
      ),
    )
    aggregator.register(
      provider('malformed', ['model'], (): Promise<Partial<TelemetrySnapshot>> =>
        Promise.resolve(null as unknown as Partial<TelemetrySnapshot>),
      ),
    )
    const envelope = await aggregator.envelope()
    expect(envelope.snapshot.workspace.name).toBe('packages/hud')
    expect(envelope.failures.map((failure): string => failure.providerId)).toEqual([
      'hung',
      'malformed',
    ])
  })

  it('contains provider rejection reasons that cannot be stringified', async (): Promise<void> => {
    const diagnostics: string[] = []
    const aggregator = new DefaultTelemetryAggregator({
      refreshMs: 1_000,
      providerTimeoutMs: 100,
      onError: (error): void => {
        diagnostics.push(error instanceof Error ? error.message : String(error))
      },
    })
    const hostileReason = {
      toString: (): never => {
        throw new Error('hostile rejection conversion')
      },
    }
    aggregator.register(
      provider('hostile', ['workspace'], (): Promise<Partial<TelemetrySnapshot>> =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- JS providers may reject any value.
        Promise.reject(hostileReason),
      ),
    )

    const envelope = await aggregator.envelope()
    expect(envelope.failures).toEqual([
      { providerId: 'hostile', message: 'Telemetry provider unavailable' },
    ])
    expect(diagnostics).toEqual(['Telemetry provider hostile failed: unknown error'])
  })

  it('discards an in-flight sample when the provider generation changes', async (): Promise<void> => {
    const monotonic = new ManualClock()
    let releaseOld: (() => void) | undefined
    const oldReady = new Promise<void>((resolve): void => {
      releaseOld = resolve
    })
    const aggregator = new DefaultTelemetryAggregator({
      monotonicClock: monotonic,
      refreshMs: 1_000,
      providerTimeoutMs: 1_000,
    })
    const unregisterOld = aggregator.register(
      provider('old', ['workspace'], async (): Promise<Partial<TelemetrySnapshot>> => {
        await oldReady
        return { workspace: { name: 'stale-workspace' } }
      }),
    )
    const pending = aggregator.envelope()
    unregisterOld()
    const freshSample = vi.fn((): Promise<Partial<TelemetrySnapshot>> =>
      Promise.resolve({ workspace: { name: 'fresh-workspace' } }),
    )
    aggregator.register(provider('fresh', ['workspace'], freshSample))
    releaseOld?.()

    const envelope = await pending
    expect(envelope.snapshot.workspace.name).toBe('fresh-workspace')
    expect(envelope.sources['workspace.name']).toBe('fresh')
    expect(freshSample).toHaveBeenCalledTimes(1)
  })

  it('restarts sampling when a failure callback changes providers during merge', async (): Promise<void> => {
    let unregisterBroken: () => void = (): void => undefined
    let changed = false
    const freshSample = vi.fn((): Promise<Partial<TelemetrySnapshot>> =>
      Promise.resolve({ workspace: { name: 'fresh-after-failure' } }),
    )
    const aggregator = new DefaultTelemetryAggregator({
      refreshMs: 1_000,
      providerTimeoutMs: 100,
      onError: (): void => {
        if (changed) return
        changed = true
        unregisterBroken()
        aggregator.register(provider('fresh', ['workspace'], freshSample))
      },
    })
    unregisterBroken = aggregator.register(
      provider('broken', ['workspace'], (): Promise<Partial<TelemetrySnapshot>> =>
        Promise.reject(new Error('offline')),
      ),
    )

    const envelope = await aggregator.envelope()
    expect(envelope.snapshot.workspace.name).toBe('fresh-after-failure')
    expect(envelope.sources['workspace.name']).toBe('fresh')
    expect(envelope.failures).toEqual([])
    expect(freshSample).toHaveBeenCalledTimes(1)
  })

  it('validates ordered thresholds and display fields', (): void => {
    expect(
      parseConfig({
        thresholds: { warn: 0.6, danger: 0.8, critical: 0.9 },
        display: { fields: ['context', 'rpm'], compact: true },
      }),
    ).toMatchObject({
      refreshSec: 1,
      thresholds: { warn: 0.6, danger: 0.8, critical: 0.9 },
      display: { fields: ['context', 'rpm'], compact: true },
    })
    expect((): unknown =>
      parseConfig({ thresholds: { warn: 0.9, danger: 0.8, critical: 0.95 } }),
    ).toThrow('warn < danger < critical')
    expect((): unknown => parseConfig({ display: { fields: ['fabricated'] } })).toThrow(
      'display.fields',
    )
    expect((): unknown => parseConfig({ refreshSec: 0.99 })).toThrow('between 1 and 60')
    expect(
      (): DefaultTelemetryAggregator => new DefaultTelemetryAggregator({ refreshMs: 999 }),
    ).toThrow('at least 1000 milliseconds')
    expect((): unknown => parseConfig({ history: { retainMinutes: 1_441 } })).toThrow(
      'between 1 and 1440',
    )
    expect(
      (): DefaultTelemetryAggregator =>
        new DefaultTelemetryAggregator({ historyRetentionMs: Number.POSITIVE_INFINITY }),
    ).toThrow('must be positive')
  })
})
