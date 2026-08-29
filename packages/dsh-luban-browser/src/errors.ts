import type { BrowserJobError } from './types.js'

export type BrowserErrorCode =
  | 'E_BROWSER_PROTOCOL'
  | 'E_BROWSER_VERSION'
  | 'E_BROWSER_UNAVAILABLE'
  | 'E_BROWSER_NOT_STARTED'
  | 'E_BROWSER_BUSY'
  | 'E_BROWSER_INVALID_PROFILE'
  | 'E_BROWSER_INVALID_TASK'
  | 'E_BROWSER_POLICY'
  | 'E_BROWSER_QUEUE_FULL'
  | 'E_BROWSER_NOT_FOUND'
  | 'E_BROWSER_TIMEOUT'
  | 'E_BROWSER_CANCELLED'
  | 'E_BROWSER_OUTPUT_INVALID'
  | 'E_BROWSER_RUN'
  | 'E_BROWSER_CLOSED'

export class BrowserError extends Error {
  public readonly code: BrowserErrorCode
  public readonly retriable: boolean

  public constructor(code: BrowserErrorCode, message: string, retriable = false) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
    this.retriable = retriable
  }

  public toJSON(): BrowserJobError {
    return { code: this.code, message: this.message, retriable: this.retriable }
  }
}

export function asBrowserError(error: unknown): BrowserError {
  if (error instanceof BrowserError) return error
  if (error instanceof Error && error.name === 'AbortError') {
    return new BrowserError('E_BROWSER_CANCELLED', 'Browser task was cancelled', true)
  }
  return new BrowserError('E_BROWSER_RUN', 'Browser task failed')
}
