import { describe, expect, it } from 'vitest'
import { standardConfigSchema } from '../src/config.js'

describe('standardConfigSchema', (): void => {
  it('exposes the parser through Standard Schema v1', (): void => {
    const schema = standardConfigSchema((input): string => String(input))

    expect(schema['~standard']).toMatchObject({ version: 1, vendor: 'dsh-luban' })
    expect(schema['~standard'].validate(42)).toEqual({ value: '42' })
  })

  it('converts parser failures into schema issues', (): void => {
    const schema = standardConfigSchema((): never => {
      throw new TypeError('invalid option')
    })

    expect(schema['~standard'].validate({})).toEqual({
      issues: [{ message: 'invalid option' }],
    })
  })
})
