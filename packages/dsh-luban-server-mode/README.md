# dsh-luban-server-mode

Ubuntu-only operations for a persistent DSH build server: a user-level systemd launcher, a
durable bounded build queue, disk/load/timeout guards, error-log injection, and authenticated
artifact downloads. The Cordis id and HTTP prefix are `luban-server-mode` and
`/luban-server-mode`.

## systemd launcher

`lubanServerMode.install({ user, profile: 'ubuntu-server' })` first verifies that linger is already
enabled and resolves `service.dshExecutable` to one executable, absolute, regular-file path. It also
captures the current Node executable and a bounded, absolute-only service `PATH`. It then writes
`~/.config/systemd/user/dsh-luban.service`, reloads user units, and runs
`systemctl --user enable --now dsh-luban.service`. Commands are argv-based, time-bounded,
cancellable, and never run through a shell.

Preflight and every mutation boundary read one strict, machine-oriented `systemctl show` snapshot.
The installer rejects same-name units loaded from another search path, drop-ins, stale manager
configuration, transient enablement, and ambiguous runtime states. Installation succeeds only when
the managed fragment is current and the service is permanently enabled, `active/running`,
`Type=exec`, and has `MainPID > 0`. A failed activation restores the exact prior enabled/running
semantics; a newly created unit is removed only after rollback is verified. Uninstall likewise
proves `disabled`, stopped, and `MainPID=0` before unlinking the owned unit, then reloads and proves
the manager no longer has that unit.

The unit runs:

```text
ExecStart="/absolute/path/to/dsh" "--profile" "ubuntu-server" "--no-open"
```

The unit carries the validated `PATH` explicitly, with the canonical directory of the current Node
executable first. The `dsh` and Node file identities are rechecked before and after activation, so
boot never inherits the systemd user manager's ambient `PATH` (including for npm-style shell shims).
It sets the exact `LUBAN_BOOT_RESTORE=1` sentinel, forcing M03 to reconstruct ledger-owned tmux work
even when the profile config sets `bootRestore: false`. Only the literal string `1` activates this
deployment override; other truthy-looking environment values do not. User linger keeps the user
service manager running before an interactive login. The installer never changes linger;
`loginctl enable-linger` is a separate operator/admin action that must be explicitly authorized by
local policy. The package intentionally avoids root services.

On Windows and macOS the plugin logs that it is disabled and registers no service or routes.

## Features

- User-level `dsh-luban.service` install/uninstall with preverified linger and boot recovery.
- Durable FIFO build queue with a configurable concurrency ceiling.
- Disk, load, and per-build timeout guards with fail-closed probe deadlines and optional
  Taskboard alerts.
- Bounded failure excerpts sent directly to the currently open DSH session.
- SSE reconnect sends a fresh baseline when a browser cursor predates or is ahead
  of the current process sequence, including after service restart.
- Retained, symlink-safe artifacts behind M01 authentication and expiring HMAC links.

## Installation

Install M01 and M03 first, then add server mode to the Ubuntu profile:

```sh
dsh plugin --profile ubuntu-server add dsh-luban-auth dsh-luban-keepalive dsh-luban-server-mode
```

The host must provide systemd, `loginctl`, tmux, and each compiler referenced by configured build
templates. Installation never runs automatically. First inspect linger without mutation:

```sh
loginctl show-user "$USER" --property=Linger --value
luban-server-mode preflight
```

If the first command reports `no`, an authorized operator must separately approve and run
`loginctl enable-linger "$USER"` (or the site-specific equivalent). Neither preflight nor install
runs that command. After local policy approval and a successful preflight, review the generated
user-level unit, then apply and inspect the verified runtime state:

```sh
luban-server-mode install --apply
luban-server-mode status
```

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
durable result. On timeout or cancellation, the process runner sends TERM, waits for process close
and pipe drain, escalates to KILL after one second, and applies a final one-second close bound while
removing its timers and listeners. A DSH restart reconnects to that worker/result instead of
blindly starting a duplicate build.

Resource probes have a five-second scheduler-side deadline. A rejected or timed-out probe fails
closed: new starts remain queued, the resource report is marked paused, and an optional M02 alert
card is created. The same pause applies when disk or load crosses its threshold. Failed builds
retain a bounded excerpt. The Settings page can send that excerpt directly to the currently open
DSH session for diagnosis.

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

- Ubuntu/Linux systemd user-service implementation is available; target-host
  installation, linger, status, and reboot recovery still require live evidence.
- Headless Ubuntu is the intended deployment; no desktop session is required
  once user linger has been explicitly enabled and verified.
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
