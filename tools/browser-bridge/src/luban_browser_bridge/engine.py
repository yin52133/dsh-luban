"""Thin browser-use 0.13.8 adapter; no browser logic is reimplemented here."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import importlib
import importlib.metadata
import json
import logging
import os
import re
import shutil
import tempfile
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol

from .dsh_model import DshChatModel
from .errors import BridgeError
from .hal import ResolvedProfile, resolve_profile
from .security import assert_url_allowed

EventSink = Callable[[dict[str, Any]], Awaitable[None]]
_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024
_MAX_SCREENSHOT_TOTAL_BYTES = 256 * 1024 * 1024
_BROWSER_USE_PROFILE_PREFIX = "browser-use-user-data-dir-"


class BrowserEngine(Protocol):
    """Engine seam used by tests so they never launch a browser or LLM."""

    async def start(self, profile: dict[str, Any] | None) -> dict[str, Any]: ...

    async def run(
        self,
        spec: dict[str, Any],
        emit: EventSink,
        cancelled: asyncio.Event,
    ) -> dict[str, Any]: ...

    async def stop(self) -> None: ...


class BrowserUseEngine:
    """Lazy adapter around the public browser-use API."""

    def __init__(self) -> None:
        self._profile: ResolvedProfile | None = None
        self._logger = logging.getLogger("luban_browser_bridge.engine")

    async def start(self, profile: dict[str, Any] | None) -> dict[str, Any]:
        if importlib.metadata.version("browser-use") != "0.13.8":
            raise BridgeError(
                "E_BROWSER_VERSION",
                "browser-use runtime version does not match 0.13.8",
            )
        await self.stop()
        self._profile = await asyncio.to_thread(resolve_profile, profile)
        return dict(self._profile.public)

    async def run(
        self,
        spec: dict[str, Any],
        emit: EventSink,
        cancelled: asyncio.Event,
    ) -> dict[str, Any]:
        profile = self._profile
        if profile is None:
            raise BridgeError("E_BROWSER_NOT_STARTED", "Browser bridge is not started")

        run_id = _required_string(spec, "runId")
        if _RUN_ID.fullmatch(run_id) is None:
            raise BridgeError("E_BROWSER_INVALID_TASK", "runId contains unsafe characters")
        goal = _required_string(spec, "goal")
        start_url = _optional_string(spec, "startUrl")
        max_steps = _bounded_int(spec.get("maxSteps", 30), "maxSteps", 1, 500)
        allow_domains = _string_list(spec.get("allowDomains", []), "allowDomains")
        try:
            assert_url_allowed(start_url, allow_domains)
        except ValueError as error:
            raise BridgeError("E_BROWSER_INVALID_TASK", str(error)) from error
        output_root = await asyncio.to_thread(
            _prepare_output_root, _required_string(spec, "outputDir")
        )
        output_dir = output_root / run_id
        try:
            await asyncio.to_thread(output_dir.mkdir, mode=0o700)
        except FileExistsError as error:
            raise BridgeError(
                "E_BROWSER_INVALID_TASK", "runId artifact directory already exists"
            ) from error
        output_schema = spec.get("outputSchema")
        if output_schema is not None and not isinstance(output_schema, dict):
            raise BridgeError("E_BROWSER_INVALID_TASK", "outputSchema must be an object")

        browser_use = importlib.import_module("browser_use")
        agent_type = getattr(browser_use, "Agent")
        profile_type = getattr(browser_use, "BrowserProfile")
        kwargs = dict(profile.browser_kwargs)
        kwargs["allowed_domains"] = allow_domains or None
        screenshots: list[str] = []
        seen_screenshots: set[str] = set()
        stored_screenshot_bytes = 0

        async def store_screenshot(data: bytes) -> None:
            nonlocal stored_screenshot_bytes
            if (
                not data
                or len(data) > _MAX_SCREENSHOT_BYTES
                or stored_screenshot_bytes + len(data) > _MAX_SCREENSHOT_TOTAL_BYTES
            ):
                return
            digest = hashlib.sha256(data).hexdigest()
            if digest in seen_screenshots:
                return
            seen_screenshots.add(digest)
            destination = output_dir / f"step-{len(screenshots) + 1:04d}.png"

            def write() -> None:
                with destination.open("xb") as target:
                    target.write(data)

            await asyncio.to_thread(write)
            stored_screenshot_bytes += len(data)
            screenshots.append(str(destination))
            await emit({"type": "screenshot", "runId": run_id, "path": str(destination)})

        async def record_screenshot(source: str | None) -> None:
            if source is None:
                return
            data = await asyncio.to_thread(_read_screenshot, Path(source))
            if data is None:
                return
            await store_screenshot(data)

        async def record_inline_screenshot(source: str | None) -> None:
            if source is None:
                return
            try:
                data = base64.b64decode(source, validate=True)
            except (binascii.Error, ValueError):
                return
            await store_screenshot(data)

        async def on_step(state: Any, output: Any, step: int) -> None:
            current_state = getattr(output, "current_state", None)
            detail = getattr(current_state, "next_goal", None) or f"Completed step {step}"
            await emit(
                {
                    "type": "progress",
                    "runId": run_id,
                    "step": int(step),
                    "detail": str(detail),
                }
            )
            await record_inline_screenshot(getattr(state, "screenshot", None))

        async def should_stop() -> bool:
            return cancelled.is_set()

        task = _task_prompt(goal, start_url, output_schema)
        started_at = time.monotonic()
        source_user_data_dir = kwargs["user_data_dir"]
        owned_profile_copy: Path | None = None
        agent: Any | None = None
        try:
            llm = DshChatModel.from_environment()
            browser_profile = profile_type(**kwargs)
            owned_profile_copy = _owned_browser_profile_copy(
                source_user_data_dir,
                getattr(browser_profile, "user_data_dir", None),
            )
            agent = agent_type(
                task=task,
                llm=llm,
                browser_profile=browser_profile,
                register_new_step_callback=on_step,
                register_should_stop_callback=should_stop,
                enable_signal_handler=False,
                use_vision=False,
                use_judge=False,
            )
            history = await agent.run(max_steps=max_steps)
            for screenshot in history.screenshot_paths(return_none_if_not_screenshot=False):
                await record_screenshot(screenshot)
            text = history.final_result() or ""
            structured = _structured_result(text, output_schema)
            successful = history.is_successful()
            status = "failed" if successful is False else "ok"
            result: dict[str, Any] = {
                "runId": run_id,
                "status": status,
                "screenshots": screenshots,
                "text": text,
                "steps": int(history.number_of_steps()),
                "durationMs": int((time.monotonic() - started_at) * 1000),
            }
            if structured is not None:
                result["structured"] = structured
            return result
        except asyncio.CancelledError:
            raise
        except BridgeError:
            raise
        except Exception as error:
            # Never attach a traceback: exception chains may contain credentials from
            # provider SDKs, while the redacting log filter sanitizes this message.
            self._logger.error("browser-use run failed: %s", error)
            raise BridgeError("E_BROWSER_RUN", "browser-use task failed") from error
        finally:
            try:
                if agent is not None:
                    await agent.close()
            finally:
                if owned_profile_copy is not None:
                    await asyncio.to_thread(
                        _cleanup_owned_browser_profile_copy,
                        source_user_data_dir,
                        owned_profile_copy,
                    )

    async def stop(self) -> None:
        profile = self._profile
        self._profile = None
        if profile is not None:
            await asyncio.to_thread(profile.cleanup)


def _required_string(source: dict[str, Any], key: str) -> str:
    value = source.get(key)
    if not isinstance(value, str) or not value.strip():
        raise BridgeError("E_BROWSER_INVALID_TASK", f"{key} must be a non-empty string")
    return value.strip()


def _prepare_output_root(value: str) -> Path:
    output_root = Path(value).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return output_root


def _owned_browser_profile_copy(source: Any, candidate: Any) -> Path | None:
    """Return a browser-use owned copy only when it is a safe temp-root child."""

    if not isinstance(source, (str, os.PathLike)) or not isinstance(candidate, (str, os.PathLike)):
        return None
    source_path = _absolute_path(source)
    candidate_path = _absolute_path(candidate)
    temp_root = _absolute_path(tempfile.gettempdir())
    name = candidate_path.name
    if (
        _same_path(candidate_path, source_path)
        or not _same_path(candidate_path.parent, temp_root)
        or not name.startswith(_BROWSER_USE_PROFILE_PREFIX)
        or name == _BROWSER_USE_PROFILE_PREFIX
    ):
        return None
    try:
        if candidate_path.is_symlink() or not candidate_path.is_dir():
            return None
        resolved_candidate = candidate_path.resolve(strict=True)
        resolved_temp_child = temp_root.resolve(strict=True) / name
        resolved_source = source_path.resolve(strict=False)
    except OSError:
        return None
    if not _same_path(resolved_candidate, resolved_temp_child) or _same_path(
        resolved_candidate, resolved_source
    ):
        return None
    return candidate_path


def _cleanup_owned_browser_profile_copy(source: Any, candidate: Path) -> None:
    safe_candidate = _owned_browser_profile_copy(source, candidate)
    if safe_candidate is not None:
        shutil.rmtree(safe_candidate, ignore_errors=True)


def _absolute_path(value: str | os.PathLike[str]) -> Path:
    return Path(os.path.abspath(os.fspath(Path(value).expanduser())))


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(os.fspath(left)) == os.path.normcase(os.fspath(right))


def _read_screenshot(path: Path) -> bytes | None:
    try:
        if not path.is_file() or path.stat().st_size > _MAX_SCREENSHOT_BYTES:
            return None
        return path.read_bytes()
    except OSError:
        return None


def _optional_string(source: dict[str, Any], key: str) -> str | None:
    value = source.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise BridgeError("E_BROWSER_INVALID_TASK", f"{key} must be a non-empty string")
    return value.strip()


def _bounded_int(value: Any, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise BridgeError(
            "E_BROWSER_INVALID_TASK",
            f"{name} must be an integer between {minimum} and {maximum}",
        )
    return value


def _string_list(value: Any, name: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise BridgeError("E_BROWSER_INVALID_TASK", f"{name} must be an array of strings")
    return [item.strip() for item in value if item.strip()]


def _task_prompt(goal: str, start_url: str | None, schema: Any) -> str:
    parts = [goal]
    if start_url is not None:
        parts.append(f"Start at this URL: {start_url}")
    if schema is not None:
        parts.append(
            "Return the final answer as JSON matching this schema exactly: "
            + json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
        )
    return "\n\n".join(parts)


def _structured_result(text: str, schema: Any) -> Any:
    if schema is None or not text.strip():
        return None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise BridgeError(
            "E_BROWSER_OUTPUT_INVALID",
            "Browser result is not valid JSON required by outputSchema",
        ) from error
    _validate_schema(parsed, schema, "$", 0)
    return parsed


def _validate_schema(value: Any, schema: dict[str, Any], path: str, depth: int) -> None:
    """Validate the safe JSON Schema subset used by Luban templates."""

    if depth > 32:
        raise BridgeError("E_BROWSER_OUTPUT_INVALID", "outputSchema nesting is too deep")
    expected = schema.get("type")
    matches = {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "number": isinstance(value, int | float) and not isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "null": value is None,
    }
    if expected is not None and (not isinstance(expected, str) or not matches.get(expected, False)):
        raise BridgeError(
            "E_BROWSER_OUTPUT_INVALID", f"Browser result does not match schema at {path}"
        )
    enum = schema.get("enum")
    if enum is not None and (not isinstance(enum, list) or value not in enum):
        raise BridgeError(
            "E_BROWSER_OUTPUT_INVALID", f"Browser result does not match enum at {path}"
        )
    if isinstance(value, dict):
        required = schema.get("required", [])
        properties = schema.get("properties", {})
        if not isinstance(required, list) or not isinstance(properties, dict):
            raise BridgeError("E_BROWSER_INVALID_TASK", "Invalid outputSchema object definition")
        for key in required:
            if not isinstance(key, str) or key not in value:
                raise BridgeError(
                    "E_BROWSER_OUTPUT_INVALID", f"Browser result is missing {path}.{key}"
                )
        for key, child in properties.items():
            if key in value and isinstance(child, dict):
                _validate_schema(value[key], child, f"{path}.{key}", depth + 1)
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        child = schema["items"]
        for index, item in enumerate(value):
            _validate_schema(item, child, f"{path}[{index}]", depth + 1)
