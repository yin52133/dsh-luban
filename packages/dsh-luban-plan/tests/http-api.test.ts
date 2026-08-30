import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountId, AccountSessionRegistry, AuthService, Clock } from 'dsh-luban-core'
import { LubanError, asAccountId, asPlanId, asSessionId } from 'dsh-luban-core'
import { PlanEventStream, PlanHttpApi } from '../src/http-api.js'
import { PlanRepository } from '../src/repository.js'
import { FilePlanService } from '../src/service.js'

const ALICE = asAccountId('alice')
const BOB = asAccountId('bob')

function accountSessions(): AccountSessionRegistry {
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

function auth(allowed = true): AuthService {
  const sessions = accountSessions()
  return {
    verify: vi.fn<AuthService['verify']>(),
    issueSession: vi.fn<AuthService['issueSession']>(),
    revoke: vi.fn<AuthService['revoke']>(),
    revokeAllFor: vi.fn<AuthService['revokeAllFor']>(),
    middleware: (): ReturnType<AuthService['middleware']> => (request) => {
      if (!allowed) return Promise.resolve({ allowed: false, status: 401 })
      const username = request.cookie?.includes('account=bob') === true ? 'bob' : 'alice'
      const accountId = username === 'bob' ? BOB : ALICE
      return Promise.resolve({
        allowed: true,
        status: 200,
        user: username,
        account: { accountId, username, role: 'operator' },
      })
    },
    onChange: vi.fn<AuthService['onChange']>().mockReturnValue((): void => undefined),
    accountSessions: sessions,
  }
}

class RecordingResponse extends EventEmitter {
  public statusCode = 0
  public writableEnded = false
  public readonly writes: string[] = []

  public setHeader(): this {
    return this
  }

  public flushHeaders(): void {
    return undefined
  }

  public write(chunk: string | Uint8Array): boolean {
    this.writes.push(String(chunk))
    return true
  }

  public end(): this {
    this.writableEnded = true
    return this
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

  it('serves versioned submit, decision, revise, list, and Markdown document routes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luban-plan-api-'))
    directories.push(directory)
    const clock: Clock = { now: (): number => 1_788_067_200_000 }
    const authService = auth()
    await authService.accountSessions.bind(ALICE, asSessionId('alice-session'))
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', clock),
      accountSessions: authService.accountSessions,
      protectedTools: ['write'],
      exemptTools: [],
    })
    await service.initialize()
    const api = new PlanHttpApi(service, authService)
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
          accountId: 'bob',
          workspace: directory,
          slug: 'api-plan',
          sessionId: 'alice-session',
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
        readonly plan: { readonly accountId: string; readonly id: string; readonly version: number }
      }
      expect(created.plan.accountId).toBe('alice')
      const decisionResponse = await fetch(`${root}/luban-plan/plans/${created.plan.id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'reject',
          comment: 'Add rollback verification',
          expectedVersion: created.plan.version,
        }),
      })
      expect(decisionResponse.status).toBe(200)
      const rejected = (await decisionResponse.json()) as {
        readonly plan: { readonly status: string; readonly version: number }
      }
      expect(rejected.plan).toMatchObject({ status: 'rejected', version: 2 })

      const revisedSections = {
        background: 'why',
        impact: 'scope',
        changes: 'file',
        verification: 'tests and rollback drill',
      }
      const reviseResponse = await fetch(`${root}/luban-plan/plans/${created.plan.id}/revise`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sections: revisedSections,
          expectedVersion: rejected.plan.version,
        }),
      })
      expect(reviseResponse.status).toBe(200)
      const revised = (await reviseResponse.json()) as {
        readonly plan: { readonly status: string; readonly version: number }
      }
      expect(revised.plan).toMatchObject({ status: 'in-review', version: 3 })

      const staleRevision = await fetch(`${root}/luban-plan/plans/${created.plan.id}/revise`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sections: revisedSections,
          expectedVersion: rejected.plan.version,
        }),
      })
      expect(staleRevision.status).toBe(409)
      await expect(staleRevision.json()).resolves.toMatchObject({
        error: { code: 'E_VERSION_CONFLICT' },
      })

      const approvalResponse = await fetch(`${root}/luban-plan/plans/${created.plan.id}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', expectedVersion: revised.plan.version }),
      })
      expect(approvalResponse.status).toBe(200)
      const listed = (await (await fetch(`${root}/luban-plan/plans`)).json()) as {
        readonly plans: readonly unknown[]
      }
      expect(listed.plans).toHaveLength(1)
      const document = await fetch(`${root}/luban-plan/plans/${created.plan.id}/document`)
      expect(document.headers.get('content-type')).toContain('text/markdown')
      const markdown = await document.text()
      expect(markdown).toContain('Status: `approved`')
      expect(markdown).toContain('tests and rollback drill')

      const bobCreateResponse = await fetch(`${root}/luban-plan/plans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'account=bob' },
        body: JSON.stringify({
          accountId: 'alice',
          workspace: directory,
          slug: 'bob-plan',
          sections: {
            background: 'bob why',
            impact: 'bob scope',
            changes: 'bob file',
            verification: 'bob tests',
          },
        }),
      })
      expect(bobCreateResponse.status).toBe(201)
      const bobCreated = (await bobCreateResponse.json()) as {
        readonly plan: { readonly accountId: string; readonly id: string; readonly version: number }
      }
      expect(bobCreated.plan.accountId).toBe('bob')
      const sessionTakeover = await fetch(`${root}/luban-plan/plans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'account=bob' },
        body: JSON.stringify({
          workspace: directory,
          slug: 'session-takeover',
          sessionId: 'alice-session',
          sections: {
            background: 'takeover',
            impact: 'scope',
            changes: 'file',
            verification: 'tests',
          },
        }),
      })
      expect(sessionTakeover.status).toBe(404)

      const aliceList = (await (await fetch(`${root}/luban-plan/plans?accountId=bob`)).json()) as {
        readonly plans: readonly { readonly id: string }[]
      }
      const bobList = (await (
        await fetch(`${root}/luban-plan/plans?accountId=alice`, {
          headers: { cookie: 'account=bob' },
        })
      ).json()) as { readonly plans: readonly { readonly id: string }[] }
      expect(aliceList.plans.map((plan) => plan.id)).toEqual([created.plan.id])
      expect(bobList.plans.map((plan) => plan.id)).toEqual([bobCreated.plan.id])

      expect(
        (
          await fetch(`${root}/luban-plan/plans/${created.plan.id}`, {
            headers: { cookie: 'account=bob' },
          })
        ).status,
      ).toBe(404)
      expect(
        (
          await fetch(`${root}/luban-plan/plans/${created.plan.id}/document`, {
            headers: { cookie: 'account=bob' },
          })
        ).status,
      ).toBe(404)
      expect(
        (
          await fetch(`${root}/luban-plan/plans/${created.plan.id}/transition`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: 'account=bob' },
            body: JSON.stringify({ to: 'executing', expectedVersion: 4 }),
          })
        ).status,
      ).toBe(404)
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
    const authService = auth(false)
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', {
        now: (): number => 1,
      }),
      accountSessions: authService.accountSessions,
      protectedTools: [],
      exemptTools: [],
    })
    await service.initialize()
    const api = new PlanHttpApi(service, authService)
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

  it('filters live and replayed SSE events by authenticated account', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luban-plan-events-'))
    directories.push(directory)
    const sessions = accountSessions()
    const service = new FilePlanService({
      repository: new PlanRepository(join(directory, 'state.json'), 'docs/plans', {
        now: (): number => 1_788_067_200_000,
      }),
      accountSessions: sessions,
      protectedTools: [],
      exemptTools: [],
    })
    await service.initialize()
    const events = new PlanEventStream(service)
    const aliceResponse = new RecordingResponse()
    const bobResponse = new RecordingResponse()
    events.connect(
      { headers: {} } as IncomingMessage,
      aliceResponse as unknown as ServerResponse,
      ALICE,
    )
    events.connect(
      { headers: {} } as IncomingMessage,
      bobResponse as unknown as ServerResponse,
      BOB,
    )

    const alicePlan = await service.submit({
      accountId: ALICE,
      workspace: directory,
      slug: 'alice-event',
      sections: {
        background: 'why',
        impact: 'scope',
        changes: 'file',
        verification: 'tests',
      },
    })
    const bobPlan = await service.submit({
      accountId: BOB,
      workspace: directory,
      slug: 'bob-event',
      sections: {
        background: 'why',
        impact: 'scope',
        changes: 'file',
        verification: 'tests',
      },
    })

    const alicePayload = aliceResponse.writes.join('')
    const bobPayload = bobResponse.writes.join('')
    expect(alicePayload).toContain(`"planId":"${alicePlan.id}"`)
    expect(alicePayload).not.toContain(`"planId":"${bobPlan.id}"`)
    expect(bobPayload).toContain(`"planId":"${bobPlan.id}"`)
    expect(bobPayload).not.toContain(`"planId":"${alicePlan.id}"`)

    for (let index = 0; index < 257; index += 1) {
      events.publish({
        type: 'luban.plan.feedback',
        accountId: BOB,
        planId: asPlanId(`P-bob-${String(index)}`),
        status: 'draft',
        filePath: `docs/plans/bob-${String(index)}.md`,
        version: 1,
        at: index,
      })
    }
    const replay = new RecordingResponse()
    events.connect(
      { headers: { 'last-event-id': '0' } } as unknown as IncomingMessage,
      replay as unknown as ServerResponse,
      ALICE,
    )
    expect(replay.writes.join('')).toContain(`"planId":"${alicePlan.id}"`)
    expect(replay.writes.join('')).not.toContain(`"planId":"${bobPlan.id}"`)
    events.dispose()
  })
})
