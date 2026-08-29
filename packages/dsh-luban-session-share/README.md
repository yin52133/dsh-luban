# dsh-luban-session-share

Authenticated Windows/Ubuntu views of the same DSH session estate, with
owner-approved exclusive control transfer and reconnectable, redacted output.
Sessions continue running on their original host; this plugin shares the view
and input authority, not the process.

## Features

- One registry combines local top-level rc2 Agent sessions with health and task
  metadata mirrored from configured peers. The canonical `AgentRegistry.roots()`
  ownership boundary excludes every non-root agent from views and input.
- A takeover records the requester's consent, then requires the session owner to
  approve the same session version before an exclusive compare-and-swap lock is
  granted. Concurrent requests are rejected and unanswered requests expire.
- Per-session SSE carries redacted output/status fragments, supports bounded
  `Last-Event-ID` replay, and returns a current baseline when history has a gap.
- `owner`, `operator`, and `observer` permissions are derived from the M01
  identity plus session ownership. Observers cannot inject input.
- Peer M01 Cookie/CSRF credentials are read only from environment variables;
  their values are never accepted in Cordis config, logs, or API responses.

## Installation

Install authentication and keepalive first, then add this plugin to the same DSH
profile on each host:

```sh
dsh plugin --profile web add dsh-luban-auth dsh-luban-keepalive dsh-luban-session-share
```

Keep the DSH WebServer on loopback and access `/luban-session-share` through the
`dsh-luban-auth` sidecar.

## Configuration

```yaml
- insert:
    - id: luban-session-share
      name: dsh-luban-session-share
      config:
        host: auto
        ownerUser: owner
        takeoverTimeoutSec: 120
        peerRefreshSec: 10
        requestTimeoutSec: 10
        replayLimit: 256
        peers:
          - name: win-debug
            baseUrl: http://win-debug.lan:42600
            credentialEnv: LUBAN_SESSION_SHARE_WIN_COOKIE
```

Set `LUBAN_SESSION_SHARE_WIN_COOKIE` in the host service environment to the
complete M01 Cookie header containing both `luban_session` and `luban_csrf`.
Never place its value in YAML, shell arguments, source control, or logs. Use an
M01 account with only the permissions this peer needs and rotate it normally.
The peer cookie user must have the same M01 username as the local actor who
requests a cross-host mutation. Before takeover, input, or release, the plugin
checks `/luban-auth/session` with that same cookie and fails closed on any
identity mismatch. A different local user may still see an observation view,
but any remote mutation fails closed with `403`.

`ownerUser` must name the local M01 account that owns newly observed local DSH
sessions. An M01 `observer` account remains an observer even if a stale role
binding says otherwise.

Session IDs must be globally unique across configured hosts. A cross-origin
collision is reported as `session-id-collision`; the existing registry entry is
preserved and no control operation is routed through the conflicting peer.

## Demo

Sign in at `/luban-auth/login` on both hosts. Open **Session Share** on Windows
to observe an Ubuntu session, choose **Request control**, then approve the
pending request from the owner's Ubuntu view. The requester becomes the sole
operator and can send a follow-up; the owner becomes an observer until release.
Opening the output stream again with its last SSE id replays missed fragments or
returns a baseline if the bounded history has rolled over.

For direct mutation API calls, first read `/luban-auth/session` and pass its
value as `x-luban-csrf`; browser requests also carry the M01 session cookies.

## Compatibility

Tested with DeepSeek Harness `0.1.1-rc.2`, Cordis 4.0.1, and Node.js 22.19 or
newer. The bridge uses the rc2 `AgentRegistry`, `agent/status`, `session/event`,
and `Agent.followup` surfaces; it does not require unreleased
session-controller APIs.

## Platform Support

The same package runs on Windows and Ubuntu. Peer URLs may use HTTP only on a
trusted private LAN behind the M01 boundary; use HTTPS through a reverse proxy
when traffic crosses an untrusted network. Tests use an in-memory peer network
and never open a real LAN connection.

## License

MIT. See `THIRD-PARTY-NOTICES.md` for peer-runtime notices.
