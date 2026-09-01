# @yin52133/dsh-luban-context

Auditable context compaction for DSH. The plugin compacts only at an idle turn boundary, keeps recent messages verbatim, preserves decisions and constraints in a summary, and writes exact older source into searchable workspace-local virtual files.

## Features

### Checklist mapping

- **M08-F001** — zero-intrusion `CompactionStrategy` registration with standalone summarize, virtual-file, and composite strategies.
- **M08-F002** — exact-session telemetry threshold plus minimum-turn-gap triggering; a DSH maintenance task guarantees an idle boundary and replaces only a contiguous old surface prefix.
- **M08-F003** — account/session-partitioned `.luban/context-archive/<account>/<session>/seg-*.md` files with checksummed `index.json` lookup.
- **M08-F004** — durable `audit.json`, authenticated audit/index routes, and checksum-verified segment replay.
- **M08-F005** — separate day/night cadence; `luban-night-*` sessions select the aggressive profile automatically and schedulers can call `markScope()` or the scope API.

## Compatibility

| Component | Supported baseline                                                                 |
| --------- | ---------------------------------------------------------------------------------- |
| Node.js   | `^22.19.0 or >=24.0.0`                                                             |
| DSH       | `0.1.1-rc.2` validation baseline (`engines.dsh` accepts compatible `>=0.1.1-rc.1`) |
| Platforms | Windows and Linux                                                                  |

No production package is added beyond `@yin52133/dsh-luban-core`. The plugin consumes `lubanTelemetry` and `lubanAuth` only through their core contracts and provides `lubanCompaction`.

## Platform Support

- Windows 10/11 with Node.js 22.19 or newer.
- Ubuntu/Linux with Node.js 22.19 or newer.
- Archives use platform-safe session directory names and workspace-relative `/` indexes on both systems.

## Installation

Add `@yin52133/dsh-luban-context` to a profile after the agent runtime, `@yin52133/dsh-luban-auth`, and the M07 telemetry provider, then merge `cordis.patch.yml`.

## Demo

After a session crosses its profile threshold, inspect its decisions and replay one exact archived segment through the authenticated gateway:

```sh
curl -b cookies.txt http://127.0.0.1:3081/luban-context/sessions/SESSION_ID/audit
curl -b cookies.txt http://127.0.0.1:3081/luban-context/sessions/SESSION_ID/archives
curl -b cookies.txt 'http://127.0.0.1:3081/luban-context/sessions/SESSION_ID/replay?startSeq=0&endSeq=3'
curl -b cookies.txt --get --data-urlencode 'path=.luban/context-archive/ACCOUNT/SESSION/seg-INDEX-HASH.md' \
  http://127.0.0.1:3081/luban-context/sessions/SESSION_ID/replay
```

The first two responses expose the chosen strategy, token estimates, compaction plan, checksums, and virtual-file indexes; replay returns the redacted original Markdown after verifying its SHA-256 digest.

## Configuration

```yaml
- insert:
    - id: luban-context
      name: @yin52133/dsh-luban-context
      config:
        trigger: { ratio: 0.80, minGapRounds: 4 }
        strategy: summarize+virtualfile
        keepRecentTokens: 24000
        archiveDir: .luban/context-archive
        nightProfile:
          trigger: { ratio: 0.70 }
          keepRecentTokens: 16000
```

`archiveDir` must be relative to the session workspace. An unknown telemetry ratio does not trigger compaction.

## Runtime behavior

When an agent becomes idle, the coordinator claims a DSH maintenance boundary, requests a fresh `lubanTelemetry.snapshotFor(sessionId)`, and calls the selected strategy. Before any archive or session-surface mutation, the engine resolves the session owner through M01 `accountSessions`; an unbound legacy session is skipped and is not assigned to the currently logged-in account. The targeted read bypasses the global HUD cache, so another initiator/running/newest agent cannot supply the ratio for this session. The default composite strategy:

1. keeps the newest complete surface messages within the token budget;
2. archives the old prefix after credential-pattern redaction;
3. creates a bounded extractive summary that favors decisions, requirements, constraints, acceptance criteria, TODOs, and errors;
4. replaces the old surface prefix with the cited summary plus virtual-file indexes;
5. records the plan, before/after token estimates, strategy, and archive files.

A strategy failure is retried once. A second failure degrades to archive-only compaction; failure of that safe fallback aborts without an audit success record.
During plugin disposal, new maintenance and HTTP work fail closed, pre-engine sampling is cancelled, and an already-running engine operation is drained before the lifecycle disposer returns.

## Strategy API and night coordination

Call `lubanCompaction.register(strategy)` to add a strategy and dispose the returned function to unregister it. `use(id, { taskScope: 'day' | 'night' })` switches one profile without changing the engine. `await markScope(sessionId, 'night', accountId)` gives authenticated schedulers an explicit boundary after verifying M01 session ownership; taskboard sessions named `luban-night-*` are recognized automatically.

## Audit and replay API

Authenticated routes live under `/luban-context`:

- `GET /profiles`
- `GET /sessions/:id/audit`
- `GET /sessions/:id/archives`
- `GET /sessions/:id/replay?startSeq=N&endSeq=M`
- `POST /sessions/:id/scope?value=day|night`

Range replay selects the newest matching surface generation. Exact historical replay accepts an indexed `path`,
verifies its stored SHA-256 digest, and never reads an arbitrary path. Content-addressed filenames make retry
idempotent while preserving older generations that reused the same temporary surface range.

## Persistence and stability

- Archives, indexes, and audits use atomic JSON replacement under an account/session namespace. New index and audit rows persist `accountId`; legacy rows without an explicitly migrated owner remain invisible.
- Audit, archive, replay, and scope routes derive `accountId` only from M01 authentication and verify the target session against M01's persistent session map. A body or query parameter cannot override ownership, and cross-account or unbound session ids return not found.
- Session ids and paths are normalized and checked against their workspace roots.
- Common API keys, bearer tokens, passwords, private keys, and platform token formats are redacted before archive or summary injection.
- Original DSH events remain in the append-only durable log; only the model-visible surface is replaced, enabling explanation and replay.

## Development

From the repository root:

```sh
pnpm --filter @yin52133/dsh-luban-context typecheck
pnpm exec eslint packages/@yin52133/dsh-luban-context --max-warnings=0
pnpm --filter @yin52133/dsh-luban-context test
pnpm --filter @yin52133/dsh-luban-context build
```

## Version history

- `0.1.0` — initial M08 strategies, threshold engine, virtual files, audit/replay, and day/night coordination.

## License

MIT. See `LICENSE` and `THIRD-PARTY-NOTICES.md`.
