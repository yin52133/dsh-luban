import type {
  Actor,
  ActorId,
  EpochMs,
  HostId,
  PackageName,
  PlanId,
  SessionId,
  TaskId,
} from './common.js'

export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'review' | 'done' | 'dropped'
export type HostScope = 'win' | 'ubuntu' | 'any'
export type Priority = 'P0' | 'P1' | 'P2' | 'P3'

export interface TaskOutput {
  readonly kind: 'note' | 'commit' | 'artifact' | 'link'
  readonly ref: string
  readonly summary: string
  readonly at: EpochMs
  readonly by: Actor
}

export interface TaskClaim {
  readonly actor: Actor
  readonly sessionId: SessionId
  readonly claimedAt: EpochMs
}

export interface Task {
  readonly id: TaskId
  readonly title: string
  readonly description: string
  readonly status: TaskStatus
  readonly hostScope: HostScope
  readonly workspace?: string
  readonly priority: Priority
  readonly acceptance?: string
  readonly tags: readonly string[]
  readonly version: number
  readonly claim?: TaskClaim | null
  readonly outputs: readonly TaskOutput[]
  readonly autoDone?: boolean
  readonly nightRunId?: string
  readonly failureCount?: number
  readonly createdAt: EpochMs
  readonly updatedAt: EpochMs
}

export interface UserRecord {
  readonly username: string
  readonly passwordHash: string
  readonly role: 'admin' | 'operator' | 'observer'
  readonly createdAt: EpochMs
  readonly failedCount: number
  readonly lockedUntil?: EpochMs
}

export interface SessionToken {
  readonly id: string
  readonly user: string
  readonly issuedAt: EpochMs
  readonly expiresAt: EpochMs
  readonly sourceIp: string
}

export interface ManagedSession {
  readonly id: string
  readonly host: HostId
  readonly kind: 'tmux' | 'service'
  readonly purpose: 'dsh-main' | 'task' | 'build'
  readonly ownerTaskId?: TaskId
  readonly createdAt: EpochMs
}

export interface Checkpoint {
  readonly taskId: TaskId
  readonly stepList: readonly string[]
  readonly currentStep: number
  readonly artifacts: readonly string[]
  readonly savedAt: EpochMs
}

export type PlanStatus =
  'draft' | 'in-review' | 'approved' | 'executing' | 'completed' | 'rejected' | 'revising'

export interface PlanSections {
  readonly background: string
  readonly impact: string
  readonly changes: string
  readonly verification: string
}

export interface PlanDecisionRecord {
  readonly by: Actor
  readonly decision: 'approve' | 'reject'
  readonly comment?: string
  readonly at: EpochMs
}

export interface Plan {
  readonly id: PlanId
  readonly taskId?: TaskId
  readonly sessionId?: SessionId
  readonly status: PlanStatus
  readonly sections: PlanSections
  readonly filePath: string
  readonly decisions: readonly PlanDecisionRecord[]
  readonly version: number
}

export type SessionRole = 'owner' | 'operator' | 'observer'

export interface SharedSession {
  readonly id: SessionId
  readonly host: HostId
  readonly ownerTaskId?: TaskId
  readonly lockHolder?: Actor | null
  readonly roles: Readonly<Record<ActorId, SessionRole>>
  readonly healthy: boolean
}

export interface IngestedImage {
  readonly relPath: string
  readonly absPath: string
  readonly sha256: string
  readonly source: 'paste' | 'drop' | 'clipboard-cli'
  readonly referencedBy: readonly SessionId[]
  readonly createdAt: EpochMs
}

export type KnownOr<T> = T | 'unknown'

