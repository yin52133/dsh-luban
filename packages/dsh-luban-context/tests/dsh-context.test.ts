import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { Clock, SessionRef, TelemetryAggregator, TelemetrySnapshot } from '@luban/core'
import { asSessionId } from '@luban/core'
import {
  DshCompactionContextFactory,
  DshCompactionCoordinator,
  sessionRefFromAgent,
} from '../src/dsh-context.js'
import type { CompactionEngineWithReplay } from '../src/engine.js'
import { SummarizeVirtualFileStrategy } from '../src/strategies.js'

function maintenanceAgent(idValue: string): {
  readonly agent: Agent
  readonly runMaintenance: Mock<(operation: () => Promise<void>) => Promise<void>>
} {
  const id = SessionId(idValue)
  const value = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: process.cwd(),
  })
  for (const text of ['older context', 'recent context']) {
    value.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
      { surfaceOp: 'append' },
    )
  }
  const runMaintenance = vi.fn((operation: () => Promise<void>): Promise<void> => operation())
  return {
    agent: { id, session: value, status: 'idle', runMaintenance } as unknown as Agent,
    runMaintenance,
  }
}

describe('DSH compaction boundary', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (path): Promise<void> => {
        await rm(path, { recursive: true, force: true })
      }),
    )
  })

  it('replaces only the old surface prefix while retaining redacted archives for replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luban-dsh-context-'))
    directories.push(directory)
    const id = SessionId('surface-session')
    const session = Session.create(id, [], {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      cwd: directory,
    })
    for (const text of [
      'Requirement: preserve constraint A; token=very-secret',
      'Decision: use the stable API',
      'Implementation details from the middle',
      'Recent user request must remain verbatim',
    ]) {
      session.append(
        'user/message',
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'test' },
        }),
        { surfaceOp: 'append' },
      )
    }
    const agent = {
      id,
      session,
      status: 'idle',
    } as unknown as Agent
    const agents = { get: (): Agent => agent } as unknown as AgentRegistry
    const clock: Clock = { now: (): number => 100 }
    const factory = new DshCompactionContextFactory(
      agents,
      {
        trigger: { ratio: 0.8, minGapRounds: 1 },
        strategy: 'summarize+virtualfile',
        keepRecentTokens: 10,
        archiveDir: '.luban/context-archive',
        nightProfile: { trigger: { ratio: 0.7 }, keepRecentTokens: 8 },
      },
      clock,
    )
    const ref = sessionRefFromAgent(agent)
    const workspace = await factory.create(ref)
    const strategy = new SummarizeVirtualFileStrategy()
    const result = await strategy.execute(
      strategy.plan({ segments: ref.segments, budgetTokens: 10 }),
      workspace.context,
    )
    expect(result.archiveFiles.length).toBeGreaterThan(0)
    expect(session.surface.nodes).toHaveLength(2)
    const derived = JSON.stringify(session.deriveMessages())
    expect(derived).toContain('stable API')
    expect(derived).toContain('Recent user request must remain verbatim')
    expect(derived).not.toContain('very-secret')
    const entry = (await workspace.repository.entries())[0]
    if (entry === undefined) throw new Error('archive entry missing')
    const replay = await workspace.repository.replay(entry.startSeq, entry.endSeq)
    expect(replay).toContain('Requirement')
    expect(replay).toContain('[REDACTED]')
    expect(await (await factory.open(ref.id)).entries()).toHaveLength(result.archiveFiles.length)
  })

  it('runs maintenance with a fresh snapshot scoped to the exact idle agent', async (): Promise<void> => {
    const { agent } = maintenanceAgent('targeted-maintenance')
    const snapshot: TelemetrySnapshot = {
      context: { used: 90, max: 100, ratio: 0.9 },
      workspace: { name: 'target' },
      model: { name: 'test', thinkingDepth: 'medium' },
      rates: { tpm1m: 0, tpm5m: 0, rpm1m: 0, rpm5m: 0 },
      at: 1,
    }
    const snapshotFor = vi.fn((): Promise<TelemetrySnapshot> => Promise.resolve(snapshot))
    const globalSnapshot = vi.fn((): Promise<TelemetrySnapshot> =>
      Promise.reject(new Error('global snapshot must not be used')),
    )
    const telemetry = { snapshot: globalSnapshot, snapshotFor } as unknown as TelemetryAggregator
    const maybeCompact = vi.fn(
      (_session: SessionRef, _telemetry: TelemetrySnapshot): Promise<void> => Promise.resolve(),
    )
    const engine = { maybeCompact } as unknown as CompactionEngineWithReplay
    const coordinator = new DshCompactionCoordinator({ engine, telemetry })

    coordinator.onAgentStatus(agent, 'idle')
    await vi.waitFor((): void => expect(maybeCompact).toHaveBeenCalledOnce())

    expect(snapshotFor).toHaveBeenCalledWith(asSessionId(agent.id))
    expect(globalSnapshot).not.toHaveBeenCalled()
    expect(maybeCompact.mock.calls[0]?.[0].id).toBe(asSessionId(agent.id))
    expect(maybeCompact.mock.calls[0]?.[1]).toBe(snapshot)
    await coordinator.dispose()
  })

  it('cancels pre-engine work and rejects new maintenance once disposal starts', async (): Promise<void> => {
    const { agent, runMaintenance } = maintenanceAgent('disposed-maintenance')
    let releaseSnapshot: ((snapshot: TelemetrySnapshot) => void) | undefined
    const pendingSnapshot = new Promise<TelemetrySnapshot>((resolve): void => {
      releaseSnapshot = resolve
    })
    const telemetry = {
      snapshotFor: (): Promise<TelemetrySnapshot> => pendingSnapshot,
    } as unknown as TelemetryAggregator
    const maybeCompact = vi.fn(
      (_session: SessionRef, _telemetry: TelemetrySnapshot): Promise<void> => Promise.resolve(),
    )
    const engine = { maybeCompact } as unknown as CompactionEngineWithReplay
    const coordinator = new DshCompactionCoordinator({ engine, telemetry })

    coordinator.onAgentStatus(agent, 'idle')
    await vi.waitFor((): void => expect(runMaintenance).toHaveBeenCalledOnce())
    const disposing = coordinator.dispose()
    releaseSnapshot?.({
      context: { used: 90, max: 100, ratio: 0.9 },
      workspace: { name: 'target' },
      model: { name: 'test', thinkingDepth: 'medium' },
      rates: { tpm1m: 0, tpm5m: 0, rpm1m: 0, rpm5m: 0 },
      at: 1,
    })
    await disposing
    coordinator.onAgentStatus(agent, 'idle')

    expect(maybeCompact).not.toHaveBeenCalled()
    expect(runMaintenance).toHaveBeenCalledOnce()
  })

  it('waits for an already-running engine operation before disposal completes', async (): Promise<void> => {
    const { agent } = maintenanceAgent('drained-maintenance')
    const snapshot: TelemetrySnapshot = {
      context: { used: 90, max: 100, ratio: 0.9 },
      workspace: { name: 'target' },
      model: { name: 'test', thinkingDepth: 'medium' },
      rates: { tpm1m: 0, tpm5m: 0, rpm1m: 0, rpm5m: 0 },
      at: 1,
    }
    const telemetry = {
      snapshotFor: (): Promise<TelemetrySnapshot> => Promise.resolve(snapshot),
    } as unknown as TelemetryAggregator
    let releaseEngine: (() => void) | undefined
    const enginePending = new Promise<void>((resolve): void => {
      releaseEngine = resolve
    })
    const maybeCompact = vi.fn(
      (_session: SessionRef, _telemetry: TelemetrySnapshot): Promise<void> => enginePending,
    )
    const coordinator = new DshCompactionCoordinator({
      engine: { maybeCompact } as unknown as CompactionEngineWithReplay,
      telemetry,
    })

    coordinator.onAgentStatus(agent, 'idle')
    await vi.waitFor((): void => expect(maybeCompact).toHaveBeenCalledOnce())
    let disposed = false
    const disposing = coordinator.dispose().then((): void => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    releaseEngine?.()
    await disposing
    expect(disposed).toBe(true)
  })
})
