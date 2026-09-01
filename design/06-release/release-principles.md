# 发布原则与操作流程

## 版本记录

| 版本 | 日期 | 作者 | 变更说明 |
| --- | --- | --- | --- |
| v1.0 | 2026-09-01 | Codex | 收敛到标准 GitHub Release 与 npm 发布流程 |

## 1. 发布目标

`mainline` 是发布分支。全仓包使用统一 SemVer；一个 `v<semver>` tag 对应一个 GitHub Release 和一组同版本 npm 包。插件市场注册不属于当前目标。

## 2. README 与包规范

根 README 使用中英双语，展示项目定位、功能亮点、界面、快速开始、兼容性、文档导航和许可证。

每个 npm 包 README 至少包含功能、安装、配置、平台支持、演示/截图和许可证。文档不得宣传 `checklist.json` 中尚未完成或已废弃的功能。

包 manifest 必须声明：

- `license`、`repository`、Node 与 `engines.dsh`；
- 精确的 `exports`、`files` 与 `dsh` bundle/client 信息；
- 宿主提供的 DSH、Cordis 和 React 依赖为 peer/external。

## 3. 版本与 tag

| 项目 | 规则 |
| --- | --- |
| 版本 | 全仓 fixed versioning，任一发布包变更统一升版 |
| 分支 | `mainline`，发布前 CI 必须通过 |
| tag | `v<semver>`，tag 版本必须与 package.json、CHANGELOG 一致 |
| 制品 | 12 个 tarball 与 manifest，`dsh-luban-core` 排在最前 |
| npm | public access；同版本存在时跳过，不覆盖 |
| Release | 附 changelog、manifest 和全部 tarball |

## 4. 标准流程

1. 运行 format、lint、typecheck、build、tests 和设计校验。
2. 运行 release metadata 校验与 12 包 audit。
3. 生成 tarball 与 manifest，并执行 publish dry-run。
4. 确认仓库无凭据或私人部署信息。
5. 推送 `mainline` 与 `v<semver>` tag。
6. GitHub Actions 按 core-first 顺序发布 npm，再创建 GitHub Release。
7. 核对 tag、Release、npm 包名和版本。

```bash
node scripts/release/validate-release.mjs
node scripts/release/pack-artifacts.mjs --prepare --tag v0.1.0 --output .release-artifacts/v0.1.0
node scripts/release/publish.mjs --dry-run --artifacts .release-artifacts/v0.1.0
```

## 5. 发布失败

npm 多包发布不是事务。任何包失败时立即停止：

- 用 `npm view` 确认当前版本是否存在；
- 不存在则修复后重新运行；
- 已存在且版本正确时由脚本跳过；
- 不执行 unpublish，不覆盖版本，不隐藏原始错误；
- 完成后重新核对 GitHub Release 与 npm。

项目不维护自定义恢复账本或额外证明系统。

## 6. 发布前检查清单

- [ ] format、lint、typecheck、build、unit/integration tests 全部通过
- [ ] uv lock、Ruff、Python tests 与 compileall 通过
- [ ] design/checklist/architecture 校验通过
- [ ] 版本、CHANGELOG、README 与 `engines.dsh` 一致
- [ ] 12 包 files、pack、manifest 与 publish dry-run 通过
- [ ] 当前树和待公开历史中无凭据、token 或私人部署信息
- [ ] npm 发布凭据与 GitHub Actions 发布变量已配置
- [ ] tag、GitHub Release 与 npm 发布结果一致
