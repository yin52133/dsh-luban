# win-debug profile template

Windows 调试主机的 DSH Web profile。官方 `dsh-base`、`dsh-web-app` 由已安装的 DSH 提供，Luban 与第三方插件通过 `dsh plugin` 添加。

## 创建 profile

```powershell
.\scripts\deploy\setup-windows.ps1
.\scripts\deploy\setup-windows.ps1 -Apply
dsh --profile win-debug --dump-config
```

setup 脚本默认仅预览，并拒绝覆盖已有目标。

## 安装固定版本第三方插件

```powershell
.\scripts\install-3rd-party.ps1 -Profile win-debug -DryRun
.\scripts\install-3rd-party.ps1 -Profile win-debug `
  -DshHome C:\dsh-profile -ApprovedBy operator-name -Apply
```

apply 仅在 Windows 目标机运行，并要求绝对、非根目录的 DSH home。安装完成后核对 `plugin list`、`--dump-config` 和 bundle 加载。

## 验证

```powershell
pnpm build
pnpm test
dsh --profile win-debug --dump-config
```

机器路径、账号、凭据和网络拓扑不得写入模板。
