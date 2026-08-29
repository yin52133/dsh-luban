import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bridgeEnvironment, redactBrowserLog } from '../src/security.js'
import { renderTemplate, TemplateRepository } from '../src/templates.js'

const cleanup: string[] = []

afterEach(async (): Promise<void> => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('TemplateRepository', () => {
  it('loads strict YAML and lets the user directory override a bundled id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luban-template-test-'))
    cleanup.push(root)
    const bundled = join(root, 'bundled')
    const user = join(root, 'user')
    await Promise.all([mkdir(bundled), mkdir(user)])
    await writeFile(join(bundled, 'site.yaml'), template('Bundled'), 'utf8')
    await writeFile(join(user, 'site.yaml'), template('User override'), 'utf8')

    const templates = await new TemplateRepository([bundled, user]).list()

    expect(templates).toHaveLength(1)
    expect(templates[0]?.title).toBe('User override')
    expect(renderTemplate(templates[0]?.goal ?? '', { topic: 'security' })).toContain('security')
    expect(() => renderTemplate('${missing}', {})).toThrow(/Missing browser template parameter/u)
  })

  it('rejects malformed or unsafe profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luban-template-test-'))
    cleanup.push(root)
    await writeFile(
      join(root, 'bad.yaml'),
      template('Bad').replace('mode: isolated', 'mode: persistent'),
      'utf8',
    )
    await expect(new TemplateRepository([root]).list()).rejects.toThrow(/requires a safe name/u)
  })

  it('rejects unrestricted domain wildcards while allowing subdomain patterns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luban-template-test-'))
    cleanup.push(root)
    await writeFile(
      join(root, 'safe.yaml'),
      template('Subdomain policy').replace('  - example.com', '  - "*.example.com"'),
      'utf8',
    )
    await expect(new TemplateRepository([root]).list()).resolves.toHaveLength(1)
    await writeFile(
      join(root, 'unsafe.yaml'),
      template('Unsafe policy').replace('  - example.com', '  - "*"'),
      'utf8',
    )
    await expect(new TemplateRepository([root]).list()).rejects.toThrow(
      /cannot contain wildcard \*/u,
    )
  })
})

describe('bridge environment security', () => {
  it('passes only base and explicitly named variables', () => {
    const environment = bridgeEnvironment(
      { PATH: '/bin', OPENAI_API_KEY: 'secret', UNRELATED_SECRET: 'nope' },
      ['OPENAI_API_KEY'],
      '/isolated/uv',
    )
    expect(environment.OPENAI_API_KEY).toBe('secret')
    expect(environment.UNRELATED_SECRET).toBeUndefined()
    expect(environment.UV_PROJECT_ENVIRONMENT).toBe('/isolated/uv')
  })

  it('redacts common secret shapes', () => {
    const output = redactBrowserLog('token=secret Bearer abc.def sk_test_123456789')
    expect(output).not.toContain('secret')
    expect(output).not.toContain('abc.def')
    expect(output).not.toContain('123456789')
  })
})

function template(title: string): string {
  return [
    'id: site',
    `title: ${title}`,
    'goal: Research ${topic}',
    'allowDomains:',
    '  - example.com',
    'timeoutSec: 30',
    'maxSteps: 5',
    'profile:',
    '  mode: isolated',
  ].join('\n')
}
