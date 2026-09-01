# dsh-luban

[简体中文](README.md) | [English](README.en.md)

[![CI](https://github.com/yin52133/dsh-luban/actions/workflows/ci.yml/badge.svg?branch=mainline)](https://github.com/yin52133/dsh-luban/actions/workflows/ci.yml)
[![GitHub Stars](https://img.shields.io/github/stars/yin52133/dsh-luban?style=flat-square)](https://github.com/yin52133/dsh-luban/stargazers)
[![GitHub Release](https://img.shields.io/github/v/release/yin52133/dsh-luban?display_name=tag&style=flat-square)](https://github.com/yin52133/dsh-luban/releases)
[![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-%40yin52133-24292f?style=flat-square&logo=github)](https://github.com/yin52133/dsh-luban/pkgs/npm/dsh-luban-auth)
[![License](https://img.shields.io/github/license/yin52133/dsh-luban?style=flat-square)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin suite for
embedded development. It connects a Windows debug workstation and an Ubuntu build server into a
browser-accessible DSH workbench with persistent jobs and account-separated contexts.

## Why dsh-luban

- **Two-host workflow**: use Windows for serial, ADB, flashing, and GDB; use Ubuntu for builds and long-running jobs.
- **One entry point**: sign in at `/luban-auth/login`; tasks, sessions, attachments, and contexts are separated by account.
- **Closed task loop**: a six-column board supports human edits, agent claims, progress reports, and human review.
- **Persistent work**: tmux, Windows Task Scheduler, and systemd keep sessions alive and recover them after restart.
- **Visible context**: the HUD reports context pressure, model, reasoning level, RPM/TPM, and replayable compaction.
- **Embedded toolchain**: one surface integrates serial, ADB/Fastboot, OpenOCD, GDB, SSH, Telnet, and TCP serial.
- **Modular installation**: every capability is an independent `@yin52133/dsh-luban-*` package.

The project targets a trusted LAN. Its simple account system separates a small number of users'
working contexts; it is not an enterprise identity or network-hardening product.

## Deployment profiles

| Host                      | Primary role                                                                     | Recommended plugins                                   |
| ------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Windows debug workstation | Serial, ADB/Fastboot, flashing, GDB, desktop and browser automation              | auth, taskboard, keepalive, HUD, win-debug, browser   |
| Ubuntu build server       | Web entry point, persistent sessions, build queue, artifacts, browser automation | auth, taskboard, keepalive, HUD, server-mode, browser |

Both hosts can add plan, context, image-paste, and session-share to work with tasks and session views
under the same account.

## Interface

![Signed-in Luban Taskboard with linked Plan and HUD status](docs/screenshots/taskboard.png)

This image is rendered directly from the production Taskboard component with non-sensitive demo
data. It shows the six-column workflow, host/workspace filters, acceptance criteria, human review
after agent completion, a linked Plan, and context/rate status in the HUD.

| Signed-in feature                 | Workflow                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| Taskboard                         | Create → agent claim → progress → Review → Done, with drag and keyboard/touch controls        |
| Plan                              | Draft → approve/reject → revise; linked plans open directly from task cards                   |
| HUD / Context                     | Inspect model, reasoning level, context pressure, RPM/TPM, and replayable archives            |
| Image Paste                       | Paste or upload → account-scoped storage and preview → inject into the active DSH session     |
| Session Share / Keepalive         | Observe sessions across hosts, explicitly hand off control, and recover managed work          |
| Win Debug / Server Mode / Browser | Feed Windows debugging, Ubuntu build artifacts, and browser tasks back into the same workflow |

<details>
<summary>Sign-in entry point (secondary screen)</summary>

![Luban sign-in screen](docs/screenshots/login.png)

</details>

All Web features enter through `/luban-auth/login`. The taskboard, HUD, Plan, and image tools reuse
the same account session after sign-in. Anonymous API requests return 401, and
`/luban/auth/login` is intentionally not an alias.

## Packages

| GitHub Packages package             | Capability                                                              | Platform            |
| ----------------------------------- | ----------------------------------------------------------------------- | ------------------- |
| `@yin52133/dsh-luban-auth`          | Local login, authentication sidecar, and account context separation     | Windows / Ubuntu    |
| `@yin52133/dsh-luban-taskboard`     | Six-column board, agent claims, night jobs, and `taskctl`               | Windows / Ubuntu    |
| `@yin52133/dsh-luban-keepalive`     | tmux/Task Scheduler persistence, heartbeat, recovery, and checkpoints   | Windows / Ubuntu    |
| `@yin52133/dsh-luban-plan`          | Draft, approve, reject, and revise plans                                | Windows / Ubuntu    |
| `@yin52133/dsh-luban-session-share` | Cross-host session views, reconnect, and explicit control handoff       | Windows / Ubuntu    |
| `@yin52133/dsh-luban-image-paste`   | Paste and store images, preview them, and reference them from a session | Windows / Ubuntu    |
| `@yin52133/dsh-luban-hud`           | Web/CLI status bar with context and rate metrics                        | Windows / Ubuntu    |
| `@yin52133/dsh-luban-context`       | Context compaction, virtual-file archive, search, and replay            | Windows / Ubuntu    |
| `@yin52133/dsh-luban-server-mode`   | systemd service, build queue, resource checks, and artifacts            | Ubuntu              |
| `@yin52133/dsh-luban-win-debug`     | Serial, flashing, GDB, ADB, remote channels, and desktop MCP            | Windows             |
| `@yin52133/dsh-luban-browser`       | browser-use bridge, task templates, and taskboard automation            | Windows / Ubuntu    |
| `@yin52133/dsh-luban-core`          | Shared contracts, routes, errors, and storage utilities                 | Internal dependency |

## Quick start

### Install plugins

You need Node.js 22.19+, pnpm 11, and DeepSeek Harness 0.1.1-rc.2. GitHub Packages requires
client authentication. Create a classic PAT with only `read:packages`, then enter your GitHub
username and PAT in this interactive command (never commit the PAT):

```sh
npm login --scope=@yin52133 --auth-type=legacy --registry=https://npm.pkg.github.com
```

Install the authentication plugin first, then add only the capabilities needed by the profile:

```sh
dsh plugin --profile web add @yin52133/dsh-luban-auth
dsh plugin --profile web add @yin52133/dsh-luban-taskboard @yin52133/dsh-luban-hud @yin52133/dsh-luban-plan
```

Publishing from CI needs no npmjs account or token: the Release workflow publishes all 12 packages
with the repository's `GITHUB_TOKEN`. For a token-free client path, download the validated `.tgz`
files from the GitHub Release and install them locally.

After starting the profile, enter through the authentication sidecar:

```text
http://<host>:42600/luban-auth/login
```

Plugin routes consistently use `/luban-<module>`, including `/luban-taskboard`, `/luban-plan`,
and `/luban-browser`. See the [Windows deployment guide](design/05-deployment/deploy-windows.md)
and [Ubuntu deployment guide](design/05-deployment/deploy-ubuntu.md) for installation and service setup.

### Develop the repository

The Python browser bridge runs only from its locked `uv` environment; no global pip environment is used.

```sh
corepack enable
pnpm install
pnpm check
uv run --project tools/browser-bridge --locked python -m unittest discover -s tools/browser-bridge/tests
```

## Network access

On Ubuntu, expose the authentication sidecar only to the actual LAN client range. The CIDR below is
a placeholder; replace it with the range supplied by the router or network administrator, and never
commit private deployment details:

```sh
LAN_CIDR=<lan-client-cidr>
sudo ufw allow proto tcp from "$LAN_CIDR" to any port 42600
```

The firewall rule limits which devices can connect to the port. DSH access still requires a login at
`/luban-auth/login`.

## Architecture

```mermaid
flowchart LR
    Browser[Browser / CLI] --> Auth[@yin52133/dsh-luban-auth]
    Auth --> DSH[DeepSeek Harness]
    DSH --> Shared[Tasks / Plan / HUD / Context / Sessions]
    DSH --> Windows[Windows debug tools]
    DSH --> Ubuntu[Ubuntu builds and persistence]
    Shared --> Store[(Account-scoped local data)]
```

Plugins do not depend on each other directly. Shared types and utilities live in `@yin52133/dsh-luban-core`,
while runtime cooperation uses DSH services, events, and HTTP contracts. See [design](design/README.md)
for design notes and [checklist.json](checklist.json) for current implementation status.

## Project status

The first public release, [v0.1.0](https://github.com/yin52133/dsh-luban/releases/tag/v0.1.0), is live.
All 12 scoped packages were published to GitHub Packages, and the Release includes the matching
tarballs and SHA-256 manifest. The code passed Windows/Ubuntu host acceptance and CI; items that
still require an external model or real hardware remain marked honestly in `checklist.json`.

## License

[MIT](LICENSE). Third-party dependency and reference-project licensing is documented in
[reference analysis](design/07-references/reference-analysis.md) and each package's
`THIRD-PARTY-NOTICES.md`.
