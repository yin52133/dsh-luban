# @yin52133/dsh-luban

The complete DSH Luban aggregate bundle. One installation mounts every Luban
plugin together with the pinned companion plugins used by the suite.

## Features

- Installs all eleven standalone `@yin52133/dsh-luban-*` plugins in one step.
- Includes `dshmarket`, `dsh-better-sidebar`, and `@furongjun1999/dsh-memory` at
  reviewed, exact versions.
- Keeps every standalone package available for selective installation.

## Install

```sh
dsh plugin --profile <profile> add @yin52133/dsh-luban@0.1.1
```

Use either this aggregate or selected standalone packages. Remove duplicate
standalone installations before adding the aggregate so a plugin is not mounted twice.

## Configuration

The bundled `cordis.patch.yml` uses the same row IDs and defaults as the
standalone packages. Profile-level overrides therefore continue to target IDs
such as `luban-auth`, `luban-taskboard`, and `better-sidebar`.

## Demo

See the authenticated Taskboard and HUD screenshot in the
[repository README](https://github.com/yin52133/dsh-luban#%E7%95%8C%E9%9D%A2%E5%B1%95%E7%A4%BA).

## Compatibility

| DSH          | Status    |
| ------------ | --------- |
| `0.1.1-rc.2` | CI target |

Manifest floor: `engines.dsh` = `>=0.1.1-rc.1`.

## Platform Support

The aggregate supports Windows and Ubuntu. Platform-specific plugins disable or
no-op their unavailable host integrations while the shared Web features remain mounted.

## License

MIT. Third-party packages remain under their upstream licenses; see
`THIRD-PARTY-NOTICES.md`.
