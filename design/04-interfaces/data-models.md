# 公共数据模型（Data Models）

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                              |
| ---- | ---------- | ----- | ------------------------------------- |
| v0.1 | 2026-08-29 | Maintainers | 初稿：任务/认证/保活/遥测等公共结构 + checklist.json schema |
| v0.2 | 2026-08-30 | Codex | 增加 claim lease 身份及压缩前后 surface 快照兼容类型 |
| v0.3 | 2026-08-30 | Codex | 明确 checklist 状态类型、需求汇总规则与里程碑派生状态 |
| v0.4 | 2026-08-30 | Codex | 增加夜间调度 claim 的可信执行所有权标记 |
| v0.5 | 2026-08-30 | Codex | 增加 M12 create-once 发布账本与摘要链事件模型 |
| v0.6 | 2026-08-30 | Codex | 将 M12 模型细化为 fixed-sequence entry、逐序号 immutable commit、本地 canonical head 与逐包 publish attempt authority |

> 本文档定义跨模块公共数据结构与 `checklist.json` 的 schema。模块专属字段在各模块文档「数据模型」章节补充。通用字段约定（version 乐观锁、epoch ms、Actor、LubanError）见 [api-overview.md](api-overview.md) §2。

<a id="task"></a>
## 1. Task 任务（M02）

```typescript
export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'review' | 'done' | 'dropped';
export type HostScope = 'win' | 'ubuntu' | 'any';

export interface Task {
  id: TaskId;                        // "T-20260829-xxxx"
  title: string;
  description: string;               // GFM markdown
  status: TaskStatus;
  hostScope: HostScope;              // win 挂 debug/串口类；ubuntu 挂编译/优化类
  workspace?: string;                // 相对 workspace 名
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  acceptance?: string;               // 验收标准 markdown（agent 领单前置条件）
  tags: string[];                    // 如 auto-ok / browser
  version: number;                   // 乐观锁
  claim?: {
    actor: Actor; sessionId: SessionId; claimedAt: number;
    leaseId?: string;                // 新 claim 必有；仅旧账本解码时可缺省
    executionOwner?: 'night-scheduler'; // 仅可信进程内调度器可设置；HTTP claim 不透传
  } | null;
  outputs: TaskOutput[];             // 产出引用（笔记/commit/产物路径）
  autoDone?: boolean;                // 夜间自动完成，待人复核
  nightRunId?: string;
  failureCount?: number;
  createdAt: number; updatedAt: number;
}

export interface TaskOutput {
  kind: 'note' | 'commit' | 'artifact' | 'link';
  ref: string;                       // 路径 / commit sha / URL
  summary: string;
  at: number; by: Actor;
}
```

存储位置：`~/.dsh/luban/taskboard/<host>-ledger.json`（每端各自账本，M02-F010）。

<a id="auth"></a>
## 2. Auth 账户与会话（M01）

```typescript
export interface UserRecord {
  username: string;
  passwordHash: string;              // argon2id（哈希+盐合一编码）
  role: 'admin' | 'operator' | 'observer';
  createdAt: number;
  failedCount: number; lockedUntil?: number;
}
export interface SessionToken {
  id: string; user: string; issuedAt: number; expiresAt: number; sourceIp: string;
}
```

<a id="keepalive"></a>
## 3. Keepalive 托管会话与断点（M03）

```typescript
export interface ManagedSession {
  id: string;                        // tmux 会话名 / 服务名
  host: HostId; kind: 'tmux' | 'service';
  purpose: 'dsh-main' | 'task' | 'build';
  ownerTaskId?: TaskId;
  createdAt: number;
}
export interface Checkpoint {
  taskId: TaskId; stepList: string[]; currentStep: number;
  artifacts: string[]; savedAt: number;
}
```

<a id="plan"></a>
## 4. Plan 计划（M04）

```typescript
export interface Plan {
  id: PlanId; taskId?: TaskId; sessionId?: SessionId;
  status: 'draft' | 'in-review' | 'approved' | 'executing' | 'completed' | 'rejected' | 'revising';
  sections: { background: string; impact: string; changes: string; verification: string };
  filePath: string;                  // workspace 相对路径
  decisions: { by: Actor; decision: 'approve' | 'reject'; comment?: string; at: number }[];
  version: number;
}
```

<a id="session"></a>
## 5. SharedSession 共享会话（M05）

```typescript
export interface SharedSession {
  id: SessionId; host: HostId; ownerTaskId?: TaskId;
  lockHolder?: Actor | null;         // 当前操作者（互斥）
  roles: Record<ActorId, 'owner' | 'operator' | 'observer'>;
  healthy: boolean;                  // 来自 M03
}
```

<a id="image"></a>
## 6. IngestedImage 粘贴图片（M06）

```typescript
export interface IngestedImage {
  relPath: string;                   // workspace 相对路径（git 可管理）
  absPath: string;
  sha256: string; source: 'paste' | 'drop' | 'clipboard-cli';
  referencedBy: SessionId[]; createdAt: number;
}
```

<a id="telemetry"></a>
## 7. TelemetrySnapshot 遥测快照（M07）

