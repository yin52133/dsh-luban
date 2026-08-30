# dsh-luban-auth

`dsh-luban-auth` provides simple local-account login for a DSH Web deployment.
It authenticates HTTP, SSE, and WebSocket traffic and supplies the account
identity used to isolate Luban data and DSH session context.

## Features

- Local accounts, expiring login sessions, logout, and global session revocation.
- One login sidecar covering DSH HTTP, SSE, WebSocket, static, and SPA fallback traffic.
- Stable account identity propagation for tasks, plans, attachments, sessions,
  context history, build jobs, and browser jobs.
- Standard Schema configuration and effect-owned startup/shutdown for Cordis.

## Installation

Add the package to the Web profile before every business plugin:

```sh
dsh plugin --profile web add dsh-luban-auth
```

Bind the built-in DSH WebServer to loopback (the default example upstream is
`127.0.0.1:3080`) and expose only the auth sidecar port to the LAN.
Startup fails closed unless that WebServer reports `127.0.0.1` and its actual
listening port matches the configured upstream port.

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
        usersFile: ~/.dsh/luban/auth/users.json
```

### First start

Set `LUBAN_ADMIN_PASSWORD` to a password of at least eight characters for the
first start. The plugin creates the initial `admin` account with an Argon2id
hash and never writes or logs the plaintext value. Remove the environment
variable after the account has been created.

Open `http://<host>:42600/luban-auth/login`. This is the only supported login
route; `/luban/auth/login` is not an alias. Use an HTTPS reverse proxy when the
deployment needs TLS termination.

## Account endpoints

- `GET|POST /luban-auth/login`
- `GET /luban-auth/session`
- `POST /luban-auth/logout`
- `POST /luban-auth/revoke-all` (admin only)

Non-browser clients reuse the current authenticated session and its request
token when calling mutation endpoints.

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

The same implementation is shared by Windows and Ubuntu. Run login, logout,
session-expiry, and alice/bob account-isolation tests on both platforms.

## License

MIT. See `THIRD-PARTY-NOTICES.md` for runtime dependency notices.
