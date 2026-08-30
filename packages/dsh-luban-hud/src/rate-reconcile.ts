export const HUD_RATE_EXPORT_SCHEMA = 'dsh-luban/m07-hud-rate-export/v1' as const
export const PROVIDER_RATE_EXPORT_SCHEMA = 'dsh-luban/m07-provider-rate-export/v1' as const
export const RATE_RECONCILIATION_SCHEMA = 'dsh-luban/m07-rate-reconciliation/v1' as const
export const RATE_TOKEN_TOLERANCE = 0.05 as const

const MAX_RECORDS = 100_000
const ONE_MINUTE_MS = 60_000
const FIVE_MINUTES_MS = 300_000
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

export type HudRateOrigin = 'live-hud-events' | 'fixture'
export type ProviderRateOrigin = 'real-provider-export' | 'fixture'

export interface RateWindowUtc {
  readonly startUtc: string
  readonly endUtc: string
}

export interface ReconciledTokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly unknownTokens: number
}

export interface RateLedgerRecord {
  readonly id: string
  readonly occurredAt: string
  readonly requestCount: number
  readonly usage: ReconciledTokenUsage
}

export interface HudRateExport {
  readonly schemaVersion: typeof HUD_RATE_EXPORT_SCHEMA
  readonly source: {
    readonly kind: 'hud-event-export'
    readonly origin: HudRateOrigin
    readonly exportedAt: string
  }
  readonly window: RateWindowUtc
  readonly records: readonly RateLedgerRecord[]
}

export interface ProviderRateExport {
  readonly schemaVersion: typeof PROVIDER_RATE_EXPORT_SCHEMA
  readonly source: {
    readonly kind: 'provider-billing-export'
    readonly origin: ProviderRateOrigin
    readonly provider: string
    readonly exportedAt: string
  }
  readonly window: RateWindowUtc
  readonly records: readonly RateLedgerRecord[]
}

export interface RateTotals extends ReconciledTokenUsage {
  readonly requestCount: number
  readonly totalTokens: number
}

export interface RateMetricDelta {
  readonly hud: number
  readonly provider: number
  readonly absolute: number
  readonly relative: number
  readonly withinTolerance: boolean
}

export interface RateReconciliation {
  readonly schemaVersion: typeof RATE_RECONCILIATION_SCHEMA
  readonly status: 'pass'
  readonly window: RateWindowUtc & { readonly durationMs: 60_000 | 300_000 }
  readonly sources: {
    readonly hud: { readonly origin: HudRateOrigin; readonly recordCount: number }
    readonly provider: {
      readonly origin: ProviderRateOrigin
      readonly provider: string
      readonly recordCount: number
    }
  }
  readonly totals: { readonly hud: RateTotals; readonly provider: RateTotals }
  readonly deltas: {
    readonly requestCount: RateMetricDelta
    readonly inputTokens: RateMetricDelta
    readonly outputTokens: RateMetricDelta
    readonly cacheReadTokens: RateMetricDelta
    readonly cacheWriteTokens: RateMetricDelta
    readonly unknownTokens: RateMetricDelta
    readonly totalTokens: RateMetricDelta
  }
  readonly tolerance: {
    readonly requestCountRelative: 0
    readonly tokenRelative: typeof RATE_TOKEN_TOLERANCE
  }
}

export class RateReconciliationError extends Error {
  public readonly code: string

  public constructor(code: string, message: string) {
    super(message)
    this.name = 'RateReconciliationError'
    this.code = code
  }
}

