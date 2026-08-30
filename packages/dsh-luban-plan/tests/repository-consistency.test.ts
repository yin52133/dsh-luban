import type * as FsPromises from 'node:fs/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccountId, Clock } from 'dsh-luban-core'
import { LubanError, asAccountId } from 'dsh-luban-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const failures = vi.hoisted(() => ({
  documentFile: '',
  documentPublishes: 0,
  failDocumentRollback: false,
  failStatePublish: false,
  stateFile: '',
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    rename: async (source: string, target: string): Promise<void> => {
      if (target === failures.stateFile && failures.failStatePublish) {
        throw Object.assign(new Error('simulated state publish failure'), { code: 'EIO' })
      }
      if (target === failures.documentFile) {
        failures.documentPublishes += 1
        if (failures.failDocumentRollback && failures.documentPublishes === 2) {
          throw Object.assign(new Error('simulated document rollback failure'), { code: 'EIO' })
        }
      }
      await fs.rename(source, target)
    },
  }
})

import { PlanRepository } from '../src/repository.js'

const ALICE: AccountId = asAccountId('alice')
const clock: Clock = { now: (): number => 1_788_067_200_000 }
const sections = {
  background: 'Need a stable update',
  impact: 'Plan repository only',
  changes: 'repository.ts',
  verification: 'repository consistency tests',
} as const

describe('PlanRepository update consistency', () => {
  let directory = ''

  beforeEach(async (): Promise<void> => {
    directory = await mkdtemp(join(tmpdir(), 'luban-plan-repository-'))
    failures.documentFile = ''
    failures.documentPublishes = 0
    failures.failDocumentRollback = false
    failures.failStatePublish = false
    failures.stateFile = join(directory, 'state.json')
  })

  afterEach(async (): Promise<void> => {
    failures.failDocumentRollback = false
    failures.failStatePublish = false
    await rm(directory, { recursive: true, force: true })
  })

  it('restores the Markdown projection when the JSON publish fails', async (): Promise<void> => {
    const repository = new PlanRepository(failures.stateFile, 'docs/plans', clock)
    const created = await repository.create({
      accountId: ALICE,
      workspace: directory,
      slug: 'consistent-update',
      sections,
    })
    failures.documentFile = join(directory, ...created.filePath.split('/'))
    const originalState = await readFile(failures.stateFile, 'utf8')
    const originalDocument = await readFile(failures.documentFile, 'utf8')
    failures.failStatePublish = true

    await expect(
      repository.update(created.id, created.version, (current) => ({
        ...current,
        sections: { ...current.sections, verification: 'new verification' },
        version: current.version + 1,
      })),
    ).rejects.toMatchObject({ code: 'E_IO' })

    failures.failStatePublish = false
    expect(await readFile(failures.stateFile, 'utf8')).toBe(originalState)
    expect(await readFile(failures.documentFile, 'utf8')).toBe(originalDocument)
    await expect(repository.all()).resolves.toEqual([created])
  })

  it('preserves both failures when the Markdown reconciliation also fails', async (): Promise<void> => {
    const repository = new PlanRepository(failures.stateFile, 'docs/plans', clock)
    const created = await repository.create({
      accountId: ALICE,
      workspace: directory,
      slug: 'failed-reconciliation',
      sections,
    })
    failures.documentFile = join(directory, ...created.filePath.split('/'))
    failures.failDocumentRollback = true
    failures.failStatePublish = true

    const failure = await repository
      .update(created.id, created.version, (current) => ({
        ...current,
        sections: { ...current.sections, verification: 'new verification' },
        version: current.version + 1,
      }))
      .catch((error: unknown): unknown => error)

    if (!(failure instanceof LubanError)) throw new Error('Expected a LubanError')
    expect(failure.code).toBe('E_IO')
    expect(failure.details?.persistenceError).toContain('Unable to atomically write')
    expect(failure.details?.reconciliationError).toContain('Unable to write plan document')
    const cause = failure.cause
    if (!(cause instanceof AggregateError)) throw new Error('Expected an AggregateError cause')
    const causes: unknown = cause.errors
    expect(causes).toBeInstanceOf(Array)
    expect(causes).toHaveLength(2)
  })
})
