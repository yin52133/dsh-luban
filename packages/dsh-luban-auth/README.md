# dsh-luban-auth

`dsh-luban-auth` is the only LAN-facing entry point for a DSH Web deployment.
It authenticates the request and then streams HTTP, SSE, and WebSocket traffic
to a loopback-only DSH WebServer (by default `http://127.0.0.1:3080`).

## Features

- Local Argon2id accounts, role-aware sessions, global revocation, failure
  lockout, per-IP login limiting, and a 30-day redacted JSONL audit trail.
- One fail-closed LAN sidecar protecting DSH HTTP, SSE, WebSocket, static, and
  SPA fallback traffic; the upstream is required to be loopback-only.
- `HttpOnly`/`SameSite=Lax` cookies, per-session CSRF, Origin/Host/CIDR checks,
  request-size bounds, proxy-aware secure cookies, and constant-shape login
  failures.
- Standard Schema configuration and effect-owned startup/shutdown for Cordis.

## Installation

Add the package to the Web profile before every business plugin:

```sh
dsh plugin --profile web add dsh-luban-auth
```

Bind the built-in DSH WebServer to loopback (the default example upstream is
`127.0.0.1:3080`) and expose only the auth sidecar port to the LAN.

## Configuration

```yaml
- insert:
    - id: luban-auth
      name: dsh-luban-auth
      config:
        host: 0.0.0.0
        port: 42600
        upstream: http://127.0.0.1:3080
        sessionTtlHours: 72
        maxFailures: 5
        lockoutMinutes: 15
        usersFile: ~/.dsh/luban/auth/users.json
        auditDirectory: ~/.dsh/luban/logs/auth
```

### First start

Set `LUBAN_ADMIN_PASSWORD` to a password of at least eight characters for the
first start. The plugin creates the initial `admin` account with an Argon2id
hash and never writes or logs the plaintext value. Remove the environment
variable after the account has been created.

Account and audit files are created with owner-only modes. On Windows, also
verify that the containing directory ACL grants access only to the DSH service
account.

Open `http://<host>:42600/luban-auth/login`. The default LAN listener uses
plain HTTP and must not be exposed to the public internet. Put it behind a TLS
reverse proxy and enable `trustProxy` for public or otherwise untrusted
networks.

When using a host name or address that is not one of the machine's local
addresses, add it to `trustedHosts`. Keep DSH's upstream listener bound to
loopback; the plugin rejects non-loopback upstream URLs.

## Security endpoints

- `GET|POST /luban-auth/login`
- `GET /luban-auth/session`
- `POST /luban-auth/logout`
- `POST /luban-auth/revoke-all` (admin only)

The session cookie is `HttpOnly` and `SameSite=Lax`. Mutation requests require
a same-origin `Origin`, or the per-session CSRF token in `x-luban-csrf` for
non-browser clients.

## Demo

Visit `http://<host>:42600/luban-auth/login`, sign in, then request a business
route such as `/luban-taskboard/tasks`. An anonymous JSON/API request receives
401, browser navigation redirects to the login page, and the authenticated
request is streamed to the loopback DSH server. Logging out invalidates that
session immediately.

## Compatibility

Tested with DeepSeek Harness `0.1.1-rc.2`, Cordis 4.0.1, and Node.js 22.19+.
DSH rc2 does not expose global WebServer middleware, so this package is an
outer sidecar by design rather than a route-local authentication plugin.

## Platform Support

The same implementation is tested on Windows and Ubuntu. File modes are
enforced where supported; Windows deployments must additionally verify the
service-account ACL. `trustProxy` is only for an explicitly configured TLS
reverse proxy.

## License

MIT. See `THIRD-PARTY-NOTICES.md` for runtime dependency notices.