/** Reconcile independent HUD events and provider billing/token rows over one exact UTC window. */
export function reconcileRateExports(
  hudValue: unknown,
  providerValue: unknown,
  options: { readonly requireLiveOrigins?: boolean } = {},
): RateReconciliation {
  const hud = parseHudRateExport(hudValue)
  const provider = parseProviderRateExport(providerValue)
  if (
    hud.window.startUtc !== provider.window.startUtc ||
    hud.window.endUtc !== provider.window.endUtc
  ) {
    throw new RateReconciliationError(
      'E_RATE_WINDOW_DRIFT',
      'HUD and provider exports must use the same exact UTC window',
    )
  }
  if (
    options.requireLiveOrigins === true &&
    (hud.source.origin !== 'live-hud-events' || provider.source.origin !== 'real-provider-export')
  ) {
    throw new RateReconciliationError(
      'E_RATE_LIVE_SOURCE',
      'Live reconciliation requires live HUD events and a real provider export',
    )
  }

  const providerById = new Map(
    provider.records.map((record): readonly [string, RateLedgerRecord] => [record.id, record]),
  )
  for (const hudRecord of hud.records) {
    const providerRecord = providerById.get(hudRecord.id)
    if (providerRecord === undefined) {
      throw new RateReconciliationError(
        'E_RATE_REQUEST_IDS',
        'HUD and provider exports do not contain the same request IDs',
      )
    }
    if (hudRecord.requestCount !== providerRecord.requestCount) {
      throw new RateReconciliationError(
        'E_RATE_REQUEST_COUNT',
        'Request counts must match exactly for every reconciled request ID',
      )
    }
    if (!recordUsageWithinTolerance(hudRecord.usage, providerRecord.usage)) {
      throw new RateReconciliationError(
        'E_RATE_RECORD_TOLERANCE',
        'Every request ID must reconcile each token category within five percent',
      )
    }
    providerById.delete(hudRecord.id)
  }
  if (providerById.size !== 0) {
    throw new RateReconciliationError(
      'E_RATE_REQUEST_IDS',
      'HUD and provider exports do not contain the same request IDs',
    )
  }

  const hudTotals = sumRecords(hud.records)
  const providerTotals = sumRecords(provider.records)
  if (hudTotals.unknownTokens !== 0 || providerTotals.unknownTokens !== 0) {
    throw new RateReconciliationError(
      'E_RATE_UNKNOWN_TOKENS',
      'Unknown tokens make the reconciliation basis incomplete',
    )
  }
  const deltas = Object.freeze({
    requestCount: metricDelta(hudTotals.requestCount, providerTotals.requestCount, 0),
    inputTokens: metricDelta(
      hudTotals.inputTokens,
      providerTotals.inputTokens,
      RATE_TOKEN_TOLERANCE,
    ),
    outputTokens: metricDelta(
      hudTotals.outputTokens,
      providerTotals.outputTokens,
      RATE_TOKEN_TOLERANCE,
    ),
    cacheReadTokens: metricDelta(
      hudTotals.cacheReadTokens,
      providerTotals.cacheReadTokens,
      RATE_TOKEN_TOLERANCE,
    ),
    cacheWriteTokens: metricDelta(
      hudTotals.cacheWriteTokens,
      providerTotals.cacheWriteTokens,
      RATE_TOKEN_TOLERANCE,
    ),
    unknownTokens: metricDelta(hudTotals.unknownTokens, providerTotals.unknownTokens, 0),
    totalTokens: metricDelta(
      hudTotals.totalTokens,
      providerTotals.totalTokens,
      RATE_TOKEN_TOLERANCE,
    ),
  })
  if (!Object.values(deltas).every((delta): boolean => delta.withinTolerance)) {
    throw new RateReconciliationError(
      'E_RATE_TOLERANCE',
      'HUD and provider token totals exceed the allowed five-percent error',
    )
  }

  const durationMs = windowDuration(hud.window)
  return Object.freeze({
    schemaVersion: RATE_RECONCILIATION_SCHEMA,
    status: 'pass',
    window: Object.freeze({ ...hud.window, durationMs }),
    sources: Object.freeze({
      hud: Object.freeze({ origin: hud.source.origin, recordCount: hud.records.length }),
      provider: Object.freeze({
        origin: provider.source.origin,
        provider: provider.source.provider,
        recordCount: provider.records.length,
      }),
    }),
    totals: Object.freeze({ hud: hudTotals, provider: providerTotals }),
    deltas,
    tolerance: Object.freeze({ requestCountRelative: 0, tokenRelative: RATE_TOKEN_TOLERANCE }),
  })
}

