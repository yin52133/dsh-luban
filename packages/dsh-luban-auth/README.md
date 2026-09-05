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
following placeholder must be replaced before running the command:

```sh
# Example only: replace this value with the actual LAN client CIDR.
LUBAN_LAN_CIDR='<lan-client-cidr>'
sudo ufw allow proto tcp from "$LUBAN_LAN_CIDR" to any port 42600
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

Create the initial administrator through the setup page. Startup does not read
password environment variables or create accounts. The form marks invalid fields,
keeps the username, and asks for passwords again before retrying.

Usernames accept 1–64 Unicode letters, numbers, combining marks, spaces, dots,
hyphens, and underscores. Leading/trailing spaces and letter case are ignored;
path separators, control characters, and reserved system names are rejected.

### Forgotten administrator password (Ubuntu)

Use the server terminal or an authenticated SSH session. Recovery requires
`sudo`/root authorization and an interactive terminal; neither a web login nor
a loopback IP grants recovery privileges. There is no HTTP recovery endpoint.

Find the real `usersFile` path in this deployment's `luban-auth` configuration
and the matching user systemd service name. Do not use another deployment's file.
Run the installed command's help, then use absolute paths with sudo:

```sh
luban-auth --help
sudo /absolute/path/to/node /absolute/path/to/dsh-luban-auth/dist/recovery-cli.js \
  reset-admin --users-file /absolute/path/to/auth/users.json --service dsh-luban
```

The executable is in the installed auth package (`dist/recovery-cli.js`); its
`luban-auth` launcher is in the profile's `node_modules/.bin`. Use Node 22.19+
or 24+, including when sudo has a different PATH. Passwords cannot be supplied
as arguments, piped input, or environment variables.

After OS authorization, the command drops root privileges to the account-file
owner. It lists existing administrators, asks for a username and two hidden
password entries, and requests explicit confirmation. Invalid input is retried.
It then stops the selected user service, saves a private backup, atomically
replaces only that administrator's password, clears their lockout, and revokes
their login sessions. Other accounts and data remain unchanged. An originally
running service is restarted, including after a failed reset; an originally
stopped service stays stopped. The browser port does not change.

The account file must already exist, be private to its owner, and have no symbolic
or hard links; its parent must belong to that owner and not be writable by others.
Missing/corrupt state, a missing service, or a service that does not stop causes
recovery to fail closed. This command does not create or promote accounts.

The printed `.recovery-*.json` backup retains the old credentials and sessions:
keep it private. Do not restore it merely because a service restart failed;
if the command says the password was reset, repair/start the service and use the
new password. Restoring a backup also restores old authentication state. Windows
does not currently support this local recovery command.

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
Its native session API uses HTTP RPC and multiplexed Remote WebSocket streams.
The sidecar scopes both session requests and streams to the signed-in account.

## Platform Support

The same implementation is shared by Windows and Ubuntu. Run login, logout,
session-expiry, and alice/bob account-isolation tests on both platforms.

## License

MIT. See `THIRD-PARTY-NOTICES.md` for runtime dependency notices.
