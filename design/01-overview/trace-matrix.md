# 需求追踪矩阵（Requirements Trace Matrix）

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                                     |
| ---- | ---------- | ----- | -------------------------------------------- |
| v0.1 | 2026-08-29 | Maintainers | 初稿：R01-R11 ↔ 模块 ↔ 功能点 ↔ 里程碑全量映射 |
| v0.2 | 2026-08-30 | Codex | 增加账号上下文隔离并标记已取消的安全加固功能 |

> 本表是 R（需求）、M（模块）、F（功能点）、MS（里程碑）四套编号的权威对照。`scripts/validate-design.mjs` 校验本表与 `checklist.json`、各模块文档三处一致。新增需求按 `design/README.md` SOP 在此追加行。

## 1. 需求 → 模块 → 里程碑总览

| 需求 | 需求名称 | 模块 | 里程碑 | 模块文档 |
| --- | --- | --- | --- | --- |
| R01 | Ubuntu 直接用网页 | M01, M09 | MS1 / MS1 | [M01](../03-modules/M01-auth.md) · [M09](../03-modules/M09-server-mode.md) |
| R02 | tmux 保活、重启续跑 | M03 | MS1 / MS4 | [M03](../03-modules/M03-keepalive.md) |
| R03 | 任务看板 + agent 自主领单 | M02 | MS1→MS3 | [M02](../03-modules/M02-taskboard.md) |
| R04 | 注册 dsh 插件市场 | M12 | MS1→MS2 | [M12](../03-modules/M12-market-release.md) |
| R05 | plan 工作模式 | M04 | MS3 | [M04](../03-modules/M04-plan.md) |
| R06 | 双机共享 session 与控制权 | M05 | MS4 | [M05](../03-modules/M05-session-share.md) |
| R07 | 粘贴图片可被访问 | M06 | MS3 | [M06](../03-modules/M06-image-paste.md) |
| R08 | HUD（context/模型/tpm/rpm 等） | M07 | MS3 | [M07](../03-modules/M07-hud.md) |
| R09 | 上下文压缩（参考 pi） | M08 | MS3 | [M08](../03-modules/M08-context.md) |
| R10 | Ubuntu 服务器操作模式 | M09 | MS1 / MS4 | [M09](../03-modules/M09-server-mode.md) |
| R11 | Windows debug/串口/远程/自动化 | M10, M11 | MS2→MS3 | [M10](../03-modules/M10-win-debug.md) · [M11](../03-modules/M11-browser.md) |

里程碑主线（用户已确认）：**MS1 服务器线 → MS2 嵌入式 debug 线 → MS3 HUD/上下文线 → MS4 协同完善**。

## 2. 里程碑 → 功能点全量清单

### MS1 · 服务器线基座（让 Ubuntu 端"能用、可看板、断电不丢"）

| 功能点 | 名称 | 优先级 |
| --- | --- | --- |
| M01-F001 | 用户账户体系（本地账户文件 + 口令哈希） | P0 |
| M01-F002 | 登录会话与 token | P0 |
| M01-F003 | Web 认证门禁中间件 | P0 |
| M01-F004 | 端口与监听地址配置 | P0 |
| M01-F005 | 已废弃：失败锁定与审计日志 | P1 |
| M01-F006 | 双端部署适配 | P0 |
| M01-F008 | 账号上下文隔离 | P0 |
| M02-F001 | 任务 CRUD 与状态机 | P0 |
| M02-F002 | 看板 Web UI | P0 |
| M02-F003 | 任务范围标签（host/workspace/优先级/验收标准） | P0 |
| M02-F010 | 存储层（JSON 文件 + 存储适配器） | P0 |
| M03-F001 | tmux 会话托管 | P0 |
| M03-F002 | Windows 保活替代（计划任务/服务） | P0 |
| M03-F003 | 重启恢复 | P0 |
| M03-F004 | 心跳巡检与健康上报 | P1 |
| M09-F001 | headless/web profile systemd 启动器 | P0 |
| M12-F001 | 包脚手架与 dsh manifest 规范落地 | P0 |
| M12-F005 | 已废弃：独立安全门禁 | P0 |

