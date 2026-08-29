import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor, Clock, Task, TaskStore } from '@luban/core'
import { asActorId, asSessionId, asTaskId } from '@luban/core'
import { PlanRepository } from '../src/repository.js'
import type { PlanFeedbackEvent } from '../src/service.js'
import { FilePlanService } from '../src/service.js'

const reviewer: Actor = { kind: 'user', id: asActorId('alice'), displayName: 'Alice' }
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

describe('FilePlanService', () => {
  let directory = ''
  let now = 1_788_067_200_000
  let clock: Clock

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'luban-plan-'))
    clock = { now: (): number => now }
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
    const submitted = await service.submit({
      workspace: directory,
      slug: 'Safe Change',
      taskId: asTaskId('T-1'),
      sessionId: asSessionId('session-1'),
      sections,
    })
    expect(submitted.status).toBe('in-review')
    expect(submitted.filePath).toMatch(/^docs\/plans\/\d{4}-\d{2}-\d{2}-safe-change\.md$/u)
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

    const executing = await service.transition(approved.id, 'executing', approved.version)
    const completed = await service.transition(executing.id, 'completed', executing.version)
    expect(completed.status).toBe('completed')
    await expect(
      service.transition(completed.id, 'executing', completed.version),
    ).rejects.toMatchObject({
      code: 'E_INVALID_TRANSITION',
    })

    const reloaded = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      protectedTools: ['write'],
      exemptTools: [],
    })
    await reloaded.initialize()
    expect(await reloaded.get(completed.id)).toMatchObject({ status: 'completed', version: 4 })
  })

  it('requires structured rejection feedback and supports revise-to-review', async () => {
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      protectedTools: ['write'],
      exemptTools: [],
    })
    await service.initialize()
    const submitted = await service.submit({
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
    const revising = await service.transition(rejected.id, 'revising', rejected.version)
    expect(revising.status).toBe('revising')
    const revised = await service.revise(
      revising.id,
      {
        ...sections,
        verification: 'lint, tests, and rollback drill',
      },
      revising.version,
    )
    expect(revised).toMatchObject({ status: 'in-review', version: 4 })
    expect(await service.getDocument(revised.id)).toContain('rollback drill')
  })

  it('persists incomplete drafts but refuses review until all four sections are present', async () => {
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      protectedTools: ['write'],
      exemptTools: [],
    })
    await service.initialize()
    const draft = await service.saveDraft({
      workspace: directory,
      slug: 'draft',
      sections: { ...sections, verification: '' },
    })
    expect(draft.status).toBe('draft')
    await expect(service.transition(draft.id, 'in-review', draft.version)).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    })
  })

  it('does not allow a second plan to overwrite a same-day slug document', async () => {
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      protectedTools: [],
      exemptTools: [],
    })
    await service.initialize()
    await service.submit({ workspace: directory, slug: 'same', sections })
    await expect(
      service.submit({ workspace: directory, slug: 'same', sections }),
    ).rejects.toMatchObject({
      code: 'E_VERSION_CONFLICT',
    })
  })

  it('rejects a plans directory link that escapes the canonical workspace', async () => {
    const workspace = join(directory, 'workspace')
    const outside = join(directory, 'outside')
    await Promise.all([mkdir(workspace), mkdir(outside)])
    await createDirectoryLink(outside, join(workspace, 'docs'))
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      protectedTools: [],
      exemptTools: [],
    })
    await service.initialize()

    await expect(service.submit({ workspace, slug: 'escape', sections })).rejects.toMatchObject({
      code: 'E_IO',
    })
    await expect(readdir(outside)).resolves.toEqual([])
  })

  it('rejects a document-directory junction swapped after the identity fence is captured', async () => {
    const workspace = join(directory, 'workspace')
    const outside = join(directory, 'outside')
    await Promise.all([mkdir(workspace), mkdir(outside)])
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      protectedTools: [],
      exemptTools: [],
    })
    await service.initialize()
    const plan = await service.submit({ workspace, slug: 'identity-swap', sections })
    const documentDirectory = join(workspace, 'docs', 'plans')
    await rm(documentDirectory, { recursive: true, force: true })
    await createDirectoryLink(outside, documentDirectory)

    await expect(
      service.decide(plan.id, { decision: 'approve', expectedVersion: plan.version }, reviewer),
    ).rejects.toMatchObject({ code: 'E_IO' })
    await expect(readdir(outside)).resolves.toEqual([])
  })
})
