# dsh-luban-keepalive

Managed-session survival for DSH. Linux sessions run in `tmux`; Windows uses native Scheduled
Tasks, so the package does not require NSSM. The service persists only metadata and progress
checkpoints—never terminal content or credentials.

## Features

- Idempotent `luban-*` tmux session creation, attach, list, probe, and destroy.
- Native Windows boot tasks with the original DSH command/`--patch` arguments preserved.
- Boot recovery from an atomic, locked, rolling-backup ledger.
- Periodic health events (`luban.keepalive.health`) for Taskboard/HUD consumers.
- Milestone checkpoints that restore the current step without repeating completed work.
- Corrupt-ledger safety: managed-looking sessions are reported as orphans and are not deleted.

## Installation

Install the package into the target DSH profile, then apply the bundled Cordis patch once:

```sh
dsh plugin --profile ubuntu-server add dsh-luban-keepalive
```

Linux hosts must provide `tmux`; Windows hosts use the built-in `schtasks.exe`. No global Node or
Python environment is created by this package.

## Configuration

```yaml
- insert:
    - id: luban-keepalive
      name: dsh-luban-keepalive
      config:
        strategy: auto
        patrolIntervalSec: 60
        commandTimeoutSec: 15
        ledgerFile: ~/.dsh/luban/keepalive/ledger.json
        bootRestore: true
        alertToTaskboard: true
```

`auto` selects tmux on Linux and Scheduled Tasks on Windows. Session ids are constrained to the
shared `luban-*` namespace. All host commands run without a command shell, with deadlines and
cancellation. tmux's required `shell-command` value is generated using strict POSIX quoting.

On Windows, ONSTART tasks use the current account with limited privileges. If tasks must start
before interactive login, provision that account's Scheduled Task credentials according to local
policy. Avoid SYSTEM unless the DSH profile and workspaces are intentionally accessible to it.

## Demo

Once the plugin is loaded, another Cordis plugin can keep one task alive and checkpoint it:

```ts
import { asTaskId } from '@luban/core'

const taskId = asTaskId('TASK-42')
const session = await ctx.lubanKeepalive.ensureAlive({
  id: 'firmware-build',
  purpose: 'task',
  command: 'dsh',
  args: ['headless', '--patch', '/srv/dsh/cordis.patch.yml'],
  ownerTaskId: taskId,
})

await ctx.lubanKeepalive.saveCheckpoint(session.id, {
  taskId,
  stepList: ['configure', 'compile', 'test'],
  currentStep: 1,
  artifacts: ['/srv/workspace/configure.log'],
  savedAt: Date.now(),
})
```

On the next DSH boot the plugin recreates a missing ledger-owned session and emits a `restored`
event with that checkpoint.

## Compatibility

The published compatibility floor is DSH **0.1.1-rc.1**. The tested baseline is **0.1.1-rc.2** on
Node 22.19+ (or Node 24+). The host implementation uses only the current Cordis service/manifest
contract and does not require alpha-only DSH session controllers.

## Platform Support

- Ubuntu/Linux: tmux HAL, including attach/list/probe/destroy and boot recovery.
- Windows: native Scheduled Tasks HAL, including ONSTART registration and process probing.
- macOS and other platforms: rejected with `E_PLATFORM_UNSUPPORTED`.

## Service API

The Cordis service key is `lubanKeepalive` and implements `KeepaliveService` from `@luban/core`.
Call `ensureAlive()` with a `SessionSpec`, and call `saveCheckpoint()` after each completed
milestone. `onEvent()` is the stable integration point for HUD and recovery audit consumers. The
concrete service also exposes `release()` so finite workers can remove a completed ledger entry.

## Publishing

From the repository root:

```sh
pnpm --filter dsh-luban-keepalive typecheck
pnpm exec eslint packages/dsh-luban-keepalive --max-warnings=0
pnpm --filter dsh-luban-keepalive test
pnpm --filter dsh-luban-keepalive build
pnpm --filter dsh-luban-keepalive pack --dry-run
```

Inspect the dry-run file list, run the repository release/security gates, then publish through the
approved provenance-enabled release workflow. Do not publish directly from a developer machine.

## License

MIT. See [LICENSE](./LICENSE) and [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