function parseHudRateExport(value: unknown): HudRateExport {
  const record = exportRecord(value, HUD_RATE_EXPORT_SCHEMA)
  const source = record.source
  if (
    !hasExactKeys(source, ['exportedAt', 'kind', 'origin']) ||
    source.kind !== 'hud-event-export' ||
    (source.origin !== 'live-hud-events' && source.origin !== 'fixture') ||
    !isCanonicalUtc(source.exportedAt)
  ) {
    invalid('HUD export source metadata is invalid')
  }
  const window = parseWindow(record.window)
  if (Date.parse(source.exportedAt) < Date.parse(window.endUtc)) {
    invalid('HUD export timestamp precedes its reconciliation window')
  }
  return Object.freeze({
    schemaVersion: HUD_RATE_EXPORT_SCHEMA,
    source: Object.freeze({
      kind: 'hud-event-export',
      origin: source.origin,
      exportedAt: source.exportedAt,
    }),
    window,
    records: parseRecords(record.records, window, 'HUD'),
  })
}

function parseProviderRateExport(value: unknown): ProviderRateExport {
  const record = exportRecord(value, PROVIDER_RATE_EXPORT_SCHEMA)
  const source = record.source
  if (
    !hasExactKeys(source, ['exportedAt', 'kind', 'origin', 'provider']) ||
    source.kind !== 'provider-billing-export' ||
    (source.origin !== 'real-provider-export' && source.origin !== 'fixture') ||
    typeof source.provider !== 'string' ||
    !PROVIDER_ID.test(source.provider) ||
    !isCanonicalUtc(source.exportedAt)
  ) {
    invalid('Provider export source metadata is invalid')
  }
  const window = parseWindow(record.window)
  if (Date.parse(source.exportedAt) < Date.parse(window.endUtc)) {
    invalid('Provider export timestamp precedes its reconciliation window')
  }
  return Object.freeze({
    schemaVersion: PROVIDER_RATE_EXPORT_SCHEMA,
    source: Object.freeze({
      kind: 'provider-billing-export',
      origin: source.origin,
      provider: source.provider,
      exportedAt: source.exportedAt,
    }),
    window,
    records: parseRecords(record.records, window, 'provider'),
  })
}

function exportRecord(
  value: unknown,
  schemaVersion: typeof HUD_RATE_EXPORT_SCHEMA | typeof PROVIDER_RATE_EXPORT_SCHEMA,
): Record<string, unknown> {
  if (
    !hasExactKeys(value, ['records', 'schemaVersion', 'source', 'window']) ||
    value.schemaVersion !== schemaVersion
  ) {
    invalid('Rate export schema is invalid')
  }
  return value
}

function parseWindow(value: unknown): RateWindowUtc {
  if (
    !hasExactKeys(value, ['endUtc', 'startUtc']) ||
    !isCanonicalUtc(value.startUtc) ||
    !isCanonicalUtc(value.endUtc)
  ) {
    invalid('Rate export window must contain canonical UTC timestamps')
  }
  const window = Object.freeze({ startUtc: value.startUtc, endUtc: value.endUtc })
  windowDuration(window)
  return window
}

function windowDuration(window: RateWindowUtc): 60_000 | 300_000 {
  const duration = Date.parse(window.endUtc) - Date.parse(window.startUtc)
  if (duration !== ONE_MINUTE_MS && duration !== FIVE_MINUTES_MS) {
    throw new RateReconciliationError(
      'E_RATE_WINDOW',
      'Rate export window must be exactly one or five minutes',
    )
  }
  return duration
}

function parseRecords(
  value: unknown,
  window: RateWindowUtc,
  label: string,
): readonly RateLedgerRecord[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RECORDS) {
    invalid(`${label} export must contain a bounded, non-empty record array`)
  }
  const start = Date.parse(window.startUtc)
  const end = Date.parse(window.endUtc)
  const ids = new Set<string>()
  return Object.freeze(
    value.map((item): RateLedgerRecord => {
      if (
        !hasExactKeys(item, ['id', 'occurredAt', 'requestCount', 'usage']) ||
        typeof item.id !== 'string' ||
        !IDENTIFIER.test(item.id) ||
        !isCanonicalUtc(item.occurredAt) ||
        !isPositiveSafeInteger(item.requestCount)
      ) {
        invalid(`${label} export contains an invalid request record`)
      }
      const occurredAt = Date.parse(item.occurredAt)
      if (occurredAt < start || occurredAt >= end) {
        throw new RateReconciliationError(
          'E_RATE_RECORD_WINDOW',
          `${label} export contains a request outside the declared UTC window`,
        )
      }
      if (ids.has(item.id)) {
        throw new RateReconciliationError(
          'E_RATE_DUPLICATE_ID',
          `${label} export contains a duplicate request ID`,
        )
      }
      ids.add(item.id)
      return Object.freeze({
        id: item.id,
        occurredAt: item.occurredAt,
        requestCount: item.requestCount,
        usage: parseUsage(item.usage, label),
      })
    }),
  )
}

