import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

interface Handoff {
  readonly id: string
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

describe('__PACKAGE_NAME__ rc2 client bundle', () => {
  it('registers a lazy-CJS factory with the official module loader', () => {
    const source = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
    let handoff: Handoff | undefined
    const window = {
      __ModuleLoader__: {
        load(value: Handoff): void {
          handoff = value
        },
      },
    }

    runInNewContext(source, { window })

    expect(handoff?.id).toBe(__PACKAGE_NAME_JSON__)
    const exports = handoff?.factory((specifier) => {
      throw new Error(`Unexpected external request in neutral template: ${specifier}`)
    })
    expect(exports?.apply).toBeTypeOf('function')
  })
})
