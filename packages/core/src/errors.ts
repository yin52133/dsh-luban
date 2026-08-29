export const LUBAN_ERROR_CODES = [
  'E_AUTH_REQUIRED',
  'E_AUTH_LOCKED',
  'E_BAD_CREDENTIALS',
  'E_VERSION_CONFLICT',
  'E_INVALID_TRANSITION',
  'E_ACCEPTANCE_REQUIRED',
  'E_QUOTA_EXCEEDED',
  'E_CIRCUIT_OPEN',
  'E_CHANNEL_UNAVAILABLE',
  'E_PLATFORM_UNSUPPORTED',
  'E_NOT_FOUND',
  'E_INVALID_INPUT',
  'E_IO',
  'E_TIMEOUT',
  'E_UNAVAILABLE',
] as const

export type LubanErrorCode = (typeof LUBAN_ERROR_CODES)[number]

export interface LubanErrorOptions {
  readonly retriable?: boolean
  readonly cause?: unknown
  readonly details?: Readonly<Record<string, unknown>>
}

/** Stable cross-plugin error shape; sensitive causes are never serialized by default. */
export class LubanError extends Error {
  public readonly code: LubanErrorCode
  public readonly retriable: boolean
  public readonly details: Readonly<Record<string, unknown>> | undefined

  public constructor(code: LubanErrorCode, message: string, options: LubanErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LubanError'
    this.code = code
    this.retriable = options.retriable ?? false
    this.details = options.details
  }

  public toJSON(): Readonly<Record<string, unknown>> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

export function isLubanError(value: unknown): value is LubanError {
  return value instanceof LubanError
}
