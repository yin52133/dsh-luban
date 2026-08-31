#!/usr/bin/env python3
"""Run a provider-free browser-use kernel smoke and write JSON evidence."""

from __future__ import annotations

import argparse
import asyncio
import importlib.metadata
import json
import platform
import secrets
import sys
import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import browser_use

TIMEOUT_SECONDS = 30


class QuietServer(ThreadingHTTPServer):
    """Ignore connection resets caused by browser shutdown."""

    def handle_error(self, request: Any, client_address: Any) -> None:
        return


class FixtureHandler(BaseHTTPRequestHandler):
    """Serve the per-run fixture supplied by the smoke runner."""

    body = b""

    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, format: str, *args: Any) -> None:
        return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=("windows", "ubuntu"))
    parser.add_argument("--browser", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


async def run_smoke(target: str, browser: Path, output: Path) -> dict[str, Any]:
    browser = browser.resolve(strict=True)
    if not browser.is_file():
        raise ValueError("browser executable is not a file")
    output = output.resolve()
    if output.exists():
        raise FileExistsError(f"refusing to overwrite evidence: {output}")

    nonce = f"luban-m11-{secrets.token_hex(12)}"
    FixtureHandler.body = (
        f"<!doctype html><title>{target}</title><main><h1>{nonce}</h1></main>".encode()
    )
    server = QuietServer(("127.0.0.1", 0), FixtureHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    fixture_url = f"http://127.0.0.1:{server.server_port}/"
    profile = output.with_suffix("").with_name(f"{output.stem}-profile")
    profile.mkdir(parents=True)
    session = browser_use.BrowserSession(
        executable_path=browser,
        headless=True,
        user_data_dir=profile,
        keep_alive=False,
        enable_default_extensions=False,
    )
    started_at = datetime.now(UTC)
    stopped = False
    try:
        await asyncio.wait_for(session.start(), TIMEOUT_SECONDS)
        await asyncio.wait_for(session.navigate_to(fixture_url), TIMEOUT_SECONDS)
        await asyncio.sleep(0.5)
        state = await asyncio.wait_for(
            session.get_browser_state_summary(include_screenshot=False), TIMEOUT_SECONDS
        )
        state_text = await asyncio.wait_for(
            session.get_state_as_text(), TIMEOUT_SECONDS
        )
        if state.url != fixture_url:
            raise RuntimeError("browser did not remain on the fixture URL")
        if nonce not in state_text:
            raise RuntimeError("browser DOM did not contain the fixture nonce")
    finally:
        try:
            await asyncio.wait_for(session.stop(), TIMEOUT_SECONDS)
            stopped = True
        finally:
            server.shutdown()
            server.server_close()

    if not stopped:
        raise RuntimeError("browser session did not stop cleanly")
    completed_at = datetime.now(UTC)
    return {
        "schemaVersion": "dsh-luban/m11-browser-kernel-smoke/v1",
        "target": target,
        "status": "pass",
        "startedAt": started_at.isoformat().replace("+00:00", "Z"),
        "completedAt": completed_at.isoformat().replace("+00:00", "Z"),
        "browser": str(browser),
        "browserUseVersion": importlib.metadata.version("browser-use"),
        "pythonVersion": platform.python_version(),
        "platform": platform.platform(),
        "fixture": {
            "urlMatched": True,
            "nonceObserved": True,
            "browserErrors": list(state.browser_errors),
        },
        "cleanStop": True,
    }


async def main() -> int:
    args = parse_args()
    evidence = await run_smoke(args.target, args.browser, args.output)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(evidence, stream, ensure_ascii=False, sort_keys=True)
        stream.write("\n")
    print(json.dumps(evidence, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
