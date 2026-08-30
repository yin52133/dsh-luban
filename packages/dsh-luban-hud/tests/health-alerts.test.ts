import type { Task, TaskCreateInput, TaskStore, TelemetrySnapshot } from 'dsh-luban-core'
import { asTaskId } from 'dsh-luban-core'
import { describe, expect, it, vi } from 'vitest'
import { TaskboardHudAlertSink } from '../src/alerts.js'
import { HudKeepaliveHealthStore } from '../src/keepalive-health.js'
import type { TelemetryAdvisory } from '../src/types.js'

function snapshot(ratio: number): TelemetrySnapshot {
  return {
    context: { used: ratio * 100, max: 100, ratio },
    workspace: { name: 'private/workspace' },
    model: { name: 'model', thinkingDepth: 'high' },
    rates: { tpm1m: 1, tpm5m: 1, rpm1m: 1, rpm5m: 1 },
    at: 1,
  }
}

const critical: TelemetryAdvisory = {
  level: 'critical',
  message: 'critical',
  compactionSuggested: true,
}
const normal: TelemetryAdvisory = {
  level: 'normal',
  message: 'normal',
  compactionSuggested: false,
}

function task(input: TaskCreateInput, index: number): Task {
  return {
    id: asTaskId(`hud-alert-${String(index)}`),
    title: input.title,
    description: input.description ?? '',
    status: input.status ?? 'backlog',
    hostScope: input.hostScope,
    priority: input.priority,
    ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
    tags: input.tags ?? [],
    version: 1,
    outputs: [],
    createdAt: index,
    updatedAt: index,
  }
}

describe('HUD cross-module health and alerts', (): void => {
  it('projects, redacts, sorts, recovers, and stops M03 health updates on disposal', (): void => {
    const health = new HudKeepaliveHealthStore()
    const changed = vi.fn()
    health.subscribe(changed)
    health.record({
      sessionId: 'luban-zeta\nforged',
      alive: false,
      detail: 'probe failed token=secret-value\u001b[31m',
    })
    health.record({ sessionId: 'luban-alpha', alive: false, detail: 'offline' })
    health.record({ sessionId: 'luban-alpha', alive: false, detail: 'offline' })

    const unhealthy = health.snapshot()
    expect(unhealthy).toEqual({
      healthy: false,
      alerts: [
        { sessionId: 'luban-alpha', detail: 'offline' },
        { sessionId: 'luban-zeta forged', detail: 'probe failed token=[REDACTED]' },
      ],
    })
    expect(JSON.stringify(unhealthy)).not.toContain('secret-value')
    expect(Object.isFrozen(unhealthy.alerts)).toBe(true)
    expect(changed).toHaveBeenCalledTimes(2)

    health.record({ sessionId: 'luban-alpha', alive: true })
    expect(health.snapshot().alerts).toHaveLength(1)
    health.dispose()
    health.record({ sessionId: 'luban-zeta forged', alive: true })
    expect(health.snapshot()).toEqual({ healthy: true, alerts: [] })
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('serializes a critical episode and creates one metadata-only active Taskboard alert', async (): Promise<void> => {
    const tasks: Task[] = []
    let releaseQuery: (() => void) | undefined
    const queryReady = new Promise<void>((resolve): void => {
      releaseQuery = resolve
    })
    const queryStarted = vi.fn()
    const query = vi.fn(async (): Promise<readonly Task[]> => {
      queryStarted()
      await queryReady
      return tasks
    })
    const create = vi.fn((input: TaskCreateInput): Promise<Task> => {
      const created = task(input, tasks.length + 1)
      tasks.push(created)
      return Promise.resolve(created)
    })
    const store = { query, create } as unknown as TaskStore
    const sink = new TaskboardHudAlertSink(store)

    const first = sink.observe(snapshot(0.961), critical)
    const duplicate = sink.observe(snapshot(0.97), critical)
    await vi.waitFor((): void => expect(queryStarted).toHaveBeenCalledOnce())
    releaseQuery?.()
    await Promise.all([first, duplicate])

    expect(create).toHaveBeenCalledOnce()
    expect(tasks[0]).toMatchObject({
      title: 'HUD context usage is critical',
      description: 'HUD context usage reached 96.1%, crossing the configured critical threshold.',
      priority: 'P1',
      tags: ['hud', 'telemetry', 'hud:context-critical'],
    })
    expect(JSON.stringify(tasks[0])).not.toContain('private/workspace')

    await sink.observe(snapshot(0.5), normal)
    await sink.observe(snapshot(0.96), critical)
    expect(query).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledOnce()
    await sink.dispose()
  })

  it('fails closed when disposal races with the active-card query', async (): Promise<void> => {
    let releaseQuery: (() => void) | undefined
    let queryStarted: (() => void) | undefined
    const started = new Promise<void>((resolve): void => {
      queryStarted = resolve
    })
    const query = vi.fn(
      (): Promise<readonly Task[]> =>
        new Promise((resolve): void => {
          queryStarted?.()
          releaseQuery = (): void => resolve([])
        }),
    )
    const create = vi.fn((_input: TaskCreateInput): Promise<Task> =>
      Promise.resolve(task(_input, 1)),
    )
    const sink = new TaskboardHudAlertSink({ query, create } as unknown as TaskStore)
    const reporting = sink.observe(snapshot(0.99), critical)
    await started
    const disposal = sink.dispose()
    releaseQuery?.()
    await Promise.all([reporting, disposal])

    expect(query).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
    await sink.observe(snapshot(0.99), critical)
    expect(query).toHaveBeenCalledOnce()
  })
})
