# dsh-luban-keepalive

Managed-session survival for DSH. Linux sessions run in `tmux`; Windows uses native Scheduled
Tasks, so the package does not require NSSM. The service persists only metadata and progress
checkpoints—never terminal content or credentials.

## Features

- Idempotent `luban-*` tmux session creation, attach, list, probe, and destroy.
- Native Windows boot tasks with the original DSH command/`--patch` arguments preserved.
- Boot recovery from an atomic, locked, rolling-backup ledger.
- Periodic health events (`luban.keepalive.health`) for Taskboard/HUD consumers.
- A checkpointed milestone runner that restores the first incomplete step and never
  reruns milestones whose completion was durably recorded.
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

`bootRestore` is the ordinary profile setting. The Ubuntu systemd launcher can force recovery by
setting the exact `LUBAN_BOOT_RESTORE=1` sentinel, even when `bootRestore` is `false`. Only the
literal string `1` enables that deployment override; values such as `true`, `yes`, `01`, or a
space-padded `1` do not. A configured `bootRestore: true` remains enabled regardless of the
environment value.

`auto` selects tmux on Linux and Scheduled Tasks on Windows. Session ids are constrained to the
shared `luban-*` namespace. All host commands run without a command shell, with deadlines and
cancellation. tmux's required `shell-command` value is generated using strict POSIX quoting.

On Windows, ONSTART tasks use the current account with limited privileges. If tasks must start
before interactive login, provision that account's Scheduled Task credentials according to local
policy. Avoid SYSTEM unless the DSH profile and workspaces are intentionally accessible to it.

## Demo

Once the plugin is loaded, another Cordis plugin can keep one task alive and checkpoint it:

```ts
import { asTaskId } from 'dsh-luban-core'

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

When boot recovery is enabled by config or the exact systemd sentinel, the plugin recreates a
missing ledger-owned session and emits a `restored` event with that checkpoint.

For an in-process long-task executor, use `runCheckpointedTask()`. It validates that a restored
checkpoint still belongs to the exact task and ordered step plan, resumes at `currentStep`, and
saves `currentStep + 1` only after the milestone succeeds. Milestone side effects should remain
idempotent because a process can still stop after the side effect completes but before the atomic
checkpoint write finishes.

## Compatibility

The published compatibility floor is DSH **0.1.1-rc.1**. The tested baseline is **0.1.1-rc.2** on
Node 22.19+ (or Node 24+). The host implementation uses only the current Cordis service/manifest
contract and does not require alpha-only DSH session controllers.

## Platform Support

- Ubuntu/Linux: tmux HAL, including attach/list/probe/destroy and boot recovery.
- Windows: native Scheduled Tasks HAL, including ONSTART registration and process probing.
- macOS and other platforms: rejected with `E_PLATFORM_UNSUPPORTED`.

These entries describe implemented HAL support, not completed target-host
acceptance. Real Ubuntu SSH disconnect/tmux reattach, Windows task installation
and logout, and authorized Windows/Ubuntu reboot recovery remain blocked checks
in M03-F001 through M03-F003.

## Staged Ubuntu acceptance

The repository includes a fail-closed Ubuntu/tmux runner for the remaining M03-F001 and M03-F003
host checks. Run it from a clean, committed checkout on the target Ubuntu host. Its preflight is
read-only and requires Ubuntu, Node 22.19+ or 24+, `tmux`, `dsh`, `Linger=yes`, and an enabled and
active `dsh-luban.service` with a positive `MainPID` and the exact
`LUBAN_BOOT_RESTORE=1` token in that exact MainPID's `/proc` environment. The runner reads the
MainPID again around this check so a unit-property string or a different process cannot satisfy it:

```sh
node scripts/acceptance/m03-ubuntu-keepalive.mjs preflight
```

Choose a new absolute directory outside the repository. `prepare` is the first mutating stage: it
creates one uniquely owned `luban-m03-*` tmux heartbeat session and matching ledger/checkpoint
record. The ledger must also be in a canonical, owner-only directory outside the repository (the
default is under `~/.dsh`). It does not install a unit or change linger.

```sh
node scripts/acceptance/m03-ubuntu-keepalive.mjs prepare --apply \
  --run-dir /var/tmp/dsh-luban-m03-acceptance
```

Disconnect the SSH client manually, reconnect, and create a new external witness JSON using the
`runId`, machine-id hash, prepared boot id, and `recordedAt` from
`01-prepared.json`. Both timestamps must be real epoch-millisecond values captured after
`prepare`: `disconnectedAt` records the actual disconnect, and `reconnectedAt` records the later
reconnect. The placeholders below cannot pass verification and must be replaced with those observed
timestamps.

```json
{
  "schemaVersion": "dsh-luban/m03-ubuntu-disconnect-witness/v1",
  "runId": "<prepared runId>",
  "machineIdSha256": "<prepared machineIdSha256>",
  "bootId": "<prepared bootId>",
  "observer": "<human operator>",
  "sshDisconnected": true,
  "disconnectedAt": "<actual disconnect epoch-ms after prepare>",
  "reconnectedAt": "<actual reconnect epoch-ms after disconnectedAt>"
}
```

Continue in order:

```sh
node scripts/acceptance/m03-ubuntu-keepalive.mjs verify-disconnect \
  --run-dir /var/tmp/dsh-luban-m03-acceptance \
  --witness /var/tmp/m03-disconnect-witness.json
node scripts/acceptance/m03-ubuntu-keepalive.mjs observe-attach \
  --run-dir /var/tmp/dsh-luban-m03-acceptance
node scripts/acceptance/m03-ubuntu-keepalive.mjs arm-reboot \
  --run-dir /var/tmp/dsh-luban-m03-acceptance
```

`observe-attach` opens the real owned tmux session and waits for the operator to detach normally.
`arm-reboot` records the boundary but never reboots. After a separately authorized human reboot,
verify that the boot id changed and that systemd restored the ledger-owned checkpoint and heartbeat,
then remove only the owned fixture:

```sh
node scripts/acceptance/m03-ubuntu-keepalive.mjs verify-reboot \
  --run-dir /var/tmp/dsh-luban-m03-acceptance
node scripts/acceptance/m03-ubuntu-keepalive.mjs cleanup --apply \
  --run-dir /var/tmp/dsh-luban-m03-acceptance
```

The runner never disconnects SSH, invokes reboot, changes linger, or installs/removes systemd
units. Each stage writes a new hash-chained evidence file and never overwrites earlier evidence.
The four verification stages also advance only this run's ledger-owned checkpoint (using the same
cross-process lock as the plugin); they do not change host policy or another session.
Before attachment or deletion, cleanup enumerates the entire tmux session and requires exactly one
pane with the owner marker's exact session id and command. `cleanup --apply` can therefore recover
the exact owned fixture from the canonical owner marker even when the first evidence publication
failed or the evidence chain is damaged. In that recovery case it reports `cleanup: "pass"` with
`evidenceAppended: false`; damaged evidence is never rewritten or promoted.
The SSH witness is explicitly human/operator attestation rather than a cryptographic network trace;
successful real-host evidence is labeled `operator-attested`. Injected test operators are always
labeled `simulated` and can never make either feature pass.

## Service API

The Cordis service key is `lubanKeepalive` and implements `KeepaliveService` from `dsh-luban-core`.
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
