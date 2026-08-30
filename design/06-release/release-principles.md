# 发布原则与操作流程（Release Principles & Operations）

> 本章定义版本、打包、发布、对账与失败恢复流程。M12 是其流程化落地；验收关注发布结果一致、
> 可预览、可恢复且不会误发。

## 版本记录

| 版本 | 日期       | 作者  | 变更说明                                        |
| ---- | ---------- | ----- | ----------------------------------------------- |
| v0.1 | 2026-08-29 | Maintainers | 初稿：README、版本、tag/npm 注册与失败处理规范 |
| v0.2 | 2026-08-30 | Codex | 增加 tag 发布前的独立预检 |
| v0.3 | 2026-08-30 | Codex | 明确包可按公开 API 需求提高 DSH 最低版本       |
| v0.4 | 2026-08-30 | Codex | 增加多包发布恢复账本与三方结果核验 |
| v0.5 | 2026-08-30 | Codex | 细化顺序事件记录、本地恢复位置与逐包状态 |
| v0.6 | 2026-08-30 | Codex | 收敛发布门禁并保留 pack 复核、幂等发布与失败对账恢复 |

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

多包 npm publish 不是事务。发布脚本按 core-first 顺序处理包，并在每个包发布前后写本地顺序账本；
同一已确认步骤重复执行不得再次发布。命令结果不明确时先停止后续包并查询 registry：版本不存在时可
从该包重试，版本与本地 `npm pack` 产物校验和一致时可记为已发布，版本存在但内容不一致或状态未知时
停止并交给人工处理。不得使用 unpublish、覆盖或盲目重复发布来消除不确定状态。

恢复从账本中首个未确认包继续。发布完成后核对 tag、GitHub Release、pack 文件名和版本、npm 版本与
tarball 内容一致；失败记录、当前包和已确认包列表保留到下一次恢复。该对账只确认发布结果，不绑定
额外的执行平台标识或来源证明。

## 3. npm 包注册规范

- 包名 `dsh-luban-<module>`（无 scope）；首次 publish 前在 npmjs.com 确认名称可用并占用。
- `package.json` 必填：`license: MIT`、`repository`、`engines`（node + dsh）、`dsh` 字段（M12 §4 基线）。
- **pack 文件清单**：`package.json#files` 只包含 `dist/`、`README.md`、`cordis.patch.yml`、
  `LICENSE`、`THIRD-PARTY-NOTICES.md`；本地配置、运行数据和测试夹具不进入发布包。
- 发布前运行 `npm pack --dry-run` 和 `npm publish --dry-run`，人工复核包名、版本、目标 registry、
  文件清单与体积后再批准真实发布。
- npm access 为 public；是否由本地或 CI 执行不改变上述功能验收口径。

## 4. GitHub 仓库规范（dsh-plugin 生态可见性）

- topics：`dsh-plugin`、`dsh`、`deepseek-harness`、`workbench`、`embedded`——插件商店与社区目录按 `topic:dsh-plugin` 收录（M12-F002）。
- 市场注册：向 awesome-dsh-plugin 提 PR（entry：npm 包名/仓库/分类/描述），随版本更新 PR。
- Release notes 中标注「兼容 dsh 版本」与「破坏性变更」；建议附 30 秒演示 GIF。
- Discussion/Issue 模板：bug 报告包含 dsh 版本与 profile bundles 列表。

## 5. 发布内容复核

- 配置示例使用占位值，确保用户复制后知道哪些字段需要填写。
- 发布计划在真实 tag/npm/市场操作前展示包名、统一版本、目标 registry、Release 资产和市场变更，
  由用户明确批准后执行。
- `npm pack --dry-run` 与 `npm publish --dry-run` 的文件清单是防止误发的主要检查；发现多余文件时
  修改 `package.json#files` 后重新运行。
- lint、typecheck、test、build、pack 与 dry-run 是本项目的发布质量门禁；不再增加与功能结果无关的
  证明步骤作为 feature 状态或发布 blocker。

## 6. 发布失败与恢复

1. 发布命令失败或超时时立即停止后续包，保存 stdout/stderr 摘要和本地发布账本。
2. 查询 npm registry 与 GitHub Release 的实际状态，不以子进程退出码之外的猜测推进状态。
3. registry 不存在该版本时从当前包重试；版本和 pack 内容一致时补记确认；不一致或未知时人工处理。
4. 恢复完成后再次核对全仓统一版本、tag、GitHub Release、npm 包和市场记录。

## 7. 发布前检查清单（每版本勾选）

- [ ] lint、typecheck、test、build 全部通过
- [ ] 版本号统一更新 + CHANGELOG 修订
- [ ] `engines.dsh` 基线与兼容矩阵核对
- [ ] 每包 README 与 checklist.json 状态一致（不宣传未实现功能）
- [ ] `npm pack --dry-run` 与 `npm publish --dry-run` 文件清单复核通过
- [ ] 真实发布计划已列出包名、版本、目标和外部变更，并获用户明确批准
- [ ] tag 推送 → GitHub Release 与 npm 同步完成 → 三处版本核对
- [ ] 市场 PR 更新（新包/版本变化时）
