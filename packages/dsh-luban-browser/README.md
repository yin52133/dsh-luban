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
          passEnvironment:
            - BROWSER_USE_API_KEY
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
template. User files with the same id override bundled files.

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
by the `@luban/core` contracts. A claimed task is eligible only when all of the
following hold:

- tags include `browser` and `auto-ok`;
- exactly one `browser-template:<id>` tag is present;
- the template has a non-empty `allowDomains` policy;
- the claim belongs to an agent.

Template parameters may be supplied as `browser-param:<name>=<value>` tags.
Progress and the final artifact are written back exclusively through
`AgentClaimService`; failures use its `fail()` path.

Tests inject mock bridges and engines. They do not start a real browser, fetch a
website, download Chromium, or call an LLM.

## Compatibility

- DSH: `0.1.1-rc.2`
- Node.js: `^22.19.0 || >=24.0.0`
- Python: `3.12`, managed only through the packaged locked `uv` project
- browser-use: exactly `0.13.8`

## Platform Support

- Windows: local Chrome or Edge through the platform HAL
- Ubuntu: headless Chromium through the same task contract

Real browser/provider acceptance remains environment-dependent; automated tests
exercise fake processes and never contact external websites.

## License

MIT. See `LICENSE` and `THIRD-PARTY-NOTICES.md`.
