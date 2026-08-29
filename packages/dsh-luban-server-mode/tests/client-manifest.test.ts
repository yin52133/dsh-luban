import { readFile } from 'node:fs/promises'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply as applyClient, inject as clientInject } from '../src/client/index.js'
import { decodeWorkerResult, decodeWorkerSpec } from '../src/worker-protocol.js'

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
      name: 'dsh-luban-server-mode',
      files: ['dist/', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
      engines: { dsh: '>=0.1.1-rc.1' },
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
      },
      exports: { './cordis.patch.yml': './cordis.patch.yml' },
    })
    expect((manifest.dsh as Readonly<Record<string, unknown>>).engines).toBeUndefined()
    const peers = manifest.peerDependencies as Readonly<Record<string, unknown>>
    for (const [name, range] of Object.entries(peers)) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(range).toBe('>=0.1.1-rc.1')
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
    expect(readme).toContain('0.1.1-rc.2')
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
