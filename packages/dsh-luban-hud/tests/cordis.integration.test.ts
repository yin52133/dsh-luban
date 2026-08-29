import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { AuthService, Task, TaskCreateInput, TaskStore } from '@luban/core'
import { asTaskId } from '@luban/core'
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
