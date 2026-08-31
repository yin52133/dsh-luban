# dsh-luban-browser

Authenticated browser automation for DeepSeek Harness, backed by the unmodified
`browser-use==0.13.8` Python package. The plugin owns only a thin JSONL adapter,
a bounded serial queue, templates, and lifecycle integration.

## Features

- Isolated `browser-use` execution through a locked Python 3.12 `uv` project.
- Bounded serial jobs with cancellation, timeouts, progress, screenshots, text,
  and structured results.
- YAML templates with domain allowlists, output schemas, and isolated or named
  browser profiles.
- Authenticated HTTP/SSE endpoints and optional taskboard automation after an
  agent claims an eligible task.

## Installation

Install `uv`, then add the plugin to the DSH bundle. The packaged bridge includes
its own `pyproject.toml` and `uv.lock`; the plugin creates its environment on the
first run and does not install into global Python.

```powershell
pnpm add dsh-luban-browser
```

The integration is tested against DSH `0.1.1-rc.2`, Node.js 22.19+, Python 3.12,
`uv`, and `browser-use==0.13.8`.

## Runtime isolation

- Python is fixed to 3.12 and launched with `uv run --locked`.
- `UV_PROJECT_ENVIRONMENT` defaults to `~/.dsh/luban/browser/uv-env`; global
  Python and repository-local virtual environments are never used.
- Browser profiles are isolated temporary directories by default. A template
  may opt into a named persistent profile under
  `~/.dsh/luban/browser/profiles/` for login-state reuse.
- Only explicitly allowlisted environment-variable names are passed to Python.
  Values stay in the process environment and are redacted from diagnostics.
- Standard output is reserved for JSONL protocol frames. Timeout, cancellation,
  process exit, protocol corruption, and output-schema failures have stable
  `E_BROWSER_*` codes.

## Configuration

```yaml
- insert:
    - id: luban-browser
      name: dsh-luban-browser
      config:
        kernel: auto # auto | chrome | edge | chromium-headless
        templatesDir: ~/.dsh/luban/browser/templates
        defaults:
          maxSteps: 30
          timeoutSec: 300
          allowDomains: []
        bridge:
          runner: uv
          python: '3.12'
        taskboard:
          autoRun: false
```

`auto` means local Chrome on Windows and headless Chromium on Linux. Set
`userDataDir` only when a deliberately shared configured profile is required.

## YAML templates

Place `.yaml` files in `templatesDir`. Required fields are `id`, `title`,
`goal`, `allowDomains`, `timeoutSec`, `maxSteps`, and `profile.mode`. `${name}`
placeholders receive values from the API `params` object. Templates can provide
an `outputSchema`; the bridge validates a bounded JSON Schema subset before
returning structured output.

The bundled `templates/research.yaml` is an example, not an unrestricted web
template. `allowDomains` accepts exact hosts and `*.example.com` subdomain
patterns; a bare `*` (including a scheme or port spelling that normalizes to it)
is rejected. An empty list remains available only for manually submitted,
unconstrained tasks. User files with the same id override bundled files.

## Authenticated API

All routes call the `lubanAuth` service before reading or mutating state. Obtain
the session through `/luban-auth/login` before using these endpoints:

- `GET /luban-browser/status`
- `GET /luban-browser/templates`
- `GET|POST /luban-browser/jobs`
- `GET /luban-browser/jobs/:id`
- `POST /luban-browser/jobs/:id/cancel`
- `GET /luban-browser/events` (SSE with bounded `Last-Event-ID` replay)

Example submission:

```json
{
  "task": {
    "templateId": "research",
    "goal": "Find the relevant section"
  },
  "params": {
    "url": "https://example.com/docs",
    "question": "What changed?"
  }
}
```

## Demo

With DSH and `luban-auth` running, submit an allowlisted template job using an
authenticated session:

```powershell
$headers = @{ Cookie = $env:LUBAN_SESSION_COOKIE; 'X-Luban-CSRF' = $env:LUBAN_CSRF }
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:18080/luban-browser/jobs `
  -Headers $headers -ContentType application/json `
  -Body '{"task":{"templateId":"research","goal":"Summarize the page"},"params":{"url":"https://example.com","question":"What is this page?"}}'
```

## Optional taskboard collaboration

M11 never imports the M02 implementation. When `taskboard.autoRun` is enabled,
it waits for the `lubanTaskStore` and `lubanAgentClaim` Cordis services defined
by the `dsh-luban-core` contracts. A claimed task is eligible only when all of the
following hold:

- tags include `browser` and `auto-ok`;
- exactly one `browser-template:<id>` tag is present;
- the template has a non-empty `allowDomains` policy;
- that policy contains no unrestricted `*` wildcard;
- the claim belongs to an agent.

Template parameters may be supplied as `browser-param:<name>=<value>` tags.
Progress and the final artifact are written back exclusively through
`AgentClaimService`; failures use its `fail()` path.

Tests inject mock bridges and engines. They do not start a real browser, fetch a
website, download Chromium, or call an LLM.

## Live dual-platform acceptance

The production plugin routes every browser-use model turn through the current
DSH default model. It does not require a Browser Use Cloud API key and does not
copy the DSH provider credential into Python. The host creates an ephemeral
loopback model gateway and passes only its one-run URL and token to the bridge.

Run local Chrome or Edge on Windows and headless Chromium on Ubuntu. Python
3.12 and browser-use are installed from the packaged `uv.lock` with the
documented uv version. Each run records browser version, progress, structured
nonce readback, and a validated PNG screenshot.

Use the model-free kernel smoke when validating only the platform HAL and
installed browser. It starts the real browser, visits a runner-owned loopback
fixture, reads its nonce from the DOM, and stops the browser cleanly:

```console
uv run --locked --no-dev --project tools/browser-bridge python scripts/acceptance/m11-browser-kernel.py --target windows --browser <absolute-browser-path> --output <new-evidence.json>
```

M11-F004 has passed this smoke with Windows Chrome and Edge plus Ubuntu headless
Chrome. For the complete mounted task, run from a clean commit with an existing
DSH profile whose default model is already usable:

```console
node scripts/acceptance/m11-dsh-browser.mjs --profile web --output <new-evidence.json>
```

The runner adds an overlay only for its process; it does not edit the selected
profile or ask for a separate browser provider key. Browser jobs, results,
cancellation, and SSE remain inside the originating M01 account context.

## Compatibility

- DSH: `0.1.1-rc.2`
- Node.js: `^22.19.0 || >=24.0.0`
- Python: `3.12`, managed only through the packaged locked `uv` project
- browser-use: exactly `0.13.8`

## Platform Support

- Windows: local Chrome or Edge through the platform HAL
- Ubuntu: headless Google Chrome or Chromium through the same task contract

Standard automated tests exercise fake processes and never contact external
websites or model services. The model-free live kernel smoke has passed on both
target platforms; mounted Agent acceptance remains explicit and opt-in.

## License

MIT. See `LICENSE` and `THIRD-PARTY-NOTICES.md`.
