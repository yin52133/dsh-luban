# dsh-luban

[简体中文](README.md) | [English](README.en.md)

[![npm package](https://img.shields.io/badge/npm%20package-0.1.3-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/@yin52133/dsh-luban)
[![pnpm](https://img.shields.io/badge/pnpm-11.24.0-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.1.2--rc.1-536DFE)](https://github.com/deepseek-ai/deepseek-harness)

dsh-luban is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin suite for
embedded development. It connects a Windows debug workstation and an Ubuntu build server to one
browser workbench for device debugging, background builds, task tracking, and session recovery.

The project is intended for individuals and small teams on a trusted local network. Its built-in
accounts separate users' tasks, sessions, and attachments; they are not a replacement for enterprise
identity management or public-network security.

## Features

- **Cross-host workflow**: use Windows for serial devices, Android Debug Bridge (ADB), flashing, and GNU Debugger (GDB); use Ubuntu for builds and long-running jobs.
- **Task management**: create, claim, execute, and review work on a taskboard, with linked execution plans.
- **Persistent work**: keep sessions and jobs running with tmux, Windows Task Scheduler, and systemd, and recover them after restart.
- **Context management**: inspect the model, reasoning level, context usage, and request rates; search and replay compacted records.
- **Images and shared sessions**: upload or paste images into a session, view sessions across hosts, and explicitly hand off control.
- **Embedded toolchain**: work with serial devices, ADB/Fastboot, OpenOCD, GDB, SSH, Telnet, and TCP serial connections.
- **Flexible installation**: install the complete suite or only the plugins needed on each host.

## Interface

![Luban taskboard with an execution plan and status panel](docs/screenshots/taskboard.png)

After signing in, users can track task states, filter by host and workspace, define acceptance
criteria, review agent results, open linked plans, and inspect context usage and request rates.

All Web features use Luban's port `42600` as their single entry point:

```text
Local: http://127.0.0.1:42600/luban-auth/login
LAN:   http://<host-ip>:42600/luban-auth/login
```

DSH at `127.0.0.1:3080` is an internal Luban upstream. Do not browse to it directly or expose it
to the LAN.

## Plugins and platforms

| Package                             | Purpose                                                                     | Platform         |
| ----------------------------------- | --------------------------------------------------------------------------- | ---------------- |
| `@yin52133/dsh-luban`               | Install the complete suite                                                  | Windows / Ubuntu |
| `@yin52133/dsh-luban-auth`          | Sign-in and account-scoped data                                             | Windows / Ubuntu |
| `@yin52133/dsh-luban-taskboard`     | Taskboard, agent claims, and progress updates                               | Windows / Ubuntu |
| `@yin52133/dsh-luban-keepalive`     | Session persistence, heartbeats, checkpoints, and restart recovery          | Windows / Ubuntu |
| `@yin52133/dsh-luban-plan`          | Create, approve, reject, and revise execution plans                         | Windows / Ubuntu |
| `@yin52133/dsh-luban-session-share` | Cross-host session views, reconnect, and control handoff                    | Windows / Ubuntu |
| `@yin52133/dsh-luban-image-paste`   | Image upload, preview, and session references                               | Windows / Ubuntu |
| `@yin52133/dsh-luban-hud`           | Model, context, and request-rate status panel                               | Windows / Ubuntu |
| `@yin52133/dsh-luban-context`       | Context compaction, archive, search, and replay                             | Windows / Ubuntu |
| `@yin52133/dsh-luban-server-mode`   | systemd service, build queue, resource checks, and artifacts                | Ubuntu           |
| `@yin52133/dsh-luban-win-debug`     | Serial, flashing, GDB, ADB, remote connections, and Windows desktop control | Windows          |
| `@yin52133/dsh-luban-browser`       | Browser automation, task templates, and taskboard execution                 | Windows / Ubuntu |

## Installation

### Requirements

- Node.js 22.19.x or version 24 and later
- pnpm 11.24.0
- DeepSeek Harness 0.1.2-rc.1

Packages are public on the npm registry. Installation does not require a GitHub account, personal
access token, or npm login. If this machine previously mapped `@yin52133` to GitHub Packages, remove
that legacy mapping first:

```sh
npm config delete @yin52133:registry
npm config get registry
```

The second command should print `https://registry.npmjs.org/`.

Install the complete suite:

```sh
dsh plugin --profile web add @yin52133/dsh-luban@0.1.3 --allow-build=node-pty@1.1.0 --allow-build=@serialport/bindings-cpp@13.0.0
```

The two `--allow-build` flags permit installation scripts only for the suite's pinned terminal and
serial native bindings. You may omit `@serialport/bindings-cpp` when serial support is not needed.
Run the same command again if an earlier installation skipped these builds.

The complete suite also installs these companion plugins at fixed versions:

- [`dshmarket@1.36.0`](https://github.com/dsh-market/dsh-market)
- [`dsh-better-sidebar@0.17.1`](https://github.com/omdsh-dev/DSH-better-sidebar)
- [`@furongjun1999/dsh-memory@0.4.0`](https://github.com/FuRongJun-1999/dsh-memory)

Alternatively, install only the plugins you need:

```sh
dsh plugin --profile web add @yin52133/dsh-luban-auth
dsh plugin --profile web add @yin52133/dsh-luban-taskboard @yin52133/dsh-luban-hud @yin52133/dsh-luban-plan
```

Do not install the complete suite together with duplicate standalone packages, because that loads
the same plugin twice. For detailed setup, see the
[Windows deployment guide](design/05-deployment/deploy-windows.md) and
[Ubuntu deployment guide](design/05-deployment/deploy-ubuntu.md).

After the first start, open `http://127.0.0.1:42600/luban-auth/login`, create the administrator in
the setup page, and continue in the signed-in session. No password environment variable is required.
Startup does not read password environment variables or create accounts. Invalid input is marked next to the field; the username is retained and passwords must be entered again.

## Network and security

Expose the sign-in service only to the local network range that needs access. Replace
`<lan-client-cidr>` below with the local network range provided by your router or network
administrator:

```sh
LAN_CIDR=<lan-client-cidr>
sudo ufw allow proto tcp from "$LAN_CIDR" to any port 42600
```

The firewall limits which devices can connect, while the dsh-luban sign-in page controls user
access. Do not expose the service directly to the public internet.

## Development

The repository uses pnpm for JavaScript dependencies. The Python browser bridge uses a locked `uv`
environment:

```sh
corepack enable
pnpm install
pnpm check
uv run --project tools/browser-bridge --locked python -m unittest discover -s tools/browser-bridge/tests
```

See [architecture and module design](design/README.md) for more information.

## License

[MIT](LICENSE). Third-party license information is available in each package's
`THIRD-PARTY-NOTICES.md`.
