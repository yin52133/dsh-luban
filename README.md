# dsh-luban

🛠️ Custom workbench plugin suite for DeepSeek Harness (DSH) — simple account-separated contexts, task board, SSH + tmux keep-alive, shared Windows/Ubuntu sessions, context HUD & serial/debug tooling. Built for embedded devs: Windows debug box + LAN Ubuntu build server. Monorepo of dsh-luban-* plugins.

> 鲁班（Luban）：为嵌入式工程师打造的 DSH 定制工作台。

## 项目定位

dsh-luban 是一套运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh，MIT）之上的**自研插件套件**，服务于两种部署形态：

| 形态                 | 宿主机  | 角色                                            |
| -------------------- | ------- | ----------------------------------------------- |
| A · 本地调试机       | Windows | dsh 本机运行 + 串口/adb/GDB 调试 + 桌面自动化   |
| B · 局域网编译服务器 | Ubuntu  | dsh 后台常驻（tmux 保活）+ 网页访问 + 编译/构建 |

核心能力：简单账号登录与账号级上下文隔离（端口可配）、任务看板（agent 可自主领单、夜间无人值守研究）、会话保活与跨机共享、上下文 HUD、上下文压缩、plan 工作模式、串口/远程/浏览器自动化集成。本项目以功能和稳定性为主，不把可信局域网内的攻击防护或安全加固证明作为产品目标。

## 文档导航

全部设计文档在 [design/](design/README.md)，配套进度看板 [checklist.json](checklist.json)：

| 分册                                                        | 内容                                            |
| ----------------------------------------------------------- | ----------------------------------------------- |
| [01-overview](design/01-overview/vision.md)                 | 愿景、分层总体架构、monorepo 目录、需求追踪矩阵 |
| [02-principles](design/02-principles/principles.md)         | 设计原则专章（分层/契约/复用三档/许可合规）     |
| [03-modules](design/03-modules/M01-auth.md)                 | 12 个模块详细设计（功能/流程图/接口/数据模型）  |
| [04-interfaces](design/04-interfaces/api-overview.md)       | 跨模块契约与数据结构                            |
| [05-deployment](design/05-deployment/deploy-windows.md)     | Windows / Ubuntu 双端部署设计                   |
| [06-release](design/06-release/release-principles.md)       | 发布流程、版本一致性、失败恢复与仓库卫生        |
| [07-references](design/07-references/reference-analysis.md) | 参考项目分析与复用档位（license 合规）          |

## 快速开始

本仓库使用 Node.js 22.19+、pnpm 11；Python 桥接环境只通过 `uv` 创建和运行。

```powershell
corepack enable
pnpm install
pnpm check
```

本地联调时先构建工作区，再把所需 `dsh-luban-*` 包加入目标 profile。浏览器入口使用
`dsh-luban-auth` sidecar（默认 `http://<host>:42600/luban-auth/login`）；登录后，各插件按
当前账号读取对应的会话与上下文。各插件路由遵循 `/luban-<module>`，例如
`/luban-taskboard/tasks` 与 `/luban-browser/jobs`。

Ubuntu 服务器只需向实际局域网地址范围开放认证 sidecar 端口。`<lan-client-cidr>` 只是
一个示例；不同网络可能使用 `192.0.2.0/24`、`10.x.x.x` 或其他 CIDR，应替换为路由器
或网络管理员提供的客户端地址范围：

```sh
# Example only: replace this value with the actual LAN client CIDR.
LAN_CIDR=<lan-client-cidr>
sudo ufw allow proto tcp from "$LAN_CIDR" to any port 42600
```

该规则只控制哪些设备能连接端口；访问 DSH 仍需通过 `/luban-auth/login` 使用本地账号登录。
除非明确需要接受所有可路由来源，否则不要使用无来源限制的 `ufw allow 42600/tcp`。

浏览器桥接使用仓库锁文件，不使用全局 pip：

```powershell
uv run --project tools/browser-bridge --locked python -m unittest discover -s tools/browser-bridge/tests
```

安装、认证初始化和双端服务注册的完整步骤见
[Windows 部署](design/05-deployment/deploy-windows.md)与
[Ubuntu 部署](design/05-deployment/deploy-ubuntu.md)。夜间任务与浏览器自动执行默认关闭，
必须在白名单和目标环境验收完成后显式启用。

## 仓库现状

- 设计与实现按 [checklist.json](checklist.json) 的 MS1 → MS4 证据化推进。
- 已进入插件实现与逐模块验收阶段；`review` 表示实现已完成、明确验收当前可执行，但尚无
  覆盖完整口径的直接证据；`blocked` 表示明确验收因环境、设备、授权或外部依赖暂时无法继续。
  `done` 只表示设计验收已有直接证据，不等同于已经发布。
- npm 发布、GitHub Release、市场 PR 与 topic 修改均是独立的外部操作，未经明确授权不会执行。
- 市场交接使用 `scripts/release/prepare-market-handoff.mjs`：默认仅预览；`--write` 在
  `.luban/market-handoffs/` 生成包含包版本、上游 schema 与候选 diff 的本地审核物。产物中的
  PR/topic 命令均为未执行计划，不能替代维护者明确批准。
- A 档第三方安装验收使用 `scripts/acceptance/m12-third-party-install.mjs`，默认仅输出零写入计划。
  真实验收安装到仓库外的 disposable profile，分别检查 Windows/Ubuntu 的安装、重复执行、启动、
  列表/config 与卸载结果。脚本和 workflow 就绪不等于已获准修改目标环境；真实双端运行仍需明确授权。

## 许可

MIT（见 [LICENSE](LICENSE)）。第三方依赖与参考项目的许可处置见[参考项目分析](design/07-references/reference-analysis.md)。
