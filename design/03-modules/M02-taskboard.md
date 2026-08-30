# M02 任务看板与自主调度模块（luban-taskboard）设计

本项目最核心模块：既是人用的任务看板（todo/执行中/已完成），也是 **agent 可自主领单的工作队列**——agent 在无人值守窗口（如半夜）自己挑任务、研究、回写产出，次日人审。

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                                                     |
| ---- | ---------- | ----- | ------------------------------------------------------------ |
| v0.1 | 2026-08-29 | Maintainers | 初稿：看板/范围标签/领单/夜间调度/回写复核/CLI/导入 全量设计 |
| v0.2 | 2026-08-30 | Codex | 回填 rc2 AgentRegistry 适配、认证 API、实现与测试证据 |
| v0.3 | 2026-08-30 | Codex | 补齐 SSE 进程重启后的超前游标 baseline 恢复验证 |
| v0.4 | 2026-08-30 | Codex | 将账本备份从最近 7 次写入修正为按本地日历日保留 |
| v0.5 | 2026-08-30 | Codex | 夜间 agent 独立模型/工具作用域与显式验收结果改为 fail-closed |
| v0.6 | 2026-08-30 | Codex | 增加触屏/键盘迁移控件及拖放校验与同步防重入锁 |
| v0.7 | 2026-08-30 | Codex | 回填 loopback CLI/SSE 与 claim lease 原子身份验证 |
| v0.8 | 2026-08-30 | Codex | 增加夜间任务执行器路由与唯一终态所有权契约 |

## 1. 概述与目标

- **解决**：R03 的任务管理 + 派生需求「agent 半夜自主找未完成/todo 项目去研究更新」。任务不是静态卡片，而是**机器可消费的工作单元**：有验收标准、可原子认领、有并发防护、有产出回写闭环。
- **不解决**：项目管理的甘特图/依赖图；跨机任务同步（MS4 前两端各自独立账本，M05-F002 落地后再议聚合视图）。
- **需求映射**：R03。
- **平台属性**：双端公用；任务通过 `hostScope` 标签区分归属（win 挂 debug/串口类，ubuntu 挂编译/优化类），**同一实现、各自账本**。

## 2. 功能清单

| 编号 | 功能 | 优先级 | 里程碑 | 验收口径 |
| --- | --- | --- | --- | --- |
| M02-F001 | 任务 CRUD 与状态机：六列 `backlog/todo/doing/review/done/dropped`，迁移规则引擎校验 | P0 | MS1 | 非法迁移被拒绝并提示 |
| M02-F002 | 看板 Web UI：列视图、拖拽、按 host/workspace/标签过滤，移动端可用 | P0 | MS1 | 拖拽或触屏/键盘控件改状态即时落盘 |
| M02-F003 | 任务范围标签：`hostScope`（win/ubuntu/any）、`workspace`、`priority`、`acceptance`（验收标准，agent 领单前置条件） | P0 | MS1 | 无验收标准的任务不可被 agent 认领 |
| M02-F004 | agent 领单 API：按过滤条件原子认领（乐观锁版本号 + CAS），绑定 dsh 会话，防双端抢占 | P1 | MS2 | 并发认领只有一方成功 |
| M02-F005 | 夜间自主调度器：时间窗、每日限额、任务白名单、失败熔断，窗口内自动选单→建会话→执行 | P2 | MS3 | 窗口外不执行；熔断后次日恢复 |
| M02-F006 | 产出回写与次日复核：执行产出（笔记/commit/产物路径）回写任务卡；夜间完成的卡打 `auto-done` 标记，人复核后转正 | P2 | MS3 | 次日人可一眼区分人工完成与夜间自动完成 |
| M02-F007 | SSE 事件广播：任务/评论/状态变更实时推送到看板，断线重连全量刷新 | P1 | MS2 | 双浏览器同看实时一致 |
| M02-F008 | taskctl CLI：与 Web 同源 HTTP API 的命令行（list/add/claim/update/done） | P2 | MS2 | CLI 与 UI 操作互见 |
| M02-F009 | 数据导入器：dashi-taskboard / cloader 导出 JSON → luban 格式一次性导入 | P3 | MS2 | 导入报告（成功/跳过/失败） |
| M02-F010 | 存储层：JSON 文件存储（默认，git-diff 友好）+ 存储适配器接口（后续可换 SQLite） | P0 | MS1 | 崩溃后文件不损坏（原子写） |

