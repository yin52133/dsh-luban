# M05 会话共享模块（luban-session-share）设计

让 Windows 与 Ubuntu 两侧对同一 dsh 会话建立共享视图：一方能观察另一方的会话，必要时请求控制权交接（互斥）。

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                              |
| ---- | ---------- | ----- | ------------------------------------- |
| v0.1 | 2026-08-29 | Maintainers | 初稿：注册表/控制权交接/状态同步/权限 |
| v0.2 | 2026-08-30 | Codex | 回填 rc2 注册表、认证联邦、SSE 与安全验证证据 |

## 1. 概述与目标

- **解决**：R06——「Ubuntu 和 Windows 能共享 session 和控制权限」：例如在 win 端浏览器观察 ubuntu 上夜间任务的会话进展，白天在 ubuntu 上接过 win 端开始的调试会话。
- **不解决**：会话内容跨机迁移执行（会话进程仍在原主机；共享的是**视图与控制权**，不是进程搬家）。
- **需求映射**：R06。
- **平台属性**：双端公用；依赖 M01 认证与 M03 托管会话。

## 2. 功能清单

| 编号 | 功能 | 优先级 | 里程碑 | 验收口径 |
| --- | --- | --- | --- | --- |
| M05-F001 | 会话注册表：双端会话清单（host 归属、任务关联、健康状态），Web 可浏览 | P3 | MS4 | 两侧互见对方会话列表 |
| M05-F002 | 跨机控制权交接：观察 → 请求接管 → 对方批准/超时自动 → 互斥锁保证同一会话同一时刻只有一个操作者 | P3 | MS4 | 并发接管请求被互斥拒绝 |
| M05-F003 | 会话状态同步：会话事件流（输出片段/状态变化）向观察端转发，断线重连补发 | P3 | MS4 | 观察端重连后补齐缺失片段 |
| M05-F004 | 权限分级：`owner / operator / observer` 三级；角色由 M01 账户 + 会话归属决定 | P3 | MS4 | observer 无法注入输入 |

## 3. 流程图（控制权交接）

```mermaid
sequenceDiagram
    autonumber
    participant W as Win 端用户（operator）
    participant R as SessionRegistry (ubuntu 主机会话)
    participant U as Ubuntu 端用户（owner）
    W->>R: GET /sessions（经 M01 认证）
    R-->>W: 会话列表 + 当前持锁者
    W->>R: POST /sessions/:id/takeover 请求接管
    R->>U: 通知（Web/SSE）
    alt U 批准
        R->>R: CAS 抢互斥锁（owner→W）
        R-->>W: granted：可注入输入
        R-->>U: 降级为 observer
    else U 拒绝或请求超时
        R-->>W: denied / expired + 理由
        R-->>U: owner 继续持锁
    end
```

## 4. 接口设计

```typescript
export interface SessionRegistry {
  list(filter?: { host?: HostId; taskId?: TaskId }): Promise<SharedSession[]>;
  subscribe(id: SessionId, role: Role): AsyncIterable<SessionEvent>; // 观察流
  requestTakeover(id: SessionId, by: Actor): Promise<TakeoverResult>;
  release(id: SessionId, by: Actor): Promise<void>;
  onRegistryChange(listener: (evt: RegistryEvent) => void): Unsubscribe;
}
```

## 5. 数据模型

见 `04-interfaces/data-models.md#session`。要点：`SharedSession`（host、ownerTaskId、lockHolder、role bindings）、`TakeoverRequest`（超时策略字段）。

## 6. 配置设计

```yaml
- insert:
    - id: luban-session-share
      name: dsh-luban-session-share
      config:
        host: auto
        ownerUser: owner
        takeoverTimeoutSec: 120
        peerRefreshSec: 10
        requestTimeoutSec: 10
        replayLimit: 256
        peers:                    # 局域网对端（互指）
          - name: win-debug
            baseUrl: "http://<win-lan-host>:42600"
            credentialEnv: LUBAN_SESSION_SHARE_WIN_COOKIE
```

## 7. 依赖与边界

- 下层：M01（认证与身份）、M03（托管会话句柄）、HAL（跨机 HTTP 客户端）；协作：M02（会话↔任务互链）。
- 复用档位：无直接参考项目，原创设计；SSE 转发参考自身 M02-F007 机制。
- 平台属性：双端公用。

## 8. 非功能与安全

- 控制权交接是高危操作：默认需对端 owner 批准；全自动放行必须显式配置且仅限白名单账户。
- 跨机通信强制走 M01 认证 token；会话输出转发过滤敏感串（token/密码正则打码）。
- 对端 Cookie/CSRF 仅从环境变量读取；每次跨机 mutation 先用同一 Cookie 查询
  `/luban-auth/session`，其用户名必须与本地发起者完全一致，否则 403。
- 只共享 `AgentRegistry.roots()` 返回的 live 顶层 Agent；durable lineage 不作为 runtime ownership，
  同时保留 `header.origin !== subagent` 的 durable fence；任何非 root 或 durable subagent Agent
  都不进入注册表，也不能由输入桥直接驱动。
- assistant 输出按 turn 做 64 KiB 有界缓冲后统一脱敏，解决 secret 跨 chunk 绕过；慢订阅者
  达队列上限即安全断流，并通过 `Last-Event-ID` 或 baseline 恢复。

## 9. checklist 映射

M05-F001 ~ M05-F004 共 4 项，与 `checklist.json` 一一对应。

## 10. 实现与验证记录

- `DshSessionBridge` 基于 rc2 `AgentRegistry`、`agent/status`、`session/event` 与
  `Agent.followup` 投影顶层会话；M03 健康、M02 task claim 均合并到同一注册表。
- 本机会话接管在 per-session mutex 内执行 owner 审批、过期检查与 version CAS；peer mutation
  使用真实 HTTP transport，并在 Cookie 身份预检后传递 CSRF。
- registry 与 per-session SSE 都有有界 replay/baseline；peer 建连有超时，单帧上限 1 MiB，
  peer refresh single-flight，dispose/remove 会终止流并释放历史。
- Session ID 在配置的主机间必须全局唯一；跨 registry origin 的碰撞会 fail closed，保留既有条目
  并报告 `session-id-collision`，避免将 stream 或 mutation 路由到错误主机。
- 本地 Prettier、严格类型、ESLint、构建、35 项 M05 测试、release metadata 与 pack dry-run
  通过；真实 Windows/Ubuntu 双主机断线、接管和 TLS/LAN profile 仍保留为目标环境验收。

## 11. 开放问题

- 是否在后续版本增加显式、可审计的白名单自动接管策略；当前超时严格 fail closed，不自动放行。
