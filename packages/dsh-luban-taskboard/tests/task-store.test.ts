import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Actor, Clock } from '@luban/core'
import { asActorId, asHostId, asSessionId } from '@luban/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DefaultAgentClaimService } from '../src/claim-service.js'
import { createLedgerStore } from '../src/ledger.js'
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
}> {
  const directory = join(tmpdir(), `dsh-luban-taskboard-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  directories.add(directory)
  const clock = new TestClock()
  const store = new JsonTaskStore(createLedgerStore(join(directory, 'ledger.json'), clock), clock)
  return { store, claims: new DefaultAgentClaimService(store, 'ubuntu', true), clock }
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
