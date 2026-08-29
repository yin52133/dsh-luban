import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Clock, Task, TaskOutput } from '@luban/core'
import { LubanError } from '@luban/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DefaultAgentClaimService } from '../src/claim-service.js'
import type { NightConfig } from '../src/config.js'
import { createLedgerStore } from '../src/ledger.js'
import {
  DefaultNightScheduler,
  DshAgentNightExecutor,
  isInWindow,
  type NightTaskExecutor,
} from '../src/night-scheduler.js'
import { JsonTaskStore } from '../src/task-store.js'

const directories = new Set<string>()

class MutableClock implements Clock {
  public value = new Date(2026, 7, 30, 1, 0, 0).getTime()
  public now(): number {
    return this.value
  }
}

const CONFIG: NightConfig = {
  enabled: true,
  window: '00:00-23:59',
  dailyQuota: 1,
  hostScopeWhitelist: ['ubuntu'],
  tagWhitelist: ['auto-ok'],
  circuitBreaker: { maxConsecutiveFailures: 2 },
}

async function state(clock: Clock): Promise<{
  readonly store: JsonTaskStore
  readonly claims: DefaultAgentClaimService
}> {
  const directory = join(tmpdir(), `dsh-luban-scheduler-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  directories.add(directory)
  const store = new JsonTaskStore(createLedgerStore(join(directory, 'ledger.json'), clock), clock)
  return { store, claims: new DefaultAgentClaimService(store, 'ubuntu', true) }
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { force: true, recursive: true })
      directories.delete(directory)
    }),
  )
})

describe('night scheduler', (): void => {
  it('executes through the rc2 agent registry and releases the active handle', async (): Promise<void> => {
    const clock = new MutableClock()
    const { store } = await state(clock)
    const task = await store.create({
      title: 'Agent adapter',
      hostScope: 'ubuntu',
      priority: 'P2',
    })
    const followup = vi.fn()
    const whenIdle = vi.fn((): Promise<void> => Promise.resolve())
    const dispose = vi.fn((): Promise<void> => Promise.resolve())
    const create = vi.fn((): Promise<unknown> =>
      Promise.resolve({
        agent: { followup, whenIdle },
        dispose,
      }),
    )
    const executor = new DshAgentNightExecutor({ create } as unknown as AgentRegistry, clock)
    const sessionId = SessionId('luban-night-test')

    await expect(executor.execute(task, sessionId)).resolves.toMatchObject({
      kind: 'note',
      ref: 'session:luban-night-test',
    })
    expect(create).toHaveBeenCalledWith({ sessionId, meta: {} })
    expect(followup).toHaveBeenCalledOnce()
    expect(whenIdle).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    await executor.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('handles overnight windows', (): void => {
    expect(isInWindow(new Date(2026, 7, 30, 23, 45).getTime(), '23:30-06:30')).toBe(true)
    expect(isInWindow(new Date(2026, 7, 30, 6, 29).getTime(), '23:30-06:30')).toBe(true)
    expect(isInWindow(new Date(2026, 7, 30, 12, 0).getTime(), '23:30-06:30')).toBe(false)
  })

  it('runs a whitelisted task once and enforces the durable quota', async (): Promise<void> => {
    const clock = new MutableClock()
    const { store, claims } = await state(clock)
    for (const title of ['First', 'Second']) {
      await store.create({
        title,
        status: 'todo',
        hostScope: 'ubuntu',
        priority: 'P1',
        acceptance: 'Result reviewed',
        tags: ['auto-ok'],
      })
    }
    const executor: NightTaskExecutor = {
      execute(task: Task): Promise<TaskOutput> {
        if (task.claim === undefined || task.claim === null) throw new Error('claim missing')
        return Promise.resolve({
          kind: 'note',
          ref: 'result',
          summary: 'completed',
          at: clock.now(),
          by: task.claim.actor,
        })
      },
    }
    const scheduler = new DefaultNightScheduler({
      store,
      claims,
      executor,
      config: CONFIG,
      hostScope: 'ubuntu',
      clock,
    })
    await scheduler.triggerOnce()
    await scheduler.triggerOnce()
    expect(await store.query({ statuses: ['review'] })).toHaveLength(1)
    expect(await store.query({ statuses: ['todo'] })).toHaveLength(1)
    expect(scheduler.status()).toMatchObject({ quotaUsed: 1, circuit: 'ok' })
    await scheduler.dispose()
  })

  it('opens the circuit after consecutive failures and resets it next day', async (): Promise<void> => {
    const clock = new MutableClock()
    const { store, claims } = await state(clock)
    for (const title of ['Failure one', 'Failure two', 'Tomorrow']) {
      await store.create({
        title,
        status: 'todo',
        hostScope: 'ubuntu',
        priority: 'P1',
        acceptance: 'Must succeed',
        tags: ['auto-ok'],
      })
    }
    const executor: NightTaskExecutor = {
      execute(): Promise<TaskOutput> {
        return Promise.reject(new LubanError('E_UNAVAILABLE', 'provider down'))
      },
    }
    const scheduler = new DefaultNightScheduler({
      store,
      claims,
      executor,
      config: { ...CONFIG, dailyQuota: 5 },
      hostScope: 'ubuntu',
      clock,
    })
    await scheduler.triggerOnce()
    await scheduler.triggerOnce()
    expect(scheduler.status().circuit).toBe('open')
    const attempts = (await store.query({})).reduce(
      (sum, task) => sum + (task.failureCount ?? 0),
      0,
    )
    expect(attempts).toBe(2)

    clock.value += 24 * 60 * 60 * 1_000
    await scheduler.triggerOnce()
    expect(scheduler.status().circuit).toBe('ok')
    await scheduler.dispose()
  })

  it('fails closed when disabled or outside the configured window', async (): Promise<void> => {
    const clock = new MutableClock()
    const { store, claims } = await state(clock)
    const disabled = new DefaultNightScheduler({
      store,
      claims,
      config: { ...CONFIG, enabled: false },
      hostScope: 'ubuntu',
      clock,
    })
    await expect(disabled.triggerOnce()).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
    const outside = new DefaultNightScheduler({
      store,
      claims,
      config: { ...CONFIG, window: '02:00-03:00' },
      hostScope: 'ubuntu',
      clock,
    })
    await outside.triggerOnce()
    expect(outside.status().windowActive).toBe(false)
  })
})
