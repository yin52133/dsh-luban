import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, AgentHandle, AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  SESSION_FORMAT_VERSION,
  Session,
  type SessionId as DshSessionId,
} from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import type {
  AccountId,
  AccountSessionRegistry,
  AuthService,
  Clock,
  SessionId,
  TelemetryAggregator,
  TelemetrySnapshot,
} from '../../packages/core/src/index.js'
import { asAccountId, asSessionId, LubanError } from '../../packages/core/src/index.js'
import contextPlugin from '../../packages/dsh-luban-context/src/index.js'
import type { Config as ContextConfig } from '../../packages/dsh-luban-context/src/config.js'
import { DefaultAgentClaimService } from '../../packages/dsh-luban-taskboard/src/claim-service.js'
import type { NightConfig } from '../../packages/dsh-luban-taskboard/src/config.js'
import { createLedgerStore } from '../../packages/dsh-luban-taskboard/src/ledger.js'
import {
  DefaultNightScheduler,
  DshAgentNightExecutor,
} from '../../packages/dsh-luban-taskboard/src/night-scheduler.js'
import { JsonTaskStore } from '../../packages/dsh-luban-taskboard/src/task-store.js'

const NIGHT_CONFIG: NightConfig = {
  enabled: true,
  window: '00:00-23:59',
  dailyQuota: 1,
  hostScopeWhitelist: ['ubuntu'],
  tagWhitelist: ['auto-ok'],
  model: { provider: 'integration-provider', id: 'integration-model' },
  toolAllowlist: ['read_file'],
  circuitBreaker: { maxConsecutiveFailures: 2 },
}

const CONTEXT_CONFIG: ContextConfig = {
  trigger: { ratio: 0.8, minGapRounds: 1 },
  strategy: 'summarize+virtualfile',
  keepRecentTokens: 100,
  archiveDir: '.luban/context-archive',
  nightProfile: { trigger: { ratio: 0.7 }, keepRecentTokens: 1 },
}

const NIGHT_USAGE: TelemetrySnapshot = {
  context: { used: 75, max: 100, ratio: 0.75 },
  workspace: { name: 'night-integration' },
  model: { name: 'integration-model', thinkingDepth: 'medium' },
  rates: { tpm1m: 0, tpm5m: 0, rpm1m: 0, rpm5m: 0 },
  at: 1,
}

const NIGHT_CONTEXT = [
  'Requirement: preserve the unattended task acceptance criteria.',
  'Decision: use the more aggressive night compaction threshold.',
  'Constraint: keep archived source replayable.',
  'Recent progress remains verbatim.',
] as const

const ACCOUNT = asAccountId('night-integration-user')

class FixedClock implements Clock {
  public now(): number {
    return new Date(2026, 7, 30, 1, 0, 0).getTime()
  }
}

function memoryAccountSessions(): AccountSessionRegistry {
  const owners = new Map<SessionId, AccountId>()
  return {
    bind(accountId, sessionId): Promise<void> {
      const current = owners.get(sessionId)
      if (current !== undefined && current !== accountId) {
        throw new LubanError(
          'E_ACCOUNT_SCOPE_MISMATCH',
          `Session ${sessionId} already belongs to another account`,
        )
      }
      owners.set(sessionId, accountId)
      return Promise.resolve()
    },
    ownerOf(sessionId): Promise<AccountId | null> {
      return Promise.resolve(owners.get(sessionId) ?? null)
    },
  }
}

function authentication(accountSessions: AccountSessionRegistry): AuthService {
  return {
    middleware: () => () =>
      Promise.resolve({
        allowed: true,
        status: 200,
        user: 'tester',
        account: { accountId: ACCOUNT, username: 'tester', role: 'operator' },
      }),
    accountSessions,
  } as unknown as AuthService
}

interface NightAgentHarness {
  readonly registry: AgentRegistry
  readonly createdAgent: () => Agent | undefined
  readonly createdSessionId: () => DshSessionId | undefined
}

