# Luban browser bridge

This Python 3.12 project is an isolated, line-delimited JSON bridge for
`browser-use==0.13.8`. The Node plugin starts it with `uv run --locked` and sets
`UV_PROJECT_ENVIRONMENT` to a user-data directory, so no global Python packages
or repository-local virtual environment are used.

Standard output is reserved for protocol frames. Diagnostics go to standard
error through a credential-redacting logging filter. A browser or LLM is never
started by the test suite; tests inject a fake engine.

Run the checks with:

```sh
uv lock --check
uv run --locked ruff check src tests
uv run --locked ruff format --check src tests
uv run --locked python -m unittest discover -s tests -v
uv run --locked python -m compileall -q src tests
```
