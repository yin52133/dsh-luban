# @yin52133/dsh-luban

The complete DSH Luban aggregate bundle. One installation mounts every Luban
plugin together with the pinned companion plugins used by the suite.

## Features

- Installs all eleven standalone `@yin52133/dsh-luban-*` plugins in one step.
- Installs the suite's companion projects at reviewed, exact versions:
  [`dshmarket@1.42.0`](https://github.com/dsh-market/dsh-market),
  [`dsh-better-sidebar@0.18.0`](https://github.com/omdsh-dev/DSH-better-sidebar), and
  [`@furongjun1999/dsh-memory@0.4.0`](https://github.com/FuRongJun-1999/dsh-memory).
- Keeps every standalone package available for selective installation.

## Install

```sh
dsh plugin --profile <profile> add @yin52133/dsh-luban@0.1.3 --allow-build=node-pty@1.1.0 --allow-build=@serialport/bindings-cpp@13.0.0
```

Use either this aggregate or selected standalone packages. Remove duplicate
standalone installations before adding the aggregate so a plugin is not mounted twice.
The public npm registry requires no GitHub account or PAT for installation.
The explicit build allowlist covers only the pinned native terminal and serial
bindings. Omit the serial binding when COM support is not required.

## Configuration

The bundled `cordis.patch.yml` uses the same row IDs and defaults as the
standalone packages. Profile-level overrides therefore continue to target IDs
such as `luban-auth`, `luban-taskboard`, and `better-sidebar`.

Use `http://127.0.0.1:42600/luban-auth/login` locally or
`http://<host-ip>:42600/luban-auth/login` on the LAN. Port `3080` remains a
loopback-only DSH upstream and is not a second user entry point.

On first visit, the page guides you through creating an administrator username
and password. After signing in, the bottom status bar shows your account and a
logout button. No bootstrap password environment variable is required.

The optional memory companion is installed but disabled by default because it
requires a separate Python environment with `aeis`. After preparing that
environment, enable it in your profile's `cordis.patch.yml` and set its Python path:

```yaml
- id: dsh-memory
  disabled: false
  config:
    python: /absolute/path/to/venv/bin/python
```

On Windows, use the absolute path to the environment's `Scripts/python.exe`.

## Demo

See the authenticated Taskboard and HUD screenshot in the
[repository README](https://github.com/yin52133/dsh-luban#%E7%95%8C%E9%9D%A2%E5%B1%95%E7%A4%BA).

## Compatibility

| DSH          | Status    |
| ------------ | --------- |
| `0.1.2-rc.1` | CI target |

Manifest floor: `engines.dsh` = `>=0.1.2-rc.1`.

## Platform Support

The aggregate supports Windows and Ubuntu. Platform-specific plugins disable or
no-op their unavailable host integrations while the shared Web features remain mounted.

## License

MIT. Third-party packages remain under their upstream licenses; see
`THIRD-PARTY-NOTICES.md`.
