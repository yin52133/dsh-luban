# dsh-luban-server-mode

Ubuntu-only operations for a persistent DSH build server: a user-level systemd launcher, a
durable bounded build queue, disk/load/timeout guards, error-log injection, and authenticated
artifact downloads. The Cordis id and HTTP prefix are `luban-server-mode` and
`/luban-server-mode`.

## systemd launcher

`lubanServerMode.install({ user, profile: 'ubuntu-server' })` writes
`~/.config/systemd/user/dsh-luban.service`, enables linger for the named account, reloads user
units, and runs `systemctl --user enable --now dsh-luban.service`. Commands are argv-based,
time-bounded, cancellable, and never run through a shell.

The unit runs:

```text
/usr/bin/env dsh web --profile ubuntu-server
```

It sets `LUBAN_BOOT_RESTORE=1`, allowing M03 to reconstruct ledger-owned tmux work. User linger
keeps the user service manager running before an interactive login; `loginctl enable-linger`
must be authorized by local policy. The package intentionally avoids root services.

On Windows and macOS the plugin logs that it is disabled and registers no service or routes.

## Features

- User-level `dsh-luban.service` install/uninstall with linger and boot recovery.
- Durable FIFO build queue with a configurable concurrency ceiling.
- Disk, load, and per-build timeout guards with optional Taskboard alerts.
- Bounded failure excerpts sent directly to the currently open DSH session.
- Retained, symlink-safe artifacts behind M01 authentication and expiring HMAC links.

## Installation

Install M01 and M03 first, then add server mode to the Ubuntu profile:

```sh
dsh plugin --profile ubuntu-server add dsh-luban-auth dsh-luban-keepalive dsh-luban-server-mode
```

The host must provide systemd, `loginctl`, tmux, and each compiler referenced by configured build
templates. Installation never runs automatically; call `lubanServerMode.install()` after reviewing
the generated user-level unit and local linger policy.

## Configuration

### Build queue

Templates are declarative command/argument vectors. `${workspace}` is substituted only into
arguments, working directories, and artifact collection paths—never into the executable. Every
workspace must be under a configured `build.workspaceRoots` entry. The default templates cover
pnpm and CMake builds; customize them for the server toolchain.

```yaml
build:
  maxConcurrent: 1
  defaultTimeoutMin: 30
  workspaceRoots: [~/workspace, ~/projects]
  templates:
    - id: firmware
      title: Firmware (CMake)
      command: cmake
      args: [--build, '${workspace}/build', --target, firmware]
      cwd: '${workspace}'
      collect: [build/firmware.bin, build/firmware.map]
guard: { diskMinGb: 10, loadMax: 8, checkIntervalSec: 15 }
artifacts: { dir: ~/builds, retainRuns: 10, linkTtlSec: 300 }
```

M03 launches an internal worker in a `luban-server-build-*` managed session. The worker enforces
the timeout, captures a bounded log tail, skips symlinks while collecting artifacts, and writes a
durable result. A DSH restart reconnects to that worker/result instead of blindly starting a
duplicate build.

When disk or load crosses its threshold, new starts pause and an optional M02 alert card is
created. Failed builds retain a bounded excerpt. The Settings page can send that excerpt directly
to the currently open DSH session for diagnosis.

## Demo

Log in through M01, obtain the authenticated session's CSRF token, enqueue a configured build,
and watch the SSE feed:

```sh
curl -c cookies.txt -H 'content-type: application/json' \
  -d '{"user":"operator","password":"YOUR_PASSWORD"}' \
  http://127.0.0.1:3081/luban-auth/login

CSRF_TOKEN=$(curl -s -b cookies.txt \
  http://127.0.0.1:3081/luban-auth/session | jq -r '.csrfToken')

curl -X POST http://127.0.0.1:3081/luban-server-mode/jobs \
  -H 'content-type: application/json' -H "x-luban-csrf: ${CSRF_TOKEN}" \
  -b cookies.txt \
  --data '{"templateId":"pnpm-build","params":{"workspace":"/home/dsh/workspace/app"}}'

curl -N http://127.0.0.1:3081/luban-server-mode/events -b cookies.txt
```

The Settings → Server Mode page offers the same queue, resource, error-log, and artifact workflow.

## Compatibility

The published compatibility floor is DSH **0.1.1-rc.1**. The tested baseline is **0.1.1-rc.2** on
Node 22.19+ (or Node 24+). The package uses the current `engines.dsh`, `dsh.bundle.patch`,
`dsh.client`, `exports["./client"]`, and lazy-CJS loader contract. It depends on M01 `lubanAuth`
and M03 `lubanKeepalive`, without alpha-only host session APIs.

## Platform Support

- Ubuntu/Linux with systemd user services: fully supported.
- Headless Ubuntu: supported; no desktop session is required when user linger is enabled.
- Windows/macOS: plugin self-disables without registering its service or HTTP route.

## Authenticated API

All routes require M01 authentication:

- `GET/POST /luban-server-mode/jobs`
- `GET /luban-server-mode/jobs/:id`
- `GET /luban-server-mode/jobs/:id/error-log`
- `GET /luban-server-mode/jobs/:id/artifacts`
- `GET /luban-server-mode/resources`
- `GET /luban-server-mode/templates`
- `GET /luban-server-mode/events`

Artifact lists return short-lived HMAC links. A valid M01 session is still required when a link is
downloaded. Paths are resolved against the exact job directory, and retained runs are pruned only
inside the configured artifact root.

## Publishing

From the repository root:

```sh
pnpm --filter dsh-luban-server-mode typecheck
pnpm exec eslint packages/dsh-luban-server-mode --max-warnings=0
pnpm --filter dsh-luban-server-mode test
pnpm --filter dsh-luban-server-mode build
pnpm --filter dsh-luban-server-mode pack --dry-run
```

Inspect the dry-run file list and built lazy-CJS loader wrapper, then use the repository's approved
provenance-enabled release workflow. Do not publish directly from a developer machine.

## License

MIT. See [LICENSE](./LICENSE) and [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