## 3. 流程图

### 3.1 任务状态机

```mermaid
stateDiagram-v2
    [*] --> backlog: 人创建（可无验收标准）
    backlog --> todo: 排期（补齐验收标准）
    todo --> doing: 人工开始 / agent 认领
    doing --> review: agent 回写产出 / 人提交
    doing --> todo: 执行失败可重试（记录原因）
    review --> done: 人验收（夜间自动完成需复核）
    review --> doing: 验收不通过
    todo --> dropped: 废弃
    backlog --> dropped: 废弃
    done --> [*]
```

### 3.2 夜间自主循环（核心场景）

```mermaid
flowchart TD
    A["调度器：进入时间窗(如 23:30-06:30)"] --> B{"窗口内且限额未满?"}
    B -- 否 --> Z["休眠至下个巡检点"]
    B -- 是 --> C{"熔断器状态正常?"}
    C -- 熔断中 --> Z
    C -- 正常 --> D["按白名单+hostScope 选单<br/>（原子认领 M02-F004）"]
    D --> E{认领成功?}
    E -- 否 --> Z
    E -- 是 --> F["创建 dsh 会话<br/>注入任务卡+独立 model/tool scope"]
    F --> G["进程内 Agent 执行<br/>宿主 profile 由 M03 在部署层保活"]
    G --> H{"唯一结果工具成功落盘<br/>且最终 turn completed?"}
    H -- 是 --> I["回写产出 → review(auto-done 标记)"]
    H -- 否 --> J["回写失败分析 → todo（失败计数+1）"]
    J --> K{"连续失败 ≥3?"}
    K -- 是 --> L["熔断：停止领单至次日"]
    K -- 否 --> Z
    I --> M["限额计数 +1"] --> Z
```

## 4. 接口设计

```typescript
/** TaskStore —— L2 核心服务（契约详见 04-interfaces/api-overview.md） */
export interface TaskStore {
  create(input: TaskCreateInput): Promise<Task>;
  update(id: TaskId, patch: TaskPatch, expectedVersion: number): Promise<Task>; // 乐观锁
  transition(id: TaskId, to: TaskStatus, actor: Actor, note?: string): Promise<Task>;
  get(id: TaskId): Promise<Task | null>;
  query(filter: TaskQuery): Promise<Task[]>;
  subscribe(listener: (evt: TaskEvent) => void): Unsubscribe; // SSE 的数据源
}

/** AgentClaimService —— agent 领单 */
export interface ClaimSession {
  actor: Actor;
  sessionId: SessionId;
  host: HostId;
  executionOwner?: 'night-scheduler'; // 仅可信进程内调用可设置，HTTP claim 不透传
}
export interface ClaimMutationOptions {
  expectedClaim?: TaskClaim; // 防止旧执行实例写入已被重领的新 claim
}
export interface AgentClaimService {
  /** 原子认领：过滤 → CAS 置 doing → 绑定会话；并发安全 */
  claim(filter: ClaimFilter, session: ClaimSession): Promise<ClaimResult>;
  /** 执行完毕回写产出并转 review */
  reportProgress(id: TaskId, progress: TaskProgress, opts?: ClaimMutationOptions): Promise<void>;
  complete(id: TaskId, output: TaskOutput, opts: ClaimMutationOptions & { autoDone: boolean }): Promise<Task>;
  fail(id: TaskId, reason: string, opts?: ClaimMutationOptions): Promise<void>;
}

/** NightScheduler —— M02-F005 */
export interface NightTaskExecutor {
  execute(task: Task, sessionId: SessionId): Promise<TaskOutput>;
}
export interface NightTaskExecutorRoute {
  id: string;
  matches(task: Task): boolean;
  executor: NightTaskExecutor;
}
export interface NightScheduler {
  start(): void;
  stop(): void;
  status(): SchedulerStatus;   // { windowActive, quotaUsed, circuit: 'ok'|'open' }
  triggerOnce(): Promise<void>; // 手动触发一轮（供 CLI/调试）
  registerTaskExecutor(route: NightTaskExecutorRoute): Unsubscribe;
}
```

