import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Clock, Task, TaskOutput } from 'dsh-luban-core'
import { LubanError, asSessionId } from 'dsh-luban-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DefaultAgentClaimService } from '../src/claim-service.js'
import type { NightConfig } from '../src/config.js'
import { parseConfig } from '../src/config.js'
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
  model: { provider: 'night-provider', id: 'night-model' },
  toolAllowlist: ['read_file', 'search'],
  circuitBreaker: { maxConsecutiveFailures: 2 },
}

interface ReportArgs {
  readonly acceptanceMet: boolean
  readonly summary: string
  readonly evidence: string
  readonly outputKind: 'note' | 'commit' | 'artifact' | 'link'
  readonly ref: string
}

function fakeAgentRegistry(options: {
  readonly report?: ReportArgs
  readonly resultError?: boolean
  readonly turnReason?: 'completed' | 'error'
}): {
  readonly registry: AgentRegistry
  readonly create: ReturnType<typeof vi.fn<(input: CreateAgentOptions) => Promise<AgentHandle>>>
  readonly restrict: ReturnType<typeof vi.fn>
  readonly register: ReturnType<typeof vi.fn>
  readonly followup: ReturnType<typeof vi.fn>
  readonly whenIdle: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
  readonly concludeTurn: ReturnType<typeof vi.fn>
} {
  let result: ToolDefinition | undefined
  let execution = Promise.resolve<unknown>(undefined)
  let agent: Agent
  const callId = 'night-result-call'
  const events: { readonly type: string; readonly data: unknown }[] = []
  const restrict = vi.fn()
  const register = vi.fn((definition: ToolDefinition): (() => void) => {
    result = definition
    return (): void => undefined
  })
  const concludeTurn = vi.fn()
  const followup = vi.fn((): void => {
    if (options.report === undefined || result === undefined) return
    events.push({
      type: 'tool/call',
      data: { turn: 0, step: 0, callId, name: 'luban_report_night_result', arguments: '{}' },
    })
    execution = result
      .execute(options.report, {
        agent,
        callId,
        concludeTurn,
        signal: new AbortController().signal,
      } as unknown as ToolRunContext)
      .then((value): unknown => {
        events.push({
          type: 'tool/result',
          data: {
            turn: 0,
            step: 0,
            message: {
              source: { kind: 'tool', callId },
              content: [
                {
                  type: 'tool-result',
                  toolCallId: callId,
                  content: [{ type: 'text', text: 'Night result recorded.' }],
                  ...(options.resultError === true ? { isError: true } : {}),
                },
              ],
            },
            ...(options.resultError === true
              ? { error: { name: 'PolicyError', code: 'RESULT_REJECTED' } }
              : {}),
          },
        })
        return value
      })
  })
  const whenIdle = vi.fn(async (): Promise<void> => {
    await execution
    events.push({
      type: 'turn/end',
      data: {
        turn: 0,
        reason:
          options.turnReason === 'error'
            ? { kind: 'error', error: { code: 'TEST', message: 'failed' } }
            : { kind: 'completed' },
      },
    })
  })
  const dispose = vi.fn((): Promise<void> => Promise.resolve())
  const create = vi.fn(async (input: CreateAgentOptions): Promise<AgentHandle> => {
    await input.setup?.({ tools: { restrict, register } } as unknown as Context)
    agent = {
      id: input.sessionId,
      followup,
      whenIdle,
      session: {
        events,
      },
    } as unknown as Agent
    return { agent, dispose }
  })
  return {
    registry: { create } as unknown as AgentRegistry,
    create,
    restrict,
    register,
    followup,
    whenIdle,
    dispose,
    concludeTurn,
  }
}