```typescript
export interface TelemetrySnapshot {
  context: { used: number | 'unknown'; max: number | 'unknown'; ratio: number | 'unknown' };
  workspace: { name: string | 'unknown' };
  model: { name: string | 'unknown'; thinkingDepth: string | 'unknown' };
  rates: { tpm1m: number | 'unknown'; tpm5m: number | 'unknown'; rpm1m: number | 'unknown'; rpm5m: number | 'unknown' };
  at: number;
}
```

<a id="compaction"></a>
## 8. Compaction 上下文压缩（M08）

```typescript
export interface ContextSegment { startSeq: number; endSeq: number; estTokens: number; topic?: string; }
export interface CompactionPlan {
  keep: ContextSegment[];            // 保留原文
  summarize: ContextSegment[];       // 摘要后替换
  archive: ContextSegment[];         // 外置虚拟文件
  budgetTokens: number; strategyId: string;
}
export interface CompactionSurfaceSnapshotIndexEntry {
  eventSeq: number;                      // 持久 Session event identity
  segment: ContextSegment;               // 该 event 在此时刻映射的可见分段
}
export interface CompactionSurfaceSnapshotIndex {
  totalTokens: number;
  entries: CompactionSurfaceSnapshotIndexEntry[];
}
export type CompactionSurfaceSnapshots =
  | { kind: 'captured'; before: CompactionSurfaceSnapshotIndex; after: CompactionSurfaceSnapshotIndex }
  | { kind: 'legacy' };                  // 旧审计不伪造前后 identity
export interface CompactionAuditRecord {
  sessionId: SessionId; at: number; strategyId: string;
  beforeTokens: number; afterTokens: number;
  archiveFiles: string[]; plan: CompactionPlan;
  surfaceSnapshots: CompactionSurfaceSnapshots;
}
```

<a id="build"></a>
## 9. BuildJob 构建任务（M09）

```typescript
export interface BuildJob {
  id: string; templateId: string; params: Record<string, string>;
  status: 'queued' | 'running' | 'failed' | 'done';
  sessionId?: string;                // tmux 托管会话
  artifacts: { name: string; path: string; sizeBytes: number }[];
  errorLogExcerpt?: string;
  version: number;
}
export interface ResourceReport { diskFreeGb: number; load1: number; queueDepth: number; paused: boolean; }
```

<a id="channel"></a>
## 10. Channel 通道（M10）

```typescript
export interface ChannelEndpoint {
  kind: 'serial' | 'adb' | 'fastboot' | 'gdb' | 'ssh' | 'telnet' | 'tcp-serial';
  id: string; label: string; params: Record<string, string>;  // 如 { port:'COM3', baud:'115200' }
}
export interface SnippetFile {
  path: string;                      // 落盘路径（.luban/snippets/...）
  content: string; timeFrom: number; timeTo: number;
  endpoint: ChannelEndpoint;         // 通道元数据随片段进会话
}
```

<a id="browser"></a>
## 11. Browser 浏览器任务（M11）

```typescript
export interface BrowserTaskSpec {
  templateId?: string; goal: string; startUrl?: string;
  constraints?: { maxSteps?: number; allowDomains?: string[]; timeoutSec?: number };
}
export interface BrowserResult {
  runId: string; status: 'ok' | 'failed' | 'timeout';
  screenshots: string[]; text: string; structured?: unknown;
  steps: number; durationMs: number;
}
```

<a id="release"></a>
## 12. ReleaseRecord 发布记录（M12）

```typescript
export interface ReleaseRecord {
  tag: string;                       // v<semver>
  npmVersions: Record<PackageName, string>;
  dshBaseline: string;               // engines.dsh 基线
  changelog: string; marketPrUrl?: string;
  securityScan: { gitleaks: 'clean' | 'findings'; filesAudit: 'pass' | 'fail' };
  at: number;
}

export interface PublishLedger {
  schemaVersion: 1;
  ledgerId: string;
  createdAt: string;                 // ISO-8601 UTC
  release: {
    version: string; tag: string; manifestSha256: string;
    authority: PublishReleaseAuthority;
    packages: Array<{ name: PackageName; version: string; file: string; sha256: string }>;
  };
}

export interface PublishReleaseAuthority {
  repository: string;                // owner/name
  repositoryId: string;
  repositoryOwnerId: string;
  workflowPath: '.github/workflows/release.yml';
  ref: string;                       // refs/tags/v<semver>
  commitSha: string;
}

export interface PublishAttemptAuthority {
  eventName: 'push';
  runId: string;
  runAttempt: string;
  runnerEnvironment: 'github-hosted';
  workflowRef: string;               // owner/name/.github/workflows/release.yml@refs/tags/v<semver>
  workflowSha: string;
}

export interface PublishLedgerEventBase {
  schemaVersion: 1;
  ledgerId: string;
  sequence: number;                  // fixed file name: 00000001.json, ...
  previousDigest: string;
  at: string;                        // ISO-8601 UTC
}

export type PublishLedgerEvent = PublishLedgerEventBase & (
  | {
      type: 'attempt-started'; package: PackageName; attemptId: string;
      authority: PublishAttemptAuthority;
    }
  | { type: 'publish-confirmed'; package: PackageName; attemptId: string }
  | { type: 'reconciled-absent'; package: PackageName; attemptId: string }
  | { type: 'reconciled-matching'; package: PackageName; attemptId: string }
  | {
      type: 'release-verified'; repository: string; expectedCommitSha: string;
      githubReleaseId: number;
    }
);

export interface PublishLedgerCommit {
  schemaVersion: 1;
  ledgerId: string;
  sequence: number;                  // publish-ledger-commit-00000000.json, ...
  entryName: string;
  entrySize: number;
  entryDigest: string;
  previousDigest: string | null;
  previousCommitDigest: string | null;
}

export interface LocalPublishLedgerHead {
  schemaVersion: 1;
  ledgerId: string;
  sequence: number;
  digest: string;                    // local canonical entry digest only; never a Release asset
}
```

