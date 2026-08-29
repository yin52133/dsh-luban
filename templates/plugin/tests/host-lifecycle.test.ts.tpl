import { describe, expect, it } from 'vitest'
import { apply, name } from '../src/index.ts'

describe('__PACKAGE_NAME__ Host lifecycle', () => {
  it('registers a disposer through the Cordis effect boundary', () => {
    let mount: (() => () => void) | undefined
    const ctx = {
      effect(effect: () => () => void): void {
        mount = effect
      },
    }

    apply(ctx as never)

    expect(name).toBe(__PLUGIN_ID_JSON__)
    expect(mount).toBeTypeOf('function')
    expect(mount?.()).toBeTypeOf('function')
  })
})
