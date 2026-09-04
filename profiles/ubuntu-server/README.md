# ubuntu-server profile template

Ubuntu 服务端的 DSH Web profile。官方 `dsh-base`、`dsh-web-app` 由已安装的 DSH 提供，Luban 与第三方插件通过 `dsh plugin` 添加。

## 创建 profile

```sh
scripts/deploy/setup-ubuntu.sh
scripts/deploy/setup-ubuntu.sh --apply
dsh --profile ubuntu-server --dump-config
```

setup 脚本默认仅预览，并拒绝覆盖已有目标。

浏览器统一访问 `http://127.0.0.1:42600/luban-auth/login`；其他局域网设备将
`127.0.0.1` 替换为服务器 IP。DSH 的 `127.0.0.1:3080` 只作为内部上游。
首次打开登录页时在界面中创建管理员，无需设置密码环境变量。

## 安装固定版本第三方插件

```sh
bash scripts/install-3rd-party.sh --profile ubuntu-server --dry-run
bash scripts/install-3rd-party.sh --profile ubuntu-server \
  --dsh-home /tmp/dsh-profile --approved-by operator-name --apply
```

apply 仅在 Linux 目标机运行，并要求绝对、非根目录的 DSH home。安装完成后核对 `plugin list`、`--dump-config` 和 bundle 加载。

## systemd

先由管理员为运行账号启用 linger，再使用项目的 systemd operator 安装或更新 user service。日常验证优先重启服务：

```sh
systemctl --user restart dsh-luban.service
systemctl --user is-enabled dsh-luban.service
systemctl --user is-active dsh-luban.service
```

仅当明确验收开机恢复时才需要重启整机。部署路径、账号、凭据、IP 和具体网段不得写入模板。
