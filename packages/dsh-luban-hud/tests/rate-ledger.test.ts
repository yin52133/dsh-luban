import { createHash } from 'node:crypto'
import { createAssistantMessage, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProviderRequestIdentityAdapter, ProviderRequestIdentityQuery } from 'dsh-luban-core'
import { describe, expect, it } from 'vitest'
import { HUD_RATE_CAPTURE_SCHEMA, HudRateLedger } from '../src/rate-ledger.js'
import { HUD_RATE_EXPORT_SCHEMA } from '../src/rate-reconcile.js'
import { HUD_RUNTIME_ARTIFACT_FIXTURE } from './runtime-artifact-fixture.js'

const START = Date.parse('2026-08-30T12:00:00.000Z')
const NOW = Date.parse('2026-08-30T12:05:00.000Z')
const FIVE_MINUTE_WINDOW = {
  startUtc: '2026-08-30T12:00:00.000Z',
  endUtc: '2026-08-30T12:05:00.000Z',
} as const
const ONE_MINUTE_WINDOW = {
  startUtc: '2026-08-30T12:04:00.000Z',
  endUtc: '2026-08-30T12:05:00.000Z',
} as const
const CHALLENGE = 'capture_challenge_0123456789abcdef'

class ManualLedgerClock {
  public wall: number
  public monotonic = 0
  public readonly epoch = { now: (): number => this.wall }
  public readonly elapsed = { now: (): number => this.monotonic }

  public constructor(wall: number) {
    this.wall = wall
  }

  public advance(milliseconds: number): void {
    this.wall += milliseconds
    this.monotonic += milliseconds
  }
}

function providerRequestAttestation(
  query: ProviderRequestIdentityQuery,
  providerRequestId: string,
): unknown {
  return {
    schemaVersion: 'dsh-luban/provider-request-identity/v1',
    adapter: {
      id: 'hud-provider-wire-test',
      version: '1.0.0',
      runtimeSha256: 'a'.repeat(64),
    },
    binding: {
      sessionId: query.sessionId,
      assistantEventSeq: query.assistantEventSeq,
      turn: query.turn,
      step: query.step,
      assistantMessageId: query.assistantMessageId,
      provider: query.provider,
      model: query.model,
      challengeSha256: createHash('sha256').update(query.challenge).digest('hex'),
    },
    providerRequestId,
  }
}

function providerRequestAdapter(
  requestId: (query: ProviderRequestIdentityQuery) => string = (query): string =>
    `provider-request-${String(query.assistantEventSeq)}`,
): ProviderRequestIdentityAdapter {
  return {
    attest(query): Promise<unknown> {
      return Promise.resolve(providerRequestAttestation(query, requestId(query)))
    },
  }
}

function ledger(
  clock: ManualLedgerClock,
  maxRecords?: number,
  adapter: ProviderRequestIdentityAdapter | null = providerRequestAdapter(),
): HudRateLedger {
  return new HudRateLedger({
    runtimeArtifact: HUD_RUNTIME_ARTIFACT_FIXTURE,
    clock: clock.epoch,
    monotonicClock: clock.elapsed,
    ...(maxRecords === undefined ? {} : { maxRecords }),
    ...(adapter === null
      ? {}
      : { resolveProviderRequestIdentity: (): ProviderRequestIdentityAdapter => adapter }),
  })
}

function session(id = 'hud-rate-session'): Session {
  return { id: SessionId(id) } as Session
}

function assistantEvent(options: {
  readonly seq: number
  readonly time: number
  readonly usage?: TokenUsage
  readonly provider?: string
  readonly model?: string
  readonly replayState?: unknown
}): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: options.seq,
    time: options.time,
    data: {
      turn: options.seq,
      step: options.seq,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'measured response' }],
        source: {
          provider: options.provider ?? 'deepseek',
          model: options.model ?? 'deepseek-chat',
          ...(options.replayState === undefined ? {} : { replayState: options.replayState }),
        },
      }),
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    },
    surfaceOp: 'append',
  }
}

