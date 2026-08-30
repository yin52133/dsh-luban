// @vitest-environment jsdom

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthService, Clock } from '@luban/core'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DefaultAgentClaimService } from '../src/claim-service.js'
import { run } from '../src/cli.js'
import { TaskboardSection } from '../src/client/index.js'
import { TaskboardHttpApi } from '../src/http-api.js'
import { createLedgerStore } from '../src/ledger.js'
import { DefaultNightScheduler } from '../src/night-scheduler.js'
import { JsonTaskStore } from '../src/task-store.js'

interface MountedRoot {
  readonly container: HTMLDivElement
  readonly root: Root
}

interface LoopbackHarness {
  readonly origin: string
  readonly ledgerPath: string
  readonly store: JsonTaskStore
  readonly claims: DefaultAgentClaimService
  readonly close: () => Promise<void>
}

interface TestEventSource {
  readonly received: readonly string[]
  readonly close: () => void
  readonly disconnect: () => void
  readonly reconnect: (lastEventId: string) => void
  readonly flush: (event: string) => Promise<void>
}

interface EventSourceFixture {
  readonly constructor: typeof EventSource
  readonly instances: readonly TestEventSource[]
}

interface BrowserFetchFixture {
  readonly settle: () => Promise<void>
}

interface SseFrame {
  readonly event: string
  readonly data: string
  readonly lastEventId: string
}

const clock: Clock = { now: (): number => Date.UTC(2026, 7, 30, 12) }

async function createLoopbackHarness(): Promise<LoopbackHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'luban-taskboard-ui-'))
  const ledgerPath = join(directory, 'ledger.json')
  const store = new JsonTaskStore(createLedgerStore(ledgerPath, clock), clock)
  const claims = new DefaultAgentClaimService(store, 'ubuntu', true)
  const scheduler = new DefaultNightScheduler({
    store,
    claims,
    config: {
      enabled: false,
      window: '23:30-06:30',
      dailyQuota: 1,
      hostScopeWhitelist: ['ubuntu'],
      tagWhitelist: ['auto-ok'],
      model: { provider: '', id: '' },
      toolAllowlist: [],
      circuitBreaker: { maxConsecutiveFailures: 1 },
    },
    hostScope: 'ubuntu',
    clock,
  })
  const auth = {
    middleware(): ReturnType<AuthService['middleware']> {
      return (request) =>
        Promise.resolve(
          request.cookie === 'session=ok'
            ? { allowed: true, status: 200, user: 'ui-user' }
            : { allowed: false, status: 401 },
        )
    },
  } as AuthService
  const api = new TaskboardHttpApi({ store, claims, scheduler, auth })
  const server = createServer((request, response): void => {
    void api.handler(request, response)
  })
  await new Promise<void>((resolve, reject): void => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    ledgerPath,
    store,
    claims,
    close: async (): Promise<void> => {
      api.dispose()
      await scheduler.dispose()
      await closeServer(server)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject): void => {
    server.close((error): void => (error === undefined ? resolve() : reject(error)))
    server.closeAllConnections()
  })
}

function installBrowserFetch(origin: string, hostFetch: typeof fetch): BrowserFetchFixture {
  const pending = new Set<Promise<Response>>()
  const track = (request: Promise<Response>): Promise<Response> => {
    const tracked = request.finally((): void => {
      pending.delete(tracked)
    })
    pending.add(tracked)
    return tracked
  }
  const browserFetch: typeof fetch = (input, init): Promise<Response> => {
    const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    const url = new URL(raw, origin)
    if (url.pathname === '/luban-auth/session') {
      return track(Promise.resolve(Response.json({ csrfToken: 'ui-csrf' })))
    }
    if (url.pathname === '/luban-plan/plans') {
      return track(Promise.resolve(Response.json({ error: 'not found' }, { status: 404 })))
    }
    const headers = new Headers(init?.headers)
    if (url.pathname.startsWith('/luban-taskboard/') && !headers.has('cookie')) {
      headers.set('cookie', 'session=ok')
    }
    return track(hostFetch(url, { ...init, headers }))
  }
  vi.stubGlobal('fetch', browserFetch)
  return {
    settle: async (): Promise<void> => {
      for (;;) {
        await Promise.allSettled([...pending])
        await new Promise<void>((resolve): void => {
          setTimeout(resolve, 0)
        })
        if (pending.size === 0) return
      }
    },
  }
}

