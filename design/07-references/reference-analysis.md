# 参考项目分析与复用档位台账（Reference Analysis）

> 复用三档策略与许可分级规则的权威定义在 [02-principles §4](../02-principles/principles.md)。本台账逐项目登记：license 核实状态、功能亮点、可借鉴点、不可碰边界、处置档位。**核实前只读公开文档、不读源码**（P4.1）。每项核实后更新本表并追加版本记录。

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                              |
| ---- | ---------- | ----- | ------------------------------------- |
| v0.1 | 2026-08-29 | Maintainers | 初稿：A/B/C 档台账建立，标注核实状态 |
| v0.2 | 2026-08-30 | Codex | 核实 browser-use 0.13.8 为 MIT 并确定 uv 集成形态 |

## 1. A 档 · 插件级安装原版（不进入本仓库代码）

| 项目 | 地址/包名 | License（状态） | 用途 | 安装方式 | 边界 |
| --- | --- | --- | --- | --- | --- |
| dsh-market | npm `dshmarket`（github.com/dsh-market/dsh-market） | 待核实 | 插件市场 UI/热启停/备份恢复 | `install-3rd-party` 脚本 pnpm 直装 | 不 fork 不改；只通过其公开 Update API 集成 |
| dsh-better-sidebar | npm `dsh-better-sidebar`（github.com/omdsh-dev/DSH-better-sidebar） | 待核实 | Trae 式 diff 展示回退、VSCode 式工作区树（相对路径） | 同上 | 同上；界面体验直接使用原版，不复制其代码 |
| dsh-memory | npm `@furongjun1999/dsh-memory`（github.com/FuRongJun-1999/dsh-memory） | 待核实 | 长期记忆（本套件不做记忆功能，避免重复） | 同上 | 同上 |

## 2. B 档 · 依赖/服务级集成（只写适配层）

| 项目/工具 | 集成形态 | License（状态） | 用于模块 | 备注 |
| --- | --- | --- | --- | --- |
| browser-use 0.13.8 | Python JSONL 子进程 + TypeScript 适配层；`uv run --locked` | **MIT（已核实：[LICENSE](https://github.com/browser-use/browser-use/blob/main/LICENSE)）** | M11 | Python ≥3.11；项目固定 3.12，双端内核差异由 HAL 收口 |
| Windows-MCP / CursorTouch | MCP 服务配置接入 | 待核实 | M10-F006 | 凭据走系统凭据管理器 |
| tmux | 命令行调用 | GPL（系统工具，独立进程使用不传染） | M03 | 仅 exec 调用 |
| OpenOCD / J-Link / esptool / STM32CubeProgrammer | 命令模板 exec | 各自许可（待核实登记） | M10-F003 | 外部工具路径可配 |
| adb / fastboot | 命令 exec | Android AOSP 许可（待核实登记） | M10-F005 | 同上 |
| gdb | 命令/MI 模式 | GPL（独立进程） | M10-F004 | 同上 |
| openssh / nssm | 系统组件 | 各自许可 | M03/M10-F007 | 独立进程使用 |

> GPL 工具以**独立进程 exec** 方式使用不构成代码衍生；绝不 import/link 其代码。

## 3. C 档 · 功能参考重新实现（代码与界面零接触）

| 项目 | 地址 | License（核实状态） | 功能亮点（可借鉴的需求） | 不可碰边界 | 受益模块 |
| --- | --- | --- | --- | --- | --- |
| dashi-taskboard | github.com/chuspeeism/dashi-taskboard | **Apache-2.0（已核实）** | 任务版本化乐观锁；issue 绑定 git 分支/worktree；CLI 与 UI 共用同一 HTTP API；SSE 广播+断线全量刷新；任务 GFM 描述 | **代码与界面一律不参考**（Apache 档）；不做其「云模式」 | M02 |
| cloader/dsh-taskboard | github.com/cloader/dsh-taskboard | 待核实 | 人建卡→agent 认领执行→人验收的协作流；任务挂项目（workspace）；指定模型；手动+定时执行 | license 核实前只读 README 级公开描述 | M02 |
| maochiy/dsh-taskboard-plugin | github.com/maochiy/dsh-taskboard-plugin | 待核实 | 本地 JSON 存储、六列拖拽、任务-会话联动 | 同上 | M02 |
| dsh-web-ui / dsh-task-board | github.com/zhu1090093659/dsh-web-ui | 待核实 | Host 权威任务账本、真实会话执行、Host cron 调度 | 同上 | M02 |
| @linxin666/dsh-web-all（本机已装，观察对象） | npm | 待核实 | LAN 访问/任务板的**需求形态**（其 LAN 无认证是本项目的反面教材） | 不参考代码；作为运行中的参照系观察行为 | M01/M02 |
| pi-mono（badlogic） | github.com/badlogic/pi-mono | 待核实（MIT 预期） | 极简 agent 上下文工程理念；RPC headless 模式 | license 核实前不读源码 | M08/M09 |
| pi-agentic-compaction | pi 生态扩展（地址待查证） | 待核实 | 虚拟文件系统式上下文压缩：旧上下文外置为可检索文件 | 同上，仅策略形态参考 | M08 |
| 各 coding-agent 状态栏（ccusage 等） | — | — | 状态栏字段口径（context/rate） | 仅字段需求参考 | M07 |

## 4. 核实任务清单（随开发推进更新）

- [ ] dsh-market / dsh-better-sidebar / dsh-memory 的 LICENSE 文件核验并登记（M12-F004 执行时）
- [x] browser-use license + python 集成成本评估（MIT；0.13.8；uv 隔离 JSONL 子进程）
- [ ] cloader / maochiy / dsh-web-ui 三家 taskboard license 核验（M02-F009 导入器前）
- [ ] pi-mono / pi-agentic-compaction license 核验（M08-F001 前；核实为 MIT 后允许读源码级参考）
- [ ] 全部 B 档外部工具版本与许可登记（M10 各通道落地时）
- [ ] `THIRD-PARTY-NOTICES.md` 生成（首个 release 前，M12-F003）

## 5. 事故记录（泄漏/合规事件，留空表示无）

| 日期 | 事件类型 | 处置 | 改进 |
| ---- | -------- | ---- | ---- |
| —    | —        | —    | —    |
