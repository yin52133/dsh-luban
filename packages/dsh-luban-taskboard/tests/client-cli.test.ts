import type { Context } from '@deepseek-ai/cordis'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { run } from '../src/cli.js'
import {
  apply as applyClient,
  loadTaskPlanLinks,
  moveTask,
  performTaskDrop,
  performTaskTransition,
  TaskboardSection,
  TaskPlanLinks,
  TaskTransitionControl,
  type TaskStatus,
  type UiTask,
} from '../src/client/index.js'

const doingTask: UiTask = Object.freeze({
  id: 'T-1',
  title: 'Verify firmware',
  description: '',
  status: 'doing',
  hostScope: 'win',
  priority: 'P1',
  acceptance: 'Test log is attached',
  tags: ['hardware'],
  version: 11,
})

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

  it('renders touch and keyboard status controls with only valid targets', (): void => {
    const onTargetChange = vi.fn<(status: TaskStatus) => void>()
    const onMove = vi.fn<(status: TaskStatus) => void>()
    const rendered = TaskTransitionControl({
      task: doingTask,
      target: 'review',
      busy: false,
      onTargetChange,
      onMove,
    })
    expect(isValidElement(rendered)).toBe(true)
    const form = rendered as ReactElement<Readonly<Record<string, unknown>>>
    expect(form.props['aria-label']).toBe('Change status for Verify firmware')
    const controls = Children.toArray(form.props.children as ReactNode).filter(isValidElement)
    const select = controls[0] as ReactElement<Readonly<Record<string, unknown>>>
    const button = controls[1] as ReactElement<Readonly<Record<string, unknown>>>
    expect(select.props['aria-label']).toBe('Target status for Verify firmware')
    expect(select.props.value).toBe('review')
    expect(
      Children.toArray(select.props.children as ReactNode).map(
        (option) =>
          (option as ReactElement<Readonly<Record<string, unknown>>>).props.value as TaskStatus,
      ),
    ).toEqual(['review', 'todo'])

    const change = select.props.onChange as (event: {
      readonly currentTarget: { readonly value: string }
    }) => void
    change({ currentTarget: { value: 'todo' } })
    expect(onTargetChange).toHaveBeenCalledWith('todo')

    const preventDefault = vi.fn()
    const submit = form.props.onSubmit as (event: { readonly preventDefault: () => void }) => void
    submit({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(onMove).toHaveBeenCalledWith('review')
    expect(button.props.disabled).toBe(false)

    const busy = TaskTransitionControl({
      task: doingTask,
      target: 'review',
      busy: true,
      onTargetChange,
      onMove,
    }) as ReactElement<Readonly<Record<string, unknown>>>
    const busyControls = Children.toArray(busy.props.children as ReactNode).filter(isValidElement)
    expect(
      (busyControls[0] as ReactElement<Readonly<Record<string, unknown>>>).props.disabled,
    ).toBe(true)
    expect(
      (busyControls[1] as ReactElement<Readonly<Record<string, unknown>>>).props.children,
    ).toBe('Moving…')
  })

  it('uses the selected target and current version while managing busy state', async (): Promise<void> => {
    const move = vi
      .fn<(id: string, status: TaskStatus, expectedVersion: number) => Promise<void>>()
      .mockResolvedValue(undefined)
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const setBusyTaskId = vi.fn<(taskId: string | undefined) => void>()
    const reportError = vi.fn<(message: string) => void>()
    const lock = { current: false }

    await expect(
      performTaskTransition(doingTask, 'review', {
        move,
        refresh,
        setBusyTaskId,
        reportError,
        lock,
      }),
    ).resolves.toBe(true)

    expect(move).toHaveBeenCalledWith('T-1', 'review', 11)
    expect(refresh).toHaveBeenCalledOnce()
    expect(setBusyTaskId.mock.calls).toEqual([['T-1'], [undefined]])
    expect(reportError).toHaveBeenCalledOnce()
    expect(reportError).toHaveBeenCalledWith('')
    expect(lock.current).toBe(false)
  })

  it('rejects direct same-column and illegal transitions at the mutation boundary', async (): Promise<void> => {
    const move = vi
      .fn<(id: string, status: TaskStatus, expectedVersion: number) => Promise<void>>()
      .mockResolvedValue(undefined)
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const setBusyTaskId = vi.fn<(taskId: string | undefined) => void>()
    const reportError = vi.fn<(message: string) => void>()
    const lock = { current: false }
    const dependencies = { move, refresh, setBusyTaskId, reportError, lock }

    await expect(performTaskTransition(doingTask, 'doing', dependencies)).resolves.toBe(false)
    await expect(performTaskTransition(doingTask, 'done', dependencies)).resolves.toBe(false)

    expect(move).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(setBusyTaskId).not.toHaveBeenCalled()
    expect(reportError.mock.calls).toEqual([
      ['Task T-1 is already in doing'],
      ['Cannot move task from doing to done'],
    ])
    expect(lock.current).toBe(false)
  })

  it('rejects same-column, forged, and stale drops before mutation', async (): Promise<void> => {
    const move = vi
      .fn<(id: string, status: TaskStatus, expectedVersion: number) => Promise<void>>()
      .mockResolvedValue(undefined)
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const setBusyTaskId = vi.fn<(taskId: string | undefined) => void>()
    const reportError = vi.fn<(message: string) => void>()
    const lock = { current: false }
    const dependencies = { move, refresh, setBusyTaskId, reportError, lock }

    await expect(
      performTaskDrop(
        [doingTask],
        JSON.stringify({ id: 'T-1', version: 11 }),
        'doing',
        dependencies,
      ),
    ).resolves.toBe(false)
    await expect(
      performTaskDrop(
        [{ ...doingTask, status: 'done' }],
        JSON.stringify({ id: 'T-1', version: 11, status: 'todo' }),
        'doing',
        dependencies,
      ),
    ).resolves.toBe(false)
    await expect(
      performTaskDrop(
        [doingTask],
        JSON.stringify({ id: 'T-1', version: 10 }),
        'review',
        dependencies,
      ),
    ).resolves.toBe(false)
    await expect(
      performTaskDrop(
        [doingTask],
        JSON.stringify({ id: 'forged', version: 11, status: 'doing' }),
        'review',
        dependencies,
      ),
    ).resolves.toBe(false)

    expect(move).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(setBusyTaskId).not.toHaveBeenCalled()
    expect(reportError.mock.calls).toEqual([
      ['Task T-1 is already in doing'],
      ['Cannot move task from done to doing'],
      ['Task T-1 changed since dragging; retry with the refreshed card'],
      ['Task forged is no longer on this board'],
    ])
    expect(lock.current).toBe(false)
  })

  it('ignores a forged payload status and uses current board state for a legal drop', async (): Promise<void> => {
    const move = vi
      .fn<(id: string, status: TaskStatus, expectedVersion: number) => Promise<void>>()
      .mockResolvedValue(undefined)
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

    await expect(
      performTaskDrop(
        [doingTask],
        JSON.stringify({ id: 'T-1', version: 11, status: 'backlog' }),
        'review',
        {
          move,
          refresh,
          setBusyTaskId: vi.fn(),
          reportError: vi.fn(),
          lock: { current: false },
        },
      ),
    ).resolves.toBe(true)

    expect(move).toHaveBeenCalledWith('T-1', 'review', 11)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('synchronously locks rapid control submissions before React can rerender', async (): Promise<void> => {
    let resolveMove: (() => void) | undefined
    const move = vi.fn<(id: string, status: TaskStatus, expectedVersion: number) => Promise<void>>(
      (): Promise<void> =>
        new Promise<void>((resolve): void => {
          resolveMove = resolve
        }),
    )
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const setBusyTaskId = vi.fn<(taskId: string | undefined) => void>()
    const reportError = vi.fn<(message: string) => void>()
    const lock = { current: false }
    const dependencies = { move, refresh, setBusyTaskId, reportError, lock }

    const first = performTaskTransition(doingTask, 'review', dependencies)
    const second = performTaskTransition(doingTask, 'review', dependencies)

    expect(move).toHaveBeenCalledOnce()
    expect(lock.current).toBe(true)
    await expect(second).resolves.toBe(false)
    expect(resolveMove).toBeTypeOf('function')
    resolveMove?.()
    await expect(first).resolves.toBe(true)
    expect(refresh).toHaveBeenCalledOnce()
    expect(setBusyTaskId.mock.calls).toEqual([['T-1'], [undefined]])
    expect(lock.current).toBe(false)
  })

  it('synchronously locks rapid drops before issuing a second request', async (): Promise<void> => {
    let resolveMove: (() => void) | undefined
    const move = vi.fn<(id: string, status: TaskStatus, expectedVersion: number) => Promise<void>>(
      (): Promise<void> =>
        new Promise<void>((resolve): void => {
          resolveMove = resolve
        }),
    )
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const setBusyTaskId = vi.fn<(taskId: string | undefined) => void>()
    const reportError = vi.fn<(message: string) => void>()
    const lock = { current: false }
    const dependencies = { move, refresh, setBusyTaskId, reportError, lock }
    const payload = JSON.stringify({ id: 'T-1', version: 11 })

    const first = performTaskDrop([doingTask], payload, 'review', dependencies)
    const second = performTaskDrop([doingTask], payload, 'review', dependencies)

    expect(move).toHaveBeenCalledOnce()
    await expect(second).resolves.toBe(false)
    expect(resolveMove).toBeTypeOf('function')
    resolveMove?.()
    await expect(first).resolves.toBe(true)
    expect(refresh).toHaveBeenCalledOnce()
    expect(setBusyTaskId.mock.calls).toEqual([['T-1'], [undefined]])
    expect(lock.current).toBe(false)
  })

  it('surfaces a versioned move failure and always clears busy state', async (): Promise<void> => {
    const move = vi
      .fn<(id: string, status: TaskStatus, expectedVersion: number) => Promise<void>>()
      .mockRejectedValue(new Error('Task changed since version 11'))
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const setBusyTaskId = vi.fn<(taskId: string | undefined) => void>()
    const reportError = vi.fn<(message: string) => void>()
    const lock = { current: false }

    await expect(
      performTaskTransition(doingTask, 'review', {
        move,
        refresh,
        setBusyTaskId,
        reportError,
        lock,
      }),
    ).resolves.toBe(false)

    expect(refresh).not.toHaveBeenCalled()
    expect(reportError.mock.calls).toEqual([[''], ['Task changed since version 11']])
    expect(setBusyTaskId.mock.calls).toEqual([['T-1'], [undefined]])
    expect(lock.current).toBe(false)
  })

  it('clears the transition lock when refresh fails after mutation', async (): Promise<void> => {
    const move = vi
      .fn<(id: string, status: TaskStatus, expectedVersion: number) => Promise<void>>()
      .mockResolvedValue(undefined)
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Unable to refresh tasks'))
    const setBusyTaskId = vi.fn<(taskId: string | undefined) => void>()
    const reportError = vi.fn<(message: string) => void>()
    const lock = { current: false }

    await expect(
      performTaskTransition(doingTask, 'review', {
        move,
        refresh,
        setBusyTaskId,
        reportError,
        lock,
      }),
    ).resolves.toBe(false)

    expect(move).toHaveBeenCalledOnce()
    expect(reportError).toHaveBeenLastCalledWith('Unable to refresh tasks')
    expect(setBusyTaskId.mock.calls).toEqual([['T-1'], [undefined]])
    expect(lock.current).toBe(false)
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
