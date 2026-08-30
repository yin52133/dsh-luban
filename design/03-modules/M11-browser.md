# M11 浏览器自动化模块（luban-browser）设计（双端）

以 **B 档依赖集成**方式接入 browser-use：win 与 ubuntu 都能用浏览器自动化完成信息采集、网页操作类任务；与任务看板联动，让「查资料/抓页面」类 todo 可被自动执行。

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                              |
| ---- | ---------- | ----- | ------------------------------------- |
| v0.1 | 2026-08-29 | Maintainers | 初稿：适配层/任务模板/看板联动/内核收口 |
| v0.2 | 2026-08-30 | Codex | 固化 browser-use 版本并采用 uv 管理本地桥接环境 |
| v0.3 | 2026-08-30 | Codex | 记录 JSONL 桥接、模板发布、鉴权 API 与看板联动实现验证 |
| v0.4 | 2026-08-30 | Codex | 收紧自动任务域名白名单，拒绝裸 `*` wildcard |
| v0.5 | 2026-08-30 | Codex | 收口 bridge 子进程退出与 task claim 轮换竞态 |
| v0.6 | 2026-08-30 | Codex | 夜间执行改由 scheduler 路由并独占终态 claim 写入 |

## 1. 概述与目标

- **解决**：R11 扩展——browser-use 在 windows 与 ubuntu 双端集成；网页类任务（查 datasheet、抓 issue、监控页面变化）可交给 agent。
- **不解决**：反爬对抗、需要复杂登录态的灰色场景；不重写浏览器自动化引擎（B 档纪律）。
- **需求映射**：R11（用户明确要求 win/ubuntu 双端集成）。
- **平台属性**：双端公用；浏览器内核差异收口在 HAL（M11-F004）。Python 桥接服务随插件构建到 `dist/browser-bridge/`，由 `uv run --locked` 创建和运行隔离环境，不使用全局 pip。

## 2. 功能清单

| 编号 | 功能 | 优先级 | 里程碑 | 验收口径 |
| --- | --- | --- | --- | --- |
| M11-F001 | browser-use 适配层：进程/服务生命周期管理、任务下发（自然语言+URL+约束）、结果（截图/文本/结构化）回收 | P1 | MS2 | 双端各一条端到端任务成功 |
| M11-F002 | 浏览器任务模板：站点清单（登录态保持策略、超时、输出 schema），模板 yaml 化用户可增补 | P2 | MS2 | 新站点 5 分钟内可加模板 |
| M11-F003 | 看板联动自动执行：任务卡打 `browser` 标签 + 模板引用 → agent 领单后按模板自动执行并回填 | P3 | MS3 | 夜间窗口可跑浏览器类白名单任务 |
| M11-F004 | 双平台浏览器内核收口：HAL 决定 win（本地 Chrome/Edge）与 ubuntu（无头 Chromium）的启动差异 | P2 | MS2 | 同一任务定义双端可跑 |

## 3. 流程图

```mermaid
sequenceDiagram
    autonumber
    participant T as 任务卡（browser 标签+模板引用）
    participant A as agent 会话（领单）
    participant B as BrowserAdapter (M11-F001)
    participant K as HAL 内核选择 (M11-F004)
    A->>B: submit(templateId, params)
    B->>K: resolve(profile) → win: 本地 Chrome / ubuntu: 无头 Chromium
    K-->>B: 浏览器会话
    B->>B: 执行（进度事件流）
    B-->>A: 结果：截图+文本+结构化数据
    A->>T: 回填产出（M02-F006 复用）
```

## 4. 接口设计

```typescript
export interface BrowserAdapter {
  start(profile?: BrowserProfile): Promise<BrowserSession>;
  run(task: BrowserTaskSpec): AsyncIterable<BrowserEvent>; // progress / screenshot / result / error
  stop(): Promise<void>;
  templates(): Promise<BrowserTemplate[]>;
}
export interface BrowserTaskSpec {
  templateId?: string;            // 有模板走模板
  goal: string;                   // 无模板走自然语言目标
  startUrl?: string;
  constraints?: { maxSteps?: number; allowDomains?: string[]; timeoutSec?: number };
}
```

## 5. 数据模型

