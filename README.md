# dsh-luban

🛠️ Custom workbench plugin suite for DeepSeek Harness (DSH) — LAN auth, task board, SSH + tmux keep-alive, shared Windows/Ubuntu sessions, context HUD & serial/debug tooling. Built for embedded devs: Windows debug box + LAN Ubuntu build server. Monorepo of dsh-luban-* plugins.

> 鲁班（Luban）：为嵌入式工程师打造的 DSH 定制工作台。

## 项目定位

dsh-luban 是一套运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh，MIT）之上的**自研插件套件**，服务于两种部署形态：

| 形态 | 宿主机 | 角色 |
|---|---|---|
| A · 本地调试机 | Windows | dsh 本机运行 + 串口/adb/GDB 调试 + 桌面自动化 |
| B · 局域网编译服务器 | Ubuntu | dsh 后台常驻（tmux 保活）+ 网页访问 + 编译/构建 |

核心能力：局域网账号密码认证（端口可配）、任务看板（agent 可自主领单、夜间无人值守研究）、会话保活与跨机共享、上下文 HUD、上下文压缩、plan 工作模式、串口/远程/浏览器自动化集成。

## 文档导航

全部设计文档在 [design/](design/README.md)，配套进度看板 [checklist.json](checklist.json)：

| 分册 | 内容 |
|---|---|
| [01-overview](design/01-overview/vision.md) | 愿景、分层总体架构、monorepo 目录、需求追踪矩阵 |
| [02-principles](design/02-principles/principles.md) | 设计原则专章（分层/契约/复用三档/许可合规） |
| [03-modules](design/03-modules/M01-auth.md) | 12 个模块详细设计（功能/流程图/接口/数据模型） |
| [04-interfaces](design/04-interfaces/api-overview.md) | 跨模块契约与数据结构 |
| [05-deployment](design/05-deployment/deploy-windows.md) | Windows / Ubuntu 双端部署设计 |
| [06-release](design/06-release/release-principles.md) | 发布原则与安全红线（key/.env 禁提交等） |
| [07-references](design/07-references/reference-analysis.md) | 参考项目分析与复用档位（license 合规） |

## 仓库现状

- ✅ 设计文档 v0.1（本仓库当前阶段）
- ⬚ 插件实现（按 [checklist.json](checklist.json) 里程碑 MS1 → MS4 推进）

## 许可

MIT（见 [LICENSE](LICENSE)）。第三方依赖与参考项目的许可处置见[参考项目分析](design/07-references/reference-analysis.md)。
