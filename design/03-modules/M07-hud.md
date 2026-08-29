# M07 HUD 模块（luban-hud）设计

常驻状态显示器：上下文用量（used/max/占比）、workspace 名、模型、思考深度、tpm、rpm 一屏可见。数据经多源 Provider 聚合，缺失的数据源降级显示。

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                              |
| ---- | ---------- | ----- | ------------------------------------- |
| v0.1 | 2026-08-29 | Maintainers | 初稿：遥测聚合/用量/环境/速率/展示/阈值 |
| v0.2 | 2026-08-30 | Codex | 回填 rc2 遥测口径、SSE、降级与验证证据 |
| v0.3 | 2026-08-30 | Codex | 增加会话定向新鲜采样，消除多 agent 缓存串扰 |
| v0.4 | 2026-08-30 | Codex | 接入 M03 健康状态与 M02 critical 去重告警 |

## 1. 概述与目标

- **解决**：R08——随时知道「还剩多少上下文、跑得多快、在哪个 workspace、用哪个模型」。
- **不解决**：上下文治理本身（M08 负责）；跨重启持久化与历史报表分析（本版仅保留有界内存历史）。
- **需求映射**：R08。
- **平台属性**：双端公用；web 状态栏（client-ui 槽位）+ CLI 头部两种呈现。

## 2. 功能清单

| 编号 | 功能 | 优先级 | 里程碑 | 验收口径 |
| --- | --- | --- | --- | --- |
| M07-F001 | TelemetryProvider 多源聚合接口：dsh 内部遥测、token 计数、速率采样等 Provider 插拔式注册，字段级缺失降级 | P2 | MS3 | 某一 Provider 缺失时其余字段正常显示 |
| M07-F002 | context 用量：`used / max / ratio`，来源优先级：会话元数据 > token 计数器估算 | P2 | MS3 | 与 dsh 会话显示的用量一致（±5%） |
| M07-F003 | 环境信息：workspace 名（相对路径展示）、模型名、思考深度（reasoning effort 档位） | P2 | MS3 | 切 workspace/模型即刷新 |
| M07-F004 | 速率指标：tpm/rpm 滑动窗口（1min/5min 两档）统计 | P2 | MS3 | 与账单侧 token 流水口径可对账 |
| M07-F005 | HUD 展示：web 常驻状态栏（紧凑模式/完整模式）+ CLI 首行渲染 | P2 | MS3 | 双端、双形态均可见 |
| M07-F006 | 阈值提醒：占比超 70%/85%/95% 分级提示，95% 时给出 M08 压缩建议 | P3 | MS3 | 超阈值事件推送看板/HUD |

## 3. 流程图

```mermaid
flowchart LR
    subgraph Providers["TelemetryProvider（可插拔）"]
        P1["dsh 会话元数据 Provider"]
        P2["Token 计数 Provider"]
        P3["速率采样 Provider（tick 采样请求/响应）"]
        P4["环境 Provider（workspace/模型/思考深度）"]
    end
    P1 & P2 & P3 & P4 --> AGG["TelemetryAggregator（L2）<br/>字段级合并 + 缺失降级"]
    AGG --> SNAP["TelemetrySnapshot（节流 1s）"]
    SNAP --> W["Web 状态栏（SSE 推送）"]
    SNAP --> C["CLI 首行渲染"]
    SNAP --> T{"ratio ≥ 阈值?"}
    T -- "≥70%/85%" --> N1["HUD 黄/橙提示"]
    T -- "≥95%" --> N2["红色提示 + 建议触发 M08 压缩"]
    N2 --> TB["M02 活跃告警卡（连续 critical episode 去重）"]
    K["M03 luban.keepalive.health"] --> KH["有界脱敏健康投影"]
    KH --> W & C
```

## 4. 接口设计

```typescript
export interface TelemetryProvider {
  readonly id: string;
  capabilities(): TelemetryField[];          // 声明可提供哪些字段
  sample(): Promise<Partial<TelemetrySnapshot>>;
  sampleForSession?(sessionId: SessionId): Promise<Partial<TelemetrySnapshot>>;
}

export interface TelemetryAggregator {
  register(p: TelemetryProvider): Unsubscribe;
  snapshot(): Promise<TelemetrySnapshot>;     // 字段级合并，缺失字段标 unknown
  snapshotFor(sessionId: SessionId): Promise<TelemetrySnapshot>; // 不复用全局 HUD 缓存
  subscribe(listener: (s: TelemetrySnapshot) => void): Unsubscribe;
}

export interface TelemetrySnapshot {
  context: { used: number | 'unknown'; max: number | 'unknown'; ratio: number | 'unknown' };
  workspace: { name: string | 'unknown' };
  model: { name: string | 'unknown'; thinkingDepth: string | 'unknown' };
  rates: { tpm1m: number | 'unknown'; tpm5m: number | 'unknown'; rpm1m: number | 'unknown'; rpm5m: number | 'unknown' };
  at: number; // epoch ms
}
```

