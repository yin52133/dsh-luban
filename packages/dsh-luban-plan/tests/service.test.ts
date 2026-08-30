import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountId, AccountSessionRegistry, Clock, Task, TaskStore } from 'dsh-luban-core'
import { LubanError, asAccountId, asActorId, asPlanId, asSessionId, asTaskId } from 'dsh-luban-core'
import { PlanRepository } from '../src/repository.js'
import type { AccountActor, PlanFeedbackEvent } from '../src/service.js'
import { FilePlanService } from '../src/service.js'

const ALICE = asAccountId('alice')
const BOB = asAccountId('bob')
const reviewer: AccountActor = {
  kind: 'user',
  id: asActorId('alice'),
  accountId: ALICE,
  displayName: 'Alice',
}
const sections = {
  background: 'Need a safe change',
  impact: 'One plugin',
  changes: 'src/index.ts',
  verification: 'lint, typecheck, build, tests',
} as const

async function createDirectoryLink(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

function todoTask(): Task {
  return {
    accountId: ALICE,
    id: asTaskId('T-1'),
    title: 'Task',
    description: '',
    status: 'todo',
    hostScope: 'any',
    priority: 'P2',
    tags: [],
    version: 1,
    outputs: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

function memoryAccountSessions(): AccountSessionRegistry {
  const owners = new Map<string, AccountId>()
  return {
    bind(accountId, sessionId): Promise<void> {
      const owner = owners.get(sessionId)
      if (owner !== undefined && owner !== accountId) {
        throw new LubanError('E_ACCOUNT_SCOPE_MISMATCH', 'Session belongs to another account')
      }
      owners.set(sessionId, accountId)
      return Promise.resolve()
    },
    ownerOf(sessionId): Promise<AccountId | null> {
      return Promise.resolve(owners.get(sessionId) ?? null)
    },
  }
}

describe('FilePlanService', () => {
  let directory = ''
  let now = 1_788_067_200_000
  let clock: Clock
  let accountSessions: AccountSessionRegistry

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'luban-plan-'))
    clock = { now: (): number => now }
    accountSessions = memoryAccountSessions()
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('persists an in-review document, approves it, gates tools, and advances a linked task', async () => {
    const transitions = vi
      .fn<TaskStore['transition']>()
      .mockResolvedValue({ ...todoTask(), status: 'doing' })
    const taskStore: TaskStore = {
      create: vi.fn<TaskStore['create']>(),
      update: vi.fn<TaskStore['update']>(),
      transition: transitions,
      get: vi.fn<TaskStore['get']>().mockResolvedValue(todoTask()),
      query: vi.fn<TaskStore['query']>().mockResolvedValue([]),
      subscribe: vi.fn<TaskStore['subscribe']>().mockReturnValue((): void => undefined),
    }
    const feedback: PlanFeedbackEvent[] = []
    const repository = new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock)
    const service = new FilePlanService({
      repository,
      accountSessions,
      protectedTools: ['edit', 'bash', 'write'],
      exemptTools: [],
      taskStore,
      sink: {
        deliver: (event): void => {
          feedback.push(event)
        },
      },
    })
    await service.initialize()
    await accountSessions.bind(ALICE, asSessionId('session-1'))
    const submitted = await service.submit({
      accountId: ALICE,
      workspace: directory,
      slug: 'Safe Change',
      taskId: asTaskId('T-1'),
      sessionId: asSessionId('session-1'),
      sections,
    })
    expect(submitted.status).toBe('in-review')
    expect(submitted.filePath).toMatch(
      /^docs\/plans\/\d{4}-\d{2}-\d{2}-safe-change-[0-9a-f]{8}\.md$/u,
    )
    expect(service.guard().assertExecutable('apply_patch', submitted).ok).toBe(false)
    expect(await readFile(join(directory, submitted.filePath), 'utf8')).toContain(
      '## 4. Verification',
    )

    now += 1
    await expect(
      service.decide(
        submitted.id,
        {
          decision: 'approve',
          expectedVersion: 99,
        },
        reviewer,
      ),
    ).rejects.toMatchObject({ code: 'E_VERSION_CONFLICT' })
    const approved = await service.decide(
      submitted.id,
      {
        decision: 'approve',
        comment: 'Looks safe',
        expectedVersion: submitted.version,
      },
      reviewer,
    )
    expect(approved.status).toBe('approved')
    expect(service.currentForSession(asSessionId('session-1'))).toMatchObject({
      status: 'approved',
    })
    expect(service.guard().assertExecutable('apply_patch', approved)).toEqual({ ok: true })
    expect(transitions).toHaveBeenCalledWith(
      asTaskId('T-1'),
      'doing',
      reviewer,
      expect.stringContaining('Approved plan'),
    )
    expect(feedback.at(-1)).toMatchObject({ decision: 'approve', status: 'approved' })

    const executing = await service.transition(approved.id, 'executing', approved.version, ALICE)
    const completed = await service.transition(executing.id, 'completed', executing.version, ALICE)
    expect(completed.status).toBe('completed')
    await expect(
      service.transition(completed.id, 'executing', completed.version, ALICE),
    ).rejects.toMatchObject({
      code: 'E_INVALID_TRANSITION',
    })

    const reloaded = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      accountSessions,
      protectedTools: ['write'],
      exemptTools: [],
    })
    await reloaded.initialize()
    expect(await reloaded.get(completed.id, ALICE)).toMatchObject({
      status: 'completed',
      version: 4,
    })
  })

  it('requires structured rejection feedback and supports revise-to-review', async () => {
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      accountSessions,
      protectedTools: ['write'],
      exemptTools: [],
    })
    await service.initialize()
    await accountSessions.bind(ALICE, asSessionId('session-r'))
    const submitted = await service.submit({
      accountId: ALICE,
      workspace: directory,
      slug: 'revision',
      sections,
      sessionId: asSessionId('session-r'),
    })
    await expect(
      service.decide(
        submitted.id,
        {
          decision: 'reject',
          expectedVersion: submitted.version,
        },
        reviewer,
      ),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
    const rejected = await service.decide(
      submitted.id,
      {
        decision: 'reject',
        comment: 'Add rollback verification',
        expectedVersion: submitted.version,
      },
      reviewer,
    )
    expect(rejected.decisions[0]).toMatchObject({
      decision: 'reject',
      comment: 'Add rollback verification',
    })
    const revising = await service.transition(rejected.id, 'revising', rejected.version, ALICE)
    expect(revising.status).toBe('revising')
    const revised = await service.revise(
      revising.id,
      {
        ...sections,
        verification: 'lint, tests, and rollback drill',
      },
      revising.version,
      ALICE,
    )
    expect(revised).toMatchObject({ status: 'in-review', version: 4 })
    expect(await service.getDocument(revised.id, ALICE)).toContain('rollback drill')
  })

  it('persists incomplete drafts but refuses review until all four sections are present', async () => {
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      accountSessions,
      protectedTools: ['write'],
      exemptTools: [],
    })
    await service.initialize()
    const draft = await service.saveDraft({
      accountId: ALICE,
      workspace: directory,
      slug: 'draft',
      sections: { ...sections, verification: '' },
    })
    expect(draft.status).toBe('draft')
    await expect(
      service.transition(draft.id, 'in-review', draft.version, ALICE),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' })
  })

  it('fails closed when a linked task cannot be ownership-checked', async () => {
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      accountSessions,
      protectedTools: [],
      exemptTools: [],
    })
    await service.initialize()

    await expect(
      service.submit({
        accountId: ALICE,
        taskId: asTaskId('T-unavailable'),
        workspace: directory,
        slug: 'task-unavailable',
        sections,
      }),
    ).rejects.toMatchObject({ code: 'E_UNAVAILABLE' })
  })

  it('isolates Alice and Bob plans, session bindings, mutations, and feedback', async () => {
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      accountSessions,
      protectedTools: [],
      exemptTools: [],
    })
    await service.initialize()
    await accountSessions.bind(ALICE, asSessionId('alice-session'))
    await accountSessions.bind(BOB, asSessionId('bob-session'))
    const aliceFeedback: PlanFeedbackEvent[] = []
    const bobFeedback: PlanFeedbackEvent[] = []
    service.subscribeFeedback(ALICE, undefined, (event): void => {
      aliceFeedback.push(event)
    })
    service.subscribeFeedback(BOB, undefined, (event): void => {
      bobFeedback.push(event)
    })

    const alicePlan = await service.submit({
      accountId: ALICE,
      workspace: directory,
      slug: 'alice-plan',
      sessionId: asSessionId('alice-session'),
      sections,
    })
    const bobPlan = await service.submit({
      accountId: BOB,
      workspace: directory,
      slug: 'bob-plan',
      sessionId: asSessionId('bob-session'),
      sections,
    })

    expect(alicePlan.accountId).toBe(ALICE)
    expect(bobPlan.accountId).toBe(BOB)
    await expect(service.listFor(undefined, ALICE)).resolves.toEqual([alicePlan])
    await expect(service.listFor(undefined, BOB)).resolves.toEqual([bobPlan])
    await expect(service.get(alicePlan.id, BOB)).resolves.toBeNull()
    await expect(service.getDocument(alicePlan.id, BOB)).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    })
    await expect(
      service.transition(alicePlan.id, 'approved', alicePlan.version, BOB),
    ).rejects.toMatchObject({ code: 'E_NOT_FOUND' })
    await expect(
      service.submit({
        accountId: BOB,
        workspace: directory,
        slug: 'session-takeover',
        sessionId: asSessionId('alice-session'),
        sections,
      }),
    ).rejects.toMatchObject({ code: 'E_ACCOUNT_SCOPE_MISMATCH' })
    await expect(
      service.submit({
        accountId: ALICE,
        workspace: directory,
        slug: 'unbound-session',
        sessionId: asSessionId('unbound-session'),
        sections,
      }),
    ).rejects.toMatchObject({ code: 'E_ACCOUNT_SCOPE_MISMATCH' })
    await expect(accountSessions.ownerOf(asSessionId('unbound-session'))).resolves.toBeNull()
    expect(aliceFeedback.map((event) => event.planId)).toEqual([alicePlan.id])
    expect(bobFeedback.map((event) => event.planId)).toEqual([bobPlan.id])

    const detached = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      accountSessions: memoryAccountSessions(),
      protectedTools: [],
      exemptTools: [],
    })
    await detached.initialize()
    expect(detached.currentForSession(asSessionId('alice-session'))).toBeNull()
    await expect(
      detached.decide(
        alicePlan.id,
        { decision: 'approve', expectedVersion: alicePlan.version },
        reviewer,
      ),
    ).rejects.toMatchObject({ code: 'E_ACCOUNT_SCOPE_MISMATCH' })
  })

  it('keeps legacy plans without account ownership explicitly unmigrated', async () => {
    await writeFile(
      join(directory, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        plans: [
          {
            id: 'P-legacy',
            sessionId: 'legacy-session',
            status: 'approved',
            sections,
            filePath: 'docs/plans/legacy.md',
            decisions: [],
            version: 1,
            workspace: directory,
            slug: 'legacy',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      'utf8',
    )
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      accountSessions,
      protectedTools: [],
      exemptTools: [],
    })
    await service.initialize()

    await expect(service.listFor(undefined, ALICE)).resolves.toEqual([])
    await expect(service.listFor(undefined, BOB)).resolves.toEqual([])
    await expect(service.get(asPlanId('P-legacy'), ALICE)).resolves.toBeNull()
    expect(service.currentForSession(asSessionId('legacy-session'))).toBeNull()
  })

  it('uses unique documents for same-day slugs without overwriting either plan', async () => {
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      accountSessions,
      protectedTools: [],
      exemptTools: [],
    })
    await service.initialize()
    const first = await service.submit({
      accountId: ALICE,
      workspace: directory,
      slug: 'same',
      sections,
    })
    const second = await service.submit({
      accountId: BOB,
      workspace: directory,
      slug: 'same',
      sections,
    })
    expect(second.filePath).not.toBe(first.filePath)
    await expect(readFile(join(directory, first.filePath), 'utf8')).resolves.toContain(first.id)
    await expect(readFile(join(directory, second.filePath), 'utf8')).resolves.toContain(second.id)
  })

  it('rejects a plans directory link that escapes the canonical workspace', async () => {
    const workspace = join(directory, 'workspace')
    const outside = join(directory, 'outside')
    await Promise.all([mkdir(workspace), mkdir(outside)])
    await createDirectoryLink(outside, join(workspace, 'docs'))
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      accountSessions,
      protectedTools: [],
      exemptTools: [],
    })
    await service.initialize()

    await expect(
      service.submit({ accountId: ALICE, workspace, slug: 'escape', sections }),
    ).rejects.toMatchObject({ code: 'E_IO' })
    await expect(readdir(outside)).resolves.toEqual([])
  })

  it('rejects a document-directory junction swapped after the identity fence is captured', async () => {
    const workspace = join(directory, 'workspace')
    const outside = join(directory, 'outside')
    await Promise.all([mkdir(workspace), mkdir(outside)])
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      accountSessions,
      protectedTools: [],
      exemptTools: [],
    })
    await service.initialize()
    const plan = await service.submit({
      accountId: ALICE,
      workspace,
      slug: 'identity-swap',
      sections,
    })
    const documentDirectory = join(workspace, 'docs', 'plans')
    await rm(documentDirectory, { recursive: true, force: true })
    await createDirectoryLink(outside, documentDirectory)

    await expect(
      service.decide(plan.id, { decision: 'approve', expectedVersion: plan.version }, reviewer),
    ).rejects.toMatchObject({ code: 'E_IO' })
    await expect(readdir(outside)).resolves.toEqual([])
  })
})
