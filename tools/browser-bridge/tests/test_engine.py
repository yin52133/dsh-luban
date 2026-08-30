"""Tests for the browser-use adapter using an in-memory fake engine API."""

from __future__ import annotations

import asyncio
import base64
import shutil
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from luban_browser_bridge import hal
from luban_browser_bridge.engine import BrowserUseEngine
from luban_browser_bridge.errors import BridgeError


class _FakeProfile:
    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs


class _CopyingFakeProfile:
    last_copy: Path | None = None

    def __init__(self, **kwargs: object) -> None:
        source = Path(str(kwargs["user_data_dir"]))
        assert source.is_dir()
        profile_copy = Path(tempfile.mkdtemp(prefix="browser-use-user-data-dir-"))
        (profile_copy / "owned-marker").touch()
        self.user_data_dir = profile_copy
        type(self).last_copy = profile_copy


class _RedirectingFakeProfile:
    target: Path | None = None

    def __init__(self, **kwargs: object) -> None:
        assert kwargs["user_data_dir"] is not None
        assert type(self).target is not None
        self.user_data_dir = type(self).target


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


class _FailingRunAgent(_FakeAgent):
    async def run(self, *, max_steps: int) -> _FakeHistory:
        assert max_steps == 3
        raise RuntimeError("simulated run failure")


class _FailingConstructorAgent:
    def __init__(self, **kwargs: object) -> None:
        assert kwargs["browser_profile"] is not None
        raise RuntimeError("simulated constructor failure")


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
            await _start_engine(engine, Path(directory))
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

    async def test_rejects_wildcard_before_loading_browser_use(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("luban_browser_bridge.engine.importlib.metadata.version", return_value="0.13.8"),
        ):
            engine = BrowserUseEngine()
            await _start_engine(engine, Path(directory))
            with self.assertRaises(BridgeError) as raised:
                await engine.run(
                    {
                        "runId": "run-wildcard",
                        "goal": "Return data",
                        "allowDomains": ["*"],
                        "outputDir": directory,
                    },
                    lambda event: _append([], event),
                    asyncio.Event(),
                )
            await engine.stop()

        self.assertEqual(raised.exception.payload.code, "E_BROWSER_INVALID_TASK")
        self.assertIn("Wildcard domain pattern", raised.exception.payload.message)

    async def test_missing_browser_fails_before_loading_browser_use(self) -> None:
        with (
            patch("luban_browser_bridge.engine.importlib.metadata.version", return_value="0.13.8"),
            patch.object(hal.sys, "platform", "win32"),
            patch.object(hal, "_browser_candidates", return_value=()),
            patch("luban_browser_bridge.engine.importlib.import_module") as import_module,
        ):
            engine = BrowserUseEngine()
            with self.assertRaises(BridgeError) as raised:
                await engine.start({"kernel": "auto"})
        self.assertEqual(raised.exception.payload.code, "E_BROWSER_UNAVAILABLE")
        import_module.assert_not_called()

    async def test_removes_browser_use_profile_copy_for_every_agent_outcome(self) -> None:
        cases: tuple[tuple[str, type[object], bool], ...] = (
            ("success", _FakeAgent, False),
            ("run-failure", _FailingRunAgent, True),
            ("constructor-failure", _FailingConstructorAgent, True),
        )
        for label, agent_type, expects_failure in cases:
            with self.subTest(outcome=label), tempfile.TemporaryDirectory() as directory:
                _CopyingFakeProfile.last_copy = None
                root = Path(directory)
                caller_profile = root / "caller-profile"
                caller_profile.mkdir()
                try:
                    if expects_failure:
                        with self.assertRaises(BridgeError) as raised:
                            await _execute(
                                _CopyingFakeProfile,
                                agent_type,
                                caller_profile,
                                root / "output",
                                f"run-{label}",
                            )
                        self.assertEqual(raised.exception.payload.code, "E_BROWSER_RUN")
                    else:
                        result = await _execute(
                            _CopyingFakeProfile,
                            agent_type,
                            caller_profile,
                            root / "output",
                            f"run-{label}",
                        )
                        self.assertEqual(result["status"], "ok")

                    self.assertFalse(_required_copy().exists())
                    self.assertTrue(caller_profile.is_dir())
                finally:
                    _remove_leftover_copy()

    async def test_does_not_remove_non_temp_root_profile_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            caller_profile = root / "caller-profile"
            caller_profile.mkdir()
            unexpected_profile = root / "browser-use-user-data-dir-not-owned"
            unexpected_profile.mkdir()
            _RedirectingFakeProfile.target = unexpected_profile
            try:
                await _execute(
                    _RedirectingFakeProfile,
                    _FakeAgent,
                    caller_profile,
                    root / "output",
                    "run-unowned-profile",
                )

                self.assertTrue(unexpected_profile.is_dir())
                self.assertTrue(caller_profile.is_dir())
            finally:
                _RedirectingFakeProfile.target = None


async def _append(events: list[dict[str, object]], event: dict[str, object]) -> None:
    events.append(event)


def _run_spec(output_dir: Path, run_id: str) -> dict[str, object]:
    return {
        "runId": run_id,
        "goal": "Return data",
        "maxSteps": 3,
        "allowDomains": ["example.com"],
        "outputDir": str(output_dir),
    }


async def _execute(
    profile_type: type[object],
    agent_type: type[object],
    caller_profile: Path,
    output_dir: Path,
    run_id: str,
) -> dict[str, object]:
    fake_module = types.SimpleNamespace(Agent=agent_type, BrowserProfile=profile_type)
    engine = BrowserUseEngine()
    try:
        with (
            patch("luban_browser_bridge.engine.importlib.metadata.version", return_value="0.13.8"),
            patch(
                "luban_browser_bridge.engine.importlib.import_module",
                return_value=fake_module,
            ),
        ):
            await _start_engine(engine, caller_profile.parent, caller_profile)
            return await engine.run(
                _run_spec(output_dir, run_id),
                lambda event: _append([], event),
                asyncio.Event(),
            )
    finally:
        await engine.stop()


async def _start_engine(
    engine: BrowserUseEngine,
    root: Path,
    user_data_dir: Path | None = None,
) -> None:
    browser = root / "attested-chrome.exe"
    browser.write_bytes(b"test-chrome-binary")
    profile: dict[str, object] = {
        "kernel": "chrome",
        "executablePath": str(browser),
    }
    if user_data_dir is not None:
        profile["userDataDir"] = str(user_data_dir)
    with (
        patch.object(hal.sys, "platform", "win32"),
        patch.object(
            hal,
            "_probe_browser_identity",
            return_value=("chrome", "140.0.0.0"),
        ),
    ):
        await engine.start(profile)


def _required_copy() -> Path:
    profile_copy = _CopyingFakeProfile.last_copy
    assert profile_copy is not None
    return profile_copy


def _remove_leftover_copy() -> None:
    profile_copy = _CopyingFakeProfile.last_copy
    if profile_copy is not None:
        shutil.rmtree(profile_copy, ignore_errors=True)
    _CopyingFakeProfile.last_copy = None