function eventSourceFixture(
  origin: string,
  hostFetch: typeof fetch,
  settleBrowserFetch: () => Promise<void>,
): EventSourceFixture {
  const instances: TestEventSource[] = []

  class LoopbackEventSource {
    public readonly received: string[] = []
    public onerror: ((event: Event) => void) | null = null
    readonly #listeners = new Map<string, Set<EventListener>>()
    readonly #frames: SseFrame[] = []
    #controller: AbortController | undefined
    #closed = false

    public constructor(public readonly url: string) {
      instances.push(this)
      queueMicrotask((): void => this.#connect())
    }

    public addEventListener(type: string, listener: EventListener): void {
      const listeners = this.#listeners.get(type) ?? new Set<EventListener>()
      listeners.add(listener)
      this.#listeners.set(type, listeners)
    }

    public disconnect(): void {
      this.#controller?.abort()
      this.#controller = undefined
    }

    public reconnect(lastEventId: string): void {
      if (this.#closed) throw new Error('Cannot reconnect a closed EventSource')
      this.disconnect()
      this.#connect(lastEventId)
    }

    public close(): void {
      this.#closed = true
      this.disconnect()
    }

    public async flush(event: string): Promise<void> {
      await vi.waitFor((): void => {
        expect(this.#frames.some((frame): boolean => frame.event === event)).toBe(true)
      })
      const index = this.#frames.findIndex((frame): boolean => frame.event === event)
      const [frame] = this.#frames.splice(index, 1)
      if (frame === undefined) throw new Error(`SSE ${event} frame disappeared before dispatch`)
      await act(async (): Promise<void> => {
        const message = new MessageEvent<string>(frame.event, {
          data: frame.data,
          lastEventId: frame.lastEventId,
        })
        for (const listener of this.#listeners.get(frame.event) ?? []) listener(message)
        await settleBrowserFetch()
      })
    }

    #connect(lastEventId?: string): void {
      if (this.#closed) return
      const controller = new AbortController()
      this.#controller = controller
      void this.#consume(controller, lastEventId).catch((): void => {
        if (!controller.signal.aborted && !this.#closed) this.onerror?.(new Event('error'))
      })
    }

    async #consume(controller: AbortController, lastEventId?: string): Promise<void> {
      const response = await hostFetch(new URL(this.url, origin), {
        headers: {
          accept: 'text/event-stream',
          cookie: 'session=ok',
          ...(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }),
        },
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) {
        throw new Error(`Unable to open taskboard events (${String(response.status)})`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return
        buffer += decoder.decode(chunk.value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          this.#queue(frame)
          boundary = buffer.indexOf('\n\n')
        }
      }
    }

    #queue(frame: string): void {
      const fields = frame.split('\n')
      const event = fields.find((line): boolean => line.startsWith('event: '))?.slice(7)
      if (event === undefined) return
      const data = fields
        .filter((line): boolean => line.startsWith('data: '))
        .map((line): string => line.slice(6))
        .join('\n')
      const lastEventId = fields.find((line): boolean => line.startsWith('id: '))?.slice(4) ?? ''
      this.received.push(event)
      this.#frames.push({ event, data, lastEventId })
    }
  }

  return {
    constructor: LoopbackEventSource as unknown as typeof EventSource,
    instances,
  }
}

async function mountTaskboard(settleBrowserFetch: () => Promise<void>): Promise<MountedRoot> {
  const container = document.createElement('div')
  container.style.width = '1280px'
  document.body.append(container)
  const root = createRoot(container)
  await act(async (): Promise<void> => {
    root.render(createElement(TaskboardSection, {} as never))
    await Promise.resolve()
  })
  await act(async (): Promise<void> => {
    await settleBrowserFetch()
  })
  return { container, root }
}

async function unmount({ container, root }: MountedRoot): Promise<void> {
  await act(async (): Promise<void> => {
    root.unmount()
    await Promise.resolve()
  })
  container.remove()
}

async function waitForUi(assertion: () => void): Promise<void> {
  await vi.waitFor(async (): Promise<void> => {
    await act(async (): Promise<void> => {
      await Promise.resolve()
    })
    assertion()
  })
}

function setInput(input: HTMLInputElement, value: string): void {
  // Bypass React's value tracker so the following input event follows a real user edit.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('HTMLInputElement value setter is unavailable')
  Reflect.apply(setter, input, [value])
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function requiredElement(container: ParentNode, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`${selector} was not rendered`)
  return element
}

async function withMountedTaskboards(
  count: number,
  settleBrowserFetch: () => Promise<void>,
  operation: (mounted: readonly MountedRoot[]) => Promise<void>,
): Promise<void> {
  const mounted: MountedRoot[] = []
  try {
    for (let index = 0; index < count; index += 1) {
      mounted.push(await mountTaskboard(settleBrowserFetch))
    }
    await operation(mounted)
  } finally {
    // React has one global act queue, so roots must be torn down sequentially.
    for (const root of mounted) await unmount(root)
  }
}

beforeEach((): void => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

afterEach((): void => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Taskboard React integration', (): void => {
  it('persists a React drag through the loopback API and restores it from the ledger', async (): Promise<void> => {
    const harness = await createLoopbackHarness()
    const hostFetch = globalThis.fetch.bind(globalThis)
    const browserFetch = installBrowserFetch(harness.origin, hostFetch)
    const events = eventSourceFixture(harness.origin, hostFetch, browserFetch.settle)
    vi.stubGlobal('EventSource', events.constructor)

    const task = await harness.store.create({
      title: 'Review overnight output',
      description: 'Generated while unattended',
      status: 'todo',
      hostScope: 'ubuntu',
      priority: 'P1',
      acceptance: 'Human confirms the artifact',
      tags: ['auto-ok'],
    })
    const claim = await harness.claims.claim(
      { statuses: ['todo'], requireAcceptance: true },
      {
        actor: { kind: 'agent', id: 'agent/nightly' as never },
        sessionId: 'agent/nightly' as never,
        host: 'local' as never,
      },
    )
    const expectedClaim = claim.ok ? claim.task.claim : undefined
    if (expectedClaim === null || expectedClaim === undefined) {
      throw new Error('Fixture task was not claimed')
    }
    await harness.claims.complete(
      task.id,
      {
        kind: 'artifact',
        ref: 'artifacts/nightly.zip',
        summary: 'Nightly artifact',
        at: clock.now(),
        by: expectedClaim.actor,
      },
      { autoDone: true, expectedClaim },
    )

    try {
      await withMountedTaskboards(1, browserFetch.settle, async ([mounted]): Promise<void> => {
        if (mounted === undefined) throw new Error('Taskboard was not mounted')
        const stream = events.instances[0]
        if (stream === undefined) throw new Error('Taskboard event stream was not opened')
        await stream.flush('baseline')
        await waitForUi((): void => {
          const card = requiredElement(mounted.container, `[data-task-id="${task.id}"]`)
          expect(card.closest('.luban-board__column')?.querySelector('h3')?.textContent).toContain(
            'Review',
          )
          expect(requiredElement(card, '.luban-board__auto').textContent).toBe(
            'Auto-completed · review required',
          )
        })

        await act(async (): Promise<void> => {
          const card = requiredElement(mounted.container, `[data-task-id="${task.id}"]`)
          const doneColumn = [
            ...mounted.container.querySelectorAll<HTMLElement>('.luban-board__column'),
          ].find((column): boolean => column.querySelector('h3 span')?.textContent === 'Done')
          if (doneColumn === undefined) throw new Error('Done column was not rendered')
          const values = new Map<string, string>()
          const dataTransfer = {
            effectAllowed: 'none',
            setData(type: string, value: string): void {
              values.set(type, value)
            },
            getData(type: string): string {
              return values.get(type) ?? ''
            },
          }
          const dragStart = new Event('dragstart', { bubbles: true, cancelable: true })
          Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
          card.dispatchEvent(dragStart)
          const drop = new Event('drop', { bubbles: true, cancelable: true })
          Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
          doneColumn.dispatchEvent(drop)
          await browserFetch.settle()
        })
        await waitForUi((): void => {
          const card = requiredElement(mounted.container, `[data-task-id="${task.id}"]`)
          expect(card.closest('.luban-board__column')?.querySelector('h3')?.textContent).toContain(
            'Done',
          )
          expect(card.querySelector('.luban-board__auto')).toBeNull()
        })
      })

      const reopened = new JsonTaskStore(createLedgerStore(harness.ledgerPath, clock), clock)
      expect(await reopened.get(task.id)).toMatchObject({
        id: task.id,
        status: 'done',
        version: 4,
        autoDone: false,
      })
    } finally {
      await harness.close()
    }
  })

  it('keeps two mounted clients consistent and restores a disconnected client from baseline', async (): Promise<void> => {
    const harness = await createLoopbackHarness()
    const hostFetch = globalThis.fetch.bind(globalThis)
    const browserFetch = installBrowserFetch(harness.origin, hostFetch)
    const events = eventSourceFixture(harness.origin, hostFetch, browserFetch.settle)
    vi.stubGlobal('EventSource', events.constructor)
    vi.stubEnv('LUBAN_URL', harness.origin)
    vi.stubEnv('LUBAN_SESSION_COOKIE', 'session=ok')
    vi.stubEnv('LUBAN_CSRF_TOKEN', 'ui-csrf')

    try {
      await withMountedTaskboards(
        2,
        browserFetch.settle,
        async ([first, second]): Promise<void> => {
          if (first === undefined || second === undefined)
            throw new Error('Two taskboards are required')
          await waitForUi((): void => {
            expect(events.instances).toHaveLength(2)
            expect(
              events.instances.every((stream): boolean => stream.received.includes('baseline')),
            ).toBe(true)
          })
          const firstStream = events.instances[0]
          const secondStream = events.instances[1]
          if (firstStream === undefined || secondStream === undefined) {
            throw new Error('Two taskboard event streams are required')
          }
          await firstStream.flush('baseline')
          await secondStream.flush('baseline')

          await run([
            'add',
            '--title',
            'Shared live mutation',
            '--hostScope',
            'any',
            '--priority',
            'P2',
          ])
          await firstStream.flush('task')
          await secondStream.flush('task')
          await waitForUi((): void => {
            expect(first.container.textContent).toContain('Shared live mutation')
            expect(second.container.textContent).toContain('Shared live mutation')
          })

          secondStream.disconnect()
          await run([
            'add',
            '--title',
            'Recovered from baseline',
            '--hostScope',
            'any',
            '--priority',
            'P1',
          ])
          await firstStream.flush('task')
          await waitForUi((): void => {
            expect(first.container.textContent).toContain('Recovered from baseline')
          })
          expect(second.container.textContent).not.toContain('Recovered from baseline')

          const baselineCount = secondStream.received.filter(
            (event): boolean => event === 'baseline',
          ).length
          secondStream.reconnect('999999')
          await secondStream.flush('baseline')
          await waitForUi((): void => {
            expect(
              secondStream.received.filter((event): boolean => event === 'baseline').length,
            ).toBe(baselineCount + 1)
            expect(second.container.textContent).toContain('Recovered from baseline')
          })
        },
      )
    } finally {
      await harness.close()
    }
  })

  it('shows CLI writes in React and exposes React writes through taskctl list', async (): Promise<void> => {
    const harness = await createLoopbackHarness()
    const hostFetch = globalThis.fetch.bind(globalThis)
    const browserFetch = installBrowserFetch(harness.origin, hostFetch)
    const events = eventSourceFixture(harness.origin, hostFetch, browserFetch.settle)
    vi.stubGlobal('EventSource', events.constructor)
    vi.stubEnv('LUBAN_URL', harness.origin)
    vi.stubEnv('LUBAN_SESSION_COOKIE', 'session=ok')
    vi.stubEnv('LUBAN_CSRF_TOKEN', 'ui-csrf')

    try {
      await withMountedTaskboards(1, browserFetch.settle, async ([mounted]): Promise<void> => {
        if (mounted === undefined) throw new Error('Taskboard was not mounted')
        const stream = events.instances[0]
        if (stream === undefined) throw new Error('Taskboard event stream was not opened')
        await stream.flush('baseline')

        await run([
          'add',
          '--title',
          'Created by taskctl',
          '--hostScope',
          'ubuntu',
          '--priority',
          'P1',
        ])
        await stream.flush('task')
        await waitForUi((): void => {
          expect(mounted.container.textContent).toContain('Created by taskctl')
        })

        const title = requiredElement(
          mounted.container,
          'input[placeholder="New task"]',
        ) as HTMLInputElement
        const acceptance = requiredElement(
          mounted.container,
          'input[placeholder="Acceptance criteria (creates Todo)"]',
        ) as HTMLInputElement
        const form = requiredElement(mounted.container, '.luban-board__form') as HTMLFormElement
        await act(async (): Promise<void> => {
          setInput(title, 'Created from React UI')
          setInput(acceptance, 'Visible to taskctl')
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
          await browserFetch.settle()
        })
        await waitForUi((): void => {
          expect(mounted.container.textContent).toContain('Created from React UI')
        })

        const listed = (await run(['list'])) as {
          readonly tasks: readonly { readonly title: string; readonly acceptance?: string }[]
        }
        expect(listed.tasks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              title: 'Created from React UI',
              acceptance: 'Visible to taskctl',
            }),
          ]),
        )
      })
    } finally {
      await harness.close()
    }
  })
})
