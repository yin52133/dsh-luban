import { describe, expect, it } from 'vitest'
import {
  HUD_RATE_EXPORT_SCHEMA,
  PROVIDER_RATE_EXPORT_SCHEMA,
  RATE_RECONCILIATION_SCHEMA,
  RATE_TOKEN_TOLERANCE,
  RateReconciliationError,
  reconcileRateExports,
  type ReconciledTokenUsage,
} from '../src/rate-reconcile.js'

const WINDOW = Object.freeze({
  startUtc: '2026-08-30T00:00:00.000Z',
  endUtc: '2026-08-30T00:01:00.000Z',
})

function usage(overrides: Partial<ReconciledTokenUsage> = {}): ReconciledTokenUsage {
  return {
    inputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
    unknownTokens: 0,
    ...overrides,
  }
}

function request(id: string, tokenUsage: unknown = usage(), requestCount = 1): unknown {
  return {
    id,
    occurredAt: '2026-08-30T00:00:30.000Z',
    requestCount,
    usage: tokenUsage,
  }
}

function exportsFor(
  options: {
    readonly hudRecords?: readonly unknown[]
    readonly providerRecords?: readonly unknown[]
    readonly hudOrigin?: 'live-hud-events' | 'fixture'
    readonly providerOrigin?: 'real-provider-export' | 'fixture'
    readonly providerWindow?: { readonly startUtc: string; readonly endUtc: string }
  } = {},
): readonly [unknown, unknown] {
  return [
    {
      schemaVersion: HUD_RATE_EXPORT_SCHEMA,
      source: {
        kind: 'hud-event-export',
        origin: options.hudOrigin ?? 'live-hud-events',
        exportedAt: '2026-08-30T00:02:00.000Z',
      },
      window: WINDOW,
      records: options.hudRecords ?? [request('request-1')],
    },
    {
      schemaVersion: PROVIDER_RATE_EXPORT_SCHEMA,
      source: {
        kind: 'provider-billing-export',
        origin: options.providerOrigin ?? 'real-provider-export',
        provider: 'provider-one',
        exportedAt: '2026-08-30T00:02:00.000Z',
      },
      window: options.providerWindow ?? WINDOW,
      records: options.providerRecords ?? [request('request-1')],
    },
  ]
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(RateReconciliationError)
    expect(error).toMatchObject({ code })
    return
  }
  throw new Error(`Expected ${code}`)
}

describe('M07 rate export reconciliation', (): void => {
  it('reconciles request count and every disjoint token category at the five-percent boundary', (): void => {
    const [hud, provider] = exportsFor({
      hudRecords: [request('request-1', usage({ inputTokens: 105 }))],
      providerRecords: [request('request-1', usage({ inputTokens: 100 }))],
    })

    const result = reconcileRateExports(hud, provider, { requireLiveOrigins: true })

    expect(result).toMatchObject({
      schemaVersion: RATE_RECONCILIATION_SCHEMA,
      status: 'pass',
      window: { ...WINDOW, durationMs: 60_000 },
      totals: {
        hud: {
          requestCount: 1,
          inputTokens: 105,
          outputTokens: 40,
          cacheReadTokens: 10,
          cacheWriteTokens: 0,
          unknownTokens: 0,
          totalTokens: 155,
        },
        provider: { totalTokens: 150 },
      },
      tolerance: { requestCountRelative: 0, tokenRelative: RATE_TOKEN_TOLERANCE },
    })
    expect(result.deltas.inputTokens).toEqual({
      hud: 105,
      provider: 100,
      absolute: 5,
      relative: 0.05,
      withinTolerance: true,
    })
  })

  it('rejects otherwise valid exports whose UTC windows drift', (): void => {
    const pair = exportsFor({
      providerWindow: {
        startUtc: '2026-08-30T00:00:01.000Z',
        endUtc: '2026-08-30T00:01:01.000Z',
      },
    })
    expectCode(() => reconcileRateExports(...pair), 'E_RATE_WINDOW_DRIFT')
  })

  it('rejects duplicate request IDs within either source', (): void => {
    const pair = exportsFor({
      hudRecords: [request('duplicate'), request('duplicate')],
      providerRecords: [request('duplicate')],
    })
    expectCode(() => reconcileRateExports(...pair), 'E_RATE_DUPLICATE_ID')
  })

  it('rejects an incomplete token basis instead of interpreting a missing category as zero', (): void => {
    const pair = exportsFor({
      hudRecords: [
        request('request-1', {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 10,
          unknownTokens: 0,
        }),
      ],
    })
    expectCode(() => reconcileRateExports(...pair), 'E_RATE_TOKEN_BASIS')

    const reasoningDoubleCount = exportsFor({
      hudRecords: [request('request-1', { ...usage(), reasoningTokens: 20 })],
    })
    expectCode(() => reconcileRateExports(...reasoningDoubleCount), 'E_RATE_TOKEN_BASIS')
  })

  it('rejects nonzero unknown tokens even when both sources agree', (): void => {
    const pair = exportsFor({
      hudRecords: [request('request-1', usage({ unknownTokens: 3 }))],
      providerRecords: [request('request-1', usage({ unknownTokens: 3 }))],
    })
    expectCode(() => reconcileRateExports(...pair), 'E_RATE_UNKNOWN_TOKENS')
  })

  it('rejects token category error above five percent', (): void => {
    const pair = exportsFor({
      hudRecords: [request('request-1', usage({ outputTokens: 43 }))],
      providerRecords: [request('request-1', usage({ outputTokens: 40 }))],
    })
    expectCode(() => reconcileRateExports(...pair), 'E_RATE_TOLERANCE')
  })

  it('requires exact request IDs and request counts', (): void => {
    const idMismatch = exportsFor({
      hudRecords: [request('hud-request')],
      providerRecords: [request('provider-request')],
    })
    expectCode(() => reconcileRateExports(...idMismatch), 'E_RATE_REQUEST_IDS')

    const countMismatch = exportsFor({
      hudRecords: [request('request-1', usage(), 2)],
      providerRecords: [request('request-1', usage(), 1)],
    })
    expectCode(() => reconcileRateExports(...countMismatch), 'E_RATE_REQUEST_COUNT')
  })

  it('does not allow fixture provenance to satisfy a live reconciliation', (): void => {
    const fixtureHud = exportsFor({ hudOrigin: 'fixture' })
    expectCode(
      () => reconcileRateExports(...fixtureHud, { requireLiveOrigins: true }),
      'E_RATE_LIVE_SOURCE',
    )
    const fixtureProvider = exportsFor({ providerOrigin: 'fixture' })
    expectCode(
      () => reconcileRateExports(...fixtureProvider, { requireLiveOrigins: true }),
      'E_RATE_LIVE_SOURCE',
    )
  })
})