function createNightAgentHarness(options: {
  readonly context: Context
  readonly directory: string
  readonly clock: Clock
  readonly compactionFinished: Promise<void>
}): NightAgentHarness {
  const activeAgents = new Map<string, Agent>()
  let lastAgent: Agent | undefined
  let lastSessionId: DshSessionId | undefined

  const create = async (input: CreateAgentOptions): Promise<AgentHandle> => {
    let resultTool: ToolDefinition | undefined
    await input.setup?.({
      tools: {
        restrict: (): void => undefined,
        register: (definition: ToolDefinition): (() => void) => {
          resultTool = definition
          return (): void => undefined
        },
      },
    } as unknown as Context)

    const session = Session.create(input.sessionId, [], {
      version: SESSION_FORMAT_VERSION,
      id: input.sessionId,
      isSeeded: false,
      createdAt: options.clock.now(),
      cwd: input.meta?.cwd ?? options.directory,
    })
    for (const text of NIGHT_CONTEXT) {
      session.append(
        'user/message',
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'night-context-integration' },
        }),
        { surfaceOp: 'append' },
      )
    }

    const status: { value: Agent['status'] } = { value: 'idle' }
    let execution = Promise.resolve()
    const followup = (): void => {
      const tool = resultTool
      if (tool === undefined) throw new Error('night result tool was not registered')
      status.value = 'running'
      options.context.emit('agent/status', { agent, status: status.value })
      const callId = ToolCallId('night-result-call')
      const report = {
        acceptanceMet: true,
        summary: 'Night cadence compacted and archived the task context.',
        evidence: 'The production compaction event completed for this session.',
        outputKind: 'note' as const,
        ref: `session:${String(input.sessionId)}`,
      }
      session.append('turn/start', { turn: 0 })
      session.append('tool/call', {
        turn: 0,
        step: 0,
        callId,
        name: tool.name,
        arguments: JSON.stringify(report),
      })
      execution = tool
        .execute(report, {
          agent,
          callId,
          concludeTurn: (): void => undefined,
          signal: new AbortController().signal,
        } as unknown as ToolRunContext)
        .then((): void => {
          session.append(
            'tool/result',
            {
              turn: 0,
              step: 0,
              message: createToolResultMessage({
                callId,
                content: [{ type: 'text', text: 'Night result recorded.' }],
                isError: false,
              }),
            },
            { surfaceOp: 'append' },
          )
        })
    }
    const whenIdle = async (): Promise<void> => {
      await execution
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
      status.value = 'idle'
      options.context.emit('agent/status', { agent, status: status.value })
      await options.compactionFinished
    }
    const agent = {
      id: input.sessionId,
      options: input.agentOptions,
      session,
      get status(): Agent['status'] {
        return status.value
      },
      followup,
      whenIdle,
      runMaintenance: <Value>(operation: (signal: AbortSignal) => Promise<Value>): Promise<Value> =>
        operation(new AbortController().signal),
    } as unknown as Agent
    activeAgents.set(String(input.sessionId), agent)
    lastAgent = agent
    lastSessionId = input.sessionId
    options.context.emit('agent/created', { agent })

    return {
      agent,
      dispose: (): Promise<void> => {
        activeAgents.delete(String(input.sessionId))
        options.context.emit('agent/disposed', { agent })
        return Promise.resolve()
      },
    }
  }

  return {
    registry: {
      create,
      get: (id: DshSessionId): Agent | undefined => activeAgents.get(String(id)),
      list: (): readonly Agent[] => [...activeAgents.values()],
    } as unknown as AgentRegistry,
    createdAgent: (): Agent | undefined => lastAgent,
    createdSessionId: (): DshSessionId | undefined => lastSessionId,
  }
}

