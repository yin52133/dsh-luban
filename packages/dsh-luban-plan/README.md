# dsh-luban-plan

Approval-gated plans for DSH. The plugin persists a strict plan state machine, writes a reviewable Markdown plan into the target workspace, blocks configured execution tools until approval, and sends structured decisions back to the owning agent session.

## Features

### Checklist mapping

- **M04-F001** — guarded `draft → in-review → approved → executing → completed` workflow, with `rejected` and `revising` branches, optimistic versions, and a real DSH monotonic tool guard.
- **M04-F002** — workspace documents at `docs/plans/<date>-<slug>.md`, plus task/session ids, authenticated document routes, and task-card links resolved by `taskId`.
- **M04-F003** — authenticated Settings approve/reject/revise controls and REST/SSE decisions; approval feedback is delivered as an identified `luban.plan.feedback` agent message.
- **M04-F004** — bundled template and mandatory background, impact scope, change locations, and verification sections.

## Compatibility

| Component | Supported baseline                                                                 |
| --------- | ---------------------------------------------------------------------------------- |
| Node.js   | `^22.19.0 or >=24.0.0`                                                             |
| DSH       | `0.1.1-rc.2` validation baseline (`engines.dsh` accepts compatible `>=0.1.1-rc.1`) |
| Platforms | Windows and Linux                                                                  |

The host uses the public `ctx.tools.guard()` and `ctx.agents` boundaries. The browser output is DSH lazy-CJS and does not bundle React, Cordis, or DSH platform modules.

## Platform Support

- Windows 10/11 with Node.js 22.19 or newer.
- Ubuntu/Linux with Node.js 22.19 or newer.
- The same state machine and storage implementation is used on both platforms; atomic file synchronization includes the Windows writable-handle requirement.

## Installation

Add `dsh-luban-plan` to the DSH profile, then merge the exported `cordis.patch.yml`. Mount `dsh-luban-auth` in front of the profile; all `/luban-plan/...` routes require `lubanAuth`.

The plugin provides the cross-module service key `lubanPlan`. If `lubanTaskStore` is present, approving a plan linked to a `todo` task moves that task to `doing`; the packages do not import one another.

## Demo

Log in, read the CSRF token from the authenticated session, then submit and approve a four-element plan:

```sh
curl -c cookies.txt -H 'content-type: application/json' \
  -d '{"user":"operator","password":"YOUR_PASSWORD"}' \
  http://127.0.0.1:3081/luban-auth/login

CSRF_TOKEN=$(curl -s -b cookies.txt \
  http://127.0.0.1:3081/luban-auth/session | jq -r '.csrfToken')

curl -b cookies.txt -H 'content-type: application/json' \
  -H "x-luban-csrf: ${CSRF_TOKEN}" \
  -d '{"workspace":".","slug":"safe-change","sections":{"background":"why","impact":"scope","changes":"src/index.ts","verification":"lint + typecheck + build + tests"}}' \
  http://127.0.0.1:3081/luban-plan/plans

curl -b cookies.txt -H 'content-type: application/json' \
  -H "x-luban-csrf: ${CSRF_TOKEN}" \
  -d '{"decision":"approve","expectedVersion":1}' \
  http://127.0.0.1:3081/luban-plan/plans/P-YYYYMMDD-ID/decision
```

The Settings **Plans** page provides the same submit/review flow, lets a reviewer edit all four required sections after rejection, and opens the generated `docs/plans/<date>-<slug>.md` document. The Settings **Taskboard** page links cards directly to documents for plans carrying the same `taskId`.

## Configuration

```yaml
- insert:
    - id: luban-plan
      name: dsh-luban-plan
      config:
        plansDir: docs/plans
        stateFile: ~/.dsh/luban/plan/plans.json
        requireApprovalFor: [edit, bash, write]
        autoApproveFor: []
        template: bundled-default
```

`plansDir` must remain workspace-relative. `requireApprovalFor` accepts exact names, `*` globs, and the `edit`, `bash`, and `write` categories. Exemptions are deliberately empty by default.

## State machine and guard

`submit()` validates all four sections and enters `in-review`. Only `decide()` may approve or reject a review; rejection requires a comment. A rejected plan may be revised back to review. Approved plans may enter `executing` and then `completed`. Every mutation checks `expectedVersion` and appends its review history to both the JSON source of truth and Markdown projection.

Protected tools are allowed only while the session's current plan is `approved` or `executing`. Read-only tools stay available unless explicitly configured as protected.

## HTTP and Web UI

All endpoints are under `/luban-plan`:

- `GET/POST /plans`
- `POST /drafts`
- `GET /plans/:id` and `GET /plans/:id/document`
- `POST /plans/:id/decision`, `/transition`, and `/revise`
- `GET /events` (bounded SSE feedback stream)
- `GET /template`

The DSH Settings page exposes plan submission, plan-document links, approve/reject controls, comments, four-section revision for `rejected`/`revising` plans, and live refresh. Revision requests include the displayed optimistic version; stale-version and other endpoint errors remain visible in the page alert. Browser writes reuse the auth session's CSRF token.

## Persistence and security

- The local JSON index is atomically replaced with a cross-process lock and rolling backups through `@luban/core`.
- Plan Markdown is written with private file modes and cannot escape the selected workspace.
- Existing same-day slug documents are never overwritten.
- Review routes are authenticated and return no-store/nosniff headers.
- The configured tool guard is monotonic: another listener cannot override its denial.

## Development

From the repository root:

```sh
pnpm --filter dsh-luban-plan typecheck
pnpm exec eslint packages/dsh-luban-plan --max-warnings=0
pnpm --filter dsh-luban-plan test
pnpm --filter dsh-luban-plan build
```

## Version history

- `0.1.0` — initial M04 state machine, documents, approval UI/feedback, task linking, and DSH tool guard.

## License

MIT. See `LICENSE` and `THIRD-PARTY-NOTICES.md`.
