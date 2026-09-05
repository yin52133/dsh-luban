import type { Context } from '@deepseek-ai/cordis'
import type * as WorkbenchClient from '@yin52133/dsh-luban-core/client'
import { registerWorkbenchPage } from '@yin52133/dsh-luban-core/client'
vi.mock('@yin52133/dsh-luban-core/client', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkbenchClient>()),
  registerWorkbenchPage: vi.fn(),
}))
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply as applyClient,
  decidePlan,
  isPlanRevisableStatus,
  PlanReviewSection,
  revisePlan,
  RevisionEditor,
  type UiPlanSections,
} from '../src/client/index.js'

const sections: UiPlanSections = Object.freeze({
  background: 'why',
  impact: 'scope',
  changes: 'src/index.ts',
  verification: 'lint and tests',
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('Plan client entry', (): void => {
  it('registers a business page in the workbench', (): void => {
    const context = { effect: (execute: () => () => void): (() => void) => execute() }
    applyClient(context as unknown as Context)
    const registered = vi.mocked(registerWorkbenchPage).mock.calls.at(-1)?.[1]
    expect(registered).toMatchObject({ id: 'luban-plan', title: '计划审批' })
    expect(registered?.component).toBe(PlanReviewSection)
  })

  it('defines revisable statuses and renders all required revision inputs', (): void => {
    expect(isPlanRevisableStatus('rejected')).toBe(true)
    expect(isPlanRevisableStatus('revising')).toBe(true)
    expect(isPlanRevisableStatus('in-review')).toBe(false)

    const onSubmit = vi.fn()
    const rendered = RevisionEditor({
      planId: 'P-1',
      sections,
      busy: false,
      onChange: vi.fn(),
      onSubmit,
    })
    expect(isValidElement(rendered)).toBe(true)
    const form = rendered as ReactElement<Readonly<Record<string, unknown>>>
    expect(form.props['aria-label']).toBe('Revise P-1')
    const controls = Children.toArray(form.props.children as ReactNode).filter(isValidElement)
    expect(
      controls
        .slice(0, 4)
        .map((control) =>
          String((control as ReactElement<Readonly<Record<string, unknown>>>).props['aria-label']),
        ),
    ).toEqual([
      'Revised background for P-1',
      'Revised impact scope for P-1',
      'Revised change locations for P-1',
      'Revised verification for P-1',
    ])

    const preventDefault = vi.fn()
    const submit = form.props.onSubmit as (event: { readonly preventDefault: () => void }) => void
    submit({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('posts complete revisions with CSRF and the current optimistic version', async (): Promise<void> => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = []
    const fetchMock: typeof fetch = (input, init): Promise<Response> => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      requests.push({ url, init })
      if (url === '/luban-auth/session') {
        return Promise.resolve(
          new Response(JSON.stringify({ csrfToken: 'csrf-token' }), { status: 200 }),
        )
      }
      return Promise.resolve(new Response(JSON.stringify({ plan: {} }), { status: 200 }))
    }
    vi.stubGlobal('fetch', fetchMock)

    await revisePlan('P/unsafe', sections, 7)

    expect(requests.map(({ url }) => url)).toEqual([
      '/luban-auth/session',
      '/luban-plan/plans/P%2Funsafe/revise',
    ])
    expect(requests[1]?.init?.method).toBe('POST')
    expect(new Headers(requests[1]?.init?.headers).get('x-luban-csrf')).toBe('csrf-token')
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ sections, expectedVersion: 7 }))
  })

  it('posts approve and reject decisions with CSRF and structured feedback', async (): Promise<void> => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = []
    const fetchMock: typeof fetch = (input, init): Promise<Response> => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      requests.push({ url, init })
      return Promise.resolve(
        url === '/luban-auth/session'
          ? new Response(JSON.stringify({ csrfToken: 'csrf-token' }), { status: 200 })
          : new Response(JSON.stringify({ plan: {} }), { status: 200 }),
      )
    }
    vi.stubGlobal('fetch', fetchMock)

    await decidePlan('P/approve', 'approve', 2)
    await decidePlan('P/reject', 'reject', 3, 'Add a rollback check')

    const mutations = requests.filter(({ url }) => url.includes('/decision'))
    expect(mutations.map(({ url }) => url)).toEqual([
      '/luban-plan/plans/P%2Fapprove/decision',
      '/luban-plan/plans/P%2Freject/decision',
    ])
    expect(mutations.map(({ init }) => new Headers(init?.headers).get('x-luban-csrf'))).toEqual([
      'csrf-token',
      'csrf-token',
    ])
    expect(
      mutations.map(({ init }): unknown => {
        if (typeof init?.body !== 'string') throw new Error('expected a JSON request body')
        return JSON.parse(init.body) as unknown
      }),
    ).toEqual([
      { decision: 'approve', expectedVersion: 2 },
      { decision: 'reject', expectedVersion: 3, comment: 'Add a rollback check' },
    ])
  })

  it('surfaces revise endpoint failures for page error reporting', async (): Promise<void> => {
    const fetchMock: typeof fetch = (input): Promise<Response> => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      return Promise.resolve(
        url === '/luban-auth/session'
          ? Response.json({ csrfToken: 'test-csrf' })
          : new Response('Plan changed since version 2', { status: 409 }),
      )
    }
    vi.stubGlobal('fetch', fetchMock)

    await expect(revisePlan('P-1', sections, 2)).rejects.toThrow('Plan changed since version 2')
  })
})
