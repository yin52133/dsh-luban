// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImagePasteSection } from '../src/client/index.js'
import { PNG_BYTES } from './helpers.js'

interface ImageFixture {
  readonly id: string
  readonly relPath: string
  readonly sha256: string
  readonly source: 'paste' | 'drop'
  readonly referencedBy: readonly string[]
  readonly createdAt: number
  readonly mime: 'image/png'
  readonly bytes: number
  readonly originalName: string
  readonly compression: {
    readonly status: 'unchanged'
    readonly originalBytes: number
    readonly outputBytes: number
  }
  readonly previewUrl: string
}

interface MountedRoot {
  readonly container: HTMLDivElement
  readonly root: Root
}

async function mountImageSection(): Promise<MountedRoot> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async (): Promise<void> => {
    root.render(createElement(ImagePasteSection, {} as never))
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

function transferEvent(
  type: 'paste' | 'drop',
  property: 'clipboardData' | 'dataTransfer',
  files: readonly File[],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, property, { value: { files } })
  return event
}

function requiredElement(container: ParentNode, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`${selector} was not rendered`)
  return element
}

function requiredButton(container: ParentNode, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate): boolean => candidate.textContent === label,
  )
  if (button === undefined) throw new Error(`${label} button was not rendered`)
  return button
}

