# win-debug profile template

Windows 调试主机的 DSH Web profile。官方 `dsh-base`、`dsh-web-app` 由已安装的 DSH 提供，Luban 与第三方插件通过 `dsh plugin` 添加。

## 创建 profile

```powershell
.\scripts\deploy\setup-windows.ps1
.\scripts\deploy\setup-windows.ps1 -Apply
dsh --profile win-debug --dump-config
```

setup 脚本默认仅预览，并拒绝覆盖已有目标。

浏览器统一访问 `http://127.0.0.1:42600/luban-auth/login`；其他局域网设备将
`127.0.0.1` 替换为这台 Windows 机器的 IP。DSH 的 `127.0.0.1:3080` 只作为内部上游。
首次打开登录页时在界面中创建管理员，无需设置密码环境变量。

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
