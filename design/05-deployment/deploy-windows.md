# Windows 端部署设计（win-debug 形态）

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                              |
| ---- | ---------- | ----- | ------------------------------------- |
| v0.1 | 2026-08-29 | Maintainers | 初稿：profile 组成、安装步骤、保活、A 档直装 |
| v0.2 | 2026-08-30 | Codex | 增加 M11 browser-use 的 uv 隔离环境要求 |
| v0.3 | 2026-08-30 | Codex | 落地默认预览且拒绝覆盖的 win-debug 生成脚本 |
| v0.4 | 2026-08-30 | Codex | 同步 A 档 lock v2、安装授权门禁与 profile smoke |
| v0.5 | 2026-08-30 | Codex | 同步 A 档 lock v3、精确原生构建许可与安装后验收链 |
| v0.6 | 2026-08-30 | Codex | 将 profile smoke 证据绑定到 CI commit、run identity 与 attempt |

## 1. 目标形态

Windows 本地调试机：dsh 本机运行（本机终端用 CLI，局域网其他设备经 web 访问），叠加自研套件的 M01-M08、M10、M11 与 A 档三个原版插件。

```mermaid
flowchart LR
    subgraph P["profile: win-debug"]
        D["dsh-base + dsh-web-app（官方）"]
        L["dsh-luban-* M01-M08, M10, M11"]
        A["A 档原版：dshmarket /<br/>dsh-better-sidebar / @furongjun1999/dsh-memory"]
    end
    T["本机终端（CLI/串口）"] --> P
    B["局域网浏览器（经 M01 登录）"] --> P
    K["保活：计划任务/服务（M03-F002）"] --> P
```

## 2. 安装步骤

1. **前置**：Node ≥ 22、pnpm ≥ 10、uv ≥ 0.11；`npm i -g @deepseek-ai/dsh`；确认 `dsh --version` 与 `uv --version`。
2. **创建 profile**：先运行 `scripts/deploy/setup-windows.ps1` 预览目标与文件清单；确认后增加
   `-Apply`，生成 `%DSH_HOME%\profiles\win-debug\`（`package.json`、`cordis.patch.yml`、
   `README.md`）。可用 `-DshHome <path>` 指向隔离目录。脚本不改官方 preset，且目标已存在时拒绝覆盖。
3. **安装本套件**：`dsh plugin --profile win-debug add dsh-luban-auth dsh-luban-taskboard ...`（monorepo 发布后逐包，或本地 `file:` 联调）。
4. **A 档直装**：先运行 `scripts/install-3rd-party.ps1 -Profile win-debug -DryRun` 审核本地
   lock v3 计划；默认固定 `dshmarket@1.36.0`、`dsh-better-sidebar@0.17.1`、
   `@furongjun1999/dsh-memory@0.4.0`。apply 必须在 Windows 宿主提供绝对且非根目录的
   `-DshHome` 与 `-ApprovedBy`，并使用 pnpm `11.24.0`；latest/显式 semver 还需
   `-ApproveUnpinned`。
5. **保活注册**：M03-F002 注册计划任务（登录时启动/开机按用户选择）；账本与配置目录 `%DSH_HOME%\luban\`。
6. **认证初始化**：首次访问 web 引导创建管理员（M01-F001）；端口默认 42600 可配。

```powershell
# Preview only (default)
.\scripts\deploy\setup-windows.ps1 -DshHome C:\dsh-acceptance

# Create after reviewing the JSON plan
.\scripts\deploy\setup-windows.ps1 -DshHome C:\dsh-acceptance -Apply

$env:DSH_HOME = 'C:\dsh-acceptance'
dsh --profile win-debug --dump-config

# Review the pinned A-class plan (no registry request and no dsh child process)
.\scripts\install-3rd-party.ps1 -Profile win-debug -DryRun

# Apply only on the matching Windows host after explicit review
.\scripts\install-3rd-party.ps1 -Profile win-debug `
  -DshHome C:\dsh-acceptance -ApprovedBy operator-name -Apply

# Unpinned resolution requires a separate approval
.\scripts\install-3rd-party.ps1 -Profile win-debug -Version latest `
  -DshHome C:\dsh-acceptance -ApprovedBy operator-name -ApproveUnpinned -Apply
```

apply 只向子进程注入 `DSH_HOME`、固定官方 npm registry 与无敏感字段的验收身份，不修改当前
PowerShell 环境。执行前会核对三包及 `node-pty@1.1.0` 的包名、版本、license metadata、
repository、integrity、bundle 与依赖边界；任一不一致即拒绝安装。安装使用 `--save-exact` 与
`--allow-build=node-pty@1.1.0` 连续执行两次，随后核对精确依赖清单、`--dump-config`、唯一 bundle、
安装 manifest、LICENSE SHA-256 和 `node-pty` native load。npm metadata 中的 MIT 声明仍不等于
双端 live notices 证据已经生成。

M12-F001 的目标宿主 smoke runner 默认只打印无写入计划。Windows 现场验收时使用项目本地
DSH `0.1.1-rc.2` 执行：

```powershell
node scripts/acceptance/m12-profile-smoke.mjs
node scripts/acceptance/m12-profile-smoke.mjs --live `
  --expected-git-sha "$env:GITHUB_SHA" `
  --workflow-run-id "$env:GITHUB_RUN_ID" `
  --workflow-run-attempt "$env:GITHUB_RUN_ATTEMPT" `
  --output "$env:TEMP\m12-win-debug.json"
```

live runner 在隔离 `DSH_HOME` 中安装临时 host/client fixture，验证唯一挂载、lazy-CJS client、
热停/热启、重启和清理。可聚合证据必须从 CI 注入 `GITHUB_SHA`、`GITHUB_RUN_ID` 与
`GITHUB_RUN_ATTEMPT`；手工虚构这些值不构成可信 workflow 证据。聚合器要求双端同一 SHA/run/
attempt、不同一次性 smoke run ID、完整有序 canonical check 集合，并记录原始输入 SHA-256；
旧 attempt 与重复输入 fail closed。runner 存在不代表 Windows/Ubuntu 双端已验收；两端必须各自
产出真实 live pass 证据。

## 3. 配置分层

```text
%DSH_HOME%\
├── profiles\win-debug\
│   ├── package.json             # bundles 有序：官方 base → A 档 → dsh-luban-*
│   ├── cordis.patch.yml         # 用户启停层（disabled 开关写这里）
│   └── node_modules\
├── luban\                       # 本套件数据（认证/看板/保活账本）
└── cordis.patch.yml             # 全局覆盖层（最优先）
```

## 4. 平台注意点

- 原生构建：A 档 profile 只允许精确 `node-pty@1.1.0`，不得改成包名级或其他版本的宽泛许可。
- 串口：本套件其他原生模块必须按各自审查结果单独登记，不能复用 A 档的构建许可。
- 桌面自动化（M10-F006）：MCP 服务以独立进程配置接入，凭据走系统凭据管理器。
- 浏览器桥接（M11）：插件以 `uv run --locked` 启动随包 Python 项目，隔离环境位于 `%DSH_HOME%\luban\browser\uv-env`，禁止使用全局 pip。
- 防火墙：首次监听提示放行私网；文档明确「仅限可信局域网」。

## 5. 升级与回退

- 本套件升级：`dsh plugin --profile win-debug update <pkg>`（dsh-market Update API）；dsh 本体升级后按 `engines.dsh` 对齐表（06-release）验证。
- 回退：profile 的 `cordis.patch.yml` 热停单个插件（`disabled: true`，约 1s 生效）；数据目录独立，卸载插件不删数据。
