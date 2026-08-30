// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServerModeSection } from '../src/client/index.js'

class FakeEventSource {
  public static readonly instances: FakeEventSource[] = []
  public readonly close = vi.fn<() => void>()
  public onerror: ((event: Event) => void) | null = null

  public constructor(public readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  public addEventListener(type: string, listener: EventListener): void {
    void type
    void listener
  }
}

interface MountedRoot {
  readonly container: HTMLDivElement
  readonly root: Root
}

async function mountServerMode(): Promise<MountedRoot> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async (): Promise<void> => {
    root.render(createElement(ServerModeSection, { close: vi.fn() }))
    await Promise.resolve()
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

beforeEach((): void => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

afterEach((): void => {
  document.cookie = 'luban_session=; Max-Age=0; Path=/'
  document.body.replaceChildren()
  FakeEventSource.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('server-mode artifact links', (): void => {
  it('renders a signed same-origin link and triggers an authenticated browser download', async (): Promise<void> => {
    const signedDownloadUrl =
      '/luban-server-mode/jobs/job%2F42/artifacts/nested%2Ffirmware.bin?expires=1800000300&signature=test-signature'
    const requests: { readonly path: string; readonly init?: RequestInit }[] = []
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw, window.location.href)
      requests.push({ path: url.pathname, ...(init === undefined ? {} : { init }) })
      switch (url.pathname) {
        case '/luban-server-mode/jobs':
          return Promise.resolve(
            Response.json({
              jobs: [{ id: 'job/42', templateId: 'cmake', status: 'done', version: 1 }],
            }),
          )
        case '/luban-server-mode/templates':
          return Promise.resolve(Response.json({ templates: [{ id: 'cmake', title: 'CMake' }] }))
        case '/luban-server-mode/resources':
          return Promise.resolve(
            Response.json({ diskFreeGb: 10, load1: 0.2, queueDepth: 0, paused: false }),
          )
        case '/luban-server-mode/jobs/job%2F42/artifacts':
          return Promise.resolve(
            Response.json({
              artifacts: [
                {
                  name: 'nested/firmware.bin',
                  sizeBytes: 1_025,
                  downloadUrl: signedDownloadUrl,
                },
              ],
            }),
          )
        default:
          return Promise.reject(new Error(`Unexpected request: ${url.pathname}`))
      }
    })
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', fetcher)
    document.cookie = 'luban_session=opaque; Path=/; SameSite=Lax'
    const mounted = await mountServerMode()

    try {
      await waitForUi((): void => {
        const rendered = mounted.container.querySelector<HTMLAnchorElement>(
          '.luban-server__artifacts a',
        )
        expect(rendered?.textContent).toBe('nested/firmware.bin (2 KiB)')
      })
      const anchor = mounted.container.querySelector<HTMLAnchorElement>(
        '.luban-server__artifacts a',
      )
      if (anchor === null) throw new Error('artifact link was not rendered')

      expect(requests).toContainEqual({
        path: '/luban-server-mode/jobs/job%2F42/artifacts',
        init: { headers: { accept: 'application/json' } },
      })
      expect(anchor.getAttribute('href')).toBe(signedDownloadUrl)
      expect(new URL(anchor.href).origin).toBe(window.location.origin)

      let triggeredDownload: { readonly href: string; readonly cookie: string } | undefined
      anchor.addEventListener(
        'click',
        (event): void => {
          event.preventDefault()
          triggeredDownload = {
            href: anchor.getAttribute('href') ?? '',
            cookie: document.cookie,
          }
        },
        { once: true },
      )
      await act(async (): Promise<void> => {
        anchor.click()
        await Promise.resolve()
      })

      expect(triggeredDownload).toEqual({
        href: signedDownloadUrl,
        cookie: 'luban_session=opaque',
      })
      expect(FakeEventSource.instances).toHaveLength(1)
      const events = FakeEventSource.instances[0]
      if (events === undefined) throw new Error('server-mode event stream was not opened')
      await unmount(mounted)
      expect(events.close).toHaveBeenCalledOnce()
    } finally {
      if (mounted.container.isConnected) await unmount(mounted)
    }
  })
})
