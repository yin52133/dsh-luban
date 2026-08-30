import type {
  AccountContext,
  AccountId,
  Actor,
  HostId,
  PlanId,
  SessionId,
  TaskId,
  Unsubscribe,
} from './common.js'
import type {
  ArtifactRef,
  BrowserResult,
  BrowserTaskSpec,
  BuildJob,
  ChannelEndpoint,
  Checkpoint,
  CompactionAuditRecord,
  CompactionPlan,
  ContextSegment,
  IngestedImage,
  ManagedSession,
  Plan,
  PlanSections,
  PlanStatus,
  ResourceReport,
  SessionRole,
  SharedSession,
  SnippetFile,
  Task,
  TaskClaim,
  TaskOutput,
  TaskStatus,
  TelemetrySnapshot,
} from './models.js'

export interface VerifyResult {
  readonly ok: boolean
  readonly reason?: 'bad-credentials' | 'locked' | 'unknown-user'
  readonly retryAfterSec?: number
}

export interface IssuedSession {
  readonly id: string
  readonly accountId?: AccountId
  readonly user: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly sourceIp: string
}

export type AuthEvent =
  | { readonly type: 'login'; readonly user: string; readonly sourceIp: string }
  | { readonly type: 'logout'; readonly user: string }
  | { readonly type: 'lockout'; readonly user: string; readonly sourceIp: string }

export interface AuthMiddlewareRequest {
  readonly path: string
  readonly method: string
  readonly accept: string | undefined
  readonly cookie: string | undefined
  readonly sourceIp: string
}

export interface AuthMiddlewareDecision {
  readonly allowed: boolean
  readonly status: 200 | 302 | 401 | 403 | 429
  readonly redirectTo?: string
  readonly user?: string
  readonly account?: AccountContext
}

export type AuthMiddleware = (request: AuthMiddlewareRequest) => Promise<AuthMiddlewareDecision>

export interface AccountSessionRegistry {
  /** Bind an unowned DSH session to an account; rebinding to another account is rejected. */
  bind(accountId: AccountId, sessionId: SessionId): Promise<void>
  ownerOf(sessionId: SessionId): Promise<AccountId | null>
}

export interface AuthService {
  verify(user: string, password: string, sourceIp: string): Promise<VerifyResult>
  issueSession(user: string, sourceIp: string): Promise<IssuedSession>
  revoke(sessionId: string): Promise<void>
  revokeAllFor(user: string): Promise<void>
  middleware(): AuthMiddleware
  onChange(listener: (event: AuthEvent) => void): Unsubscribe
  readonly accountSessions: AccountSessionRegistry
}

export interface TaskCreateInput {
  /** Set by the authenticated service boundary, never by the request body. */
  readonly accountId?: AccountId
  readonly title: string
  readonly description?: string
  readonly status?: 'backlog' | 'todo'
  readonly hostScope: 'win' | 'ubuntu' | 'any'
  readonly workspace?: string
  readonly priority: 'P0' | 'P1' | 'P2' | 'P3'
  readonly acceptance?: string
  readonly tags?: readonly string[]
}

export interface TaskPatch {
  readonly title?: string
  readonly description?: string
  readonly workspace?: string | null
  readonly priority?: 'P0' | 'P1' | 'P2' | 'P3'
  readonly acceptance?: string | null
  readonly tags?: readonly string[]
}

export interface TaskQuery {
  readonly accountId?: AccountId
  readonly statuses?: readonly TaskStatus[]
  readonly hostScope?: 'win' | 'ubuntu' | 'any'
  readonly workspace?: string
  readonly tags?: readonly string[]
}

export type TaskEvent =
  | { readonly type: 'created'; readonly task: Task }
  | { readonly type: 'updated'; readonly task: Task }
  | {
      readonly type: 'transitioned'
      readonly task: Task
      readonly from: TaskStatus
      readonly to: TaskStatus
      readonly actor: Actor
      readonly note?: string
    }

export interface TaskStore {
  create(input: TaskCreateInput): Promise<Task>
  update(id: TaskId, patch: TaskPatch, expectedVersion: number): Promise<Task>
  transition(id: TaskId, to: TaskStatus, actor: Actor, note?: string): Promise<Task>
  get(id: TaskId): Promise<Task | null>
  query(filter: TaskQuery): Promise<readonly Task[]>
  subscribe(listener: (event: TaskEvent) => void): Unsubscribe
}

