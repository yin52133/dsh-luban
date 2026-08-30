import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { AuthService, Task, TaskCreateInput, TaskStore } from 'dsh-luban-core'
import { asSessionId, asTaskId } from 'dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'
import { keepaliveIndicator } from '../src/client/index.js'
import type { HudSnapshotResponse } from '../src/types.js'

function authentication(): AuthService {
  return {
    middleware: () => () => Promise.resolve({ allowed: true, status: 200, user: 'tester' }),
  } as unknown as AuthService
}

function alertTask(input: TaskCreateInput): Task {
  return {
    id: asTaskId('hud-cordis-alert'),
    title: input.title,
    description: input.description ?? '',
    status: input.status ?? 'backlog',
    hostScope: input.hostScope,
    priority: input.priority,
    ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
    tags: input.tags ?? [],
    version: 1,
    outputs: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('HUD Cordis integration', (): void => {
  it('discovers the optional projection service and falls back after it unloads', async (): Promise<void> => {
    const context = new Context()
    const id = SessionId('hud-cordis-projection')
    const session = Session.create(id, [], {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      cwd: process.cwd(),
    })
    session.append('request/context', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      contextWindow: 4_096,
    })
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'production wiring prompt' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )
    session.append('step/start', { turn: 0, step: 0 })
    session.append(
      'assistant/message',
      {
        turn: 0,
        step: 0,
        message: createAssistantMessage({
          content: [{ type: 'text', text: 'measured reply' }],
          source: { provider: 'deepseek', model: 'deepseek-chat' },
        }),
        usage: {
          inputTokens: 700,
          outputTokens: 50,
          cacheReadTokens: 100,
          cacheWriteTokens: 20,
        },
      },
      { surfaceOp: 'append' },
    )
    session.append('step/end', { turn: 0, step: 0 })
    const agent = { id, session, status: 'idle', options: {} } as unknown as Agent
    const agents = {
      currentInitiator: (): undefined => undefined,
      get: (candidate: SessionId): Agent | undefined => (candidate === id ? agent : undefined),
      list: (): readonly Agent[] => [agent],
    } as unknown as AgentRegistry
    const webFiber = context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const agentsFiber = context.plugin({
      name: 'luban-hud-projection-agents',
      apply(ctx: Context): void {
        ctx.provide('agents', agents)
      },
    })
    const authFiber = context.plugin({
      name: 'luban-hud-projection-auth',
      apply(ctx: Context): void {
        ctx.provide('lubanAuth', authentication())
      },
    })
    const projectionFiber = context.plugin(SessionProjectionRegistry)
    let projectionActive = true
    let disposeMeter: (() => Promise<unknown>) | undefined

    try {
      await Promise.all([webFiber, agentsFiber, authFiber, projectionFiber])
      const meterFiber = context.plugin(TokenMeter)
      disposeMeter = (): Promise<unknown> => meterFiber.dispose()
      await meterFiber
      const hudFiber = context.plugin(plugin)
      await hudFiber
      try {
        const official = context.sessionProjections.snapshot(session).values.contextPressure
        if (
          official?.projectedTokens === undefined ||
          official.pressureTokens === undefined ||
          official.contextWindow === undefined
        ) {
          throw new Error('official context projection is incomplete')
        }
        expect(official.projectedTokens).toBeGreaterThan(official.pressureTokens)

        const projected = await context.lubanTelemetry.snapshotFor(asSessionId(id))
        expect(projected.context).toEqual({
          used: official.projectedTokens,
          max: official.contextWindow,
          ratio: official.projectedTokens / official.contextWindow,
        })

        await meterFiber.dispose()
        disposeMeter = undefined
        const afterKeyUnload = await context.lubanTelemetry.snapshotFor(asSessionId(id))
        expect(afterKeyUnload.context).toEqual({ used: 820, max: 4_096, ratio: 820 / 4_096 })

        await projectionFiber.dispose()
        projectionActive = false
        const afterServiceUnload = await context.lubanTelemetry.snapshotFor(asSessionId(id))
        expect(afterServiceUnload.context).toEqual({
          used: 820,
          max: 4_096,
          ratio: 820 / 4_096,
        })
      } finally {
        await hudFiber.dispose()
      }
    } finally {
      await Promise.allSettled([
        ...(disposeMeter === undefined ? [] : [disposeMeter()]),
        ...(projectionActive ? [projectionFiber.dispose()] : []),
        authFiber.dispose(),
        agentsFiber.dispose(),
        webFiber.dispose(),
      ])
    }
  }, 30_000)

  it('mounts optional TaskStore and projects real keepalive events into authenticated HUD data', async (): Promise<void> => {
    const context = new Context()
    const agents = { list: (): readonly never[] => [] } as unknown as AgentRegistry
    const tasks: Task[] = []
    const query = vi.fn((): Promise<readonly Task[]> => Promise.resolve(tasks))
    const create = vi.fn((input: TaskCreateInput): Promise<Task> => {
      const created = alertTask(input)
      tasks.push(created)
      return Promise.resolve(created)
    })
    const store = { query, create } as unknown as TaskStore
    const webFiber = context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const agentsFiber = context.plugin({
      name: 'luban-hud-test-agents',
      apply(ctx: Context): void {
        ctx.provide('agents', agents)
      },
    })
    const authFiber = context.plugin({
      name: 'luban-hud-test-auth',
      apply(ctx: Context): void {
        ctx.provide('lubanAuth', authentication())
      },
    })

    try {
      await Promise.all([webFiber, agentsFiber, authFiber])
      const hudFiber = context.plugin(plugin)
      await hudFiber
      const taskStoreFiber = context.plugin({
        name: 'luban-hud-test-task-store',
        apply(ctx: Context): void {
          ctx.provide('lubanTaskStore', store)
        },
      })
      try {
        await taskStoreFiber
        const unregisterProvider = context.lubanTelemetry.register({
          id: 'critical-cordis-provider',
          capabilities: (): readonly ['context'] => ['context'],
          sample: () => Promise.resolve({ context: { used: 96, max: 100, ratio: 0.96 } }),
        })

        context.emit('luban.keepalive.health', {
          sessionId: 'luban-build',
          alive: false,
          detail: 'probe failed password=should-not-leak',
        })
        await context.lubanTelemetry.snapshot()
        await vi.waitFor((): void => expect(create).toHaveBeenCalledOnce())

        const response = await fetch(
          `http://127.0.0.1:${String(context.webServer.port)}/luban-hud/snapshot`,
        )
        expect(response.status).toBe(200)
        const envelope = (await response.json()) as HudSnapshotResponse
        expect(envelope.advisory.level).toBe('critical')
        expect(envelope.keepalive).toEqual({
          healthy: false,
          alerts: [{ sessionId: 'luban-build', detail: 'probe failed password=[REDACTED]' }],
        })
        expect(JSON.stringify(envelope)).not.toContain('should-not-leak')
        expect(keepaliveIndicator(envelope.keepalive)).toMatchObject({
          count: 1,
          label: 'keepalive 1 down',
          title: 'luban-build: probe failed password=[REDACTED]',
        })
        expect(tasks).toHaveLength(1)

        context.emit('luban.keepalive.health', { sessionId: 'luban-build', alive: true })
        const recovered = await fetch(
          `http://127.0.0.1:${String(context.webServer.port)}/luban-hud/snapshot`,
        )
        expect(((await recovered.json()) as HudSnapshotResponse).keepalive).toEqual({
          healthy: true,
          alerts: [],
        })

        unregisterProvider()
      } finally {
        await Promise.allSettled([taskStoreFiber.dispose(), hudFiber.dispose()])
      }
      expect(context.get('lubanTelemetry')).toBeUndefined()
      expect(hudFiber.getEffects()).toEqual([])
    } finally {
      await Promise.allSettled([authFiber.dispose(), agentsFiber.dispose(), webFiber.dispose()])
    }
  }, 30_000)
})
