import { Context } from '@deepseek-ai/cordis'
import type {
  AgentClaimService,
  AuthService,
  NightScheduler,
  NightTaskExecutorRoute,
  Task,
  TaskStore,
} from 'dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.js'

describe('browser Cordis taskboard lifecycle', (): void => {
  it('registers one browser night route and removes it with the task listener', async (): Promise<void> => {
    const context = new Context()
    const unregisterHttp = vi.fn<() => void>()
    const unbindTaskStore = vi.fn<() => void>()
    const unregisterExecutor = vi.fn<() => void>()
    let route: NightTaskExecutorRoute | undefined
    const registerTaskExecutor = vi.fn((candidate: NightTaskExecutorRoute): (() => void) => {
      route = candidate
      return unregisterExecutor
    })
    const subscribe = vi.fn((): (() => void) => unbindTaskStore)
    const query = vi.fn((): Promise<readonly Task[]> => Promise.resolve([]))

    context.provide('webServer', {
      register: vi.fn((): (() => void) => unregisterHttp),
    } as unknown as Context['webServer'])
    context.provide('lubanAuth', {
      middleware: (): ReturnType<AuthService['middleware']> => () =>
        Promise.resolve({ allowed: true, status: 200, user: 'tester' }),
    } as unknown as AuthService)
    context.provide('lubanTaskStore', { query, subscribe } as unknown as TaskStore)
    context.provide('lubanAgentClaim', {} as AgentClaimService)
    const scheduler: NightScheduler = {
      start: vi.fn(),
      stop: vi.fn(),
      status: () => ({ windowActive: false, quotaUsed: 0, circuit: 'ok' }),
      triggerOnce: () => Promise.resolve(),
      registerTaskExecutor,
    }
    context.provide('lubanNightScheduler', scheduler)

    const fiber = context.plugin(plugin, { taskboard: { autoRun: true } })
    try {
      await fiber

      expect(registerTaskExecutor).toHaveBeenCalledOnce()
      expect(subscribe).toHaveBeenCalledOnce()
      expect(query).toHaveBeenCalledWith({ statuses: ['doing'], tags: ['browser'] })
      expect(route?.id).toBe('luban-browser')
      expect(route?.matches({ tags: ['browser'] } as unknown as Task)).toBe(true)
      expect(route?.matches({ tags: ['manual'] } as unknown as Task)).toBe(false)
    } finally {
      await fiber.dispose()
    }

    expect(unbindTaskStore).toHaveBeenCalledOnce()
    expect(unregisterExecutor).toHaveBeenCalledOnce()
    expect(unregisterHttp).toHaveBeenCalledOnce()
    expect(fiber.getEffects()).toEqual([])
  })
})
