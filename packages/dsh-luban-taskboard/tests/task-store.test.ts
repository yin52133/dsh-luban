import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Actor, Clock } from 'dsh-luban-core'
import { asAccountId, asActorId, asHostId, asSessionId } from 'dsh-luban-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DefaultAgentClaimService } from '../src/claim-service.js'
import { createLedgerStore, decodeLedger } from '../src/ledger.js'
import { JsonTaskStore } from '../src/task-store.js'

const directories = new Set<string>()

class TestClock implements Clock {
  public value = Date.UTC(2026, 7, 30, 1, 0, 0)
  public now(): number {
    return this.value++
  }
}

async function harness(): Promise<{
  readonly store: JsonTaskStore
  readonly claims: DefaultAgentClaimService
  readonly clock: TestClock
  readonly ledgerPath: string
}> {
  const directory = join(tmpdir(), `dsh-luban-taskboard-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  directories.add(directory)
  const clock = new TestClock()
  const ledgerPath = join(directory, 'ledger.json')
  const store = new JsonTaskStore(createLedgerStore(ledgerPath, clock), clock)
  return {
    store,
    claims: new DefaultAgentClaimService(store, 'ubuntu', true),
    clock,
    ledgerPath,
  }
}

const HUMAN: Actor = { kind: 'user', id: asActorId('alice'), displayName: 'Alice' }

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { force: true, recursive: true })
      directories.delete(directory)
    }),
  )
})

describe('JsonTaskStore', (): void => {
  it('does not copy legacy process-wide scheduler state into account ledgers', async (): Promise<void> => {
    const { store, ledgerPath } = await harness()
    await store.create({
      accountId: asAccountId('alice'),
      title: 'Alice task',
      hostScope: 'any',
      priority: 'P3',
    })
    await store.create({
      accountId: asAccountId('bob'),
      title: 'Bob task',
      hostScope: 'any',
      priority: 'P3',
    })

    const persisted = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, unknown>
    const legacy = Object.fromEntries(
      Object.entries(persisted).filter(([key]): boolean => key !== 'schedulers'),
    )
    const decoded = decodeLedger({
      ...legacy,
      scheduler: {
        dateKey: '2026-08-30',
        quotaUsed: 9,
        consecutiveFailures: 4,
        circuit: 'open',
      },
    })

    expect(decoded.scheduler).toMatchObject({ quotaUsed: 9, circuit: 'open' })
    expect(decoded.schedulers).toEqual({})
  })

  it('partitions queries, imports, and claims by account', async (): Promise<void> => {
    const { store, claims } = await harness()
    const alice = asAccountId('alice')
    const bob = asAccountId('bob')
    const aliceTask = await store.create({
      accountId: alice,
      title: 'Scoped task',
      status: 'todo',
      hostScope: 'ubuntu',
      priority: 'P1',
      acceptance: 'Alice owns this task',
    })
    const bobTask = await store.create({
      accountId: bob,
      title: 'Scoped task',
      status: 'todo',
      hostScope: 'ubuntu',
      priority: 'P1',
      acceptance: 'Bob owns this task',
    })

    expect((await store.query({ accountId: alice })).map((task) => task.id)).toEqual([aliceTask.id])
    expect((await store.query({ accountId: bob })).map((task) => task.id)).toEqual([bobTask.id])
    expect(await store.import([{ title: 'Imported' }], alice)).toMatchObject({ imported: 1 })
    expect(await store.import([{ title: 'Imported' }], bob)).toMatchObject({ imported: 1 })

    const claim = await claims.claim(
      { accountId: bob },
      {
        actor: { kind: 'agent', id: asActorId('bob-agent'), accountId: bob },
        sessionId: asSessionId('bob-session'),
        host: asHostId('ubuntu'),
      },
    )
    expect(claim).toMatchObject({ ok: true, task: { id: bobTask.id, accountId: 'bob' } })
    expect(await store.get(aliceTask.id)).toMatchObject({ status: 'todo', accountId: 'alice' })
  })

  it('enforces acceptance, legal transitions, and optimistic versions', async (): Promise<void> => {
    const { store } = await harness()
    const created = await store.create({
      title: 'Build firmware',
      hostScope: 'ubuntu',
      priority: 'P0',
    })

    await expect(store.transition(created.id, 'todo', HUMAN)).rejects.toMatchObject({
      code: 'E_ACCEPTANCE_REQUIRED',
    })
    const scheduled = await store.update(created.id, { acceptance: 'Artifact exists' }, 1)
    expect(scheduled.version).toBe(2)
    await expect(store.update(created.id, { title: 'stale' }, 1)).rejects.toMatchObject({
      code: 'E_VERSION_CONFLICT',
    })
    const todo = await store.transitionWithVersion(created.id, 'todo', HUMAN, 2)
    await expect(store.transition(todo.id, 'done', HUMAN)).rejects.toMatchObject({
      code: 'E_INVALID_TRANSITION',
    })
    expect(
      (await store.query({ statuses: ['todo'], hostScope: 'ubuntu' })).map((task) => task.id),
    ).toEqual([created.id])
  })

  it('allows exactly one concurrent claim and closes through review', async (): Promise<void> => {
    const { store, claims, clock } = await harness()
    const task = await store.create({
      title: 'Investigate failure',
      status: 'todo',
      hostScope: 'any',
      priority: 'P1',
      acceptance: 'Root cause documented',
      tags: ['auto-ok'],
    })
    const sessions = ['agent-a', 'agent-b'].map((id) => ({
      actor: { kind: 'agent' as const, id: asActorId(id) },
      sessionId: asSessionId(id),
      host: asHostId('builder'),
    }))

    const results = await Promise.all(sessions.map(async (session) => claims.claim({}, session)))
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    const claimed = await store.get(task.id)
    expect(claimed?.status).toBe('doing')
    expect(claimed?.claim).not.toBeNull()
    if (claimed?.claim === undefined || claimed.claim === null) throw new Error('claim missing')

    await claims.reportProgress(task.id, { summary: 'Halfway', percent: 50 })
    const completed = await claims.complete(
      task.id,
      {
        kind: 'commit',
        ref: 'abc1234',
        summary: 'Fix ready for review',
        at: clock.now(),
        by: claimed.claim.actor,
      },
      { autoDone: true },
    )
    expect(completed).toMatchObject({ status: 'review', autoDone: true, claim: null })
    expect(completed.outputs.map((output) => output.summary)).toEqual([
      'Halfway',
      'Fix ready for review',
    ])
    const accepted = await store.transition(completed.id, 'done', HUMAN)
    expect(accepted.autoDone).toBe(false)
  })

  it('persists the trusted execution owner and includes it in claim CAS identity', async (): Promise<void> => {
    const { store, claims, clock, ledgerPath } = await harness()
    const task = await store.create({
      title: 'Night-owned browser task',
      status: 'todo',
      hostScope: 'ubuntu',
      priority: 'P1',
      acceptance: 'The night scheduler owns terminal mutations',
    })
    const claimed = await claims.claim(
      {},
      {
        actor: { kind: 'agent', id: asActorId('luban-night-owner') },
        sessionId: asSessionId('luban-night-owner'),
        host: asHostId('ubuntu'),
        executionOwner: 'night-scheduler',
      },
    )
    if (!claimed.ok || claimed.task.claim === undefined || claimed.task.claim === null) {
      throw new Error('night claim missing')
    }
    const expectedClaim = claimed.task.claim

    await expect(
      claims.reportProgress(
        task.id,
        { summary: 'ownerless claim must not match', percent: 10 },
        {
          expectedClaim: {
            actor: expectedClaim.actor,
            sessionId: expectedClaim.sessionId,
            claimedAt: expectedClaim.claimedAt,
            ...(expectedClaim.leaseId === undefined ? {} : { leaseId: expectedClaim.leaseId }),
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'E_VERSION_CONFLICT', retriable: true })

    const reopened = new JsonTaskStore(createLedgerStore(ledgerPath, clock), clock)
    expect(await reopened.get(task.id)).toMatchObject({
      status: 'doing',
      claim: { executionOwner: 'night-scheduler' },
    })
  })

  it('records failure atomically and produces deterministic import reports', async (): Promise<void> => {
    const { store, claims } = await harness()
    const task = await store.create({
      title: 'Run tests',
      status: 'todo',
      hostScope: 'ubuntu',
      priority: 'P2',
      acceptance: 'Tests pass',
    })
    const session = {
      actor: { kind: 'agent' as const, id: asActorId('runner') },
      sessionId: asSessionId('runner'),
      host: asHostId('ubuntu'),
    }
    expect((await claims.claim({}, session)).ok).toBe(true)
    await claims.fail(task.id, 'Compiler unavailable')
    expect(await store.get(task.id)).toMatchObject({
      status: 'todo',
      failureCount: 1,
      version: 3,
      outputs: [{ kind: 'note', summary: 'Compiler unavailable' }],
    })

    const first = await store.import([
      { title: 'Imported one', hostScope: 'any' },
      { title: '', hostScope: 'any' },
    ])
    expect(first).toMatchObject({ imported: 1, skipped: 0, failed: 1 })
    const second = await store.import([{ title: 'Imported one', hostScope: 'any' }])
    expect(second).toMatchObject({ imported: 0, skipped: 1, failed: 0 })
  })

  it('rejects every stale claim mutation after an identical-clock reclaim', async (): Promise<void> => {
    const { store, claims, clock } = await harness()
    const task = await store.create({
      title: 'Serialize browser work',
      status: 'todo',
      hostScope: 'ubuntu',
      priority: 'P1',
      acceptance: 'The latest lease owns every mutation',
    })
    const session = {
      actor: { kind: 'agent' as const, id: asActorId('same-agent') },
      sessionId: asSessionId('same-session'),
      host: asHostId('ubuntu'),
    }
    const first = await claims.claim({}, session)
    if (!first.ok || first.task.claim === undefined || first.task.claim === null) {
      throw new Error('first claim missing')
    }
    const staleClaim = first.task.claim

    await store.transition(task.id, 'todo', HUMAN)
    clock.value = staleClaim.claimedAt
    const second = await claims.claim({}, session)
    if (!second.ok || second.task.claim === undefined || second.task.claim === null) {
      throw new Error('second claim missing')
    }
    const currentClaim = second.task.claim
    expect(currentClaim.claimedAt).toBe(staleClaim.claimedAt)
    expect(currentClaim.leaseId).not.toBe(staleClaim.leaseId)

    const conflicts = [
      (): Promise<void> =>
        claims.reportProgress(
          task.id,
          { summary: 'stale progress', percent: 50 },
          { expectedClaim: staleClaim },
        ),
      async (): Promise<void> => {
        await claims.complete(
          task.id,
          {
            kind: 'artifact',
            ref: 'stale-artifact',
            summary: 'stale completion',
            at: clock.now(),
            by: staleClaim.actor,
          },
          { autoDone: true, expectedClaim: staleClaim },
        )
      },
      (): Promise<void> => claims.fail(task.id, 'stale failure', { expectedClaim: staleClaim }),
    ]
    for (const conflict of conflicts) {
      await expect(conflict()).rejects.toMatchObject({
        code: 'E_VERSION_CONFLICT',
        retriable: true,
      })
    }
    await expect(
      claims.fail(task.id, 'legacy claim must not match a leased claim', {
        expectedClaim: {
          actor: currentClaim.actor,
          sessionId: currentClaim.sessionId,
          claimedAt: currentClaim.claimedAt,
        },
      }),
    ).rejects.toMatchObject({ code: 'E_VERSION_CONFLICT', retriable: true })

    expect(await store.get(task.id)).toMatchObject({
      status: 'doing',
      claim: currentClaim,
      outputs: [],
      failureCount: 0,
      version: 4,
    })
  })

  it('emits one committed event per task mutation', async (): Promise<void> => {
    const { store } = await harness()
    const events: string[] = []
    const dispose = store.subscribe((event): void => {
      events.push(event.type)
    })
    const task = await store.create({ title: 'Observe', hostScope: 'any', priority: 'P3' })
    await store.update(task.id, { description: 'changed' }, 1)
    dispose()
    await store.update(task.id, { description: 'not observed' }, 2)
    expect(events).toEqual(['created', 'updated'])
  })

  it('keeps a committed mutation successful when an observer fails', async (): Promise<void> => {
    const { store } = await harness()
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation((): void => undefined)
    const dispose = store.subscribe((): void => {
      throw new Error('observer failed')
    })
    try {
      const task = await store.create({ title: 'Committed', hostScope: 'any', priority: 'P3' })
      expect(await store.get(task.id)).toMatchObject({ title: 'Committed', version: 1 })
    } finally {
      dispose()
      warning.mockRestore()
    }
  })
})