describe('mounted HUD rate ledger', (): void => {
  it('captures durable assistant usage in exact complete half-open UTC windows once', async () => {
    const clock = new ManualLedgerClock(START)
    const rateLedger = ledger(clock)
    const value = session()
    const atStart = assistantEvent({
      seq: 0,
      time: START,
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
      },
      replayState: { privateNonce: 'never-export-this-secret' },
    })
    rateLedger.observe(value, atStart)

    clock.advance(299_999)
    const inside = assistantEvent({
      seq: 1,
      time: clock.wall,
      usage: { inputTokens: 40, outputTokens: 10 },
      provider: 'deepseek',
      model: 'deepseek-chat',
    })
    rateLedger.observe(value, inside)
    rateLedger.observe(value, inside)

    clock.advance(1)
    const atEnd = assistantEvent({
      seq: 2,
      time: NOW,
      usage: { inputTokens: 999, outputTokens: 999 },
    })
    const beforeStart = assistantEvent({
      seq: 3,
      time: START - 1,
      usage: { inputTokens: 999, outputTokens: 999 },
    })
    rateLedger.observe(value, atEnd)
    rateLedger.observe(value, beforeStart)

    const capture = await rateLedger.capture(FIVE_MINUTE_WINDOW, CHALLENGE)
    expect(capture).toMatchObject({
      schemaVersion: HUD_RATE_CAPTURE_SCHEMA,
      source: {
        kind: 'mounted-hud-capture',
        exportedAt: '2026-08-30T12:05:00.000Z',
        coverageStartUtc: FIVE_MINUTE_WINDOW.startUtc,
        processId: process.pid,
        nodeVersion: process.version,
        runtimeArtifact: HUD_RUNTIME_ARTIFACT_FIXTURE,
      },
      export: {
        schemaVersion: HUD_RATE_EXPORT_SCHEMA,
        source: { kind: 'hud-event-export', origin: 'live-hud-events' },
        window: FIVE_MINUTE_WINDOW,
      },
    })
    expect(capture.source.challengeSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(capture.export.records).toHaveLength(2)
    expect(capture.export.records.map(({ id }) => id)).toEqual([
      'provider-request-0',
      'provider-request-1',
    ])
    expect(capture.export.records[0]?.usage).toEqual({
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      unknownTokens: 0,
    })
    expect(capture.captures).toMatchObject([
      {
        sessionId: 'hud-rate-session',
        eventSeq: 0,
        turn: 0,
        step: 0,
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
      {
        sessionId: 'hud-rate-session',
        eventSeq: 1,
        turn: 1,
        step: 1,
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    ])
    expect(capture.captures[0]?.providerRequest).toMatchObject({
      adapter: { id: 'hud-provider-wire-test', version: '1.0.0' },
      binding: { turn: 0, step: 0, provider: 'deepseek', model: 'deepseek-chat' },
    })
    expect(capture.captures[0]).not.toHaveProperty('replayStateSha256')
    expect(JSON.stringify(capture)).not.toContain('never-export-this-secret')
    expect(JSON.stringify(capture)).not.toContain(CHALLENGE)
  })

  it('deduplicates forked history globally and fails closed on identity conflicts', async () => {
    const clock = new ManualLedgerClock(Date.parse(ONE_MINUTE_WINDOW.startUtc))
    const rateLedger = ledger(clock)
    clock.advance(30_000)
    const shared = assistantEvent({
      seq: 4,
      time: clock.wall,
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    rateLedger.observe(session('parent-session'), shared)
    rateLedger.observe(session('forked-session'), shared)
    clock.advance(30_000)

    expect((await rateLedger.capture(ONE_MINUTE_WINDOW, CHALLENGE)).export.records).toHaveLength(1)

    const conflict = {
      ...shared,
      data: { ...shared.data, usage: { inputTokens: 11, outputTokens: 5 } },
    } as SessionEvent<'assistant/message'>
    rateLedger.observe(session('conflicting-session'), conflict)
    await expect(rateLedger.capture(ONE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'conflicting message identity',
    )
  })

  it('retains a complete five-minute window for one minute after it ends', async () => {
    const clock = new ManualLedgerClock(START)
    const rateLedger = ledger(clock)
    rateLedger.observe(
      session(),
      assistantEvent({ seq: 0, time: START, usage: { inputTokens: 10, outputTokens: 5 } }),
    )
    clock.advance(360_000)

    const capture = await rateLedger.capture(FIVE_MINUTE_WINDOW, CHALLENGE)
    expect(capture).toMatchObject({
      source: {
        coverageStartUtc: FIVE_MINUTE_WINDOW.startUtc,
        runtimeArtifact: HUD_RUNTIME_ARTIFACT_FIXTURE,
      },
    })
    expect(capture.export.records).toHaveLength(1)
  })

  it('fails reconciliation closed when durable usage is absent or malformed', async () => {
    const clock = new ManualLedgerClock(Date.parse(ONE_MINUTE_WINDOW.startUtc))
    const rateLedger = ledger(clock)
    clock.advance(30_000)
    rateLedger.observe(session('hud-rate-unknown'), assistantEvent({ seq: 0, time: clock.wall }))
    clock.advance(10_000)
    rateLedger.observe(
      session('hud-rate-unknown'),
      assistantEvent({
        seq: 1,
        time: clock.wall,
        usage: { inputTokens: -1, outputTokens: 1 },
      }),
    )
    clock.advance(20_000)

    const capture = await rateLedger.capture(ONE_MINUTE_WINDOW, CHALLENGE)
    expect(capture.export.records).toHaveLength(2)
    expect(capture.export.records.every(({ usage }) => usage.unknownTokens === 1)).toBe(true)
  })

  it('requires exact provider bindings and unique provider request ids', async () => {
    const missingClock = new ManualLedgerClock(Date.parse(ONE_MINUTE_WINDOW.startUtc))
    const missingAdapter = ledger(missingClock, undefined, null)
    missingClock.advance(30_000)
    missingAdapter.observe(
      session(),
      assistantEvent({
        seq: 0,
        time: missingClock.wall,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    )
    missingClock.advance(30_000)
    await expect(missingAdapter.capture(ONE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'adapter is unavailable',
    )

    const mismatchClock = new ManualLedgerClock(Date.parse(ONE_MINUTE_WINDOW.startUtc))
    const mismatchedAdapter: ProviderRequestIdentityAdapter = {
      attest(query): Promise<unknown> {
        const value = providerRequestAttestation(query, 'provider-request-mismatch') as {
          readonly binding: Readonly<Record<string, unknown>>
        }
        return Promise.resolve({ ...value, binding: { ...value.binding, step: query.step + 1 } })
      },
    }
    const mismatched = ledger(mismatchClock, undefined, mismatchedAdapter)
    mismatchClock.advance(30_000)
    mismatched.observe(
      session(),
      assistantEvent({
        seq: 0,
        time: mismatchClock.wall,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    )
    mismatchClock.advance(30_000)
    await expect(mismatched.capture(ONE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'attestation is invalid',
    )

    const duplicateClock = new ManualLedgerClock(Date.parse(ONE_MINUTE_WINDOW.startUtc))
    const duplicate = ledger(
      duplicateClock,
      undefined,
      providerRequestAdapter((): string => 'provider-request-duplicate'),
    )
    for (let sequence = 0; sequence < 2; sequence += 1) {
      duplicateClock.advance(20_000)
      duplicate.observe(
        session(),
        assistantEvent({
          seq: sequence,
          time: duplicateClock.wall,
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      )
    }
    duplicateClock.advance(20_000)
    await expect(duplicate.capture(ONE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'duplicated within the rate window',
    )
  })

  it('rejects ledger drift while provider identities are being attested', async () => {
    const clock = new ManualLedgerClock(Date.parse(ONE_MINUTE_WINDOW.startUtc))
    let release: (() => void) | undefined
    const delayedAdapter: ProviderRequestIdentityAdapter = {
      attest(query): Promise<unknown> {
        return new Promise<unknown>((resolve): void => {
          release = (): void => {
            resolve(providerRequestAttestation(query, 'provider-request-delayed'))
          }
        })
      },
    }
    const rateLedger = ledger(clock, undefined, delayedAdapter)
    clock.advance(30_000)
    rateLedger.observe(
      session(),
      assistantEvent({
        seq: 0,
        time: clock.wall,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    )
    clock.advance(30_000)

    const pending = rateLedger.capture(ONE_MINUTE_WINDOW, CHALLENGE)
    await Promise.resolve()
    rateLedger.observe(
      session(),
      assistantEvent({
        seq: 1,
        time: clock.wall,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    )
    if (release === undefined) throw new Error('delayed adapter was not invoked')
    release()

    await expect(pending).rejects.toThrow('changed during provider request identity attestation')
  })

  it('rejects response identities that cannot be passed exactly to an adapter', async () => {
    const clock = new ManualLedgerClock(Date.parse(ONE_MINUTE_WINDOW.startUtc))
    const rateLedger = ledger(clock)
    clock.advance(30_000)
    rateLedger.observe(
      session(),
      assistantEvent({
        seq: 0,
        time: clock.wall,
        usage: { inputTokens: 1, outputTokens: 1 },
        provider: 'unsafe\nprovider',
      }),
    )
    clock.advance(30_000)

    await expect(rateLedger.capture(ONE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'coverage is unavailable',
    )
  })

  it('rejects startup gaps, retention gaps, capacity eviction, and clock discontinuity', async () => {
    const startupClock = new ManualLedgerClock(Date.parse('2026-08-30T12:04:30.000Z'))
    const startupLedger = ledger(startupClock)
    startupClock.advance(30_000)
    startupLedger.observe(
      session(),
      assistantEvent({
        seq: 0,
        time: startupClock.wall,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    )
    await expect(startupLedger.capture(ONE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'outside complete mounted coverage',
    )

    const retentionClock = new ManualLedgerClock(START)
    const retentionLedger = ledger(retentionClock)
    retentionLedger.observe(
      session(),
      assistantEvent({ seq: 0, time: START, usage: { inputTokens: 1, outputTokens: 1 } }),
    )
    retentionClock.advance(900_001)
    await expect(retentionLedger.capture(FIVE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'outside complete mounted coverage',
    )

    const capacityClock = new ManualLedgerClock(Date.parse(ONE_MINUTE_WINDOW.startUtc))
    const capacityLedger = ledger(capacityClock, 2)
    for (let sequence = 0; sequence < 3; sequence += 1) {
      capacityClock.advance(10_000)
      capacityLedger.observe(
        session(),
        assistantEvent({
          seq: sequence,
          time: capacityClock.wall,
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      )
    }
    capacityClock.advance(30_000)
    await expect(capacityLedger.capture(ONE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'outside complete mounted coverage',
    )

    const driftClock = new ManualLedgerClock(Date.parse(ONE_MINUTE_WINDOW.startUtc))
    const driftLedger = ledger(driftClock)
    driftClock.wall += 60_000
    await expect(driftLedger.capture(ONE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'coverage is unavailable',
    )
  })

  it('rejects invalid windows, challenges, clocks, empty captures, and invalid event dates', async () => {
    const clock = new ManualLedgerClock(START)
    const rateLedger = ledger(clock)
    await expect(rateLedger.capture(FIVE_MINUTE_WINDOW, 'too-short')).rejects.toThrow(
      'challenge is invalid',
    )
    await expect(
      rateLedger.capture(
        {
          startUtc: '2026-08-30T12:03:00.000Z',
          endUtc: FIVE_MINUTE_WINDOW.endUtc,
        },
        CHALLENGE,
      ),
    ).rejects.toThrow('exactly one or five minutes')
    await expect(
      rateLedger.capture(
        {
          startUtc: '2026-08-30T12:04:02.000Z',
          endUtc: '2026-08-30T12:05:02.000Z',
        },
        CHALLENGE,
      ),
    ).rejects.toThrow('cannot end in the future')

    const invalidDate = assistantEvent({
      seq: 0,
      time: Number.MAX_SAFE_INTEGER,
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    expect((): void => rateLedger.observe(session(), invalidDate)).not.toThrow()
    clock.advance(300_000)
    await expect(rateLedger.capture(FIVE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'coverage is unavailable',
    )

    const emptyClock = new ManualLedgerClock(START)
    const emptyLedger = ledger(emptyClock)
    emptyClock.advance(300_000)
    await expect(emptyLedger.capture(FIVE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'contains no assistant requests',
    )

    const invalidClock = new HudRateLedger({
      runtimeArtifact: HUD_RUNTIME_ARTIFACT_FIXTURE,
      clock: { now: (): number => Number.NaN },
      monotonicClock: { now: (): number => 0 },
    })
    await expect(invalidClock.capture(FIVE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'coverage is unavailable',
    )
    const outOfRangeClock = new HudRateLedger({
      runtimeArtifact: HUD_RUNTIME_ARTIFACT_FIXTURE,
      clock: { now: (): number => Number.MAX_SAFE_INTEGER },
      monotonicClock: { now: (): number => 0 },
    })
    await expect(outOfRangeClock.capture(FIVE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'coverage is unavailable',
    )

    const invalidSequenceClock = new ManualLedgerClock(Date.parse(ONE_MINUTE_WINDOW.startUtc))
    const invalidSequenceLedger = ledger(invalidSequenceClock)
    invalidSequenceClock.advance(30_000)
    invalidSequenceLedger.observe(
      session(),
      assistantEvent({
        seq: -1,
        time: invalidSequenceClock.wall,
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    )
    invalidSequenceClock.advance(30_000)
    await expect(invalidSequenceLedger.capture(ONE_MINUTE_WINDOW, CHALLENGE)).rejects.toThrow(
      'coverage is unavailable',
    )
  })
})
