# 发布原则与安全红线（Release Principles & Security Red Lines）

> 本章是发布行为的强制规范（P0 一票否决）。M12 是其流程化落地；任何与发布相关的 CI/脚本/文档都不得与本章冲突。

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                                        |
| ---- | ---------- | ----- | ----------------------------------------------- |
| v0.1 | 2026-08-29 | Maintainers | 初稿：README 规范/版本与 tag/npm 注册/敏感红线/应急 |
| v0.2 | 2026-08-30 | Codex | 要求 tag 发布 job 在制品生成前独立复验密钥门禁 |
| v0.3 | 2026-08-30 | Codex | 明确包可按公开 API 需求提高 DSH 最低版本       |

## 1. README 规范

**仓库级 README**（根目录）必须包含：一句话定位（中英）、双模式拓扑图、文档导航表、快速开始（设计阶段=读设计；实现阶段=安装命令）、许可证与第三方许可声明。

**每个 npm 包 README** 模板（M12-F006 脚手架生成）：

```markdown
# dsh-luban-<module>
<一句话：这个插件给你的 dsh 增加了什么>

![badge: version] ![badge: dsh 兼容] ![badge: license]

## 功能亮点（3-5 条）
## 安装
  dsh plugin --profile <profile> add dsh-luban-<module>
## 配置（cordis.patch.yml config: 段示例，含全部配置项与默认值）
## 截图 / 演示
## 兼容性（dsh 版本矩阵：engines.dsh 基线 + 实测版本表）
## 平台支持（双端公用 / win / ubuntu）
## License 与致谢（THIRD-PARTY-NOTICES 引用）
```

硬性要求：配置示例必须可直接复制使用；不写未实现的功能（与 checklist.json 状态一致）。

## 2. 版本与 tag 规范

| 项 | 规范 |
| --- | --- |
| 版本号 | SemVer；**全仓库统一版本**（fixed locking），任一包变更即统一升版 |
| 版本对齐 | 仓库 DSH 最低下限为 `>=0.1.1-rc.1`；包可按所用公开 API 提高 `engines.dsh` 下限，但不得低于仓库下限或高于当前实测版本；dsh 升级 → 兼容矩阵实测 |
| 分支 | `mainline` 为发布分支；功能分支合并必须 CI 绿 |
| tag | `v<semver>`（如 `v0.2.0`），一个 tag 一次发布；tag 后 CI 自动走流水线 |
| CHANGELOG | 按里程碑/模块分组；由发布脚本从 commit（`feat/fix/docs(<模块>):`）生成草稿，人工修订 |
| GitHub ↔ npm 同步 | 同一 tag 触发：GitHub Release（changelog+产物）与 npm publish 同内容；发布后核对三者一致（M12-F003 口径） |

## 3. npm 包注册规范

- 包名 `dsh-luban-<module>`（无 scope）；首次 publish 前在 npmjs.com 确认名称可用并占用。
- `package.json` 必填：`license: MIT`、`repository`、`engines`（node + dsh）、`dsh` 字段（M12 §4 基线）。
- **`files` 白名单发布**：只发布 `dist/`、`README.md`、`cordis.patch.yml`、`LICENSE`、`THIRD-PARTY-NOTICES.md`；绝不发布源码外的任何本地配置、数据、测试夹具。
- 发布前强制 `npm publish --dry-run` 审计输出清单；CI 中固化为门禁步骤。
- npm access public；provenance（`--provenance`）开启以绑定仓库与构建。

## 4. GitHub 仓库规范（dsh-plugin 生态可见性）

- topics：`dsh-plugin`、`dsh`、`deepseek-harness`、`workbench`、`embedded`——插件商店与社区目录按 `topic:dsh-plugin` 收录（M12-F002）。
- 市场注册：向 awesome-dsh-plugin 提 PR（entry：npm 包名/仓库/分类/描述），随版本更新 PR。
- Release notes 中标注「兼容 dsh 版本」与「破坏性变更」；建议附 30 秒演示 GIF。
- Discussion/Issue 模板：bug 报告必须含 dsh 版本与 profile bundles 列表（脱敏）。

## 5. 敏感信息红线（P0，一票否决）

**任何提交（代码/文档/issue/截图/commit message）不得出现**：

- API key、token、密码、口令哈希、`credentials.yaml` 内容；
- `.env` 及其变体内容（占位示例只允许 `.env.example`，且值必须为假数据）；
- 内网 IP/主机名的真实拓扑细节（文档用 `<win-lan-host>` 类占位）；
- 会话日志原文（含密钥的报错输出等）。

落地机制（M12-F005）：

| 层 | 机制 |
| --- | --- |
| 提交前 | pre-commit 跑 gitleaks（`scripts/release/install-hooks.mjs` 一键安装） |
| 服务端 | CI 每次跑 gitleaks 全历史扫描；命中即红 |
| 发布 | tag job 独立复跑全历史 gitleaks + 合成泄漏证明；随后执行 `files` 白名单与 `npm publish --dry-run` 清单审计 |
| 本地 | `.gitignore` 基线：`.env`/`.env.*`（保留 `!.env.example`）、`.dsh/`、`*.credentials.*`、`~密钥类文件` |
| 文档 | 设计文档中一律占位符；示例配置值必须为假数据 |

## 6. 泄漏应急（发现已提交敏感信息时）

1. **立即 rotate**（吊销/更换 key、改密码）——先止血，再清理。
2. 从历史中移除（filter-repo）+ force push，通知所有克隆方重新克隆。
3. 在 07-references/事故记录追加一条（时间、类型、处置），不写敏感内容本身。
4. 复盘：补充红线规则或门禁，更新本章版本记录。

> 原则：**rotation 优先于历史清理**；历史不可信时一律按已泄漏处理。

## 7. 发布前检查清单（每版本勾选）

- [ ] CI 全绿（lint/typecheck/test/gitleaks）
- [ ] 版本号统一更新 + CHANGELOG 修订
- [ ] `engines.dsh` 基线与兼容矩阵核对
- [ ] 每包 README 与 checklist.json 状态一致（不宣传未实现功能）
- [ ] `npm publish --dry-run` 清单审计通过（files 白名单）
- [ ] tag 推送 → GitHub Release 与 npm 同步完成 → 三处版本核对
- [ ] 市场 PR 更新（新包/版本变化时）
