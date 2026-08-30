# M12 市场与发布模块（market-release）设计

发布基础设施（非插件）：包脚手架与 dsh manifest 规范、插件市场注册、tag→GitHub Release→npm 同步流水线、A 档第三方插件安装脚本、安全门禁。发布原则全文见 [06-release](../06-release/release-principles.md)。

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                              |
| ---- | ---------- | ----- | ------------------------------------- |
| v0.1 | 2026-08-29 | Maintainers | 初稿：脚手架/市场/流水线/安装脚本/门禁/规范 |
| v0.2 | 2026-08-30 | Codex | 对齐 DSH 0.1.1 bundle/client 与 lazy-CJS 契约 |
| v0.3 | 2026-08-30 | Codex | 回填可复现发布、安全门禁与人工市场边界验证 |
| v0.4 | 2026-08-30 | Codex | 补齐 tag 发布工作流的独立全历史扫描与合成泄漏证明 |
| v0.5 | 2026-08-30 | Codex | 补齐双端 profile 安全生成器及隔离配置解析验证 |
| v0.6 | 2026-08-30 | Codex | 要求 tag 来源于 mainline，并让制品构建复用完整 TS/Python CI 门禁 |
| v0.7 | 2026-08-30 | Codex | 增加原子 staging 发布与可加载脚手架/profile 验证 |
| v0.8 | 2026-08-30 | Codex | 记录本地完整发布、安全与 uv 锁定门禁证据 |
| v0.9 | 2026-08-30 | Codex | 固化 A 档 lock v2、安装授权门禁与目标宿主 profile smoke |
| v0.10 | 2026-08-30 | Codex | 将 A 档锁升级为 schema v3，并补齐原生构建、幂等安装与安装后独立核验 |

## 1. 概述与目标

- **解决**：R04——插件能被市场发现、安装、升级；发布过程可信（不出敏感信息、版本可追溯、GitHub 与 npm 同步）。
- **不解决**：自建插件市场站点（用官方 awesome-dsh-plugin 注册表）。
- **需求映射**：R04。
- **平台属性**：仓库级设施。

## 2. 功能清单

| 编号 | 功能 | 优先级 | 里程碑 | 验收口径 |
| --- | --- | --- | --- | --- |
| M12-F001 | 包脚手架与 manifest 规范：生成 `dsh-luban-*` 包骨架（顶层 `engines.dsh`、`dsh.bundle.patch`、可选 `dsh.client` + `exports["./client"]`；cordis.patch.yml 模板），在一个最简 host/client 插件上验证双端可挂载/可热启停 | P0 | MS1 | 最简插件在双端 profile 挂载成功，client bundle 可加载 |
| M12-F002 | 市场注册：向 awesome-dsh-plugin 仓库提 PR（entry），GitHub 仓库打 `dsh-plugin` 等 topic | P1 | MS2 | 市场检索可见并可安装 |
| M12-F003 | 发布流水线：git tag → CI 构建 → GitHub Release（changelog）→ npm publish，同 tag 同内容；版本号全仓统一 | P1 | MS2 | tag 与 npm 版本一一对应 |
| M12-F004 | A 档第三方安装脚本：win(.ps1)/ubuntu(.sh) 安装 `dshmarket@1.36.0`、`dsh-better-sidebar@0.17.1`、`@furongjun1999/dsh-memory@0.4.0` 原版到目标 profile；默认 lock v3 pinned，并精确约束 `node-pty@1.1.0` 原生构建，latest/显式 semver 需二次批准 | P1 | MS2 | 双端脚本一键装齐、重复执行结果一致，且安装后独立核验通过 |
| M12-F005 | 安全门禁：gitleaks pre-commit + CI 扫描；npm `files` 白名单；publish 前 dry-run 检查 | P0 | MS1 | 模拟含密钥提交被拦截 |
| M12-F006 | README 与版本记录规范落地：每包 README 模板、`engines.dsh` 对齐表、CHANGELOG 生成约定 | P1 | MS2 | 新包从模板创建即合规 |

## 3. 流程图

### 3.1 发布流水线（含安全门禁）