### MS2 · 嵌入式 debug 线

| 功能点 | 名称 | 优先级 |
| --- | --- | --- |
| M10-F001 | 串口通道适配器 | P1 |
| M10-F002 | 串口日志监视 UI 与过滤捕获 | P1 |
| M10-F003 | 烧录/复位命令编排 | P1 |
| M10-F004 | GDB 调试会话托管 | P2 |
| M10-F005 | adb/fastboot 通道 | P1 |
| M10-F006 | 桌面自动化适配（Windows-MCP 类，B 档） | P2 |
| M10-F007 | 远程设备通道（ssh/telnet/网络串口） | P2 |
| M10-F008 | ChannelAdapter 统一通道接口 | P1 |
| M11-F001 | browser-use 适配层（B 档） | P1 |
| M11-F002 | 浏览器任务模板 | P2 |
| M11-F004 | 双平台浏览器内核收口 | P2 |
| M02-F004 | agent 领单 API（原子认领 + 乐观锁） | P1 |
| M02-F007 | SSE 事件广播 | P1 |
| M02-F008 | taskctl CLI | P2 |
| M02-F009 | 数据导入器（dashi/cloader JSON） | P3 |
| M12-F002 | 市场注册 PR + topic 打标 | P1 |
| M12-F003 | 发布流水线（tag→Release→npm 同步） | P1 |
| M12-F004 | A 档第三方插件安装脚本 | P1 |
| M12-F006 | README 与版本记录规范落地 | P1 |

### MS3 · HUD/上下文线

| 功能点 | 名称 | 优先级 |
| --- | --- | --- |
| M04-F001 | plan 模式状态机 | P2 |
| M04-F002 | plan 文档落盘与引用 | P2 |
| M04-F003 | 审批交互（Web 批准/驳回/修订） | P2 |
| M04-F004 | plan 模板与检查清单 | P3 |
| M06-F001 | 剪贴板图片捕获 | P2 |
| M06-F002 | 图片落盘与命名 | P2 |
| M06-F003 | 会话引用注入 | P2 |
| M06-F004 | 图片预览与清理策略 | P3 |
| M07-F001 | TelemetryProvider 多源聚合 | P2 |
| M07-F002 | context 用量（used/max/占比） | P2 |
| M07-F003 | 环境信息（workspace/模型/思考深度） | P2 |
| M07-F004 | tpm/rpm 滑动窗口统计 | P2 |
| M07-F005 | HUD 展示（web 状态栏 + CLI） | P2 |
| M07-F006 | 阈值提醒 | P3 |
| M08-F001 | 压缩策略接口（策略模式） | P2 |
| M08-F002 | 阈值触发自动压缩 | P2 |
| M08-F003 | 虚拟文件归档 | P3 |
| M08-F004 | 压缩审计与回放 | P3 |
| M08-F005 | 与长任务/夜间模式协同 | P2 |
| M02-F005 | 夜间自主调度器 | P2 |
| M02-F006 | 产出回写与次日复核 | P2 |
| M11-F003 | 看板联动自动执行 | P3 |

### MS4 · 协同完善

| 功能点 | 名称 | 优先级 |
| --- | --- | --- |
| M05-F001 | 会话注册表 | P3 |
| M05-F002 | 跨机控制权交接（互斥锁） | P3 |
| M05-F003 | 会话状态同步与断线重连 | P3 |
| M05-F004 | 已废弃：权限分级（观察者/操作者/所有者） | P3 |
| M09-F002 | 服务器命令集（编译/构建队列） | P3 |
| M09-F003 | 资源看护 | P3 |
| M09-F004 | 构建产物管理 | P3 |
| M01-F007 | HTTPS/反代适配 | P3 |
| M03-F005 | 长任务断点记录 | P3 |

## 3. 校验口径

- 本表功能点总数 = `checklist.json` features 数 = 各模块文档「功能清单」行数之和（校验脚本强制）。
- 里程碑排序调整：只改 checklist.json 的 `milestones` 与本表归属列，功能编号永不复用。