export interface ClaimFilter extends TaskQuery {
  readonly requireAcceptance?: boolean
}

export interface ClaimSession {
  readonly actor: Actor
  readonly sessionId: SessionId
  readonly host: HostId
  /** Trusted in-process execution owner; HTTP claim requests cannot set this field. */
  readonly executionOwner?: 'night-scheduler'
}

export type ClaimResult =
  | { readonly ok: true; readonly task: Task }
  | { readonly ok: false; readonly reason: 'no-match' | 'version-conflict' | 'acceptance-required' }

export interface TaskProgress {
  readonly summary: string
  readonly percent?: number
}

export interface ClaimMutationOptions {
  readonly expectedClaim?: TaskClaim
}

export interface ClaimCompletionOptions extends ClaimMutationOptions {
  readonly autoDone: boolean
}

export interface AgentClaimService {
  claim(filter: ClaimFilter, session: ClaimSession): Promise<ClaimResult>
  reportProgress(id: TaskId, progress: TaskProgress, options?: ClaimMutationOptions): Promise<void>
  complete(id: TaskId, output: TaskOutput, options: ClaimCompletionOptions): Promise<Task>
  fail(id: TaskId, reason: string, options?: ClaimMutationOptions): Promise<void>
}

export interface SchedulerStatus {
  readonly windowActive: boolean
  readonly quotaUsed: number
  readonly circuit: 'ok' | 'open'
}

export interface NightTaskExecutor {
  execute(task: Task, sessionId: SessionId): Promise<TaskOutput>
}

export interface NightTaskExecutorRoute {
  readonly id: string
  readonly matches: (task: Task) => boolean
  readonly executor: NightTaskExecutor
}

export interface NightScheduler {
  start(): void
  stop(): void
  status(): SchedulerStatus
  triggerOnce(): Promise<void>
  registerTaskExecutor(route: NightTaskExecutorRoute): Unsubscribe
}

export interface SessionSpec {
  readonly id: string
  readonly purpose: 'dsh-main' | 'task' | 'build'
  readonly command: string
  readonly args?: readonly string[]
  readonly ownerTaskId?: TaskId
}

export interface HealthReport {
  readonly healthy: boolean
  readonly checkedAt: number
  readonly sessions: readonly {
    readonly id: string
    readonly alive: boolean
    readonly detail?: string
  }[]
}

export type KeepaliveEvent =
  | { readonly type: 'started'; readonly session: ManagedSession }
  | { readonly type: 'health'; readonly report: HealthReport }
  | {
      readonly type: 'restored'
      readonly session: ManagedSession
      readonly checkpoint?: Checkpoint
    }

export interface KeepaliveAdapter {
  create(spec: SessionSpec): Promise<ManagedSession>
  attach(id: string): Promise<void>
  list(): Promise<readonly ManagedSession[]>
  isAlive(id: string): Promise<boolean>
  /** Destroy only the runtime bound to the exact persisted session specification. */
  destroy(spec: SessionSpec): Promise<void>
}

export interface KeepaliveService {
  ensureAlive(spec: SessionSpec): Promise<ManagedSession>
  patrol(): Promise<HealthReport>
  onEvent(listener: (event: KeepaliveEvent) => void): Unsubscribe
  saveCheckpoint(id: string, checkpoint: Checkpoint): Promise<void>
  loadCheckpoint(id: string): Promise<Checkpoint | null>
}

export interface PlanInput {
  readonly taskId?: TaskId
  readonly sessionId?: SessionId
  readonly workspace: string
  readonly slug: string
  readonly sections: PlanSections
}

export interface PlanDecision {
  readonly decision: 'approve' | 'reject'
  readonly comment?: string
  readonly expectedVersion: number
}

export interface PlanGuardResult {
  readonly ok: boolean
  readonly reason?: string
}

export interface PlanGuard {
  assertExecutable(tool: string, plan: Plan | null): PlanGuardResult
}

export interface PlanService {
  submit(input: PlanInput): Promise<Plan>
  decide(id: PlanId, decision: PlanDecision, reviewer: Actor): Promise<Plan>
  transition(id: PlanId, to: PlanStatus, expectedVersion: number): Promise<Plan>
  get(id: PlanId): Promise<Plan | null>
  listFor(taskId?: TaskId): Promise<readonly Plan[]>
  guard(): PlanGuard
}

