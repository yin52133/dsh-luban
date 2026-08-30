# dsh-luban-image-paste

Authenticated image paste, drop, clipboard capture, workspace storage, and DSH
session injection for Windows and Ubuntu.

## Features

- Focusable Web drop zone for Ctrl+V image paste and file drag-and-drop.
- Settings-slot registration and paste/drop source routing are covered by client
  contract tests; multi-file input skips invalid or oversized entries.
- `luban-img` CLI capture with fixed PowerShell, `wl-paste`, or `xclip` commands;
  commands use argument arrays, `shell: false`, a timeout, and bounded output.
- PNG, JPEG, and WebP magic-byte validation with a default 10 MiB upload limit.
- Atomic `YYYYMMDD-<slug>-<n>.<ext>` publication under a canonicalized workspace
  attachment directory, with runtime directory-identity and SHA-256 checks.
- Optional dynamic `sharp` resize. With `compression: true`, a missing peer,
  decode failure, or unverifiable size bound fails closed before persistence.
- Real DSH rc2 `AgentRegistry` injection in Markdown or absolute-path form,
  limited to live, top-level sessions in the configured workspace.
- Opt-in mounted live acceptance that renders an unpredictable code as PNG
  pixels, injects it through the production repository/service path, and binds
  the readback to one exact DSH message, turn, session, provider, and model.
- Authenticated recent-image previews, reference-safe manual deletion, and TTL
  cleanup that always retains attachments referenced by a session. Recent
  responses are server-bounded by `recentLimit`.

## Installation

Install the authentication boundary and this plugin in the same DSH profile:

```sh
dsh plugin --profile web add dsh-luban-auth dsh-luban-image-paste
```

Install the optional resize capability when `compression` is enabled:

```sh
pnpm add sharp
```

Keep the internal DSH WebServer on loopback and access the profile through the
`dsh-luban-auth` sidecar. The authenticated route is `/luban-image-paste`.

## Configuration

```yaml
- insert:
    - id: luban-image-paste
      name: dsh-luban-image-paste
      config:
        workspaceRoot: .
        attachDir: .luban/attachments
        maxBytes: 10485760
        maxSidePx: 2000
        compression: true
        compressionQuality: 82
        retainDays: 14
        recentLimit: 50
        cleanupIntervalMinutes: 60
        injectStyle: markdown
        clipboardTimeoutMs: 10000
```

`attachDir` must be a child of `workspaceRoot`; absolute paths, `..`, `.`, and
symlink escapes are rejected. Runtime operations stop if the canonical directory
is replaced. Cleanup only removes indexed files inside this directory; startup
also removes stale, unindexed plugin-generated crash artifacts after a grace
period. Referenced files are retained regardless of age.

Treat `attachDir` as plugin-owned storage and do not place manually named files
inside it; orphan recovery recognizes the plugin's dated filename scheme.

The current recent strip renders original image payloads rather than generated
thumbnails. `recentLimit` bounds the list on the server; lower it for workspaces
with many images near `maxBytes` to bound browser transfer and memory use.

Set `compression: false` only when dimension enforcement is not required. With
compression enabled, `sharp` is required so the service can decode and verify
`maxSidePx` before storing an image.

The CLI reads credentials from environment variables so secrets never appear in
the process argument list. CLI and Web API requests have a 10-second deadline
covering both headers and response bodies. CLI JSON is capped at 64 KiB, Web JSON
at 1 MiB, and remote error bodies are never copied to the terminal:

```powershell
$env:LUBAN_SESSION_COOKIE = 'luban_session=...'
$env:LUBAN_CSRF_TOKEN = '...'
luban-img capture --session '<dsh-session-id>' --style markdown
```

On Ubuntu, install `wl-clipboard` for Wayland or `xclip` for X11. The CLI does
not invoke a shell and does not probe any other program.

## Demo

Sign in at `/luban-auth/login`, open **Settings → Images**, enter an optional DSH
session id, focus the drop zone, and press Ctrl+V. The recent-image card shows
the stored relative path, preview, resize status, and reference count. A
referenced card cannot be deleted; **Clean expired** removes only unreferenced
attachments older than `retainDays`.

For CLI capture, copy an image, export `LUBAN_SESSION_COOKIE` and
`LUBAN_CSRF_TOKEN` from the authenticated session, then run `luban-img capture`.
The CLI sends `x-luban-csrf` on both upload and injection writes.

## Live visual acceptance

Live M06-F003 evidence must run inside the mounted plugin so it can use the
Host-owned `AgentRegistry`, LLM registry, and existing top-level session:

```typescript
const evidence = await ctx.lubanImageVisualAcceptance.run({
  live: true,
  sessionId: '<idle top-level rc2 session>',
})
```

The runner requires a clean Git worktree, Windows or Ubuntu, an empty idle
inbox, and an actual response route whose model metadata declares image input.
The nonce exists only in PNG pixels and model-authored output; evidence stores
hashes, never the nonce or provider credential. It waits for the exact queued
message's turn and removes only its owned fixture after that turn settles. A
timeout or uncertain queue state retains the fixture and fails closed.

`luban-img-visual-acceptance` defaults to a plan and cannot call a provider
unless `--live` is explicit. Live mode calls the authenticated endpoint on the
already-mounted production plugin; it requires `LUBAN_SESSION_COOKIE`,
`LUBAN_CSRF_TOKEN`, and `--session <idle-top-level-session>`. Each run creates a
new evidence file and refuses to overwrite an existing path. The authenticated
endpoint is restricted to a literal IPv4 or IPv6 loopback host so operator
credentials are never forwarded to a remote `--base-url`. A live evidence path
is confined to the repository's ignored `.luban/acceptance` directory; existing
symlink/junction parents and existing files are rejected. The CLI rechecks the
same clean HEAD after writing and invalidates the new evidence if that check
fails:

```console
luban-img-visual-acceptance
luban-img-visual-acceptance --live --session <session-id>
```

Production acceptance also requires the loaded module to be a hash-matching
artifact from this repository's clean current-HEAD build. Provenance v3 embeds
both the Git HEAD and a random per-build ID into the loaded module, so an old
Host process is rejected even after a same-HEAD rebuild replaces `dist` on
disk. Source execution, external installations, dirty/stale builds, and
injected transports always remain blocked or `simulated` and cannot satisfy
live acceptance.

## Compatibility

Tested with DeepSeek Harness `0.1.1-rc.2`, Cordis 4.0.1, React 18, and Node.js
`^22.19.0` or `>=24.0.0`. The DSH peer baseline is `>=0.1.1-rc.2`; injection uses
the rc2 `AgentRegistry.get` and identified user-message APIs. Dormant sessions,
subagent-owned sessions, and sessions from another workspace are rejected; this
plugin does not reconstruct the host-owned model/tool composition for cold resume.

## Platform Support

The host service and Web UI are shared across Windows and Ubuntu. CLI clipboard
capture uses `powershell.exe` with STA mode on Windows, `wl-paste` on Wayland,
and `xclip` on X11. macOS and other platforms fail with
`E_PLATFORM_UNSUPPORTED` instead of running an unspecified command.

## License

MIT. See `THIRD-PARTY-NOTICES.md` for peer/runtime notices.
