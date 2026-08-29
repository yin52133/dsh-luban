import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AuthService, Clock } from '@luban/core'
import { afterEach, describe, expect, it } from 'vitest'
import { DefaultAgentClaimService } from '../src/claim-service.js'
import { TaskboardHttpApi } from '../src/http-api.js'
import { createLedgerStore } from '../src/ledger.js'
import { DefaultNightScheduler } from '../src/night-scheduler.js'
import { JsonTaskStore } from '../src/task-store.js'

const directories = new Set<string>()

async function readSseEvent(response: Response, event: string): Promise<string> {
  if (response.body === null) throw new Error('SSE response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async (): Promise<string> => {
        let text = ''
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) throw new Error(`SSE stream closed before ${event}`)
          text += decoder.decode(chunk.value, { stream: true })
          if (text.includes(`event: ${event}\n`)) return text
        }
      })(),
      new Promise<never>((_resolve, reject): void => {
        timeout = setTimeout(
          (): void => reject(new Error(`Timed out waiting for SSE event ${event}`)),
          1_000,
        )
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    await reader.cancel().catch((): void => undefined)
  }
}

async function listen(api: TaskboardHttpApi): Promise<{
  readonly base: string
  readonly close: () => Promise<void>
}> {
  const server = createServer((request, response): void => {
    void api.handler(request, response)
  })
  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${String(address.port)}/luban-taskboard`,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject): void => {
        server.close((error): void => (error === undefined ? resolve() : reject(error)))
      }),
  }
}

class StaticClock implements Clock {
  public now(): number {
    return Date.UTC(2026, 7, 30, 1, 0, 0)
  }
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    [...directories].map(async (directory): Promise<void> => {
      await rm(directory, { force: true, recursive: true })
      directories.delete(directory)
    }),
  )
})

describe('TaskboardHttpApi', (): void => {
  it('serves one authenticated API to REST, importer, and SSE clients', async (): Promise<void> => {
    const directory = join(tmpdir(), `dsh-luban-http-${randomUUID()}`)
    await mkdir(directory, { recursive: true })
    directories.add(directory)
    const clock = new StaticClock()
    const store = new JsonTaskStore(createLedgerStore(join(directory, 'ledger.json'), clock), clock)
    const claims = new DefaultAgentClaimService(store, 'ubuntu', true)
    const scheduler = new DefaultNightScheduler({
      store,
      claims,
      config: {
        enabled: false,
        window: '23:30-06:30',
        dailyQuota: 5,
        hostScopeWhitelist: ['ubuntu'],
        tagWhitelist: ['auto-ok'],
        circuitBreaker: { maxConsecutiveFailures: 3 },
      },
      hostScope: 'ubuntu',
      clock,
    })
    const auth = {
      middleware(): ReturnType<AuthService['middleware']> {
        return (request) =>
          Promise.resolve(
            request.cookie === 'session=ok'
              ? { allowed: true, status: 200, user: 'alice' }
              : { allowed: false, status: 401 },
          )
      },
    }
    const api = new TaskboardHttpApi({ store, claims, scheduler, auth })
    const server = createServer((request, response): void => {
      void api.handler(request, response)
    })
    await new Promise<void>((resolve, reject): void => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const base = `http://127.0.0.1:${String(address.port)}/luban-taskboard`
    const headers = { cookie: 'session=ok', 'content-type': 'application/json' }

    const unauthorized = await fetch(`${base}/tasks`)
    expect(unauthorized.status).toBe(401)
    const created = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'HTTP task',
        status: 'todo',
        hostScope: 'ubuntu',
        priority: 'P0',
        acceptance: 'Visible over HTTP',
        tags: ['auto-ok'],
      }),
    })
    expect(created.status).toBe(201)
    const createdJson = (await created.json()) as {
      readonly task: { readonly id: string; readonly version: number }
    }
    const listed = await fetch(`${base}/tasks?status=todo`, { headers: { cookie: 'session=ok' } })
    const listedJson = (await listed.json()) as {
      readonly tasks: readonly { readonly title: string }[]
    }
    expect(listedJson.tasks.map((task) => task.title)).toEqual(['HTTP task'])

    const dropped = await fetch(`${base}/tasks/${encodeURIComponent(createdJson.task.id)}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ expectedVersion: createdJson.task.version, note: 'No longer needed' }),
    })
    expect(await dropped.json()).toMatchObject({ task: { status: 'dropped', version: 2 } })

    const imported = await fetch(`${base}/import`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tasks: [{ name: 'Legacy task', project: '/workspace' }] }),
    })
    expect(await imported.json()).toMatchObject({ report: { imported: 1, failed: 0 } })

    const stream = await fetch(`${base}/events`, { headers: { cookie: 'session=ok' } })
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    if (stream.body === null) throw new Error('SSE response has no body')
    const reader = stream.body.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('event: baseline')

    const liveCreate = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Live task',
        hostScope: 'any',
        priority: 'P2',
      }),
    })
    expect(liveCreate.status).toBe(201)
    const live = await reader.read()
    expect(new TextDecoder().decode(live.value)).toContain('event: task')
    await reader.cancel()

    const recovered = await fetch(`${base}/events`, {
      headers: { cookie: 'session=ok', 'last-event-id': '-100' },
    })
    if (recovered.body === null) throw new Error('Recovered SSE response has no body')
    const recoveredReader = recovered.body.getReader()
    const recovery = await recoveredReader.read()
    expect(new TextDecoder().decode(recovery.value)).toContain('event: baseline')
    await recoveredReader.cancel()

    api.dispose()
    await scheduler.dispose()
    await new Promise<void>((resolve, reject): void => {
      server.close((error): void => (error === undefined ? resolve() : reject(error)))
    })
  })

  it('sends a baseline when a pre-restart Last-Event-ID is ahead of the new sequence', async (): Promise<void> => {
    const directory = join(tmpdir(), `dsh-luban-http-restart-${randomUUID()}`)
    await mkdir(directory, { recursive: true })
    directories.add(directory)
    const clock = new StaticClock()
    const store = new JsonTaskStore(createLedgerStore(join(directory, 'ledger.json'), clock), clock)
    const claims = new DefaultAgentClaimService(store, 'ubuntu', true)
    const scheduler = new DefaultNightScheduler({
      store,
      claims,
      config: {
        enabled: false,
        window: '23:30-06:30',
        dailyQuota: 5,
        hostScopeWhitelist: ['ubuntu'],
        tagWhitelist: ['auto-ok'],
        circuitBreaker: { maxConsecutiveFailures: 3 },
      },
      hostScope: 'ubuntu',
      clock,
    })
    const auth = {
      middleware(): ReturnType<AuthService['middleware']> {
        return (request) =>
          Promise.resolve(
            request.cookie === 'session=ok'
              ? { allowed: true, status: 200, user: 'alice' }
              : { allowed: false, status: 401 },
          )
      },
    }
    const headers = { cookie: 'session=ok', 'content-type': 'application/json' }

    const firstApi = new TaskboardHttpApi({ store, claims, scheduler, auth })
    const firstServer = await listen(firstApi)
    try {
      const created = await fetch(`${firstServer.base}/tasks`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Survives stream restart',
          status: 'todo',
          hostScope: 'ubuntu',
          priority: 'P1',
          acceptance: 'Returned in the restart baseline',
        }),
      })
      expect(created.status).toBe(201)

      const replay = await fetch(`${firstServer.base}/events`, {
        headers: { cookie: 'session=ok', 'last-event-id': '0' },
      })
      const replayFrame = await readSseEvent(replay, 'task')
      expect(replayFrame).toContain('id: 1\n')
      expect(replayFrame).not.toContain('event: baseline')
    } finally {
      firstApi.dispose()
      await firstServer.close()
    }

    const restartedApi = new TaskboardHttpApi({ store, claims, scheduler, auth })
    const restartedServer = await listen(restartedApi)
    try {
      const recovered = await fetch(`${restartedServer.base}/events`, {
        headers: { cookie: 'session=ok', 'last-event-id': '1' },
      })
      const recoveryFrame = await readSseEvent(recovered, 'baseline')
      expect(recoveryFrame).toContain('id: 0\n')
      expect(recoveryFrame).toContain('Survives stream restart')
    } finally {
      restartedApi.dispose()
      await restartedServer.close()
      await scheduler.dispose()
    }
  })
})
