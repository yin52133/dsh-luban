# dsh-luban-hud

An authenticated, always-visible DSH telemetry HUD backed by concurrent, pluggable providers. It shows context capacity, workspace, model/reasoning effort, and token/request rates designed for later billing reconciliation in the Web shell and CLI.

## Features

- **M07-F001** — concurrent `TelemetryProvider` sampling with field-level first-provider priority, per-provider timeout, immutable snapshots, and partial-failure diagnostics.
- **M07-F002** — official rc2 `SessionProjectionRegistry.contextPressure` first; only a missing or unloaded projection service/key falls back to `assistant/message.usage`, `request/context.contextWindow`, and content estimation. An incomplete official projection stays unknown.
- **M07-F003** — workspace-relative display plus live model and reasoning-effort values from public rc2 `Session`/`AgentRegistry` interfaces. Selection prefers the current initiator, then a running agent, then the newest registered agent.
- **M07-F004** — monotonic 1-minute and 5-minute sliding TPM/RPM windows. Cached input/output fields are disjoint and included; reasoning tokens are not double-counted inside output.
- **M07-F005** — compact/full Web status bar in the official rc2 `shell.overlay` slot and a one-line `luban-hud` CLI rendered from the same snapshot response.
- **M07-F006** — normal/warn/danger/critical states at 70%/85%/95%; critical renders a compaction advisory and, when M02 is present, creates one deduplicated active Taskboard alert while M08 independently requests a fresh `lubanTelemetry.snapshotFor(sessionId)` without a runtime dependency cycle.
- **M03-F004 integration** — consumes `luban.keepalive.health` without importing M03, exposes bounded/redacted current failures in REST/SSE, and renders `keepalive N down` in both the Web bar and CLI.

One-hour history is an in-memory, time-bounded ring. Telemetry contains metadata only and never session text. Browser SSE is closed while the page is hidden.

## Installation

Install after the rc2 agent/Web runtime and `dsh-luban-auth`, then apply the bundled patch:

```sh
dsh plugin --profile default add dsh-luban-hud
```

The host provides `lubanTelemetry`; M08 can inject that Core contract and request one exact live session without replacing or publishing the cached HUD snapshot. If `lubanTaskStore` appears before or after HUD startup, Cordis dynamically connects the critical-alert sink; the dependency remains optional. No production dependency is added beyond `@luban/core`.

For development, run package-scoped gates from the repository root:

```sh
pnpm --filter dsh-luban-hud typecheck
pnpm exec eslint packages/dsh-luban-hud --max-warnings=0
pnpm --filter dsh-luban-hud test
pnpm --filter dsh-luban-hud build
pnpm --filter dsh-luban-hud pack --dry-run
```

## Configuration

All options and defaults are shown below:

```yaml
- insert:
    - id: luban-hud
      name: dsh-luban-hud
      config:
        refreshSec: 1
        thresholds: { warn: 0.70, danger: 0.85, critical: 0.95 }
        display:
          fields: [context, workspace, model, thinking, tpm, rpm]
          compact: false
        history: { enabled: true, retainMinutes: 60 }
```

Thresholds must be ordered `warn < danger < critical`. Five-minute TPM/RPM values are normalized per minute over a fixed five-minute denominator, so a single 100-token request contributes `20 TPM` and `0.2 RPM` to that window.
`refreshSec` is bounded to 1–60 seconds and history retention to 1–1440 minutes so configuration cannot exceed the registered one-second event cadence or create an unbounded retention window.

Every HTTP endpoint is authenticated through `lubanAuth` at `/luban-hud/snapshot`, `/luban-hud/history`, and `/luban-hud/events`.
The event stream uses the registered `luban.telemetry.snapshot` name and bounded `Last-Event-ID` replay; a replay gap receives the latest immutable envelope.
`HudSnapshotResponse.keepalive` is an optional compatibility extension. Health changes immediately
publish a new envelope through the same SSE event; M03 diagnostic text is stripped of controls,
redacted, capped, and never persisted by HUD. At most 256 current failures are retained in memory.
The initial Web snapshot and CLI request use a 10-second deadline. Route and SSE
lifecycle checks fail closed if plugin disposal races with authentication or sampling.

Critical Taskboard cards use the fixed `hud:context-critical` tag and contain only the numeric
context ratio. Calls are serialized so concurrent samples cannot create duplicates; an active card
is reused, and a continuous critical episode is reported once until telemetry recovers.

## Demo

The Web client displays a persistent pill in DSH's frame-wide overlay. Click it to toggle compact and full modes. Unknown fields use `?`; one failed provider marks the result `partial` without hiding healthy data. A keepalive failure remains visible in both compact and full modes and its tooltip contains only the sanitized M03 diagnosis.

Render the identical snapshot as the CLI's first line:

```sh
set LUBAN_SESSION_COOKIE=luban_session=REDACTED
luban-hud
```

On POSIX shells, use `export` instead of `set`. `LUBAN_URL` defaults to the authentication sidecar at `http://127.0.0.1:42600`. Credentials are accepted only through the environment, never command-line arguments. Use `luban-hud --json` for the full envelope and source/failure diagnostics.

## Compatibility

| Component                     | Published floor        | Tested baseline         |
| ----------------------------- | ---------------------- | ----------------------- |
| Node.js                       | `^22.19.0 or >=24.0.0` | Node 22.19+             |
| DSH host/session/client peers | `>=0.1.1-rc.1`         | `0.1.1-rc.2`            |
| Cordis                        | `^4.0.1`               | DSH rc2 bundled version |

The implementation uses the public rc2 `AgentRegistry`, `Session.requestContext()`, `Session.requestHeader()`, `Session.events`, `session/event`, and `shell.overlay` contracts. It performs no model or provider-network calls.

## Platform Support

- Windows 10/11 and PowerShell: workspace paths display with portable `/` separators; CLI uses the auth sidecar.
- Ubuntu/Linux: the same host, Web, and CLI implementation is used.
- Web: current DSH rc2 browser client; subscriptions pause when `document.hidden`.

Window math and token-source projection are directly tested. Comparison with a
real provider billing/token ledger remains the explicit M07-F004 blocker.

## License

MIT. See [LICENSE](./LICENSE) and [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md). DSH peer packages are interoperated with and are not bundled.