```mermaid
flowchart TD
    A["合并到 mainline（CI 绿：lint+test+gitleaks）"] --> B["release 脚本：统一版本号 + engines.dsh 对齐 + CHANGELOG"]
    B --> C["git tag v<semver> 推送"]
    C --> D["release.yml 触发"]
    D --> D1{"tag commit 是 origin/mainline 的祖先？"}
    D1 -- "否 / 无法确认" --> X
    D1 -- 是 --> E{"门禁检查（M12-F005）"}
    E -- "gitleaks 命中 / files 越界" --> X["失败：禁止发布并告警"]
    E -- 通过 --> F["完整 TS/Python CI 门禁 + pack dry-run 审计"]
    F --> G["GitHub Release（附 changelog 与产物）"]
    F --> H["npm publish（files 白名单生效）"]
    G & H --> I["核对：tag ↔ Release ↔ npm 版本一致（M12-F003 口径）"]
    I --> J["市场 PR 更新版本（M12-F002）"]
```

### 3.2 A 档安装脚本

```mermaid
flowchart TD
    U["用户执行 install-3rd-party"] --> L["读取并严格校验 lock v3<br/>固定三项包 + node-pty 构建身份"]
    L --> D{"dry-run?"}
    D -- 是 --> O["输出请求 spec 与执行计划<br/>不访问 registry、不启动子进程"]
    D -- 否 --> H{"目标平台与当前宿主一致?"}
    H -- 否 --> X["fail closed：拒绝跨宿主安装"]
    H -- 是 --> A["要求绝对且非根 DSH_HOME<br/>+ approved-by"]
    A --> P{"pinned?"}
    P -- 否 --> P2["要求 approve-unpinned"]
    P -- 是 --> R["官方 npm registry 复核<br/>name/version/license/repository/integrity"]
    P2 --> R
    R --> E["要求 pnpm 11.24.0<br/>解析精确 name@version"]
    E --> C["仅向子进程注入 DSH_HOME、<br/>registry 与无敏感字段的验收身份"]
    C --> I["add --save-exact<br/>--allow-build=node-pty@1.1.0"]
    I --> I2["以同一参数重复 add"]
    I2 --> V["list 精确版本 + dump-config<br/>+ manifest/LICENSE/native load 独立核验"]
```

## 4. 接口设计（脚本与配置约定，非运行时 API）

```text
scripts/release/publish.mjs [--dry-run] [--packages <glob>]
scripts/install-3rd-party.ps1 [-Profile win-debug] [-Version pinned|latest|<semver>] [-DshHome <absolute>] [-ApprovedBy <actor>] [-ApproveUnpinned] [-DryRun|-Apply]
scripts/install-3rd-party.sh  [--profile ubuntu-server] [--version pinned|latest|<semver>] [--dsh-home <absolute>] [--approved-by <actor>] [--approve-unpinned] [--dry-run|--apply]
node scripts/acceptance/m12-profile-smoke.mjs [--live] [--output <new-json-path>]
```

安装器默认 dry-run；该路径只校验本地 lock 并输出计划，不访问 registry，也不启动 `dsh`。
`--apply`/`-Apply` 仅允许在与目标一致的宿主执行，并要求通过 `--dsh-home`/`-DshHome` 和
`--approved-by`/`-ApprovedBy` 显式提供绝对、非文件系统根目录的 DSH home 与非空批准人。
latest 或显式 semver 还必须提供 `--approve-unpinned`/`-ApproveUnpinned`；registry 复核后安装器
只把解析出的精确版本交给 `dsh plugin add`。apply 固定 pnpm `11.24.0`，以 `--save-exact` 保存
三项直接依赖，并只允许 `node-pty@1.1.0` 执行原生构建脚本；同一安装命令必须连续成功两次。
随后以 `plugin list --depth=0 --json`、`--dump-config` 和在目标 profile 内运行的独立 verifier
核对精确版本、bundle 唯一挂载、MIT manifest、常规 LICENSE 文件及其 SHA-256、精确
`allowBuilds` 与 `node-pty` 可加载性。`DSH_HOME`、官方 npm registry 和不含 integrity/repository
的验收身份只注入子进程，不修改父进程环境；子进程原始输出不进入失败消息。

