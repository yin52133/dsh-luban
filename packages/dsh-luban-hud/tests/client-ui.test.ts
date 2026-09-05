// @vitest-environment jsdom

import type { TelemetryProvider } from '@yin52133/dsh-luban-core'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DefaultTelemetryAggregator } from '../src/aggregator.js'
import { apply as applyClient, HudStatusBar } from '../src/client/index.js'
import { HUD_TELEMETRY_EVENT, type HudSnapshotResponse } from '../src/types.js'

class FakeEventSource {
  public static readonly instances: FakeEventSource[] = []
  public readonly listeners = new Map<string, Set<EventListener>>()
  public readonly close = vi.fn<() => void>()
  public onerror: ((event: Event) => void) | null = null

  public constructor(public readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  public addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  public emit(type: string, data: string): void {
    const event = { data } as MessageEvent<string>
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const publicConfig = {
  thresholds: { warn: 0.7, danger: 0.85, critical: 0.95 },
  display: {
    fields: ['context', 'workspace', 'model', 'thinking', 'tpm', 'rpm'] as const,
    compact: false,
  },
} as const

interface MountedRoot {
  readonly container: HTMLDivElement
  readonly root: Root
}

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((accept): void => {
    resolve = accept
  })
  if (resolve === undefined) throw new Error('deferred resolver was not initialized')
  return { promise, resolve }
}

async function responseAt(ratio: number): Promise<HudSnapshotResponse> {
  const aggregator = new DefaultTelemetryAggregator({ refreshMs: 1_000, providerTimeoutMs: 100 })
  const healthy: TelemetryProvider = {
    id: 'healthy-ui-provider',
    capabilities: () => ['context', 'workspace', 'model', 'rates'],
    sample: () =>
      Promise.resolve({
        context: { used: ratio * 100, max: 100, ratio },
        workspace: { name: 'ui-workspace' },
        model: { name: 'ui-model', thinkingDepth: 'high' },
        rates: { tpm1m: 120, tpm5m: 80, rpm1m: 2, rpm5m: 1 },
      }),
  }
  const failing: TelemetryProvider = {
    id: 'failed-ui-provider',
    capabilities: () => ['model'],
    sample: () => Promise.reject(new Error('private upstream diagnostic')),
  }
  aggregator.register(healthy)
  aggregator.register(failing)
  try {
    return { ...(await aggregator.envelope()), config: publicConfig }
  } finally {
    aggregator.dispose()
  }
}

async function mountHud(): Promise<MountedRoot> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async (): Promise<void> => {
    root.render(createElement(HudStatusBar))
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

function requiredElement(container: ParentNode, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`${selector} was not rendered`)
  return element
}

beforeEach((): void => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

afterEach((): void => {
  FakeEventSource.instances.length = 0
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('HUD React overlay', (): void => {
  it('registers the tested component in the official frame-wide slot', (): void => {
    const register = vi.fn((): (() => void) => (): void => undefined)
    const inject = vi.fn((_name: string, contribution: () => unknown): unknown => contribution())

    applyClient({ slots: { inject, register } } as never)

    expect(inject).toHaveBeenCalledWith('shell.overlay', expect.any(Function))
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'shell.overlay', id: 'luban-hud' }),
      HudStatusBar,
    )
  })

  it('keeps healthy fields and bounded failure details visible through 70/85/95 SSE updates', async (): Promise<void> => {
    const [warn, danger, critical] = await Promise.all([
      responseAt(0.7),
      responseAt(0.85),
      responseAt(0.95),
    ])
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const fetcher = vi.fn((): Promise<Response> => Promise.resolve(Response.json(warn)))
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', (url: string): Promise<Response> =>
      url === '/luban-auth/session' ? Promise.resolve(Response.json({ user: 'admin' })) : fetcher(),
    )
    const mounted = await mountHud()

    try {
      await waitForUi((): void => {
        expect(requiredElement(mounted.container, 'aside').dataset.level).toBe('warn')
        expect(mounted.container.textContent).toContain('ctx 70/100 · 70%')
      })

      const text = mounted.container.textContent
      expect(text).toContain('ws ui-workspace')
      expect(text).toContain('model ui-model')
      expect(text).toContain('TPM 120/80')
      expect(text).toContain('RPM 2/1')
      expect(text).toContain('partial')
      expect(text).toContain('账号：admin')
      const logout = mounted.container.querySelector<HTMLFormElement>('form')
      expect(logout?.getAttribute('action')).toBe('/luban-auth/logout')
      expect(logout?.method).toBe('post')
      const partial = requiredElement(mounted.container, '.luban-hud__error')
      expect(partial.title).toBe('private upstream diagnostic')
      expect(FakeEventSource.instances).toHaveLength(1)
      const stream = FakeEventSource.instances[0]
      if (stream === undefined) throw new Error('HUD SSE stream was not opened')

      await act(async (): Promise<void> => {
        stream.emit(HUD_TELEMETRY_EVENT, JSON.stringify(danger))
        await Promise.resolve()
      })
      expect(requiredElement(mounted.container, 'aside').dataset.level).toBe('danger')
      expect(mounted.container.textContent).toContain('ctx 85/100 · 85%')

      await act(async (): Promise<void> => {
        stream.emit(HUD_TELEMETRY_EVENT, JSON.stringify(critical))
        await Promise.resolve()
      })
      expect(requiredElement(mounted.container, 'aside').dataset.level).toBe('critical')
      expect(mounted.container.textContent).toContain('ctx 95/100 · 95%')
      expect(mounted.container.textContent).toContain('compact recommended')

      await unmount(mounted)
      expect(stream.close).toHaveBeenCalledOnce()
    } finally {
      if (mounted.container.isConnected) await unmount(mounted)
    }
  })

  it('closes while hidden, reopens while visible, and ignores a refresh completing after unmount', async (): Promise<void> => {
    const warn = await responseAt(0.7)
    const pendingRefresh = deferred<Response>()
    const inspectedAfterUnmount = vi.fn()
    const lateEnvelope: HudSnapshotResponse = {
      ...warn,
      get snapshot(): HudSnapshotResponse['snapshot'] {
        inspectedAfterUnmount()
        return warn.snapshot
      },
    }
    const lateJson = vi.fn((): Promise<HudSnapshotResponse> => Promise.resolve(lateEnvelope))
    const lateResponse = { ok: true, json: lateJson } as unknown as Response
    let hidden = false
    vi.spyOn(document, 'hidden', 'get').mockImplementation((): boolean => hidden)
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(Response.json(warn))
      .mockReturnValueOnce(pendingRefresh.promise)
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', (url: string): Promise<Response> =>
      url === '/luban-auth/session'
        ? Promise.resolve(new Response(null, { status: 404 }))
        : fetcher(),
    )
    const mounted = await mountHud()

    try {
      await waitForUi((): void => {
        expect(fetcher).toHaveBeenCalledOnce()
        expect(FakeEventSource.instances).toHaveLength(1)
      })
      const first = FakeEventSource.instances[0]
      if (first === undefined) throw new Error('initial HUD SSE stream was not opened')

      hidden = true
      await act(async (): Promise<void> => {
        document.dispatchEvent(new Event('visibilitychange'))
        await Promise.resolve()
      })
      expect(first.close).toHaveBeenCalledOnce()

      hidden = false
      await act(async (): Promise<void> => {
        document.dispatchEvent(new Event('visibilitychange'))
        await Promise.resolve()
      })
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(FakeEventSource.instances).toHaveLength(2)
      const second = FakeEventSource.instances[1]
      if (second === undefined) throw new Error('visible HUD SSE stream was not reopened')

      await unmount(mounted)
      expect(second.close).toHaveBeenCalledOnce()

      pendingRefresh.resolve(lateResponse)
      await waitForUi((): void => {
        expect(lateJson).toHaveBeenCalledOnce()
      })
      expect(inspectedAfterUnmount).not.toHaveBeenCalled()
      document.dispatchEvent(new Event('visibilitychange'))
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(FakeEventSource.instances).toHaveLength(2)
      expect(mounted.container.childNodes).toHaveLength(0)
    } finally {
      if (mounted.container.isConnected) await unmount(mounted)
      pendingRefresh.resolve(lateResponse)
      await act(async (): Promise<void> => {
        await Promise.resolve()
      })
    }
  })
})