async function state(clock: Clock): Promise<{
  readonly store: JsonTaskStore
  readonly claims: DefaultAgentClaimService
  readonly ledgerPath: string
}> {
  const directory = join(tmpdir(), `dsh-luban-scheduler-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  directories.add(directory)
  const ledgerPath = join(directory, 'ledger.json')
  const store = new JsonTaskStore(createLedgerStore(ledgerPath, clock), clock)
  return { store, claims: new DefaultAgentClaimService(store, 'ubuntu', true), ledgerPath }
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
  it('applies a dedicated rc2 model/tool scope and accepts one verified result report', async (): Promise<void> => {
    const clock = new MutableClock()
    const { store } = await state(clock)
    const task = await store.create({
      title: 'Agent adapter',
      hostScope: 'ubuntu',
      priority: 'P2',
    })
    const harness = fakeAgentRegistry({
      report: {
        acceptanceMet: true,
        summary: 'Checks passed',
        evidence: 'lint and unit tests passed',
        outputKind: 'commit',
        ref: 'commit:abc123',
      },
    })
    const executor = new DshAgentNightExecutor(harness.registry, CONFIG, clock)
    const sessionId = asSessionId('luban-night-test')

    await expect(executor.execute(task, sessionId)).resolves.toMatchObject({
      kind: 'commit',
      ref: 'commit:abc123',
      summary: 'Checks passed Evidence: lint and unit tests passed',
    })
    expect(harness.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        meta: {},
        agentOptions: { provider: 'night-provider', model: 'night-model' },
      }),
    )
    expect(harness.create.mock.calls[0]?.[0].setup).toEqual(expect.any(Function))
    expect(harness.restrict).toHaveBeenCalledWith({ allow: ['read_file', 'search'] })
    expect(harness.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'luban_report_night_result' }),
    )
    expect(harness.followup).toHaveBeenCalledOnce()
    expect(harness.whenIdle).toHaveBeenCalledOnce()
    expect(harness.concludeTurn).toHaveBeenCalledOnce()
    expect(harness.dispose).toHaveBeenCalledOnce()
    await executor.dispose()
    expect(harness.dispose).toHaveBeenCalledOnce()
  })

  it('fails closed when idle has no report, acceptance fails, or the turn did not complete', async (): Promise<void> => {
    const clock = new MutableClock()
    const { store } = await state(clock)
    const task = await store.create({
      title: 'Fail closed',
      hostScope: 'ubuntu',
      priority: 'P2',
    })
    const sessionId = asSessionId('luban-night-fail-closed')

    const missing = fakeAgentRegistry({})
    await expect(
      new DshAgentNightExecutor(missing.registry, CONFIG, clock).execute(task, sessionId),
    ).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
      message: 'Night agent did not submit one successful final result report',
    })

    const unmet = fakeAgentRegistry({
      report: {
        acceptanceMet: false,
        summary: 'Build failed',
        evidence: 'exit code 1',
        outputKind: 'note',
        ref: `session:${sessionId}`,
      },
    })
    await expect(
      new DshAgentNightExecutor(unmet.registry, CONFIG, clock).execute(task, sessionId),
    ).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
      message: 'Night task acceptance was not met: Build failed (exit code 1)',
    })

    const rejectedResult = fakeAgentRegistry({
      resultError: true,
      report: {
        acceptanceMet: true,
        summary: 'Uncommitted report',
        evidence: 'tool pipeline rejected the result',
        outputKind: 'note',
        ref: `session:${sessionId}`,
      },
    })
    await expect(
      new DshAgentNightExecutor(rejectedResult.registry, CONFIG, clock).execute(task, sessionId),
    ).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
      message: 'Night agent did not submit one successful final result report',
    })

    const incomplete = fakeAgentRegistry({
      turnReason: 'error',
      report: {
        acceptanceMet: true,
        summary: 'Untrusted success',
        evidence: 'incomplete turn',
        outputKind: 'note',
        ref: `session:${sessionId}`,
      },
    })
    await expect(
      new DshAgentNightExecutor(incomplete.registry, CONFIG, clock).execute(task, sessionId),
    ).rejects.toMatchObject({
      code: 'E_UNAVAILABLE',
      message: 'Night agent did not finish a completed turn',
    })
  })

  it('requires an explicit dedicated model before night mode can be enabled', (): void => {
    expect((): unknown => parseConfig({ night: { enabled: true } })).toThrow(
      'night.model.provider and night.model.id are required when night mode is enabled',
    )
    expect(
      parseConfig({
        night: {
          enabled: true,
          model: { provider: ' dedicated ', id: ' model ' },
          toolAllowlist: ['read_file', 'read_file', ''],
        },
      }).night,
    ).toMatchObject({
      model: { provider: 'dedicated', id: 'model' },
      toolAllowlist: ['read_file'],
    })
  })

  it('returns an unverified DSH result to todo instead of marking it autoDone', async (): Promise<void> => {
    const clock = new MutableClock()
    const { store, claims } = await state(clock)
    await store.create({
      title: 'Needs real evidence',
      status: 'todo',
      hostScope: 'ubuntu',
      priority: 'P1',
      acceptance: 'All checks pass',
      tags: ['auto-ok'],
    })
    const harness = fakeAgentRegistry({
      report: {
        acceptanceMet: false,
        summary: 'Checks failed',
        evidence: 'test suite exit code 1',
        outputKind: 'note',
        ref: 'session:failed-night-run',
      },
    })
    const scheduler = new DefaultNightScheduler({
      store,
      claims,
      executor: new DshAgentNightExecutor(harness.registry, CONFIG, clock),
      config: CONFIG,
      hostScope: 'ubuntu',
      clock,
    })

    await scheduler.triggerOnce()

    expect(await store.query({ statuses: ['review'] })).toEqual([])
    const [retried] = await store.query({ statuses: ['todo'] })
    expect(retried).toMatchObject({
      failureCount: 1,
      claim: null,
      outputs: [
        expect.objectContaining({
          kind: 'note',
          summary: 'Night task acceptance was not met: Checks failed (test suite exit code 1)',
        }),
      ],
    })
    expect(retried?.autoDone).toBeUndefined()
    expect(scheduler.status()).toMatchObject({ quotaUsed: 0, circuit: 'ok' })
    await scheduler.dispose()
  })

  it('handles overnight windows', (): void => {
    expect(isInWindow(new Date(2026, 7, 30, 23, 45).getTime(), '23:30-06:30')).toBe(true)
    expect(isInWindow(new Date(2026, 7, 30, 6, 29).getTime(), '23:30-06:30')).toBe(true)
    expect(isInWindow(new Date(2026, 7, 30, 12, 0).getTime(), '23:30-06:30')).toBe(false)
  })

  it('runs a whitelisted task once and enforces the durable quota', async (): Promise<void> => {
    const clock = new MutableClock()
    const { store, claims, ledgerPath } = await state(clock)
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
    await scheduler.dispose()

    const reloadedStore = new JsonTaskStore(createLedgerStore(ledgerPath, clock), clock)
    const restarted = new DefaultNightScheduler({
      store: reloadedStore,
      claims: new DefaultAgentClaimService(reloadedStore, 'ubuntu', true),
      executor,
      config: CONFIG,
      hostScope: 'ubuntu',
      clock,
    })
    await restarted.triggerOnce()
    expect(await reloadedStore.query({ statuses: ['review'] })).toHaveLength(1)
    expect(await reloadedStore.query({ statuses: ['todo'] })).toHaveLength(1)
    expect(restarted.status()).toMatchObject({ quotaUsed: 1, circuit: 'ok' })
    await restarted.dispose()
  })

  it('fails closed instead of choosing between overlapping executor routes', async (): Promise<void> => {
    const clock = new MutableClock()
    const { store, claims } = await state(clock)
    await store.create({
      title: 'Ambiguous browser task',
      status: 'todo',
      hostScope: 'ubuntu',
      priority: 'P1',
      acceptance: 'One executor owns the task',
      tags: ['auto-ok', 'browser'],
    })
    const fallback = vi.fn<NightTaskExecutor['execute']>()
    const first = vi.fn<NightTaskExecutor['execute']>()
    const second = vi.fn<NightTaskExecutor['execute']>()
    const scheduler = new DefaultNightScheduler({
      store,
      claims,
      executor: { execute: fallback },
      config: CONFIG,
      hostScope: 'ubuntu',
      clock,
    })
    const unregisterFirst = scheduler.registerTaskExecutor({
      id: 'browser-first',
      matches: (task): boolean => task.tags.includes('browser'),
      executor: { execute: first },
    })
    const unregisterSecond = scheduler.registerTaskExecutor({
      id: 'browser-second',
      matches: (task): boolean => task.tags.includes('browser'),
      executor: { execute: second },
    })

    await scheduler.triggerOnce()

    expect(fallback).not.toHaveBeenCalled()
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    const [failed] = await store.query({ statuses: ['todo'] })
    expect(failed).toMatchObject({ failureCount: 1, claim: null })
    expect(failed?.outputs.at(-1)?.summary).toContain('Multiple night task executors match task')
    expect(scheduler.status()).toMatchObject({ quotaUsed: 0, circuit: 'ok' })

    unregisterSecond()
    unregisterFirst()
    await scheduler.dispose()
  })

  it('does not claim tasks outside either the tag or host whitelist', async (): Promise<void> => {
    const clock = new MutableClock()
    const { store, claims } = await state(clock)
    await store.create({
      title: 'Manual only',
      status: 'todo',
      hostScope: 'ubuntu',
      priority: 'P1',
      acceptance: 'A human runs it',
      tags: ['manual'],
    })
    await store.create({
      title: 'Wrong host',
      status: 'todo',
      hostScope: 'win',
      priority: 'P1',
      acceptance: 'Runs on Windows',
      tags: ['auto-ok'],
    })
    const execute = vi.fn<NightTaskExecutor['execute']>()
    const tagRestricted = new DefaultNightScheduler({
      store,
      claims,
      executor: { execute },
      config: CONFIG,
      hostScope: 'ubuntu',
      clock,
    })
    await tagRestricted.triggerOnce()
    expect(execute).not.toHaveBeenCalled()
    await tagRestricted.dispose()

    const hostRestricted = new DefaultNightScheduler({
      store,
      claims: new DefaultAgentClaimService(store, 'win', true),
      executor: { execute },
      config: CONFIG,
      hostScope: 'win',
      clock,
    })
    await hostRestricted.triggerOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(await store.query({ statuses: ['todo'] })).toHaveLength(2)
    await hostRestricted.dispose()
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

  it('records an executor version conflict when the scheduler still owns the claim', async (): Promise<void> => {
    const clock = new MutableClock()
    const { store, claims } = await state(clock)
    await store.create({
      title: 'Executor-local conflict',
      status: 'todo',
      hostScope: 'ubuntu',
      priority: 'P1',
      acceptance: 'The task returns safely to todo',
      tags: ['auto-ok'],
    })
    const scheduler = new DefaultNightScheduler({
      store,
      claims,
      executor: {
        execute: (): Promise<TaskOutput> =>
          Promise.reject(
            new LubanError('E_VERSION_CONFLICT', 'Executor workspace version changed', {
              retriable: true,
            }),
          ),
      },
      config: CONFIG,
      hostScope: 'ubuntu',
      clock,
    })

    await scheduler.triggerOnce()

    const [failed] = await store.query({ statuses: ['todo'] })
    expect(failed).toMatchObject({ status: 'todo', claim: null, failureCount: 1 })
    expect(failed?.outputs.at(-1)?.summary).toBe('Executor workspace version changed')
    expect(scheduler.status()).toMatchObject({ quotaUsed: 0, circuit: 'ok' })
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
