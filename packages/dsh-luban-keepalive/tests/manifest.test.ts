import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('keepalive package contract', (): void => {
  it('publishes only the current DSH host manifest and required artifacts', async (): Promise<void> => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<Record<string, unknown>>
    expect(manifest).toMatchObject({
      name: '@yin52133/dsh-luban-keepalive',
      files: ['dist/', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
      engines: { dsh: '>=0.1.1-rc.1' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      exports: { './cordis.patch.yml': './cordis.patch.yml' },
    })
    expect((manifest.dsh as Readonly<Record<string, unknown>>).engines).toBeUndefined()
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('id: luban-keepalive')
    expect(patch).toContain("name: '@yin52133/dsh-luban-keepalive'")
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
