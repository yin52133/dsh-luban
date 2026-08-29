import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('HUD package contract', (): void => {
  it('publishes the rc2 Web client, patch alias, and allowlisted artifacts', async (): Promise<void> => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Readonly<Record<string, unknown>>
    expect(manifest).toMatchObject({
      name: 'dsh-luban-hud',
      files: ['dist/', 'cordis.patch.yml', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
      engines: { node: '^22.19.0 || >=24.0.0', dsh: '>=0.1.1-rc.1' },
      exports: {
        './client': { default: './dist/client.js' },
        './patch': './cordis.patch.yml',
        './cordis.patch.yml': './cordis.patch.yml',
      },
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
      },
      peerDependencies: { '@deepseek-ai/dsh-llm': '>=0.1.1-rc.1' },
    })
    expect(JSON.stringify(manifest)).not.toContain('dsh-luban-context')
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('id: luban-hud')
    expect(patch).toContain('name: dsh-luban-hud')
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
    for (const heading of [
      'Features',
      'Installation',
      'Configuration',
      'Demo',
      'Compatibility',
      'Platform Support',
      'License',
    ]) {
      expect(readme).toContain(`## ${heading}`)
    }
    expect(readme).toContain('0.1.1-rc.2')
  })
})
