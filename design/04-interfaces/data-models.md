# 公共数据模型（Data Models）

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                              |
| ---- | ---------- | ----- | ------------------------------------- |
| v0.1 | 2026-08-29 | Maintainers | 初稿：任务/认证/保活/遥测等公共结构 + checklist.json schema |
| v0.2 | 2026-08-30 | Codex | 增加 claim lease 身份及压缩前后 surface 快照兼容类型 |
| v0.3 | 2026-08-30 | Codex | 明确 checklist 状态类型、需求汇总规则与里程碑派生状态 |
| v0.4 | 2026-08-30 | Codex | 增加夜间调度 claim 的执行来源标记 |
| v0.5 | 2026-08-30 | Codex | 增加 M12 多包发布恢复账本模型 |
| v0.6 | 2026-08-30 | Codex | 细化发布事件、恢复位置与逐包发布状态 |
| v0.7 | 2026-08-30 | Codex | 增加 M01-F008 账号归属模型并将发布账本收敛为失败恢复模型 |
| v0.8 | 2026-08-30 | Codex | 明确角色字段仅作兼容操作提示，不构成复杂权限或安全边界 |

> 本文档定义跨模块公共数据结构与 `checklist.json` 的 schema。模块专属字段在各模块文档「数据模型」章节补充。通用字段约定（version 乐观锁、epoch ms、Actor、LubanError）见 [api-overview.md](api-overview.md) §2。

<a id="account-context"></a>
## 0. AccountContext 账号上下文（M01-F008）

```typescript
export type AccountId = string;

export interface AccountContext {
  accountId: AccountId;
  username: string;
  role: 'admin' | 'operator' | 'observer'; // 兼容现有账户管理 UI；业务隔离只看 accountId
}

export interface AccountOwned {
  accountId: AccountId;
}

export type Actor =
  | { kind: 'user'; id: AccountId; displayName?: string }
  | { kind: 'agent'; id: SessionId; accountId: AccountId; displayName?: string };
```

M01 负责把登录 cookie 解析为 `AccountContext`。M01-F008 的最小跨模块约定是：任务、托管会话、
计划、共享会话、附件、遥测、压缩记录、构建任务、通道片段与浏览器任务等用户数据都带稳定的
`accountId`；查询、mutation、事件投影与文件引用均按当前 `AccountContext.accountId` 限定范围。
旧数据升级时必须由用户或迁移配置明确指定归属，不根据用户名、路径或当前登录账号猜测归属。

<a id="task"></a>
## 1. Task 任务（M02）

```typescript
export type TaskStatus = 'backlog' | 'todo' | 'doing' | 'review' | 'done' | 'dropped';
export type HostScope = 'win' | 'ubuntu' | 'any';

export interface Task extends AccountOwned {
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
    executionOwner?: 'night-scheduler'; // 调度来源标记，不作为账号身份依据
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
  id: AccountId;
  username: string;
  passwordHash: string;              // argon2id（哈希+盐合一编码）
  role: 'admin' | 'operator' | 'observer'; // 兼容提示，不扩展为业务 RBAC
  createdAt: number;
}
export interface SessionToken {
  id: string; accountId: AccountId; user: string; issuedAt: number; expiresAt: number;
}
```

<a id="keepalive"></a>
## 3. Keepalive 托管会话与断点（M03）

```typescript
export interface ManagedSession extends AccountOwned {
  id: string;                        // tmux 会话名 / 服务名
  host: HostId; kind: 'tmux' | 'service';
  purpose: 'dsh-main' | 'task' | 'build';
  ownerTaskId?: TaskId;
  createdAt: number;
}
export interface Checkpoint {
  accountId: AccountId;
  taskId: TaskId; stepList: string[]; currentStep: number;
  artifacts: string[]; savedAt: number;
}
```

<a id="plan"></a>
## 4. Plan 计划（M04）

```typescript
export interface Plan extends AccountOwned {
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
export interface SharedSession extends AccountOwned {
  id: SessionId; host: HostId; ownerTaskId?: TaskId;
  lockHolder?: Actor | null;         // 当前操作者（互斥）
  roles: Record<ActorId, 'owner' | 'operator' | 'observer'>; // 同账号内的控制锁状态，不是跨账号权限
  healthy: boolean;                  // 来自 M03
}
```

<a id="image"></a>
## 6. IngestedImage 粘贴图片（M06）