见 `04-interfaces/data-models.md#browser`。要点：`BrowserTaskSpec`、`BrowserResult`（截图文件引用、提取文本、结构化 JSON、耗时/步数）。

## 6. 配置设计

```yaml
- insert:
    - id: luban-browser
      name: dsh-luban-browser
      config:
        engine: browser-use        # B 档，唯一引擎；接口留多引擎余地但不过度设计
        kernel: auto               # auto | chrome | edge | chromium-headless
        templatesDir: "browser-templates"
        defaults: { maxSteps: 30, timeoutSec: 300, allowDomains: [] }
        bridge: { runner: uv, python: "3.12", browserUseVersion: "0.13.8" }
```

## 7. 依赖与边界

- 下层：browser-use `0.13.8`（**B 档**、MIT）：Python JSONL 子进程桥接，仅写适配层；使用随包的 `pyproject.toml` + `uv.lock`，环境目录落在用户数据目录而非仓库或 npm 包目录；HAL 浏览器内核。
- 协作：M02（任务卡联动）、M10（win 桌面侧可与浏览器任务互补）。
- 平台属性：双端公用。

## 8. 非功能与安全

- 域名白名单默认为空=仅手动触发；夜间自动执行必须模板 + 域名白名单齐备（继承 M02 夜间三重防护）。
- `allowDomains` 仅接受精确域名与 `*.example.com` 子域模式；裸 `*`（及归一化后为 `*` 的写法）在 TS 配置/模板/任务入口和 Python 执行端均拒绝。空列表仍只表示手动无约束，自动任务 fail closed。
- 登录态凭据只存系统凭据管理器/环境变量，绝不入仓库与模板文件（P6.1）。

## 9. checklist 映射

M11-F001 ~ M11-F004 共 4 项，与 `checklist.json` 一一对应。

## 10. 实现与验证记录

- TypeScript Host 通过有界串行队列管理 `uv run --locked` JSONL 子进程；协议覆盖启动、
  进度、截图、结构化结果、取消、超时和稳定错误码，敏感环境变量仅按名称白名单传递。每个
  listener 与 child state 绑定；shutdown 响应后继续等待真实 `close`，超时按 TERM→KILL 收口，
  旧 child 的迟到事件不能影响 replacement，listener/stdin/stdout/stderr 最终全部释放。
- Python 3.12 桥接项目固定 `browser-use==0.13.8` 并提交 `uv.lock`；发布构建将桥接项目和
  内置 YAML 模板复制到 `dist/`，运行环境落在用户数据目录而非全局 Python。
- `/luban-browser` HTTP/SSE API 复用 `lubanAuth`，会话入口统一为 `/luban-auth/login`；
  自动任务仅响应已由 agent 认领且带 `browser`、`auto-ok` 和唯一模板标签的看板卡片。
- 自动任务按 claim `leaseId` 分代去重并串行；同毫秒 A→B 重领时 A 的 progress/complete/fail
  全部被账本拒绝，B 仍继续 queue/progress/artifact 并进入 `review(autoDone)`。
- 夜间浏览器任务通过共享 `NightTaskExecutorRoute` 进入 queue；browser 只上报进度并返回产物，
  scheduler 独占 complete/fail。持久化 `executionOwner` 防止普通 listener 双执行且不能由 HTTP 伪造。
- 本地 ESLint、严格类型、构建、22 项 M11 包测试、6 项 M11 跨模块集成与 13 项 `uv --locked`
  Python 测试、Ruff、compileall、ESM 导入及 npm pack 白名单均通过。真实 uv JSONL 子进程已完成
  ping→shutdown→exit 0 且剥离模型凭据；本机 browser-use/Chrome 已加载 loopback DOM，并验证
  临时复制 profile 清理，未访问外部网站或模型提供商。
- M11-F002/M11-F003 域名策略复核：TS 配置、YAML 模板和任务解析拒绝裸 `*`，自动任务
  仍要求非空白名单；Python 桥接在执行前再次拒绝，精确域名与 `*.example.com` 继续可用。

## 11. 开放问题

- browser-use 在 ubuntu 无桌面环境下的 headless 稳定性实测；若依赖 playwright，其浏览器下载与离线部署方式写入部署文档。
- 仍需在 Windows/Ubuntu 目标 profile 用真实登录态、人工可见标签页和长期任务完成端到端验收。