beforeEach((): void => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

afterEach((): void => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('image paste Settings component', (): void => {
  it('offers a file picker and explains invalid files without uploading', async (): Promise<void> => {
    const fetcher = vi.fn((): Promise<Response> => Promise.resolve(Response.json({ images: [] })))
    vi.stubGlobal('fetch', fetcher)
    const mounted = await mountImageSection()
    try {
      const picker = mounted.container.querySelector<HTMLInputElement>('input[type="file"]')
      expect(picker?.accept).toBe('image/png,image/jpeg,image/webp')
      if (picker === null) throw new Error('file picker was not rendered')
      Object.defineProperty(picker, 'files', {
        value: [new File(['invalid'], 'test.txt', { type: 'text/plain' })],
      })
      await act(async (): Promise<void> => {
        picker.dispatchEvent(new Event('change', { bubbles: true }))
        await Promise.resolve()
      })
      await waitForUi((): void => {
        expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
          'PNG, JPEG, or WebP',
        )
      })
      expect(fetcher).toHaveBeenCalledOnce()
      expect(picker.value).toBe('')
    } finally {
      await unmount(mounted)
    }
  })

  it('drives paste/drop, preview rendering, delete, and a completed cleanup refresh through React', async (): Promise<void> => {
    let images: ImageFixture[] = []
    let nextId = 1
    const calls: {
      readonly path: string
      readonly method: string
      readonly csrf: string | null
    }[] = []
    const fetcher = vi.fn(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const parsed = new URL(url, 'http://127.0.0.1')
        const method = init?.method ?? 'GET'
        calls.push({
          path: `${parsed.pathname}${parsed.search}`,
          method,
          csrf: new Headers(init?.headers).get('x-luban-csrf'),
        })
        if (parsed.pathname === '/luban-auth/session') {
          return Promise.resolve(Response.json({ csrfToken: 'ui-csrf' }))
        }
        if (parsed.pathname === '/luban-image-paste/images' && method === 'GET') {
          return Promise.resolve(Response.json({ images }))
        }
        if (parsed.pathname === '/luban-image-paste/images' && method === 'POST') {
          const source = parsed.searchParams.get('source')
          if (source !== 'paste' && source !== 'drop') {
            return Promise.resolve(Response.json({ error: 'invalid source' }, { status: 400 }))
          }
          const name = parsed.searchParams.get('name') ?? source
          const id = `image-${String(nextId)}`
          nextId += 1
          const image: ImageFixture = {
            id,
            relPath: `.luban/attachments/${source}-${id}.png`,
            sha256: String(nextId).repeat(64).slice(0, 64),
            source,
            referencedBy: [],
            createdAt: nextId,
            mime: 'image/png',
            bytes: PNG_BYTES.byteLength,
            originalName: name,
            compression: {
              status: 'unchanged',
              originalBytes: PNG_BYTES.byteLength,
              outputBytes: PNG_BYTES.byteLength,
            },
            previewUrl: `/luban-image-paste/images/${id}/content`,
          }
          images = [...images, image]
          return Promise.resolve(Response.json({ image }))
        }
        if (
          parsed.pathname.startsWith('/luban-image-paste/images/') &&
          !parsed.pathname.endsWith('/content') &&
          method === 'DELETE'
        ) {
          const id = decodeURIComponent(parsed.pathname.split('/').at(-1) ?? '')
          images = images.filter((image): boolean => image.id !== id)
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        if (parsed.pathname === '/luban-image-paste/cleanup' && method === 'POST') {
          images = []
          return Promise.resolve(new Response(null, { status: 204 }))
        }
        return Promise.resolve(Response.json({ error: 'not found' }, { status: 404 }))
      },
    )
    vi.stubGlobal('fetch', fetcher)
    const mounted = await mountImageSection()

    try {
      await waitForUi((): void => expect(fetcher).toHaveBeenCalledOnce())
      const zone = requiredElement(mounted.container, '[aria-label="Paste or drop an image"]')
      const pasteEvent = transferEvent('paste', 'clipboardData', [
        new File([PNG_BYTES], 'pasted scope.png', { type: 'image/png' }),
      ])
      await act(async (): Promise<void> => {
        zone.dispatchEvent(pasteEvent)
        await Promise.resolve()
      })
      expect(pasteEvent.defaultPrevented).toBe(true)

      await waitForUi((): void => {
        expect(mounted.container.textContent).toContain(
          '已保存：.luban/attachments/paste-image-1.png',
        )
        const preview = requiredElement(mounted.container, 'img[alt="pasted scope.png"]')
        // HTTP authentication for this URL is covered by http-api.test.ts.
        expect(preview.getAttribute('src')).toBe('/luban-image-paste/images/image-1/content')
      })

      const dropEvent = transferEvent('drop', 'dataTransfer', [
        new File([PNG_BYTES], 'dropped scope.png', { type: 'image/png' }),
      ])
      await act(async (): Promise<void> => {
        zone.dispatchEvent(dropEvent)
        await Promise.resolve()
      })
      expect(dropEvent.defaultPrevented).toBe(true)
      await waitForUi((): void => {
        expect(mounted.container.querySelectorAll('img')).toHaveLength(2)
      })
      expect(calls).toEqual(
        expect.arrayContaining([
          {
            path: '/luban-image-paste/images?source=paste&name=pasted+scope.png',
            method: 'POST',
            csrf: 'ui-csrf',
          },
          {
            path: '/luban-image-paste/images?source=drop&name=dropped+scope.png',
            method: 'POST',
            csrf: 'ui-csrf',
          },
        ]),
      )

      await act(async (): Promise<void> => {
        requiredButton(mounted.container, '删除').click()
        await Promise.resolve()
      })
      await waitForUi((): void => {
        const previews = mounted.container.querySelectorAll<HTMLImageElement>('img')
        expect(previews).toHaveLength(1)
        expect(previews[0]?.alt).toBe('dropped scope.png')
      })
      expect(calls).toContainEqual({
        path: '/luban-image-paste/images/image-1',
        method: 'DELETE',
        csrf: 'ui-csrf',
      })

      const getCountBeforeCleanup = calls.filter(
        (call): boolean => call.path === '/luban-image-paste/images' && call.method === 'GET',
      ).length
      await act(async (): Promise<void> => {
        requiredButton(mounted.container, '清理过期图片').click()
        await Promise.resolve()
      })
      await waitForUi((): void => {
        expect(calls).toContainEqual({
          path: '/luban-image-paste/cleanup',
          method: 'POST',
          csrf: 'ui-csrf',
        })
        expect(
          calls.filter(
            (call): boolean => call.path === '/luban-image-paste/images' && call.method === 'GET',
          ),
        ).toHaveLength(getCountBeforeCleanup + 1)
        expect(mounted.container.querySelectorAll('img')).toHaveLength(0)
      })
    } finally {
      await unmount(mounted)
    }
  })
})
