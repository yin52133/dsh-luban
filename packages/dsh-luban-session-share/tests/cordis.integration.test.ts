import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SessionId as DshSessionId, type Session } from '@deepseek-ai/dsh-session'
import type { AuthService, KeepaliveService, Task, TaskStore } from 'dsh-luban-core'
import { asActorId, asSessionId, asTaskId } from 'dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import plugin from '../src/index.js'
import type { SharedSessionRegistry } from '../src/registry.js'

function authentication(): AuthService {
  return {
    middleware: () => () => Promise.resolve({ allowed: true, status: 200, user: 'owner' }),
  } as unknown as AuthService
}

function keepalive(): KeepaliveService {
  return {
    onEvent: () => (): void => undefined,
  } as unknown as KeepaliveService
}

function task(sessionId?: string): Task {
  return {
    id: asTaskId('late-task'),
    title: 'Late task link',
    description: '',
    status: 'doing',
    hostScope: 'any',
    priority: 'P2',
    tags: [],
    version: 1,
    ...(sessionId === undefined
      ? { claim: null }
      : {
          claim: {
            actor: { kind: 'agent', id: asActorId('late-agent') },
            sessionId: asSessionId(sessionId),
            claimedAt: 1,
          },
        }),
    outputs: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('Session Share Cordis integration', (): void => {
  it('attaches and releases a TaskStore that appears after the session registry', async (): Promise<void> => {
    const context = new Context()
    const dshSessionId = DshSessionId('late-session')
    const session = { id: dshSessionId, header: {} } as Session
    const agent = { id: dshSessionId, session, status: 'idle' } as Agent
    const agents = {
      roots: (): readonly Agent[] => [agent],
      get: (id: ReturnType<typeof DshSessionId>): Agent | undefined =>
        id === dshSessionId ? agent : undefined,
    } as unknown as AgentRegistry
    const webFiber = context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const agentsFiber = context.plugin({
      name: 'luban-session-share-test-agents',
      apply(ctx: Context): void {
        ctx.provide('agents', agents)
      },
    })
    const authFiber = context.plugin({
      name: 'luban-session-share-test-auth',
      apply(ctx: Context): void {
        ctx.provide('lubanAuth', authentication())
      },
    })
    const keepaliveFiber = context.plugin({
      name: 'luban-session-share-test-keepalive',
      apply(ctx: Context): void {
        ctx.provide('lubanKeepalive', keepalive())
      },
    })

    try {
      await Promise.all([webFiber, agentsFiber, authFiber, keepaliveFiber])
      const shareFiber = context.plugin(plugin, { host: 'windows', peerRefreshSec: 60 })
      await shareFiber
      const registry = context.get('lubanSessionRegistry') as SharedSessionRegistry | undefined
      if (registry === undefined) throw new Error('session registry was not provided')
      expect(registry.getView(asSessionId(dshSessionId))).toMatchObject({ id: 'late-session' })
      expect(registry.getView(asSessionId(dshSessionId))?.ownerTaskId).toBeUndefined()

      let tasks: readonly Task[] = [task('late-session')]
      let notify: (() => void) | undefined
      const unsubscribe = vi.fn()
      const store = {
        query: vi.fn((): Promise<readonly Task[]> => Promise.resolve(tasks)),
        subscribe: vi.fn((listener: () => void): (() => void) => {
          notify = listener
          return unsubscribe
        }),
      } as unknown as TaskStore
      const taskStoreFiber = context.plugin({
        name: 'luban-session-share-test-task-store',
        apply(ctx: Context): void {
          ctx.provide('lubanTaskStore', store)
        },
      })
      await taskStoreFiber
      await vi.waitFor((): void =>
        expect(registry.getView(asSessionId(dshSessionId))).toMatchObject({
          ownerTaskId: 'late-task',
        }),
      )

      tasks = [task()]
      notify?.()
      await vi.waitFor((): void =>
        expect(registry.getView(asSessionId(dshSessionId))?.ownerTaskId).toBeUndefined(),
      )

      await taskStoreFiber.dispose()
      expect(unsubscribe).toHaveBeenCalledOnce()
      tasks = [task('late-session')]
      notify?.()
      await Promise.resolve()
      expect(registry.getView(asSessionId(dshSessionId))?.ownerTaskId).toBeUndefined()

      const replacementTaskStoreFiber = context.plugin({
        name: 'luban-session-share-test-task-store-replacement',
        apply(ctx: Context): void {
          ctx.provide('lubanTaskStore', store)
        },
      })
      await replacementTaskStoreFiber
      await vi.waitFor((): void =>
        expect(registry.getView(asSessionId(dshSessionId))).toMatchObject({
          ownerTaskId: 'late-task',
        }),
      )

      await shareFiber.dispose()
      expect(unsubscribe).toHaveBeenCalledTimes(2)
      expect(context.get('lubanSessionRegistry')).toBeUndefined()
      expect(shareFiber.getEffects()).toEqual([])
      await replacementTaskStoreFiber.dispose()
    } finally {
      await Promise.allSettled([
        keepaliveFiber.dispose(),
        authFiber.dispose(),
        agentsFiber.dispose(),
        webFiber.dispose(),
      ])
    }
  }, 30_000)
})
