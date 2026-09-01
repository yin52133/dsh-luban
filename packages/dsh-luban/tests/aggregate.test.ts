import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import manifest from '../package.json' with { type: 'json' }
import { bundledPackages } from '../src/index.js'

describe('@yin52133/dsh-luban aggregate', () => {
  it('pins every mounted package exactly once', async (): Promise<void> => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

    expect(new Set(bundledPackages).size).toBe(bundledPackages.length)
    for (const packageName of bundledPackages) {
      expect(manifest.dependencies[packageName as keyof typeof manifest.dependencies]).toBeDefined()
      expect(patch.match(new RegExp(`name: ['"]${packageName}['"]`, 'gu'))).toHaveLength(1)
    }
  })

  it('keeps companion packages at reviewed versions', (): void => {
    expect(manifest.dependencies).toMatchObject({
      dshmarket: '1.36.0',
      'dsh-better-sidebar': '0.17.1',
      '@furongjun1999/dsh-memory': '0.4.0',
    })
  })
})