M12 profile smoke 默认只输出无写入计划。`--live` 根据当前宿主选择 `win-debug` 或
`ubuntu-server`，要求项目本地 DSH `0.1.1-rc.2`，在忽略目录下创建隔离 `DSH_HOME`，离线安装
临时 host/client fixture，验证 config 唯一挂载、lazy-CJS client、热停/热启、进程重启和完整
dispose 序列，最后只清理其明确拥有的临时目录。注入 fake executor 的测试结果只能标记为
`simulated`，不能升级为 live acceptance；只有目标宿主的真实 `--live` pass 才是该平台证据。

包 manifest 基线（全部包必须满足，CI 校验）：

```json
{
  "name": "dsh-luban-<module>",
  "version": "<全仓统一>",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "license": "MIT",
  "repository": "github:yin52133/dsh-luban",
  "engines": { "node": "^22.19.0 || >=24.0.0", "dsh": ">=0.1.1-rc.1" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./client": { "types": "./dist/client/index.d.ts", "default": "./dist/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime"] }
  }
}
```

`dsh.client.inject` 按模块填写真实 Cordis client 服务依赖；React、Cordis、slots 等 Web Shell 基线模块不得重复打包。浏览器产物必须是 `window.__ModuleLoader__.load({ id, factory })` lazy-CJS 格式，实际存在于 `exports["./client"]` 指向的位置。`cordis.patch.yml` 只插入一次 host 包行，client 由 Loader 从同包 manifest 自动发现。

## 5. 数据模型

见 `04-interfaces/data-models.md#release`。要点：`ReleaseRecord`（tag、npmVersion、dshBaseline、artifact 清单、marketPrUrl）。

## 6. 配置设计

- `.github/workflows/release.yml` 触发条件 `tags: ['v*']`；npm token 存 GitHub Secrets（P6.1：token 不落盘不入文档）。
- 第三方版本锁定文件 `scripts/install-3rd-party.versions.json` 使用 schema v3，固定官方 registry，
  并为三项顶层包及 `dsh-better-sidebar` 的原生构建边界 `node-pty@1.1.0` 记录精确 `name`、
  `version`、SHA-512 `integrity`、npm metadata `license` 与 `repository`。pinned apply 必须逐字段
  与官方 registry 当前响应一致，且三项顶层包仍声明 `dsh.bundle.patch`、sidebar 仍精确依赖已审
  范围 `node-pty@^1.1.0`，否则 fail closed。

## 7. 依赖与边界

- 下层：官方 npm registry、GitHub Actions、awesome-dsh-plugin 注册表（市场侧）；A 档三插件
  （只安装，不修改）。npm metadata 的许可声明不替代源码仓库 LICENSE 与安装后 notices 复核。
- 平台属性：仓库级；脚本双平台成对提供。

## 8. 非功能与安全

- 全部红线见 06-release：key/.env 禁提交（P6.1）、files 白名单、gitleaks、泄漏即 rotate。
- 发布原子性：npm publish 失败可重发同版本前必须先 unpublish/deprecate 处理，流水线给出明确指引，避免半发布状态。
- A 档 apply 在任何 registry 请求或 `dsh` 子进程前完成批准人、目标宿主与 DSH_HOME 边界校验；
  dry-run 无网络、无子进程。非 pinned 请求不得沿用 pinned 供应链声明，必须二次批准并记录为
  `registry-resolved`。
- A 档原生构建许可不得退化为包名级 `node-pty: true` 或其他版本规则；安装后 verifier 必须看到
  唯一的 `node-pty@1.1.0: true`，并实际加载其 `spawn` API。安装命令返回成功不等于验收成功。

## 9. checklist 映射

M12-F001 ~ M12-F006 共 6 项，与 `checklist.json` 一一对应。

## 10. 开放问题

- awesome-dsh-plugin PR 的 entry 字段细则与审核周期须在获准执行 M12-F002 时，以届时上游贡献
  说明为准；仓库只生成待人工审核的候选 entry，不自动调用 GitHub 或修改 topic。
- client-ui 槽位按模块从官方 SlotMap 选择并做 profile 实测；脚手架只提供 lazy-CJS 构建、manifest 与生命周期模板，不虚构通用页面槽位。
- A 档三包及 `node-pty@1.1.0` 的 npm metadata/lock v3 已核对；安装器已经具备 LICENSE 哈希、
  重复执行、精确清单、配置挂载和原生模块加载的 fail-closed 验证，但双平台真实安装与 notices
  证据仍须在获得授权的可丢弃 profile 上生成。

