export type ValidationResult<Value> =
  | { readonly value: Value }
  | {
      readonly issues: readonly {
        readonly message: string
        readonly path?: readonly PropertyKey[]
      }[]
    }

export interface StandardConfigSchema<Value> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: 'dsh-luban'
    validate(input: unknown): ValidationResult<Value>
  }
}

/** Adapt a throwing config parser to the Cordis Standard Schema contract. */
export function standardConfigSchema<Value>(
  parse: (input: unknown) => Value,
): StandardConfigSchema<Value> {
  return Object.freeze({
    '~standard': {
      version: 1 as const,
      vendor: 'dsh-luban' as const,
      validate(input: unknown): ValidationResult<Value> {
        try {
          return { value: parse(input) }
        } catch (error: unknown) {
          return {
            issues: [{ message: error instanceof Error ? error.message : 'invalid config' }],
          }
        }
      },
    },
  })
}