## 5. 数据模型

见 `04-interfaces/data-models.md#telemetry`。要点：快照不可变、带时间戳；历史快照采用按时间裁剪的
内存环形序列（默认保留 1h），经认证 `/history` 提供诊断。本版 Web HUD 展示当前值，不承诺跨重启持久化或趋势报表。

## 6. 配置设计

```yaml
- insert:
    - id: luban-hud
      name: dsh-luban-hud
      config:
        refreshSec: 1
        thresholds: { warn: 0.70, danger: 0.85, critical: 0.95 }
        display: { fields: ["context", "workspace", "model", "thinking", "tpm", "rpm"], compact: false }
        history: { enabled: true, retainMinutes: 60 }
```

## 7. 依赖与边界

- 下层：dsh 公开遥测点（实测确定；拿不到的字段由估算 Provider 兜底）；协作：M03（健康事件）、可选 M02 `lubanTaskStore`（critical 告警）、M08（critical 提示触发压缩建议）。M07 只依赖 Core 契约和已登记 Cordis 事件，不 import 其他模块实现。
- 复用档位：**C 档**——参考各类 coding-agent 状态栏的需求形态（ccusage/状态栏插件的字段口径），实现原创。
- 平台属性：双端公用。

## 8. 非功能与安全

- 遥测只含元数据（数字、名称），不含会话内容；快照不落敏感字段。
- 采样器避免高频计时器泄漏（页面隐藏时暂停 web 端订阅）。
- `refreshSec` 下限 1 秒；Provider 并发采样有 timeout，历史保留上限 1440 分钟，SSE replay 固定 256 条。
- Provider 任意异常仅以固定公共文案进入 API，内部日志先脱敏；非法/溢出 token usage 保持 `unknown/partial`，不伪装为 0。
- REST/SSE 全部经 M01 认证；对外 SSE 只使用已登记的 `luban.telemetry.snapshot` 事件名和共享递增 ID。
- M03 健康异常作为 `HudSnapshotResponse.keepalive` 可选扩展字段加入；旧响应/旧客户端仍可工作。
  健康 detail 去控制字符、凭据脱敏、单条限长，异常集合上限 256；卸载后不再接受事件或推送。
- M02 后置加载时通过可选 Cordis injection 自动接通。critical 告警只含比例元数据，不含 workspace、
  模型或会话内容；同一连续 critical episode 串行查询并复用活跃卡，卸载竞态在 create 前复查。

## 9. checklist 映射

M07-F001 ~ M07-F006 共 6 项，与 `checklist.json` 一一对应。

## 10. 实现与验证记录

- rc2 Session Provider 优先读取 `assistant/message.usage`、`request/context.contextWindow`、request header
  model/reasoning；缺少官方 used 时，内容估算 Provider 只补 used，不编造 max。
- context pressure 口径为 input + cache read + cache write；TPM 使用 input + output + cache read + cache write，
  reasoning token 已包含在 output 中不重复计数。1m/5m 均使用 monotonic 滑动窗口，历史事件按 wall-clock age 映射。
- `DefaultTelemetryAggregator` 并发采样、按 Provider 注册顺序做字段级 first-wins 合并；generation 防止注册/卸载竞态提交陈旧结果。
- `snapshotFor(sessionId)` 对指定 live agent 重新采样，不读取或替换全局 HUD 缓存，也不向订阅者发布；
  M08 因而不会把 initiator/running/newest 的全局选择结果误用于另一个刚进入 idle 的会话。
- Web 使用官方 `shell.overlay` slot，并在页面隐藏时关闭 SSE；CLI 从环境读取 Cookie，输出单行去控制字符，HTTP 10 秒超时。
- SSE 支持共享 ID、`Last-Event-ID`、256 条 replay 与断档 baseline；API/stream 在插件卸载竞态中 fail closed。
- M03 异常/恢复会立即复用现有 SSE envelope 推送，Web 无论紧凑/完整模式均显示红色
  `keepalive N down`，CLI 首行同步显示异常会话 id；字段缺失时保持旧 envelope 兼容。
- 可选 `lubanTaskStore` 在服务后置出现时动态接通；critical episode 通过串行 active-tag 查询去重，
  恢复后才开启下一 episode，TaskStore 失败只写脱敏诊断且不影响遥测。
- 本地 Prettier、严格类型、ESLint、构建、27 项 M07 测试通过；其中真实 Cordis mount 覆盖
  keepalive 事件、后置 TaskStore、认证响应、客户端行为，另有卸载竞态与并发去重单测。

## 11. 目标环境验收

- 仍需在真实 Windows/Ubuntu DSH profile 核对 workspace/model/reasoning 切换、Web 常驻 HUD、CLI 首行与页面隐藏重连。
- 仍需用真实 Provider/账单流水验证 TPM/RPM 口径，并在真实长会话复核 M08 的会话定向采样与压缩质量。
- 仍需在真实掉线长任务中核对 M03 巡检到 HUD/Taskboard 的端到端可见时延。
