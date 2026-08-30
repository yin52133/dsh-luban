import type {
  AccountId,
  BrowserEvent,
  BrowserProfile,
  BrowserResult,
  BrowserSession,
  BrowserTaskSpec,
  BrowserTemplate,
} from 'dsh-luban-core'

export type BrowserJobStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled'

export interface BrowserTemplateProfile {
  readonly mode: 'isolated' | 'persistent'
  readonly name?: string
}

export interface LubanBrowserTemplate extends BrowserTemplate {
  readonly maxSteps: number
  readonly profile: BrowserTemplateProfile
}

export interface BrowserJobRequest {
  readonly accountId: AccountId
  readonly task: BrowserTaskSpec
  readonly params?: Readonly<Record<string, string>>
  /** Internal scheduler flag. HTTP callers cannot set this field. */
  readonly automatic?: boolean
}

export interface BrowserJobError {
  readonly code: string
  readonly message: string
  readonly retriable: boolean
}

export interface BrowserJobSnapshot {
  readonly id: string
  readonly accountId: AccountId
  readonly status: BrowserJobStatus
  readonly task: BrowserTaskSpec
  readonly automatic: boolean
  readonly createdAt: number
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly progressStep: number
  readonly screenshots: readonly string[]
  readonly result?: BrowserResult
  readonly error?: BrowserJobError
}

export interface BrowserJobEvent {
  readonly sequence: number
  readonly at: number
  readonly job: BrowserJobSnapshot
  readonly event?: BrowserEvent
}

export interface ResolvedBrowserTask {
  readonly runId: string
  readonly accountId: AccountId
  readonly goal: string
  readonly startUrl?: string
  readonly maxSteps: number
  readonly timeoutSec: number
  readonly allowDomains: readonly string[]
  readonly outputSchema?: Readonly<Record<string, unknown>>
  readonly profile: BrowserProfile
}

export interface BrowserBridge {
  start(profile: BrowserProfile): Promise<BrowserSession>
  run(
    task: ResolvedBrowserTask,
    outputDir: string,
    signal: AbortSignal,
  ): AsyncIterable<BrowserEvent>
  stop(): Promise<void>
  close(): Promise<void>
}

export interface BrowserQueue {
  enqueue(request: BrowserJobRequest): BrowserJobSnapshot
  cancel(id: string, accountId: AccountId): Promise<boolean>
  get(id: string, accountId: AccountId): BrowserJobSnapshot | null
  list(accountId: AccountId): readonly BrowserJobSnapshot[]
  wait(id: string, accountId: AccountId): Promise<BrowserJobSnapshot>
  subscribe(accountId: AccountId, listener: (event: BrowserJobEvent) => void): () => void
  subscribeAll(listener: (event: BrowserJobEvent) => void): () => void
}