```typescript
export interface IngestedImage extends AccountOwned {
  relPath: string;                   // workspace 相对路径（git 可管理）
  absPath: string;
  sha256: string;                    // 附件去重与写入一致性，不作为来源证明
  source: 'paste' | 'drop' | 'clipboard-cli';
  referencedBy: SessionId[]; createdAt: number;
}
```

<a id="telemetry"></a>
## 7. TelemetrySnapshot 遥测快照（M07）

```typescript
export interface TelemetrySnapshot extends AccountOwned {
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
  | { kind: 'legacy' };                  // 旧记录没有前后 surface snapshot
export interface CompactionAuditRecord extends AccountOwned {
  sessionId: SessionId; at: number; strategyId: string;
  beforeTokens: number; afterTokens: number;
  archiveFiles: string[]; plan: CompactionPlan;
  surfaceSnapshots: CompactionSurfaceSnapshots;
}
```

<a id="build"></a>
## 9. BuildJob 构建任务（M09）

```typescript
export interface BuildJob extends AccountOwned {
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
export interface ChannelEndpoint extends AccountOwned {
  kind: 'serial' | 'adb' | 'fastboot' | 'gdb' | 'ssh' | 'telnet' | 'tcp-serial';
  id: string; label: string; params: Record<string, string>;  // 如 { port:'COM3', baud:'115200' }
}
export interface SnippetFile extends AccountOwned {
  path: string;                      // 落盘路径（.luban/snippets/...）
  content: string; timeFrom: number; timeTo: number;
  endpoint: ChannelEndpoint;         // 通道元数据随片段进会话
}
```

<a id="browser"></a>
## 11. Browser 浏览器任务（M11）

```typescript
export interface BrowserTaskSpec extends AccountOwned {
  templateId?: string; goal: string; startUrl?: string;
  constraints?: { maxSteps?: number; allowDomains?: string[]; timeoutSec?: number };
}
export interface BrowserResult extends AccountOwned {
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
  packageAudit: { pack: 'pass' | 'fail'; dryRun: 'pass' | 'fail' };
  at: number;
}

export interface PublishLedger {
  schemaVersion: 1;
  ledgerId: string;
  createdAt: string;                 // ISO-8601 UTC
  release: {
    version: string; tag: string; manifestSha256: string;
    packages: Array<{
      name: PackageName;
      version: string;
      file: string;
      sha256: string;                // 对账本地 pack 与 registry tarball
      status: 'pending' | 'publishing' | 'published' | 'failed';
    }>;
  };
}

export interface PublishLedgerEventBase {
  schemaVersion: 1;
  ledgerId: string;
  sequence: number;                  // fixed file name: 00000001.json, ...
  at: string;                        // ISO-8601 UTC
}

export type PublishLedgerEvent = PublishLedgerEventBase & (
  | {
      type: 'attempt-started'; package: PackageName; attemptId: string;
    }
  | { type: 'publish-confirmed'; package: PackageName; attemptId: string }
  | { type: 'publish-failed'; package: PackageName; attemptId: string; reason: string }
  | { type: 'reconciled-absent'; package: PackageName; attemptId: string }
  | { type: 'reconciled-matching'; package: PackageName; attemptId: string }
  | {
      type: 'release-verified'; repository: string; tag: string;
      githubReleaseId: number;
    }
);

export interface PublishLedgerCommit {
  schemaVersion: 1;
  ledgerId: string;
  sequence: number;                  // publish-ledger-commit-00000000.json, ...
  entryName: string;
  entrySize: number;
  recordedAt: string;
}

export interface LocalPublishLedgerHead {
  schemaVersion: 1;
  ledgerId: string;
  sequence: number;
}
```

`PublishLedger` 和按序事件用于多包发布的失败恢复。每次发布包前先落盘
`attempt-started`，成功后写 `publish-confirmed`；命令结果不明确时先查询 registry：版本不存在可重试，
版本与本地 pack 校验和一致可记为 `reconciled-matching`，版本存在但内容不一致或状态未知则停止并交给
人工处理。不得通过 unpublish、覆盖或盲目重复发布来伪装成功。

账本事件使用连续序号并以临时文件加原子 rename 写入；`PublishLedgerCommit` 只记录同序号事件已完整
落盘，`LocalPublishLedgerHead` 记录本地恢复位置。恢复时从首个非 `published` 包继续，重复执行同一
已确认步骤不产生第二次发布。GitHub Release、tag、pack 文件名/版本与 npm registry 版本在最终阶段
做普通一致性对账；真实发布失败时保留账本和错误信息供后续恢复。

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
