# @yin52133/dsh-luban-auth

`@yin52133/dsh-luban-auth` provides simple local-account login for a DSH Web deployment.
It authenticates HTTP, SSE, and WebSocket traffic and supplies the account
identity used to isolate Luban data and DSH session context.

This package targets a trusted LAN and separates a small number of users'
contexts. It is not an enterprise authorization system and does not claim to
protect the service from hostile clients on the same network.

## Features

- Local accounts, expiring login sessions, logout, and global session revocation.
- One login sidecar covering DSH HTTP, SSE, WebSocket, static, and SPA fallback traffic.
- Stable account identity propagation for tasks, plans, attachments, sessions,
  context history, build jobs, and browser jobs.
- Standard Schema configuration and effect-owned startup/shutdown for Cordis.

## Installation

Add the package to the Web profile before every business plugin:

```sh
dsh plugin --profile web add @yin52133/dsh-luban-auth
```

Bind the built-in DSH WebServer to loopback (the default internal upstream is
`127.0.0.1:3080`) and expose only the auth sidecar port to the LAN. Local and
LAN browsers both use port `42600`; port `3080` is not a user entry point.
Startup fails closed unless that WebServer reports `127.0.0.1` and its actual
listening port matches the configured upstream port.

## Configuration

```yaml
- insert:
    - id: luban-auth
      name: @yin52133/dsh-luban-auth
      config:
        host: 0.0.0.0
        port: 42600
        upstream: http://127.0.0.1:3080
        sessionTtlHours: 72
        usersFile: ~/.dsh/luban/auth/users.json
```

### LAN firewall

Expose the sidecar only to the client address range of the actual LAN. The
following CIDR matches one example network; it is not a universal default:

```sh
# Example only: replace this value with the actual LAN client CIDR.
LAN_CIDR=<lan-client-cidr>
sudo ufw allow proto tcp from "$LAN_CIDR" to any port 42600
```

Use the CIDR reported by the router or network administrator, and do not commit
the acceptance environment's real subnet. The UFW
rule controls network reachability only; clients must still sign in at
`/luban-auth/login`. Avoid an unrestricted `ufw allow 42600/tcp` rule unless
the service is intentionally meant to accept every routable source.

### First start

Open `http://127.0.0.1:42600/luban-auth/login` on the DSH host, or use the
host's LAN address from a trusted local network. When no account exists, the
page asks for the first administrator username, password, and confirmation.
It creates the account atomically, stores only a salted scrypt hash, and signs
the administrator in. Concurrent setup requests cannot replace the first
administrator.

No environment variable is required for interactive setup. An unattended
deployment may optionally set `LUBAN_ADMIN_PASSWORD` for one start to create
the configured bootstrap administrator, then remove the variable.

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

Tested with DeepSeek Harness `0.1.2-rc.1`, Cordis 4.0.2, and Node.js 22.19+.
DSH `0.1.2-rc.1` does not expose global WebServer middleware, so this package is an
outer sidecar by design rather than a route-local authentication plugin.
Its native session API uses HTTP RPC plus SSE; DSH `0.1.2-rc.1` registers no production
WebSocket session route. Generic WebSocket upgrades still require a valid login.

## Platform Support

The same implementation is shared by Windows and Ubuntu. Run login, logout,
session-expiry, and alice/bob account-isolation tests on both platforms.

## License

MIT. See `THIRD-PARTY-NOTICES.md` for runtime dependency notices.