## 11. 实现与验证记录

- `scripts/create-plugin.mjs` 默认 dry-run、拒绝路径穿越和覆盖，生成统一版本、`engines.dsh`、
  `dsh.bundle.patch`、可选 `dsh.client`、`./client` export、lazy-CJS 构建与 host/client 生命周期测试；
  生成的 host 入口指向 `dist/index.js`，临时包已完成自身 import/build 和 client 类型验证。
- 市场 entry 工具只输出预览；写文件必须同时提供显式批准与批准人，且仍不创建 PR 或修改 topic。
  本轮未执行任何外部市场、GitHub topic 或发布操作。
- tag 工作流先在只读权限 job 中显式拉取 `origin/mainline`，并以 `git merge-base --is-ancestor`
  fail closed 地拒绝不属于 mainline 历史的 tag；通过后才执行校验、构建并产出带 SHA-256 manifest
  的不可变 tarball。受保护的 release environment 先创建可恢复 draft Release，再发布同一 tarball
  到 npm，成功后才公开 Release。
- Windows/Ubuntu 包装脚本共享 schema v3 A 档锁：`dshmarket@1.36.0`、
  `dsh-better-sidebar@0.17.1`、`@furongjun1999/dsh-memory@0.4.0`，同时固定 SHA-512
  integrity、MIT npm metadata 声明与 repository 身份，并固定 sidebar 的 `node-pty@1.1.0` 构建
  边界。dry-run 无 registry/子进程；apply 在目标宿主要求显式 DSH_HOME 与批准人，逐项复核后
  使用 pnpm 11.24.0、精确依赖和精确 allow-build 连续安装两次，再独立核验清单、配置、manifest、
  LICENSE 哈希与 native load。latest/显式 semver 需额外批准并先解析为精确版本；28 项 M12 定向
  测试覆盖成功链和 fail-closed 边界，本轮未安装外部插件。
- `scripts/deploy/setup-windows.ps1` 与 `setup-ubuntu.sh` 共享 allowlist 生成器，默认仅输出计划，
  显式 apply 才创建 profile；随机同父目录 staging 经 canonical/device/inode 身份校验后原子发布，
  已有目标一律拒绝覆盖，异常身份不递归清理。Windows 隔离 `DSH_HOME` 已实际 apply `win-debug`
  与 `ubuntu-server` profile 并由 DSH `--dump-config` 验证加载，随后清理临时目录。
- `scripts/acceptance/m12-profile-smoke.mjs` 提供 fail-closed 的目标宿主 live runner：生成并构建临时
  host/client 插件，在隔离 profile 中离线安装，验证 host/client 挂载、热启停、重启与清理；其 5 项
  契约测试证明默认 plan 不写入、fake 结果不得冒充 live、缺少项目本地 DSH 时副作用前 blocked，
  以及临时目录所有权和 lazy-CJS 生命周期边界。runner 已就绪不代表双端现场验收已完成。
- gitleaks pre-commit、mainline CI 与 tag 发布工作流均固定扫描器版本；tag job 在生成任何 tarball
  前独立执行全历史扫描与带校验和的合成密钥拒绝证明，并固定 uv `0.11.8` 复跑
  format/lint/typecheck/build/test、uv lock、ruff、13 项 Python 测试、compileall 与发布校验。npm
  `files` 白名单、pack dry-run、tag/版本/CHANGELOG/README/DSH 基线验证均已落地；发布入口在本地和
  未批准 CI 中 fail closed。
- M12 的脚手架、profile 生成、安装、安全、市场、不可变发布及 profile smoke 契约测试通过；
  仍缺 Windows/Ubuntu 两台目标宿主分别产出的 live smoke 证据、A 档真实安装与重复执行、CI tag、
  npm、GitHub Release、市场 PR 与 topic，须在获得明确授权后验收。
- 全工作区 format/lint/typecheck/build、包测试、跨模块集成、12 包 audit、release metadata 与
  pack/publish dry-run 门禁通过；经 SHA-256 校验的临时 Gitleaks 8.30.1 已证明全历史扫描和合成
  token 拒绝链路，扫描器随后清理且未做全局安装；`uv --locked` 的 Ruff、13 项 Python 测试与
  compileall 通过。具体测试数不在设计记录固化，以当前门禁输出为准。
