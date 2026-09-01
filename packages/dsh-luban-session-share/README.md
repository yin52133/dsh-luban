# @yin52133/dsh-luban-session-share

Account-isolated Windows/Ubuntu views of the same user's DSH sessions, with
confirmed exclusive control transfer and reconnectable output.
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
- Sessions are scoped by the M01 `accountId`: another account cannot list,
  subscribe to, take over, or inject input into them. Explicit cross-account
  sharing is not currently supported.

## Installation

Install authentication and keepalive first, then add this plugin to the same DSH
profile on each host:

```sh
dsh plugin --profile web add @yin52133/dsh-luban-auth @yin52133/dsh-luban-keepalive @yin52133/dsh-luban-session-share
```

Keep the DSH WebServer on loopback and access `/luban-session-share` through the
`@yin52133/dsh-luban-auth` sidecar.

## Configuration

```yaml
- insert:
    - id: luban-session-share
      name: @yin52133/dsh-luban-session-share
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
current M01 login Cookie. The account must be the same on both hosts. A
different account does not receive an observation view.

`ownerUser` is a compatibility default for existing single-account profiles.
New session ownership comes from the M01 account/session registry.

Session IDs must be globally unique across configured hosts. A cross-origin
collision is reported as `session-id-collision`; the existing registry entry is
preserved and no control operation is routed through the conflicting peer.

## Demo

Sign in at `/luban-auth/login` on both hosts. Open **Session Share** on Windows
to observe an Ubuntu session, choose **Request control**, then confirm the
pending request from the Ubuntu view. The Windows side becomes the sole input
holder until release.
Opening the output stream again with its last SSE id replays missed fragments or
returns a baseline if the bounded history has rolled over.

Direct API calls reuse the current M01 login session and its request token.

## Compatibility

Tested with DeepSeek Harness `0.1.1-rc.2`, Cordis 4.0.1, and Node.js 22.19 or
newer. The bridge uses the rc2 `AgentRegistry`, `agent/status`, `session/event`,
and `Agent.followup` surfaces; it does not require unreleased
session-controller APIs.

## Platform Support

The same package runs on Windows and Ubuntu. Validate discovery, reconnect, and
control transfer on the actual two-host profile. Tests use an in-memory peer
network and never open a real LAN connection.

## License

MIT. See `THIRD-PARTY-NOTICES.md` for peer-runtime notices.
