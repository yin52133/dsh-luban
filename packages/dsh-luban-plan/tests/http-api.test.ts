import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthService, Clock } from '@luban/core'
import { PlanHttpApi } from '../src/http-api.js'
import { PlanRepository } from '../src/repository.js'
import { FilePlanService } from '../src/service.js'

function auth(allowed = true): AuthService {
  return {
    verify: vi.fn<AuthService['verify']>(),
    issueSession: vi.fn<AuthService['issueSession']>(),
    revoke: vi.fn<AuthService['revoke']>(),
    revokeAllFor: vi.fn<AuthService['revokeAllFor']>(),
    middleware: (): ReturnType<AuthService['middleware']> => () =>
      Promise.resolve(
        allowed
          ? { allowed: true, status: 200, user: 'reviewer' }
          : { allowed: false, status: 401 },
      ),
    onChange: vi.fn<AuthService['onChange']>().mockReturnValue((): void => undefined),
  }
}

describe('PlanHttpApi', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (path): Promise<void> => {
        await rm(path, { recursive: true, force: true })
      }),
    )
  })

  it('serves authenticated submit, list, decision, and Markdown document routes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luban-plan-api-'))
    directories.push(directory)
    const clock: Clock = { now: (): number => 1_788_067_200_000 }
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      protectedTools: ['write'],
      exemptTools: [],
    })
    await service.initialize()
    const api = new PlanHttpApi(service, auth())
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    const root = `http://127.0.0.1:${String(address.port)}`
    try {
      const createdResponse = await fetch(`${root}/luban-plan/plans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace: directory,
          slug: 'api-plan',
          sections: {
            background: 'why',
            impact: 'scope',
            changes: 'file',
            verification: 'tests',
          },
        }),
      })
      expect(createdResponse.status).toBe(201)
      const created = (await createdResponse.json()) as {
        readonly plan: { readonly id: string; readonly version: number }
      }
      const decisionResponse = await fetch(`${root}/luban-plan/plans/${created.plan.id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', expectedVersion: created.plan.version }),
      })
      expect(decisionResponse.status).toBe(200)
      const listed = (await (await fetch(`${root}/luban-plan/plans`)).json()) as {
        readonly plans: readonly unknown[]
      }
      expect(listed.plans).toHaveLength(1)
      const document = await fetch(`${root}/luban-plan/plans/${created.plan.id}/document`)
      expect(document.headers.get('content-type')).toContain('text/markdown')
      expect(await document.text()).toContain('Status: `approved`')
    } finally {
      api.dispose()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      )
    }
  })

  it('rejects unauthenticated callers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luban-plan-auth-'))
    directories.push(directory)
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', {
        now: (): number => 1,
      }),
      protectedTools: [],
      exemptTools: [],
    })
    await service.initialize()
    const api = new PlanHttpApi(service, auth(false))
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server did not bind')
    try {
      expect(
        (await fetch(`http://127.0.0.1:${String(address.port)}/luban-plan/plans`)).status,
      ).toBe(401)
    } finally {
      api.dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