export interface TelemetrySnapshot {
  readonly context: {
    readonly used: KnownOr<number>
    readonly max: KnownOr<number>
    readonly ratio: KnownOr<number>
  }
  readonly workspace: { readonly name: KnownOr<string> }
  readonly model: {
    readonly name: KnownOr<string>
    readonly thinkingDepth: KnownOr<string>
  }
  readonly rates: {
    readonly tpm1m: KnownOr<number>
    readonly tpm5m: KnownOr<number>
    readonly rpm1m: KnownOr<number>
    readonly rpm5m: KnownOr<number>
  }
  readonly at: EpochMs
}

export interface ContextSegment {
  readonly startSeq: number
  readonly endSeq: number
  readonly estTokens: number
  readonly topic?: string
}

export interface CompactionPlan {
  readonly keep: readonly ContextSegment[]
  readonly summarize: readonly ContextSegment[]
  readonly archive: readonly ContextSegment[]
  readonly budgetTokens: number
  readonly strategyId: string
}

/** One live surface node linked to its durable DSH event and logical segment. */
export interface CompactionSurfaceSnapshotIndexEntry {
  readonly eventSeq: number
  readonly segment: ContextSegment
}

/** A point-in-time index of the model-visible surface and its estimated token total. */
export interface CompactionSurfaceSnapshotIndex {
  readonly totalTokens: number
  readonly entries: readonly CompactionSurfaceSnapshotIndexEntry[]
}

export type CompactionSurfaceSnapshots =
  | {
      readonly kind: 'captured'
      readonly before: CompactionSurfaceSnapshotIndex
      readonly after: CompactionSurfaceSnapshotIndex
    }
  | {
      /** The persisted audit predates surface snapshot indexing. */
      readonly kind: 'legacy'
    }

export interface CompactionAuditRecord {
  readonly sessionId: SessionId
  readonly at: EpochMs
  readonly strategyId: string
  readonly beforeTokens: number
  readonly afterTokens: number
  readonly archiveFiles: readonly string[]
  readonly plan: CompactionPlan
  readonly surfaceSnapshots: CompactionSurfaceSnapshots
}

export type BuildJobStatus = 'queued' | 'running' | 'failed' | 'done'

export interface ArtifactRef {
  readonly name: string
  readonly path: string
  readonly sizeBytes: number
}

export interface BuildJob {
  readonly id: string
  readonly templateId: string
  readonly params: Readonly<Record<string, string>>
  readonly status: BuildJobStatus
  readonly sessionId?: string
  readonly artifacts: readonly ArtifactRef[]
  readonly errorLogExcerpt?: string
  readonly version: number
}

export interface ResourceReport {
  readonly diskFreeGb: number
  readonly load1: number
  readonly queueDepth: number
  readonly paused: boolean
}

export type ChannelKind = 'serial' | 'adb' | 'fastboot' | 'gdb' | 'ssh' | 'telnet' | 'tcp-serial'

export interface ChannelEndpoint {
  readonly kind: ChannelKind
  readonly id: string
  readonly label: string
  readonly params: Readonly<Record<string, string>>
}

export interface SnippetFile {
  readonly path: string
  readonly content: string
  readonly timeFrom: EpochMs
  readonly timeTo: EpochMs
  readonly endpoint: ChannelEndpoint
}

export interface BrowserTaskSpec {
  readonly templateId?: string
  readonly goal: string
  readonly startUrl?: string
  readonly constraints?: {
    readonly maxSteps?: number
    readonly allowDomains?: readonly string[]
    readonly timeoutSec?: number
  }
}

export interface BrowserResult {
  readonly runId: string
  readonly status: 'ok' | 'failed' | 'timeout'
  readonly screenshots: readonly string[]
  readonly text: string
  readonly structured?: unknown
  readonly steps: number
  readonly durationMs: number
}

export interface ReleaseRecord {
  readonly tag: string
  readonly npmVersions: Readonly<Record<PackageName, string>>
  readonly dshBaseline: string
  readonly changelog: string
  readonly marketPrUrl?: string
  readonly securityScan: {
    readonly gitleaks: 'clean' | 'findings'
    readonly filesAudit: 'pass' | 'fail'
  }
  readonly at: EpochMs
}
