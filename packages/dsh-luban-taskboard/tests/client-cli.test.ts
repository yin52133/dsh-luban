import type { Context } from '@deepseek-ai/cordis'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { run } from '../src/cli.js'
import {
  apply as applyClient,
  loadTaskPlanLinks,
  moveTask,
  TaskboardSection,
  TaskPlanLinks,
} from '../src/client/index.js'

afterEach((): void => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('taskctl', (): void => {
  it('calls the same filtered HTTP API without printing credentials', async (): Promise<void> => {
    const calls: { readonly input: string; readonly init: RequestInit | undefined }[] = []
    const fetchMock: typeof fetch = (input, init): Promise<Response> => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      calls.push({ input: url, init })
      return Promise.resolve(
        new Response(JSON.stringify({ tasks: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('LUBAN_SESSION_COOKIE', 'session=secret')
    vi.stubEnv('LUBAN_CSRF_TOKEN', 'csrf-secret')

    await expect(
      run(['list', '--url', 'http://localhost:42600/', '--status', 'todo', '--tag', 'auto-ok']),
    ).resolves.toEqual({ tasks: [] })
    expect(calls[0]?.input).toBe(
      'http://localhost:42600/luban-taskboard/tasks?status=todo&tag=auto-ok',
    )
    expect(calls[0]?.init?.headers).toMatchObject({ cookie: 'session=secret' })
    expect(calls[0]?.init?.headers).toMatchObject({ 'x-luban-csrf': 'csrf-secret' })
    vi.stubEnv('LUBAN_SESSION_COOKIE', '')
    await expect(run(['list'])).rejects.toThrow('LUBAN_SESSION_COOKIE')
  })
})

describe('Taskboard client entry', (): void => {
  it('registers one settings section through the slots service', (): void => {
    let registered: Readonly<Record<string, unknown>> | undefined
    let component: unknown
    const context = {
      slots: {
        inject(_name: string, factory: () => void): void {
          factory()
        },
        register(options: Readonly<Record<string, unknown>>, value: unknown): () => void {
          registered = options
          component = value
          return (): void => undefined
        },
      },
    }
    applyClient(context as unknown as Context)
    expect(registered).toMatchObject({
      name: 'settings.section',
      id: 'luban-taskboard',
      label: 'Taskboard',
    })
    expect(component).toBe(TaskboardSection)
  })

  it('persists drag-and-drop through the authenticated versioned transition API', async (): Promise<void> => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = []
    const fetchMock: typeof fetch = (input, init): Promise<Response> => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      requests.push({ url, init })
      if (url === '/luban-auth/session') {
        return Promise.resolve(
          new Response(JSON.stringify({ csrfToken: 'csrf-token' }), { status: 200 }),
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    vi.stubGlobal('fetch', fetchMock)

    await moveTask('T/unsafe', 'review', 7)

    expect(requests.map((request) => request.url)).toEqual([
      '/luban-auth/session',
      '/luban-taskboard/tasks/T%2Funsafe/transition',
    ])
    expect(requests[1]?.init?.method).toBe('POST')
    expect(new Headers(requests[1]?.init?.headers).get('x-luban-csrf')).toBe('csrf-token')
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ to: 'review', expectedVersion: 7 }))
  })

  it('links a task card to documents returned by the existing taskId plan contract', async (): Promise<void> => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          plans: [
            {
              id: 'P/linked',
              taskId: 'T-1',
              status: 'rejected',
              filePath: 'docs/plans/linked.md',
            },
            {
              id: 'P-unlinked',
              status: 'in-review',
              filePath: 'docs/plans/unlinked.md',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const grouped = await loadTaskPlanLinks()
    expect(fetchMock).toHaveBeenCalledWith('/luban-plan/plans', {
      headers: { accept: 'application/json' },
    })
    const plans = grouped.get('T-1') ?? []
    expect(plans).toEqual([
      {
        id: 'P/linked',
        taskId: 'T-1',
        status: 'rejected',
        filePath: 'docs/plans/linked.md',
      },
    ])

    const rendered = TaskPlanLinks({ taskId: 'T-1', plans })
    expect(isValidElement(rendered)).toBe(true)
    const container = rendered as ReactElement<Readonly<Record<string, unknown>>>
    expect(container.props['aria-label']).toBe('Plans for T-1')
    const anchors = Children.toArray(container.props.children as ReactNode)
    expect(anchors).toHaveLength(1)
    expect(isValidElement(anchors[0])).toBe(true)
    const anchor = anchors[0] as ReactElement<Readonly<Record<string, unknown>>>
    expect(anchor.props.href).toBe('/luban-plan/plans/P%2Flinked/document')
    expect(anchor.props.title).toBe('docs/plans/linked.md')
  })

  it('keeps the board usable when the optional Plan route is absent', async (): Promise<void> => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 })),
    )
    await expect(loadTaskPlanLinks()).resolves.toEqual(new Map())
  })
})
