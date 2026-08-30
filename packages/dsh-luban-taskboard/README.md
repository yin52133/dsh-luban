# dsh-luban-taskboard

Durable six-column work queue for people and DSH agents. The Web board, `taskctl`,
the importer, and autonomous scheduler all use one authenticated API and one
atomically written JSON ledger.

## Features

- `backlog → todo → doing → review → done` with a separate `dropped` terminal
  state, explicit transition rules, and optimistic versions.
- Responsive six-column board with drag-and-drop plus native select/button status
  controls for touch and keyboard input, with host, workspace, and tag filters.
- Status changes validate the current card state and optimistic version, reject
  stale/forged drag data, and use a synchronous board-wide lock to prevent rapid
  duplicate submissions before the disabled state renders.
- Direct links from each task card to authenticated Plan documents associated by
  the shared `taskId` contract when `dsh-luban-plan` is installed.
- Atomic agent claiming, acceptance criteria, session binding, progress and
  output records, and human review of `autoDone` work.
- Bounded SSE replay with a full baseline after an event gap.
- Cross-process locked, fsync/rename persistence with one backup per local
  calendar day and seven retained write days by default.
- Disabled-by-default night execution with host/tag allowlists, daily quota, and
  a durable next-day circuit-breaker reset. Night agents use an explicit model
  and inherited-tool allowlist that do not fall back to the interactive agent.
- Fail-closed autonomous completion: idle alone is never success. The scoped
  result tool must record one successful, evidence-backed acceptance report in
  the durable session log before the task can enter Review as `autoDone`.
- Idempotent import of common dashi-taskboard and cloader JSON fields.

## Installation

Install the authentication boundary first, then add this plugin to the same DSH
profile:

```sh
dsh plugin --profile web add dsh-luban-auth dsh-luban-taskboard
```

Keep the DSH WebServer on loopback and access the profile through the
`dsh-luban-auth` sidecar. The taskboard route is `/luban-taskboard`; the browser
section appears under Settings as **Taskboard**.

## Configuration

```yaml
- insert:
    - id: luban-taskboard
      name: dsh-luban-taskboard
      config:
        store: { dir: ~/.dsh/luban/taskboard }
        hostScope: auto
        claim: { requireAcceptance: true }
        night:
          enabled: false
          window: 23:30-06:30
          dailyQuota: 5
          hostScopeWhitelist: [ubuntu]
          tagWhitelist: [auto-ok]
          model: { provider: '', id: '' }
          toolAllowlist: []
          circuitBreaker: { maxConsecutiveFailures: 3 }
```

Night mode remains off until explicitly enabled. It only claims `todo` tasks
that have acceptance criteria and match both task allowlists. Before enabling
it, set `model.provider` and `model.id` to an rc2 provider route/model and list
every inherited tool the night agent may use in `toolAllowlist`; an empty list
leaves only the scoped result-reporting tool. Missing model configuration,
unknown tools, a missing/failed/duplicate report, unmet acceptance, or a
non-completed final turn all fail closed and return the task to `todo`.

`taskctl` talks to the same `/luban-taskboard` HTTP API. Put the complete Cookie
header in `LUBAN_SESSION_COOKIE` and the authenticated request token in
`LUBAN_CSRF_TOKEN`; neither value is accepted as a command-line argument.

Task lists, claims, and event streams are intended to be scoped to the M01
`accountId`; one account must not see or mutate another account's tasks.

```sh
taskctl list --status todo --tag auto-ok
taskctl add --title "Verify firmware" --hostScope ubuntu --priority P1 \
  --acceptance "CI artifact and test log are attached"
taskctl claim --session agent-123 --tag auto-ok
```

## Demo

Create a card with acceptance criteria, drag it from Todo to Doing (or select
**Move to Doing** and press **Move** on a touch/keyboard-only device), and open a
second browser. Both views refresh from the SSE task event. Autonomous results
return to Review with an `Auto-completed · review required` marker; only the
human `review → done` transition clears that marker. A card linked to one or
more plans opens each generated Markdown document directly; a profile without
the Plan plugin keeps the board available without those links.

## Compatibility

Tested with DeepSeek Harness `0.1.1-rc.2`, Cordis 4.0.1, and Node.js 22.19+.
The host adapter uses public rc2 `AgentRegistry.create({ agentOptions, setup })`,
agent-scoped `tools.restrict({ allow })`, `followup()`, `whenIdle()`, and durable
session events; it does not require unreleased session-controller APIs.

## Platform Support

The same package runs on Windows and Ubuntu. Each host owns a ledger named
`<hostname>-ledger.json`; `hostScope` controls which local agent may claim a
task. Cross-host ledger aggregation is outside this package.

M03 supervises the containing DSH profile process at the deployment boundary.
The night executor itself is an in-process `AgentRegistry` handle, so it owns and
drains that handle but intentionally does not call `KeepaliveService.ensureAlive`
to launch a duplicate copy of its own host. Deploy the profile under M03's
tmux/service strategy when process-level restart recovery is required.

## License

MIT. See `THIRD-PARTY-NOTICES.md`. The implementation is original; referenced
taskboard projects informed requirements only and no source or interface assets
were copied.
