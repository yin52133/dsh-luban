import { readFile } from 'node:fs/promises'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply as applyClient,
  inject as clientInject,
  sendErrorToCurrentSession,
} from '../src/client/index.js'
import { decodeWorkerResult, decodeWorkerSpec } from '../src/worker-protocol.js'

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('server-mode client and package contract', (): void => {
  it('registers one Settings section with sessions injected for log handoff', (): void => {
    let registration: Readonly<Record<string, unknown>> | undefined
    const context = {
      effect(execute: () => () => void): () => void {
        return execute()
      },
      slots: {
        inject(_name: string, callback: () => unknown): unknown {
          return callback()
        },
        register(config: Readonly<Record<string, unknown>>, _component: unknown): () => void {
          registration = config
          return (): void => undefined
        },
      },
      sessions: {},
    }
    applyClient(context as unknown as ClientContext)
    expect(clientInject).toEqual(['slots', 'sessions'])
    expect(registration).toMatchObject({
      name: 'settings.section',
      id: 'luban-server-mode',
      label: 'Server Mode',
    })
  })

  it('uses the current DSH manifest and publish whitelist', async (): Promise<void> => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<Record<string, unknown>>
    expect(manifest).toMatchObject({
      name: '@yin52133/dsh-luban-server-mode',
      files: ['dist/', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
      engines: { dsh: '>=0.1.2-rc.1' },
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
      },
      exports: { './cordis.patch.yml': './cordis.patch.yml' },
    })
    expect((manifest.dsh as Readonly<Record<string, unknown>>).engines).toBeUndefined()
    const peers = manifest.peerDependencies as Readonly<Record<string, unknown>>
    for (const [name, range] of Object.entries(peers)) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(range).toBe('^0.1.2-rc.1')
    }
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
    for (const heading of [
      'Features',
      'Installation',
      'Configuration',
      'Demo',
      'Compatibility',
      'Platform Support',
      'License',
    ])
      expect(readme).toContain(`## ${heading}`)
    expect(readme).toContain('0.1.2-rc.1')
  })

  it('queues the authenticated failure excerpt in the active DSH session', async (): Promise<void> => {
    type Prompt = (
      content: readonly { readonly type: 'text'; readonly text: string }[],
      mode: 'queue',
    ) => Promise<{ readonly ok: true }>
    const prompt = vi.fn<Prompt>().mockResolvedValue({ ok: true })
    const current = { id: 'session-1' }
    let cleanup: (() => void) | undefined
    const context = {
      effect(execute: () => () => void): () => void {
        cleanup = execute()
        return cleanup
      },
      slots: {
        inject(_name: string, callback: () => unknown): unknown {
          return callback()
        },
        register(): () => void {
          return (): void => undefined
        },
      },
      sessions: {
        list: { getSnapshot: (): { readonly current: typeof current } => ({ current }) },
        scope: (value: unknown): unknown => value,
        sessionOf: (): { readonly prompt: typeof prompt } => ({ prompt }),
      },
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ excerpt: 'fatal: compiler rejected firmware.c:42' }))
    vi.stubGlobal('fetch', fetcher)
    applyClient(context as unknown as ClientContext)

    await sendErrorToCurrentSession({
      id: 'job/unsafe',
      templateId: 'cmake-build',
      status: 'failed',
      version: 3,
    })

    expect(fetcher).toHaveBeenCalledWith('/luban-server-mode/jobs/job%2Funsafe/error-log', {
      headers: { accept: 'application/json' },
    })
    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt.mock.calls[0]?.[0][0]?.text).toContain('fatal: compiler rejected firmware.c:42')
    expect(prompt.mock.calls[0]?.[1]).toBe('queue')
    cleanup?.()
  })
})

describe('worker protocol validation', (): void => {
  it('accepts the versioned bounded protocol and rejects malformed data', (): void => {
    expect(
      decodeWorkerSpec({
        schemaVersion: 1,
        command: 'cmake',
        args: ['--build', 'build'],
        cwd: '/workspace',
        timeoutMs: 1_000,
        artifactDirectory: '/artifacts',
        collect: [],
        resultFile: '/state/result.json',
      }),
    ).toMatchObject({ command: 'cmake', timeoutMs: 1_000 })
    expect(
      decodeWorkerResult({
        schemaVersion: 1,
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        durationMs: 10,
      }),
    ).toMatchObject({ exitCode: 0, stdout: 'ok' })
    expect(() => decodeWorkerSpec({ schemaVersion: 2 })).toThrow(/schemaVersion/u)
    expect(() =>
      decodeWorkerResult({
        schemaVersion: 1,
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: -1,
      }),
    ).toThrow(/durationMs/u)
  })
})