export type SessionEvent =
  | { readonly type: 'output'; readonly seq: number; readonly text: string; readonly at: number }
  | { readonly type: 'status'; readonly seq: number; readonly status: string; readonly at: number }

export type TakeoverResult =
  | { readonly status: 'granted'; readonly session: SharedSession }
  | { readonly status: 'pending'; readonly requestId: string }
  | { readonly status: 'denied'; readonly reason: string }

export type RegistryEvent =
  | { readonly type: 'registered'; readonly session: SharedSession }
  | { readonly type: 'changed'; readonly session: SharedSession }
  | { readonly type: 'removed'; readonly sessionId: SessionId }

export interface SessionRegistry {
  list(filter?: {
    readonly host?: HostId
    readonly taskId?: TaskId
  }): Promise<readonly SharedSession[]>
  subscribe(id: SessionId, role: SessionRole): AsyncIterable<SessionEvent>
  requestTakeover(id: SessionId, by: Actor): Promise<TakeoverResult>
  release(id: SessionId, by: Actor): Promise<void>
  onRegistryChange(listener: (event: RegistryEvent) => void): Unsubscribe
}

export interface CleanupReport {
  readonly candidates: readonly string[]
  readonly removed: readonly string[]
  readonly retainedReferenced: readonly string[]
  readonly errors: readonly { readonly path: string; readonly message: string }[]
}

export interface ImageIngestService {
  fromBlob(blob: Blob, meta?: { readonly nameHint?: string }): Promise<IngestedImage>
  fromClipboard(): Promise<IngestedImage>
  inject(sessionId: SessionId, image: IngestedImage, style: 'markdown' | 'path'): Promise<void>
  recent(filter?: { readonly sessionId?: SessionId }): Promise<readonly IngestedImage[]>
  cleanup(dryRun?: boolean): Promise<CleanupReport>
}

/** Exact durable DSH response identity presented to a provider-wire adapter. */
export interface ProviderRequestIdentityQuery {
  readonly sessionId: string
  readonly assistantEventSeq: number
  readonly turn: number
  readonly step: number
  readonly assistantMessageId: string
  readonly provider: string
  readonly model: string
  readonly challenge: string
}

/**
 * Provider-wire attestation returned for one exact successful DSH response.
 *
 * The request id is intentionally opaque. Consumers must validate every echoed
 * binding field and persist only a digest unless an independent provider export
 * requires the raw id for an in-memory reconciliation.
 */
export interface ProviderRequestIdentityAttestation {
  readonly schemaVersion: 'dsh-luban/provider-request-identity/v1'
  readonly adapter: {
    readonly id: string
    readonly version: string
    readonly runtimeSha256: string
  }
  readonly binding: {
    readonly sessionId: string
    readonly assistantEventSeq: number
    readonly turn: number
    readonly step: number
    readonly assistantMessageId: string
    readonly provider: string
    readonly model: string
    readonly challengeSha256: string
  }
  readonly providerRequestId: string
}

/** Optional provider-specific capability; implementations observe the real wire response. */
export interface ProviderRequestIdentityAdapter {
  attest(query: ProviderRequestIdentityQuery, signal: AbortSignal): Promise<unknown>
}

export type TelemetryField = 'context' | 'workspace' | 'model' | 'rates'

export interface TelemetryProvider {
  readonly id: string
  capabilities(): readonly TelemetryField[]
  sample(): Promise<Partial<TelemetrySnapshot>>
  /** Sample one live session when the provider has session-scoped data. */
  sampleForSession?(sessionId: SessionId): Promise<Partial<TelemetrySnapshot>>
}

export interface TelemetryAggregator {
  register(provider: TelemetryProvider): Unsubscribe
  snapshot(): Promise<TelemetrySnapshot>
  /** Bypass the global HUD cache and sample the requested session. */
  snapshotFor(sessionId: SessionId): Promise<TelemetrySnapshot>
  subscribe(listener: (snapshot: TelemetrySnapshot) => void): Unsubscribe
}

export interface CompactionContext {
  readonly sessionId: SessionId
  readonly archiveDir: string
  archive(segment: ContextSegment, content: string): Promise<string>
  summarize(segments: readonly ContextSegment[]): Promise<string>
  inject(summary: string, archiveFiles: readonly string[]): Promise<void>
}

export interface CompactionResult {
  readonly beforeTokens: number
  readonly afterTokens: number
  readonly archiveFiles: readonly string[]
}