function parseUsage(value: unknown, label: string): ReconciledTokenUsage {
  const fields = [
    'cacheReadTokens',
    'cacheWriteTokens',
    'inputTokens',
    'outputTokens',
    'unknownTokens',
  ] as const
  if (!hasExactKeys(value, [...fields])) {
    throw new RateReconciliationError(
      'E_RATE_TOKEN_BASIS',
      `${label} export token basis is incomplete`,
    )
  }
  return Object.freeze({
    inputTokens: tokenField(value, 'inputTokens', label),
    outputTokens: tokenField(value, 'outputTokens', label),
    cacheReadTokens: tokenField(value, 'cacheReadTokens', label),
    cacheWriteTokens: tokenField(value, 'cacheWriteTokens', label),
    unknownTokens: tokenField(value, 'unknownTokens', label),
  })
}

function tokenField(
  value: Record<string, unknown>,
  field: keyof ReconciledTokenUsage,
  label: string,
): number {
  const tokenCount = value[field]
  if (!isNonNegativeSafeInteger(tokenCount)) {
    throw new RateReconciliationError(
      'E_RATE_TOKEN_BASIS',
      `${label} export token basis contains an invalid ${field}`,
    )
  }
  return tokenCount
}

function sumRecords(records: readonly RateLedgerRecord[]): RateTotals {
  const totals = {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unknownTokens: 0,
  }
  for (const record of records) {
    totals.requestCount = safeSum(totals.requestCount, record.requestCount)
    totals.inputTokens = safeSum(totals.inputTokens, record.usage.inputTokens)
    totals.outputTokens = safeSum(totals.outputTokens, record.usage.outputTokens)
    totals.cacheReadTokens = safeSum(totals.cacheReadTokens, record.usage.cacheReadTokens)
    totals.cacheWriteTokens = safeSum(totals.cacheWriteTokens, record.usage.cacheWriteTokens)
    totals.unknownTokens = safeSum(totals.unknownTokens, record.usage.unknownTokens)
  }
  const totalTokens = [
    totals.inputTokens,
    totals.outputTokens,
    totals.cacheReadTokens,
    totals.cacheWriteTokens,
    totals.unknownTokens,
  ].reduce((sum, value): number => safeSum(sum, value), 0)
  return Object.freeze({ ...totals, totalTokens })
}

function metricDelta(hud: number, provider: number, tolerance: number): RateMetricDelta {
  const absolute = Math.abs(hud - provider)
  const relative = provider === 0 ? (hud === 0 ? 0 : 1) : absolute / provider
  return Object.freeze({
    hud,
    provider,
    absolute,
    relative,
    withinTolerance: relative <= tolerance,
  })
}

function recordUsageWithinTolerance(
  hud: ReconciledTokenUsage,
  provider: ReconciledTokenUsage,
): boolean {
  const fields = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'unknownTokens',
  ] as const
  if (
    !fields.every(
      (field): boolean =>
        metricDelta(
          hud[field],
          provider[field],
          field === 'unknownTokens' ? 0 : RATE_TOKEN_TOLERANCE,
        ).withinTolerance,
    )
  ) {
    return false
  }
  const hudTotal = fields.reduce((sum, field): number => safeSum(sum, hud[field]), 0)
  const providerTotal = fields.reduce((sum, field): number => safeSum(sum, provider[field]), 0)
  return metricDelta(hudTotal, providerTotal, RATE_TOKEN_TOLERANCE).withinTolerance
}

function safeSum(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total)) {
    throw new RateReconciliationError(
      'E_RATE_TOKEN_BASIS',
      'Rate export totals exceed the supported safe-integer range',
    )
  }
  return total
}

function isCanonicalUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index): boolean => key === sortedExpected[index])
  )
}

function invalid(message: string): never {
  throw new RateReconciliationError('E_RATE_SCHEMA', message)
}