`PublishLedger` 初始文件是 sequence 0；事件使用 fixed-sequence 文件名，而不是把摘要编码进文件名。
每个初始文件/事件 entry 都必须有同序号 `PublishLedgerCommit`：commit 绑定 entry 名称、大小和 SHA-256，
并通过 `previousDigest`、`previousCommitDigest` 同时链接前一 entry 与前一 commit。entry/commit 的最终名
都由完整临时文件经 `fsync` 和原子 no-replace link 安装，并以无 clobber 的 create-once asset 上传到
同 tag draft Release。同名逐字节一致是幂等重试；异字节是 fork，必须 fail closed。

远端不保存 mutable head；`LocalPublishLedgerHead` 仅用于本地 canonical 恢复。draft 恢复只允许完整
连续 entry/commit 前缀，或恰好一个缺 commit 的尾部 entry；prefix barrier 必须在任何 registry 读取
或 npm 副作用前补齐该 commit 并逐项确认完整远端前缀。public Release 禁止 orphan、gap、fork、未知
资产和非 `published` 状态。读取方还必须拒绝非 core-first 前缀及非法状态迁移，不能把 `npm publish`
子进程退出不明直接解释为成功。

`attempt-started.authority` 在包被 `publish-confirmed` 或 `reconciled-matching` 后成为该包的持久
`publishAuthority`。后续 workflow attempt 必须使用包自身的原 authority 校验 registry 返回的同一
Sigstore bundle：repository/owner IDs、原 run ID/attempt、workflow ref/SHA、tag ref、commit SHA、
SLSA subject PURL 与 tarball SHA-512 必须全部匹配。pending 包不得依据 registry 现状认领已有版本。
`release-verified` 绑定 immutable release repository/SHA 与实际 GitHub Release ID，但它及对应本地
commit/head 只进入 Actions artifact，不作为已公开 Release 的远端 checkpoint。

<a id="checklist-json-v1"></a>
## 13. checklist.json Schema（checklist-json-v1）

```typescript
export type ChecklistStatus = 'todo' | 'doing' | 'review' | 'done' | 'blocked' | 'dropped';
export interface ChecklistFile {
  meta: { project: string; description: string; version: string; updatedAt: string; idRules: string };
  statusLegend: Record<ChecklistStatus, string>;
  milestones: { id: string; name: string; goal: string; order: number; featureIds: string[] }[];
  requirements: { id: string; title: string; modules: string[]; status: ChecklistStatus }[];
  features: {
    id: string;                      // M<NN>-F<NNN>
    requirement: string;             // R<NN>
    module: string;                  // M<NN>
    title: string; priority: 'P0' | 'P1' | 'P2' | 'P3';
    milestone: string;               // MS<N>，与 milestones[].featureIds 一致
    status: ChecklistStatus;
    designDoc: string; updatedAt: string;
    notes?: string[];
  }[];
}
```

不变式（校验脚本强制）：features.id 唯一；feature.milestone 与 milestones[].featureIds 双向一致；feature.requirement ∈ requirements；feature.module 与 id 前缀一致；里程碑并集 = 全部 features。

功能状态以对应模块文档「功能清单」中的明确验收口径为准：

- `todo`：尚未开始实现。
- `doing`：实现或验证仍在进行，尚未达到可验收状态。
- `review`：实现已经完成，验收条件当前可执行，但尚无覆盖完整验收口径的直接证据。
- `done`：已有测试、集成运行或人工验收的直接证据覆盖明确验收口径。目标环境抽查、长期压测等超出该口径的附加加固项可以保留在 `notes`，但不得据此把功能降回 `review` 或 `blocked`。
- `blocked`：明确验收口径本身因缺少目标环境、设备、授权或外部依赖而无法继续；`notes` 必须同时写明当前阻塞条件与解阻条件。
- `dropped`：设计明确废弃，记录保留且不删除。

需求状态由其非 `dropped` 功能点汇总，优先级为 `blocked > doing > todo > review > done`；全部功能点均废弃时才为 `dropped`。里程碑不重复存储 `status`，展示端按同一优先级从 `featureIds` 派生，避免形成第二状态事实源。
