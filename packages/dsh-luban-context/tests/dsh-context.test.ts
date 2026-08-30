import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentRegistry, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { Clock, SessionRef, TelemetryAggregator, TelemetrySnapshot } from '@luban/core'
import { asSessionId } from '@luban/core'
import {
  DshCompactionContextFactory,
  DshCompactionCoordinator,
  sessionRefFromAgent,
} from '../src/dsh-context.js'
import { DefaultCompactionEngine, type CompactionEngineWithReplay } from '../src/engine.js'
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

  it('exposes deterministic agent-facing retrieval of an injected archive path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luban-agent-context-retrieval-'))
    directories.push(directory)
    const context = new Context()
    const systemPromptFiber = context.plugin({
      name: 'luban-context-test-system-prompt',
      apply(ctx: Context): void {
        ctx.provide('systemPrompt', {
          tools: (): (() => void) => (): void => undefined,
          section: (): (() => void) => (): void => undefined,
        })
      },
    })
    await systemPromptFiber
    const agentsFiber = context.plugin(AgentRegistry)
    const toolsFiber = context.plugin(ToolRuntime, { mode: 'native' })
    await Promise.all([agentsFiber, toolsFiber])

    const id = SessionId('agent-context-retrieval')
    const session = Session.create(id, [], {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      cwd: directory,
    })
    const exactSourceDetail = 'ALPHA-42 uses the copper migration sequence at checkpoint seventeen.'
    for (const text of [
      'Requirement: preserve the high-level deployment constraints.',
      exactSourceDetail,
      'Decision: keep stable replay metadata for archived context.',
      'Recent user request must remain verbatim.',
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
    const inbox = new Inbox(session, {
      inserted: (): void => undefined,
      discarded: (): void => undefined,
      claimed: (): void => undefined,
    })
    const agent: Agent = {
      id,
      options: {},
      session,
      inbox,
      status: 'idle',
      ctx: context,
      cancel(): void {
        inbox.clear()
      },
      whenIdle: (): Promise<void> => Promise.resolve(),
      runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        return task(new AbortController().signal)
      },
      send(message, target): void {
        inbox.append(target, message)
      },
      followup(message): void {
        inbox.append('next-turn', message)
      },
      steer(message): void {
        inbox.append('next-step', message)
      },
      inject(message): void {
        inbox.append('next-step', message)
      },
    }
    const unregisterAgent = context.agents.register(agent)
    let toolCaller: Agent | undefined
    const unregisterReadFile = context.tools.register(
      defineTool({
        name: 'read_file',
        description: 'Read one UTF-8 file from the calling agent workspace.',
        parameters: {
          path: { type: 'string', required: true },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args, execution): Promise<string> {
          toolCaller = execution.agent
          if (execution.agent === undefined) throw new Error('read_file requires an agent')
          const workspace = resolve(execution.agent.session.header.cwd ?? process.cwd())
          return readFile(resolve(workspace, args.path), {
            encoding: 'utf8',
            signal: execution.signal,
          })
        },
      }),
    )

    try {
      const activeConfig = {
        trigger: { ratio: 0.8, minGapRounds: 1 },
        strategy: 'summarize+virtualfile',
        keepRecentTokens: 10,
        archiveDir: '.luban/context-archive',
        nightProfile: { trigger: { ratio: 0.7 }, keepRecentTokens: 8 },
      } as const
      const factory = new DshCompactionContextFactory(context.agents, activeConfig, {
        now: (): number => 100,
      })
      const ref = sessionRefFromAgent(agent)
      const workspace = await factory.create(ref)
      const strategy = new SummarizeVirtualFileStrategy()
      await strategy.execute(
        strategy.plan({ segments: ref.segments, budgetTokens: 10 }),
        workspace.context,
      )

      const modelFacingContext = session
        .deriveMessages()
        .flatMap((message) => message.content)
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      const injectedPaths = modelFacingContext.match(/\.luban\/context-archive\/[^\s]+\.md/gu) ?? []
      const injectedPath = injectedPaths.find((path): boolean =>
        path.includes('/seg-00000001-00000001-'),
      )
      expect(injectedPath).toBeDefined()
      expect(modelFacingContext).not.toContain(exactSourceDetail)
      expect(context.tools.schemas(agent)).toEqual([expect.objectContaining({ name: 'read_file' })])
      if (injectedPath === undefined) throw new Error('archive path was not injected')

      // This invokes the same deterministic ToolRuntime boundary used by the agent loop;
      // it does not claim that a model autonomously selected the file.
      const readResult = await context.tools.execute({
        callId: CallId('context-archive-read'),
        name: 'read_file',
        arguments: { path: injectedPath },
        agent,
        signal: new AbortController().signal,
      })

      expect(readResult.isError).toBe(false)
      if (readResult.isError || typeof readResult.value !== 'string') {
        throw new Error('agent-facing archive read failed')
      }
      expect(toolCaller).toBe(agent)
      expect(readResult.value).toContain(exactSourceDetail)
      const indexedEntry = (await workspace.repository.entries()).find(
        (entry): boolean => entry.path === injectedPath,
      )
      expect(indexedEntry).toBeDefined()
      expect(createHash('sha256').update(readResult.value).digest('hex')).toBe(indexedEntry?.sha256)
    } finally {
      unregisterReadFile()
      unregisterAgent()
      await toolsFiber.dispose()
      await agentsFiber.dispose()
      await systemPromptFiber.dispose()
    }
  })

  it('audits the real live surface event and segment indexes before and after execution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luban-dsh-surface-audit-'))
    directories.push(directory)
    const id = SessionId('surface-audit-session')
    const session = Session.create(id, [], {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      cwd: directory,
    })
    for (const text of [
      'Requirement: retain the durable event identity for the oldest context.',
      'Decision: preserve the selected implementation constraint.',
      'Recent request remains on the model-visible surface.',
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
    const agent = { id, session, status: 'idle' } as unknown as Agent
    const agents = { get: (): Agent => agent } as unknown as AgentRegistry
    const activeConfig = {
      trigger: { ratio: 0.8, minGapRounds: 1 },
      strategy: 'summarize+virtualfile',
      keepRecentTokens: 10,
      archiveDir: '.luban/context-archive',
      nightProfile: { trigger: { ratio: 0.7 }, keepRecentTokens: 8 },
    } as const
    const factory = new DshCompactionContextFactory(agents, activeConfig, {
      now: (): number => 100,
    })
    const engine = new DefaultCompactionEngine({
      config: activeConfig,
      factory,
      clock: { now: (): number => 100 },
    })
    engine.register(new SummarizeVirtualFileStrategy())
    const ref = sessionRefFromAgent(agent)
    const beforeEventSeqs = [...session.surface.nodes]

    await engine.maybeCompact(ref, {
      context: { used: 90, max: 100, ratio: 0.9 },
      workspace: { name: directory },
      model: { name: 'test', thinkingDepth: 'medium' },
      rates: { tpm1m: 0, tpm5m: 0, rpm1m: 0, rpm5m: 0 },
      at: 1,
    })

    const [record] = await engine.audit(asSessionId(id))
    if (record?.surfaceSnapshots.kind !== 'captured') {
      throw new Error('captured surface snapshots are missing')
    }
    const { before, after } = record.surfaceSnapshots
    expect(before.entries.map((entry) => entry.eventSeq)).toEqual(beforeEventSeqs)
    expect(before.entries.map((entry) => entry.segment)).toEqual(ref.segments)
    expect(before.totalTokens).toBe(
      before.entries.reduce((total, entry): number => total + entry.segment.estTokens, 0),
    )

    const summaryEventSeq = session.events.at(-1)?.seq
    expect(summaryEventSeq).toBe((beforeEventSeqs.at(-1) ?? 0) + 1)
    expect(after.entries.map((entry) => entry.eventSeq)).toEqual([
      summaryEventSeq,
      beforeEventSeqs.at(-1),
    ])
    expect(after.entries.map((entry) => entry.segment.startSeq)).toEqual([0, 1])
    expect(after.totalTokens).toBe(
      after.entries.reduce((total, entry): number => total + entry.segment.estTokens, 0),
    )
    expect(await (await factory.open(asSessionId(id))).audit()).toEqual([record])
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
