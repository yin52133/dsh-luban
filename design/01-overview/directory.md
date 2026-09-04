# 仓库目录设计（Monorepo）

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                                      |
| ---- | ---------- | ----- | --------------------------------------------- |
| v0.1 | 2026-08-29 | Maintainers | 初稿：pnpm monorepo 结构与包命名规范          |
| v0.2 | 2026-08-30 | Codex | 对齐 DSH 0.1.1 bundle/client manifest 契约    |
| v0.3 | 2026-08-30 | Codex | 校正 A 档三方包身份并记录受控安装入口          |
| v0.4 | 2026-08-30 | Codex | 移除安全扫描目标并保留发布质量门禁              |
| v0.5 | 2026-09-01 | Codex | 12 包切换为 GitHub Packages scoped 发布         |
| v0.6 | 2026-09-02 | Codex | 台账归入 design，并增加完整套件聚合包           |
| v0.7 | 2026-09-02 | Codex | 13 个公共包迁移到 npm registry                  |

## 1. 总览

```text
dsh-luban/
├── README.md                    # 项目门面（遵循 06-release README 规范）
├── README.en.md                 # 英文项目门面
├── CHANGELOG.md                 # 版本变更记录与 Release notes 来源
├── LICENSE                      # MIT
├── package.json                 # 工作区命令、版本和开发依赖
├── pnpm-workspace.yaml          # pnpm 工作区与构建许可
├── pnpm-lock.yaml               # 可复现依赖锁
├── .gitignore                   # 本机配置、构建输出与临时文件忽略规则
├── .github/
│   └── workflows/
│       ├── ci.yml               # lint + typecheck + build + test
│       └── release.yml          # tag → npm registry → GitHub Release
├── design/                      # 设计文档（本目录，唯一设计权威来源）
│   ├── README.md
│   ├── TEMPLATE.md
│   ├── checklist.json           # 功能进度台账（与设计文档 F 编号双向一致）
│   ├── 01-overview/             # vision / architecture / directory / trace-matrix
│   ├── 02-principles/           # principles
│   ├── 03-modules/              # M01-M12 各模块详细设计
│   ├── 04-interfaces/           # api-overview / data-models
│   ├── 05-deployment/           # deploy-windows / deploy-ubuntu
│   ├── 06-release/              # release-principles
│   └── 07-references/           # reference-analysis
├── scripts/
│   ├── validate-design.mjs      # 设计一致性校验（F 编号三处一致等）
│   ├── install-3rd-party.ps1    # A 档：Windows 受控安装 dshmarket / dsh-better-sidebar / @furongjun1999/dsh-memory
│   ├── install-3rd-party.sh     # A 档：Ubuntu 同上
│   ├── deploy/                  # 双端 profile 生成与部署脚本
│   └── release/                 # 版本对齐、tag、npm registry 发布辅助
├── packages/
│   ├── dsh-luban/               # @yin52133/dsh-luban：完整套件聚合安装入口
│   ├── core/                    # @yin52133/dsh-luban-core：L1 HAL + L2 服务 + 契约定义
│   ├── dsh-luban-auth/          # M01
│   ├── dsh-luban-taskboard/     # M02
│   ├── dsh-luban-keepalive/     # M03
│   ├── dsh-luban-plan/          # M04
│   ├── dsh-luban-session-share/ # M05
│   ├── dsh-luban-image-paste/   # M06
│   ├── dsh-luban-hud/           # M07
│   ├── dsh-luban-context/       # M08
│   ├── dsh-luban-server-mode/   # M09（ubuntu 专属，engine 包内做平台守卫）
│   ├── dsh-luban-win-debug/     # M10（win 专属）
│   └── dsh-luban-browser/       # M11
└── profiles/
    ├── win-debug/               # Windows profile 模板（package.json + cordis.patch.yml）
    └── ubuntu-server/           # Ubuntu profile 模板
```

## 2. 插件包内部结构（统一约定）

```text
packages/dsh-luban-<name>/
├── package.json          # 顶层 engines.dsh + dsh.bundle；有 UI 时含 dsh.client/./client export
├── cordis.patch.yml      # bundle patch：insert 本插件（config 放 config: 段）
├── src/
│   ├── index.ts          # cordis 插件入口（L3：装配 L2 服务）
│   ├── server/           # 服务端逻辑（路由、SSE、任务处理）
│   └── client/           # L4：web 组件（client-ui 槽位注入）
├── README.md             # 每包必有（06-release 模板）
└── tests/                # vitest；L2 逻辑可脱离 dsh 单测
```

## 3. 命名与依赖规范

| 项 | 规范 |
| --- | --- |
| 完整套件包 | `@yin52133/dsh-luban`；精确依赖并聚合挂载全部单包及审核过的配套插件 |
| 插件包名 | `@yin52133/dsh-luban-<module>`；源码目录仍为 `packages/dsh-luban-<module>` |
| 内部核心包 | `@yin52133/dsh-luban-core`（随套件公开发布到 npm registry，供其他包解析依赖） |
| cordis 插件 id | `luban-<module>`（patch 中的 `id:`） |
| HTTP 路由前缀 | `/luban-<module>/...`（如 `/luban-auth/login`） |
| 版本 | 全仓库统一版本号（fixed locking），见 06-release |
| 依赖方向 | 聚合包 → 各独立插件；独立插件 → `@yin52133/dsh-luban-core` → 仅外部依赖。独立插件之间禁止直接依赖，跨插件协作只走 `04-interfaces` 契约与事件总线 |
| 平台专属依赖 | 用 `optionalDependencies` + 运行时平台守卫（如 serialport 仅 win 使用路径加载） |

## 4. 设计阶段与本目录的对应关系

当前仓库处于**设计阶段**：本目录与 `design/` 已建；`packages/`、`profiles/`、`.github/` 随 MS1 开发落地，落地的文件必须与本文档结构一致；结构变更需先改本文档并追加版本记录。