## 5. 数据模型

见 `04-interfaces/data-models.md#task`。要点字段：`hostScope`、`workspace`、`acceptance`（验收标准 markdown）、`version`（乐观锁）、`claim`（认领会话/时间）、`outputs[]`（产出引用）、`autoDone`、`nightRunId`。

## 6. 配置设计

```yaml
- insert:
    - id: luban-taskboard
      name: dsh-luban-taskboard
      config:
        store: { type: json, dir: "~/.dsh/luban/taskboard" }
        hostScope: auto          # auto=按当前机器类型推断；可强制 win/ubuntu
        claim:
          requireAcceptance: true  # 无验收标准不可被 agent 领
        night:
          enabled: false           # 默认关闭，显式开启（P6 安全默认）
          window: "23:30-06:30"
          dailyQuota: 5
          hostScopeWhitelist: ["ubuntu"]   # 夜间只跑编译服务器侧任务
          tagWhitelist: ["auto-ok"]        # 仅白名单标签任务可夜间领
          model: { provider: "", id: "" }  # enabled=true 前必须显式配置
          toolAllowlist: []                 # 仅保留列出的继承工具；结果工具始终为会话私有
          circuitBreaker: { maxConsecutiveFailures: 3 }
```

## 7. 依赖与边界

- 下层：M01 认证（写操作需登录）、HAL 文件适配器；协作：M03（部署层宿主 profile
  进程保活）、M08（长任务压缩）、M11（浏览器类任务自动执行）。M02 的执行器是宿主内
  `AgentRegistry` handle，没有可交给 `KeepaliveService.ensureAlive(SessionSpec)` 的独立命令；
  因而不会从自身进程内递归启动第二个 DSH。可验证边界是：M02 负责创建、等待并释放
  agent handle，M03 在 profile 的 tmux/service 部署层负责宿主进程重启恢复。
- 复用档位：**C 档**——dashi-taskboard（Apache-2.0，只参考功能：任务版本化乐观锁、SSE 广播、CLI 与 UI 同源）、cloader/dsh-taskboard（认领-验收流，license 待核实）、maochiy/dsh-taskboard-plugin（六列交互，license 待核实）。全部只读其公开文档，实现原创。
- 平台属性：双端公用。

## 8. 非功能与安全

- 存储原子写（tmp + rename）；账本文件每日滚动备份保留 7 份。
- 夜间模式默认**关闭**；白名单 + 限额 + 熔断三重防失控；`enabled=true` 时独立
  provider/model 必填，`AgentRegistry.create({ agentOptions, setup })` 将模型与
  `tools.restrict({ allow })` 工具范围绑定到该 agent 作用域，未知工具在创建阶段失败。
- `whenIdle()` 只表示无活动，不构成成功。agent 必须恰好一次调用会话私有
  `luban_report_night_result`；只有对应 `tool/call`/无错误 `tool/result` 已进入 durable
  session log、最终 `turn/end` 为 `completed` 且 `acceptanceMet=true` 时才写入
  `review(autoDone)`，其余路径全部回到 `todo` 并累计失败/熔断。
- 所有写操作经 M01 认证；审计日志记录 actor（人 / agent 会话 id）。

## 9. checklist 映射

