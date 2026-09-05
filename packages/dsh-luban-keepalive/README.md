# @yin52133/dsh-luban-keepalive

Cross-platform DSH session persistence with tmux on Ubuntu and Scheduled Tasks
on Windows.

## Features

- Starts, probes, and releases managed DSH sessions through one platform-neutral service.
- Restores ledger-owned sessions after host restart when `bootRestore` is enabled.
- Reports bounded heartbeat failures to HUD and Taskboard.
- Stores atomic task checkpoints so idempotent long jobs can resume from the next step.
- Uses native tmux on Ubuntu and native Scheduled Tasks on Windows.

## Installation

Install authentication first, then add keepalive to the same profile:

```sh
dsh plugin --profile web add @yin52133/dsh-luban-auth @yin52133/dsh-luban-keepalive
```

Ubuntu requires `tmux`. Windows task registration uses the current user's Task
Scheduler and does not require a separate service executable.

## Configuration

```yaml
- insert:
    - id: luban-keepalive
      name: @yin52133/dsh-luban-keepalive
      config:
        ledgerDir: ~/.dsh/luban/keepalive
        patrolIntervalSec: 60
        bootRestore: true
        tmuxPrefix: luban
        windowsTaskPrefix: Luban
```

`bootRestore` can also be controlled by `LUBAN_BOOT_RESTORE=1`. The service only
restores sessions already owned by its ledger; it does not discover or adopt
unrelated tmux sessions or Scheduled Tasks.

## Service API

The Cordis service key is `lubanKeepalive` and implements `KeepaliveService`
from `@yin52133/dsh-luban-core`.

- `ensureAlive(spec)` starts or reconnects a managed session.
- `saveCheckpoint(checkpoint)` records the next resumable step.
- `release(sessionId)` removes a completed managed session.
- `onEvent(listener)` provides the stable HUD and recovery integration point.

Milestone handlers should remain idempotent: a process can stop after a side
effect succeeds but before its next checkpoint is written.

## Demo

After the plugin starts, use the DSH task and session views to confirm that a
managed session remains healthy. Stop the child process once and verify that
keepalive restores it from the persisted ledger and latest checkpoint.

## Compatibility

- DSH: `>=0.1.2-rc.1`; tested with `0.1.2-rc.1`
- Node.js: `^22.19.0 || >=24.0.0`
- Ubuntu: tmux session management and restart restoration
- Windows: Scheduled Tasks and process probing
- Other platforms: `E_PLATFORM_UNSUPPORTED`

## Platform Support

Ubuntu and Windows use the same Cordis service contract. Ubuntu delegates
process persistence to tmux; Windows delegates host and child restoration to
Task Scheduler.

## Development

```sh
pnpm --filter @yin52133/dsh-luban-keepalive typecheck
pnpm --filter @yin52133/dsh-luban-keepalive test
pnpm --filter @yin52133/dsh-luban-keepalive build
```

## License

MIT. See `LICENSE` and `THIRD-PARTY-NOTICES.md`.
