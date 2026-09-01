import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { AccountId, Clock, Task, TaskClaim, TaskOutput } from '@yin52133/dsh-luban-core'
import {
  AtomicJsonStore,
  asAccountId,
  asActorId,
  asHostId,
  asSessionId,
} from '@yin52133/dsh-luban-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DefaultAgentClaimService } from '../src/claim-service.js'
import type { NightConfig } from '../src/config.js'
import { createLedgerStore, decodeLedger, emptyLedger, type TaskLedger } from '../src/ledger.js'
import { DefaultNightScheduler, type NightTaskExecutor } from '../src/night-scheduler.js'
import { JsonTaskStore } from '../src/task-store.js'

const directories = new Set<string>()
const ACCOUNT = asAccountId('alice')

class MutableClock implements Clock {
  public value = new Date(2026, 7, 30, 1, 0, 0).getTime()

  public now(): number {
    return this.value
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((fulfill): void => {
    resolve = fulfill
  })
  return {
    promise,
    resolve(value): void {
      if (resolve === undefined) throw new Error('Deferred resolver is unavailable')
      resolve(value)
    },
  }
}

const CONFIG: NightConfig = {
  enabled: true,
  window: '00:00-23:59',
  dailyQuota: 1,
  hostScopeWhitelist: ['ubuntu'],
  tagWhitelist: ['auto-ok'],
  model: { provider: 'night-provider', id: 'night-model' },
  toolAllowlist: [],
  circuitBreaker: { maxConsecutiveFailures: 2 },
}

async function state(clock: Clock): Promise<{
  readonly ledgerPath: string
  readonly ledger: AtomicJsonStore<TaskLedger>
  readonly store: JsonTaskStore
  readonly claims: DefaultAgentClaimService
}> {
  const directory = join(tmpdir(), `dsh-luban-scheduler-atomic-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  directories.add(directory)
  const ledgerPath = join(directory, 'ledger.json')
  const ledger = createLedgerStore(ledgerPath, clock)
  const store = new JsonTaskStore(ledger, clock)
  return {
    ledgerPath,
    ledger,
    store,
    claims: new DefaultAgentClaimService(store, 'ubuntu', true),
  }
}

async function createNightTask(store: JsonTaskStore, title: string): Promise<Task> {
  return store.create({
    accountId: ACCOUNT,
    title,
    status: 'todo',
    hostScope: 'ubuntu',
    priority: 'P1',
    acceptance: 'The durable result is verified',
    tags: ['auto-ok'],
  })
}

function claimSession(id: string): {
  readonly actor: {
    readonly kind: 'agent'
    readonly id: ReturnType<typeof asActorId>
    readonly accountId: AccountId
  }
  readonly sessionId: ReturnType<typeof asSessionId>
  readonly host: ReturnType<typeof asHostId>
  readonly executionOwner: 'night-scheduler'
} {
  return {
    actor: { kind: 'agent', id: asActorId(id), accountId: ACCOUNT },
    sessionId: asSessionId(id),
    host: asHostId('ubuntu'),
    executionOwner: 'night-scheduler',
  }
}

function expectedClaim(task: Task): TaskClaim {
  if (task.claim === undefined || task.claim === null) throw new Error('night claim is missing')
  return task.claim
}

function output(task: Task, clock: Clock, summary = 'completed'): TaskOutput {
  const claim = expectedClaim(task)
  return {
    kind: 'note',
    ref: `result:${task.id}`,
    summary,
    at: clock.now(),
    by: claim.actor,
  }
}

function scheduler(
  store: JsonTaskStore,
  clock: Clock,
  executor: NightTaskExecutor,
): DefaultNightScheduler {
  return new DefaultNightScheduler({
    store,
    claims: new DefaultAgentClaimService(store, 'ubuntu', true),
    executor,
    config: CONFIG,
    hostScope: 'ubuntu',
    clock,
  })
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { force: true, recursive: true })
      directories.delete(directory)
    }),
  )
})

describe('night scheduler atomic ledger transactions', (): void => {
  it('reserves capacity under the ledger lock so two schedulers cannot oversell', async (): Promise<void> => {
    const clock = new MutableClock()
    const { ledgerPath, store } = await state(clock)
    await createNightTask(store, 'First concurrent task')
    await createNightTask(store, 'Second concurrent task')
    const secondStore = new JsonTaskStore(createLedgerStore(ledgerPath, clock), clock)
    const started = deferred<undefined>()
    const release = deferred<undefined>()
    const execute = vi.fn(async (task: Task): Promise<TaskOutput> => {
      started.resolve(undefined)
      await release.promise
      return output(task, clock)
    })
    const first = scheduler(store, clock, { execute })
    const second = scheduler(secondStore, clock, { execute })

    const firstRun = first.triggerOnce()
    try {
      await started.promise
      await second.triggerOnce()
      expect(execute).toHaveBeenCalledOnce()
      expect(second.status()).toMatchObject({ quotaUsed: 1, circuit: 'ok' })
    } finally {
      release.resolve(undefined)
      await firstRun
      await Promise.all([first.dispose(), second.dispose()])
    }

    const reopened = new JsonTaskStore(createLedgerStore(ledgerPath, clock), clock)
    expect(await reopened.query({ statuses: ['review'] })).toHaveLength(1)
    expect(await reopened.query({ statuses: ['todo'] })).toHaveLength(1)
    expect(await reopened.schedulerLedger(ACCOUNT)).toMatchObject({
      quotaUsed: 1,
      consecutiveFailures: 0,
      circuit: 'ok',
    })
  })

  it('does not charge or reset the new day when a previous-day reservation settles', async (): Promise<void> => {
    const clock = new MutableClock()
    const { store, claims } = await state(clock)
    await createNightTask(store, 'Previous day run')
    await createNightTask(store, 'Current day failure')
    const first = await claims.claimNight(
      { accountId: ACCOUNT, tags: ['auto-ok'], requireAcceptance: true },
      claimSession('night-day-one'),
      { dateKey: '2026-08-30', dailyQuota: 1 },
    )
    if (!first.ok) throw new Error(`first claim failed: ${first.reason}`)

    clock.value += 24 * 60 * 60 * 1_000
    const second = await claims.claimNight(
      { accountId: ACCOUNT, tags: ['auto-ok'], requireAcceptance: true },
      claimSession('night-day-two'),
      { dateKey: '2026-08-31', dailyQuota: 1 },
    )
    if (!second.ok) throw new Error(`second claim failed: ${second.reason}`)
    const failed = await claims.failNight(second.task.id, 'new-day provider failure', {
      expectedClaim: expectedClaim(second.task),
      maxConsecutiveFailures: 2,
    })
    expect(failed.scheduler).toMatchObject({
      dateKey: '2026-08-31',
      quotaUsed: 0,
      consecutiveFailures: 1,
      circuit: 'ok',
    })

    const completed = await claims.completeNight(first.task.id, output(first.task, clock), {
      expectedClaim: expectedClaim(first.task),
      autoDone: true,
      dailyQuota: 1,
    })
    expect(completed.scheduler).toEqual(failed.scheduler)
    expect(completed.quotaAllocated).toBe(0)
    expect(await store.query({ statuses: ['review'] })).toHaveLength(1)
    expect(await store.query({ statuses: ['todo'] })).toHaveLength(1)
  })

  it('rejects stale claim and mismatched run identities without changing scheduler state', async (): Promise<void> => {
    const clock = new MutableClock()
    const { ledger, store, claims } = await state(clock)
    await createNightTask(store, 'CAS-protected run')
    const session = claimSession('night-cas')
    const first = await claims.claimNight({ accountId: ACCOUNT }, session, {
      dateKey: '2026-08-30',
      dailyQuota: 1,
    })
    if (!first.ok) throw new Error(`first claim failed: ${first.reason}`)
    await store.transition(first.task.id, 'todo', {
      kind: 'user',
      id: asActorId('operator'),
    })
    const second = await claims.claimNight({ accountId: ACCOUNT }, session, {
      dateKey: '2026-08-30',
      dailyQuota: 1,
    })
    if (!second.ok) throw new Error(`second claim failed: ${second.reason}`)

    await expect(
      claims.completeNight(first.task.id, output(first.task, clock, 'stale result'), {
        expectedClaim: expectedClaim(first.task),
        autoDone: true,
        dailyQuota: 1,
      }),
    ).rejects.toMatchObject({ code: 'E_VERSION_CONFLICT', retriable: true })

    await ledger.update((current): TaskLedger => ({
      ...current,
      tasks: current.tasks.map((task): Task =>
        task.id === second.task.id ? { ...task, nightRunId: '2026-08-30:wrong-run' } : task,
      ),
    }))
    await expect(
      claims.completeNight(second.task.id, output(second.task, clock, 'wrong run result'), {
        expectedClaim: expectedClaim(second.task),
        autoDone: true,
        dailyQuota: 1,
      }),
    ).rejects.toMatchObject({ code: 'E_VERSION_CONFLICT', retriable: true })

    expect(await store.schedulerLedger(ACCOUNT)).toMatchObject({
      quotaUsed: 0,
      consecutiveFailures: 0,
      circuit: 'ok',
    })
    expect(await store.get(second.task.id)).toMatchObject({
      status: 'doing',
      claim: second.task.claim,
    })
  })

  it('keeps task and scheduler state together when killed at the publish boundary', async (): Promise<void> => {
    const clock = new MutableClock()
    const { ledgerPath, store, claims } = await state(clock)
    const task = await createNightTask(store, 'Crash-safe settlement')
    const claimed = await claims.claimNight({ accountId: ACCOUNT }, claimSession('night-crash'), {
      dateKey: '2026-08-30',
      dailyQuota: 1,
    })
    if (!claimed.ok) throw new Error(`claim failed: ${claimed.reason}`)
    const claim = expectedClaim(claimed.task)
    const writerPath = fileURLToPath(
      new URL('./fixtures/night-settlement-writer.ts', import.meta.url),
    )
    const writer = spawn(
      process.execPath,
      ['--import', 'tsx', writerPath, ledgerPath, task.id, String(clock.now()), '1'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let writerOutput = ''
    let writerError = ''
    writer.stdout.setEncoding('utf8')
    writer.stdout.on('data', (chunk: string): void => {
      writerOutput += chunk
    })
    writer.stderr.setEncoding('utf8')
    writer.stderr.on('data', (chunk: string): void => {
      writerError += chunk
    })
    const writerExit = new Promise<{
      readonly code: number | null
      readonly signal: string | null
    }>((resolve, reject): void => {
      writer.once('error', reject)
      writer.once('exit', (code, signal): void => resolve({ code, signal }))
    })

    try {
      await new Promise<void>((resolve, reject): void => {
        const timeout = setTimeout((): void => {
          reject(new Error(`writer did not reach publish boundary: ${writerError}`))
        }, 10_000)
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          clearTimeout(timeout)
          writer.stdout.off('data', onOutput)
          reject(
            new Error(
              `writer exited before publish boundary (${String(code)}, ${String(signal)}): ${writerError}`,
            ),
          )
        }
        const onOutput = (): void => {
          if (!writerOutput.includes('before-publish\n')) return
          clearTimeout(timeout)
          writer.off('exit', onExit)
          writer.stdout.off('data', onOutput)
          resolve()
        }
        writer.stdout.on('data', onOutput)
        writer.once('exit', onExit)
      })
      expect(writer.kill('SIGKILL')).toBe(true)
      const exit = await writerExit
      expect(exit.signal !== null || exit.code !== 0).toBe(true)
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) {
        writer.kill('SIGKILL')
        await writerExit.catch((): undefined => undefined)
      }
    }

    const reopenedLedger = new AtomicJsonStore<TaskLedger>({
      filePath: ledgerPath,
      codec: { decode: decodeLedger, encode: (value): unknown => value },
      initial: (): TaskLedger => emptyLedger('2026-08-30'),
      lockTimeoutMs: 1_000,
      staleLockMs: 0,
      backupCount: 0,
    })
    const reopened = new JsonTaskStore(reopenedLedger, clock)
    expect(await reopened.get(task.id)).toMatchObject({ status: 'doing', claim })
    expect(await reopened.schedulerLedger(ACCOUNT)).toMatchObject({
      quotaUsed: 0,
      consecutiveFailures: 0,
      circuit: 'ok',
    })
    expect((await reopened.nightSchedulerSnapshot(ACCOUNT, '2026-08-30')).quotaAllocated).toBe(1)

    const retried = await new DefaultAgentClaimService(reopened, 'ubuntu', true).completeNight(
      task.id,
      output(claimed.task, clock, 'retried settlement'),
      { expectedClaim: claim, autoDone: true, dailyQuota: 1 },
    )
    expect(retried.task).toMatchObject({ status: 'review', autoDone: true, claim: null })
    expect(retried.scheduler).toMatchObject({ quotaUsed: 1, consecutiveFailures: 0 })
  })
})
