import type { Context } from '@deepseek-ai/cordis'
import type * as WorkbenchClient from '@yin52133/dsh-luban-core/client'
import { registerWorkbenchPage } from '@yin52133/dsh-luban-core/client'
vi.mock('@yin52133/dsh-luban-core/client', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkbenchClient>()),
  registerWorkbenchPage: vi.fn(),
}))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, approveTakeover, injectSessionInput, SessionShareSection } from '../src/client.js'

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('Session Share client entry', (): void => {
  it('registers a business page in the workbench', (): void => {
    const context = { effect: (execute: () => () => void): (() => void) => execute() }
    apply(context as unknown as Context)
    const registered = vi.mocked(registerWorkbenchPage).mock.calls.at(-1)?.[1]
    expect(registered).toMatchObject({ id: 'luban-session-share', title: '会话共享' })
    expect(registered?.component).toBe(SessionShareSection)
  })

  it('uses the luban-prefixed authenticated mutation API and CSRF token', async (): Promise<void> => {
    const requests: { readonly url: string; readonly init: RequestInit | undefined }[] = []
    const fetchStub: typeof fetch = (input, init): Promise<Response> => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      requests.push({ url, init })
      return Promise.resolve(
        url === '/luban-auth/session'
          ? Response.json({ csrfToken: 'csrf-token' })
          : new Response(null, { status: 204 }),
      )
    }
    vi.stubGlobal('fetch', fetchStub)

    await approveTakeover('R/unsafe', 7, 'approve')
    await injectSessionInput('S/unsafe', 'continue')

    expect(requests.map((request) => request.url)).toEqual([
      '/luban-auth/session',
      '/luban-session-share/takeovers/R%2Funsafe/decision',
      '/luban-auth/session',
      '/luban-session-share/sessions/S%2Funsafe/input',
    ])
    expect(new Headers(requests[1]?.init?.headers).get('x-luban-csrf')).toBe('csrf-token')
    expect(requests[1]?.init?.body).toBe(
      JSON.stringify({ decision: 'approve', expectedVersion: 7 }),
    )
    expect(requests[3]?.init?.body).toBe(JSON.stringify({ text: 'continue' }))
  })
})
