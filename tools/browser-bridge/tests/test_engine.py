"""Tests for the browser-use adapter using an in-memory fake engine API."""

from __future__ import annotations

import asyncio
import base64
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from luban_browser_bridge.engine import BrowserUseEngine


class _FakeProfile:
    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs


class _FakeHistory:
    def final_result(self) -> str:
        return '{"answer":"ok"}'

    def number_of_steps(self) -> int:
        return 1

    def screenshot_paths(self, *, return_none_if_not_screenshot: bool) -> list[str]:
        assert return_none_if_not_screenshot is False
        return []

    def is_successful(self) -> bool:
        return True


class _FakeAgent:
    closed = False

    def __init__(self, **kwargs: object) -> None:
        self._step = kwargs["register_new_step_callback"]

    async def run(self, *, max_steps: int) -> _FakeHistory:
        assert max_steps == 3
        state = types.SimpleNamespace(screenshot=base64.b64encode(b"png-data").decode())
        output = types.SimpleNamespace(current_state=types.SimpleNamespace(next_goal="done"))
        await self._step(state, output, 1)
        return _FakeHistory()

    async def close(self) -> None:
        type(self).closed = True


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def test_streams_inline_screenshot_and_structured_result(self) -> None:
        fake_module = types.SimpleNamespace(Agent=_FakeAgent, BrowserProfile=_FakeProfile)
        events: list[dict[str, object]] = []
        _FakeAgent.closed = False
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("luban_browser_bridge.engine.importlib.metadata.version", return_value="0.13.8"),
            patch("luban_browser_bridge.engine.importlib.import_module", return_value=fake_module),
        ):
            engine = BrowserUseEngine()
            await engine.start({"kernel": "chromium-headless"})
            result = await engine.run(
                {
                    "runId": "run-1",
                    "goal": "Return data",
                    "maxSteps": 3,
                    "allowDomains": ["example.com"],
                    "outputDir": directory,
                    "outputSchema": {
                        "type": "object",
                        "required": ["answer"],
                        "properties": {"answer": {"type": "string"}},
                    },
                },
                lambda event: _append(events, event),
                asyncio.Event(),
            )
            await engine.stop()

            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["structured"], {"answer": "ok"})
            self.assertEqual(len(result["screenshots"]), 1)
            screenshot = Path(result["screenshots"][0])
            self.assertEqual(await asyncio.to_thread(screenshot.read_bytes), b"png-data")
            self.assertEqual([event["type"] for event in events], ["progress", "screenshot"])
            self.assertTrue(_FakeAgent.closed)


async def _append(events: list[dict[str, object]], event: dict[str, object]) -> None:
    events.append(event)