export interface CompactionStrategy {
  readonly id: string
  plan(input: {
    readonly segments: readonly ContextSegment[]
    readonly budgetTokens: number
  }): CompactionPlan
  execute(plan: CompactionPlan, context: CompactionContext): Promise<CompactionResult>
}

export interface SessionRef {
  readonly id: SessionId
  readonly segments: readonly ContextSegment[]
  readonly atTurnBoundary: boolean
}

export interface CompactionEngine {
  register(strategy: CompactionStrategy): Unsubscribe
  use(strategyId: string, scope?: { readonly taskScope?: 'night' | 'day' }): void
  maybeCompact(session: SessionRef, telemetry: TelemetrySnapshot): Promise<void>
  audit(sessionId: SessionId): Promise<readonly CompactionAuditRecord[]>
}

export interface BuildJobInput {
  /** Set by the authenticated service boundary, never by the request body. */
  readonly accountId?: AccountId
  readonly templateId: string
  readonly params: Readonly<Record<string, string>>
}

export interface ServerModeService {
  install(options: { readonly user: string; readonly profile: 'ubuntu-server' }): Promise<void>
  uninstall(): Promise<void>
  enqueue(job: BuildJobInput): Promise<BuildJob>
  queue(accountId?: AccountId): Promise<readonly BuildJob[]>
  artifacts(jobId: string, accountId?: AccountId): Promise<readonly ArtifactRef[]>
  resourceReport(): Promise<ResourceReport>
}

export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

export interface OpenOptions {
  readonly baudRate?: number
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export type ChannelDataEvent =
  | { readonly type: 'data'; readonly data: Uint8Array; readonly at: number }
  | {
      readonly type: 'status'
      readonly status: 'open' | 'closed' | 'error'
      readonly detail?: string
      readonly at: number
    }

export interface ChannelHandle {
  write(data: Uint8Array | string): Promise<void>
  readEvents(): AsyncIterable<ChannelDataEvent>
  exec?(command: string): Promise<ExecResult>
  close(): Promise<void>
}

export interface ChannelAdapter {
  readonly kind: ChannelEndpoint['kind']
  list(): Promise<readonly ChannelEndpoint[]>
  open(endpoint: ChannelEndpoint, options: OpenOptions): Promise<ChannelHandle>
}

export interface SnippetRange {
  readonly from: number
  readonly to: number
}

export interface WinDebugService {
  captureSnippet(handle: ChannelHandle, range: SnippetRange): Promise<SnippetFile>
  injectToSession(sessionId: SessionId, snippet: SnippetFile): Promise<void>
  runTemplate(templateId: string, params: Readonly<Record<string, string>>): Promise<ExecResult>
}

export interface BrowserProfile {
  readonly kernel?: 'auto' | 'chrome' | 'edge' | 'chromium-headless'
  readonly userDataDir?: string
  /** Explicit executable to validate and launch instead of searching installed browsers. */
  readonly executablePath?: string
  readonly headless?: boolean
  /** True when the bridge created and owns the browser profile directory. */
  readonly isolated?: boolean
  /** Attestation of the executable that the bridge will launch. */
  readonly binary?: BrowserBinaryAttestation
}

export interface BrowserBinaryAttestation {
  readonly kind: 'chrome' | 'edge' | 'chromium'
  readonly version: string
  readonly sha256: string
}

export interface BrowserSession {
  readonly id: string
  readonly profile: BrowserProfile
  readonly startedAt: number
}

export type BrowserEvent =
  | {
      readonly type: 'progress'
      readonly runId: string
      readonly step: number
      readonly detail: string
    }
  | { readonly type: 'screenshot'; readonly runId: string; readonly path: string }
  | { readonly type: 'result'; readonly result: BrowserResult }
  | { readonly type: 'error'; readonly runId: string; readonly message: string }

export interface BrowserTemplate {
  readonly id: string
  readonly title: string
  readonly goal: string
  readonly startUrl?: string
  readonly allowDomains: readonly string[]
  readonly timeoutSec: number
  readonly outputSchema?: Readonly<Record<string, unknown>>
}

export interface BrowserAdapter {
  start(profile?: BrowserProfile): Promise<BrowserSession>
  run(task: BrowserTaskSpec): AsyncIterable<BrowserEvent>
  stop(): Promise<void>
  templates(): Promise<readonly BrowserTemplate[]>
}