M02-F001 ~ M02-F010 共 10 项，与 `checklist.json` 一一对应。

## 10. 实现与验证记录

- Host 使用 DSH `0.1.1-rc.2` 已发布的 `AgentRegistry.create({ agentOptions, setup })`、
  agent-scoped `tools.restrict()`、`followup()`、`whenIdle()` 与 session events；每轮结束
  释放活动 handle，会话 id 与产出引用保留在任务账本。
- Host API 统一挂载在 `/luban-taskboard`，所有入口复用 M01 身份，写请求由外层
  sidecar 校验 Origin/`x-luban-csrf`。Web 与 CLI 不自行复制认证逻辑。
- 每张非终态任务卡同时提供拖拽和原生 `select` + `button` 迁移入口；控件只列出状态机
  允许的目标，适配触屏与纯键盘操作。两种入口共用 `moveTask(id, to, expectedVersion)`、
  错误提示与成功后的刷新流程。统一 mutation boundary 用当前任务的 `status` 校验目标，
  并在首个异步调用前同步占用看板级锁，避免 React busy 状态渲染前的快速双触发。
- 拖放 payload 只用于定位任务；发请求前必须在当前看板快照中重新查找 id/status/version，
  payload 版本与当前版本不符、任务不存在、同列或非法迁移均不发写请求并显示错误。
- SSE 将事件序号视为单进程游标；`Last-Event-ID` 落后于有界重放窗口或领先于当前
  进程序号（例如服务重启后）时，立即返回持久化任务全集 baseline，窗口内旧序号
  继续按原顺序增量重放。
- 真实 loopback JSON ledger/API 已跑通 `taskctl` 的 add/list/claim/update/transition/done 完整
  mutation 生命周期；两个并发 loopback SSE 客户端同时收到 baseline 与 live task 事件。
- `AtomicJsonStore` 仍使用跨进程锁、同目录临时文件、fsync 与原子 rename；备份槽位只在
  本地日历日变化时轮转，同一天的高频写入不会挤掉历史日快照，默认保留最近 7 个写入日。
- 每次认领生成唯一 `leaseId`；progress/complete/fail 在同一次 ledger update 锁内比对
  actor/session/claimedAt/leaseId/executionOwner。夜间 scheduler 和浏览器自动化始终传递启动时捕获的 claim，
  即使同一 agent/session 在同一毫秒 A→B 重领，A 的陈旧写入也全部 `E_VERSION_CONFLICT`。
- 夜间 scheduler 为匹配任务选择唯一注册执行器；重叠路由 fail closed。路由执行器只返回
  `TaskOutput`，scheduler 独占 complete/fail；可信 `executionOwner` 随 claim 持久化，HTTP 领单
  无法伪造，普通浏览器监听器据此跳过夜间 claim。
- `tests/task-store.test.ts` 覆盖状态机、版本冲突、并发原子认领、回写复核、失败与
  幂等导入；`tests/scheduler.test.ts` 覆盖时间窗、限额、白名单、熔断次日恢复、独立
  model/tool scope、结果工具成功日志以及缺报告/验收失败/异常 turn 的 fail-closed；
  `tests/http-api.test.ts` 覆盖鉴权 CRUD、导入、实时 SSE 与断档基线；
  `tests/client-cli.test.ts` 覆盖客户端槽位、拖拽写 API、触屏/键盘迁移控件的合法目标、
  `expectedVersion`、伪造/陈旧 payload 拒绝、快速双提交/拖放互斥、busy/error/lock 清理
  语义与 CLI 同源调用。
- 发布包生成 Host ESM、`taskctl` 与 rc2 lazy-CJS `client.js`/`client.d.ts`；夜间模式
  继续默认关闭。39 项 M02 测试通过；真实无人值守执行仍需在目标 profile 进行部署验收后才启用。

## 11. 开放问题

- 多机聚合视图：等 M05 落地后按需在 MS4+ 评估。