describe('M02 night task to M08 cadence integration', (): void => {
  it('flows through the production night executor and Cordis idle-status coordinator', async (): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), 'luban-night-context-integration-'))
    const context = new Context()
    const clock = new FixedClock()
    const accountSessions = memoryAccountSessions()
    let sampledSessionId: ReturnType<typeof asSessionId> | undefined
    const telemetry: TelemetryAggregator = {
      register: () => (): void => undefined,
      snapshot: (): Promise<TelemetrySnapshot> => Promise.resolve(NIGHT_USAGE),
      snapshotFor: (sessionId): Promise<TelemetrySnapshot> => {
        sampledSessionId = sessionId
        return Promise.resolve(NIGHT_USAGE)
      },
      subscribe: () => (): void => undefined,
    }
    let finishCompaction: () => void = (): void => undefined
    const compactionFinished = new Promise<void>((resolve): void => {
      finishCompaction = resolve
    })
    const compactionEvents: unknown[] = []
    const unregisterCompaction = context.on('luban.compaction.done', (payload): void => {
      compactionEvents.push(payload)
      finishCompaction()
    })
    const harness = createNightAgentHarness({
      context,
      directory,
      clock,
      compactionFinished,
    })
    const webFiber = context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const agentsFiber = context.plugin({
      name: 'night-context-integration-agents',
      apply(ctx: Context): void {
        ctx.provide('agents', harness.registry)
      },
    })
    const authFiber = context.plugin({
      name: 'night-context-integration-auth',
      apply(ctx: Context): void {
        ctx.provide('lubanAuth', authentication(accountSessions))
      },
    })
    const telemetryFiber = context.plugin({
      name: 'night-context-integration-telemetry',
      apply(ctx: Context): void {
        ctx.provide('lubanTelemetry', telemetry)
      },
    })
    const sessionQueryFiber = context.plugin({
      name: 'night-context-integration-session-query',
      apply(ctx: Context): void {
        ctx.provide('sessionQuery', {
          listSessions: (): Promise<readonly { header: { id: DshSessionId; cwd: string } }[]> => {
            const sessionId = harness.createdSessionId()
            return Promise.resolve(
              sessionId === undefined ? [] : [{ header: { id: sessionId, cwd: directory } }],
            )
          },
        })
      },
    })

    try {
      await Promise.all([webFiber, agentsFiber, authFiber, telemetryFiber, sessionQueryFiber])
      const contextFiber = context.plugin(contextPlugin, CONTEXT_CONFIG)
      try {
        await contextFiber
        const store = new JsonTaskStore(
          createLedgerStore(join(directory, 'ledger.json'), clock),
          clock,
        )
        const claims = new DefaultAgentClaimService(store, 'ubuntu', true)
        await store.create({
          accountId: ACCOUNT,
          title: 'Compact a long unattended task',
          description: 'Exercise the M02 to M08 cadence contract.',
          status: 'todo',
          hostScope: 'ubuntu',
          workspace: directory,
          priority: 'P1',
          acceptance: 'The night profile compacts below the day threshold.',
          tags: ['auto-ok'],
        })
        const scheduler = new DefaultNightScheduler({
          store,
          claims,
          executor: new DshAgentNightExecutor(harness.registry, NIGHT_CONFIG, clock),
          config: NIGHT_CONFIG,
          hostScope: 'ubuntu',
          accountSessions,
          clock,
        })

        try {
          expect(context.lubanCompaction.profile('day').thresholdRatio).toBe(0.8)
          expect(NIGHT_USAGE.context.ratio).toBeLessThan(
            context.lubanCompaction.profile('day').thresholdRatio,
          )
          await scheduler.triggerOnce()

          const sessionId = harness.createdSessionId()
          const agent = harness.createdAgent()
          if (sessionId === undefined || agent === undefined) {
            throw new Error('night executor did not create an agent session')
          }
          expect(String(sessionId)).toMatch(/^luban-night-/u)
          expect(sampledSessionId).toBe(asSessionId(sessionId))
          expect(agent.session.surface.nodes).toHaveLength(2)
          const audits = await context.lubanCompaction.audit(asSessionId(sessionId), ACCOUNT)
          expect(audits).toHaveLength(1)
          const [audit] = audits
          expect(audit).toMatchObject({
            strategyId: 'summarize+virtualfile',
            plan: { budgetTokens: 1 },
          })
          expect(audit?.archiveFiles).toHaveLength(NIGHT_CONTEXT.length)
          const replay = (
            await Promise.all(
              (audit?.archiveFiles ?? []).map(async (path): Promise<string> =>
                context.lubanCompaction.replayFile(asSessionId(sessionId), path, ACCOUNT),
              ),
            )
          ).join('\n')
          for (const source of NIGHT_CONTEXT) expect(replay).toContain(source)
          expect(compactionEvents).toEqual([
            expect.objectContaining({
              accountId: ACCOUNT,
              sessionId,
              strategy: 'summarize+virtualfile',
            }),
          ])
          const [completed] = await store.query({ accountId: ACCOUNT, statuses: ['review'] })
          expect(completed).toMatchObject({ autoDone: true, outputs: [expect.any(Object)] })
          expect(scheduler.status()).toMatchObject({ quotaUsed: 1, circuit: 'ok' })
        } finally {
          await scheduler.dispose()
        }
      } finally {
        await contextFiber.dispose()
      }
    } finally {
      unregisterCompaction()
      await Promise.allSettled([
        sessionQueryFiber.dispose(),
        telemetryFiber.dispose(),
        authFiber.dispose(),
        agentsFiber.dispose(),
        webFiber.dispose(),
      ])
      await rm(directory, { recursive: true, force: true })
    }
  })
})
