"""Concurrent JSONL request server with cancellation and timeout support."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from collections.abc import Awaitable, Callable
from typing import Any, TextIO

from .engine import BrowserEngine, BrowserUseEngine
from .errors import BridgeError, ErrorPayload, error_payload
from .version import BRIDGE_VERSION

FrameSink = Callable[[dict[str, Any]], Awaitable[None]]


class BridgeServer:
    """Stateful protocol server. One browser task may run at a time."""

    def __init__(self, engine_factory: Callable[[], BrowserEngine] = BrowserUseEngine) -> None:
        self._engine_factory = engine_factory
        self._engine: BrowserEngine | None = None
        self._run_task: asyncio.Task[None] | None = None
        self._run_id: str | None = None
        self._cancel_event: asyncio.Event | None = None
        self._stopping = False
        self._logger = logging.getLogger("luban_browser_bridge.server")

    async def handle(self, frame: Any, emit: FrameSink) -> bool:
        """Handle one decoded request. Return false after shutdown."""

        request_id = ""
        try:
            if not isinstance(frame, dict):
                raise BridgeError("E_BROWSER_PROTOCOL", "Protocol frame must be an object")
            request_id = frame.get("id", "")
            if not isinstance(request_id, str) or not request_id:
                raise BridgeError("E_BROWSER_PROTOCOL", "Protocol frame id is required")
            if frame.get("v") != 1 or frame.get("kind") != "request":
                raise BridgeError("E_BROWSER_PROTOCOL", "Unsupported protocol frame")
            method = frame.get("method")
            params = frame.get("params", {})
            if not isinstance(method, str) or not isinstance(params, dict):
                raise BridgeError("E_BROWSER_PROTOCOL", "Invalid request method or params")

            if method == "ping":
                await self._success(
                    request_id,
                    {
                        "bridgeVersion": BRIDGE_VERSION,
                        "browserUseVersion": "0.13.8",
                        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
                    },
                    emit,
                )
            elif method == "start":
                await self._start(request_id, params, emit)
            elif method == "run":
                await self._begin_run(request_id, params, emit)
            elif method == "cancel":
                await self._cancel(request_id, params, emit)
            elif method == "stop":
                await self._stop()
                await self._success(request_id, {"stopped": True}, emit)
            elif method == "shutdown":
                await self._stop()
                self._stopping = True
                await self._success(request_id, {"stopped": True}, emit)
                return False
            else:
                raise BridgeError("E_BROWSER_PROTOCOL", "Unknown protocol method")
        except Exception as error:
            await self._failure(request_id, error_payload(error), emit)
        return True

    async def close(self) -> None:
        await self._stop()
        self._stopping = True

    async def _start(self, request_id: str, params: dict[str, Any], emit: FrameSink) -> None:
        if self._run_task is not None:
            raise BridgeError("E_BROWSER_BUSY", "Cannot change profile while a task is running")
        profile = params.get("profile")
        if profile is not None and not isinstance(profile, dict):
            raise BridgeError("E_BROWSER_INVALID_PROFILE", "profile must be an object")
        if self._engine is None:
            self._engine = self._engine_factory()
        resolved = await self._engine.start(profile)
        await self._success(request_id, {"profile": resolved}, emit)

    async def _begin_run(self, request_id: str, params: dict[str, Any], emit: FrameSink) -> None:
        if self._engine is None:
            raise BridgeError("E_BROWSER_NOT_STARTED", "Browser bridge is not started")
        if self._run_task is not None:
            raise BridgeError("E_BROWSER_BUSY", "A browser task is already running", retriable=True)
        run_id = params.get("runId")
        if not isinstance(run_id, str) or not run_id:
            raise BridgeError("E_BROWSER_INVALID_TASK", "runId is required")
        timeout_sec = params.get("timeoutSec", 300)
        if (
            isinstance(timeout_sec, bool)
            or not isinstance(timeout_sec, int)
            or not 1 <= timeout_sec <= 3600
        ):
            raise BridgeError("E_BROWSER_INVALID_TASK", "timeoutSec must be between 1 and 3600")
        self._run_id = run_id
        self._cancel_event = asyncio.Event()
        self._run_task = asyncio.create_task(
            self._execute_run(request_id, params, timeout_sec, emit),
            name=f"browser-run:{run_id}",
        )

    async def _execute_run(
        self,
        request_id: str,
        params: dict[str, Any],
        timeout_sec: int,
        emit: FrameSink,
    ) -> None:
        engine = self._engine
        cancel_event = self._cancel_event
        assert engine is not None and cancel_event is not None

        async def emit_event(event: dict[str, Any]) -> None:
            await emit({"v": 1, "id": request_id, "kind": "event", "event": event})

        try:
            async with asyncio.timeout(timeout_sec):
                result = await engine.run(params, emit_event, cancel_event)
            await self._success(request_id, result, emit)
        except asyncio.CancelledError:
            await self._failure(
                request_id,
                ErrorPayload("E_BROWSER_CANCELLED", "Browser task was cancelled", True),
                emit,
            )
        except TimeoutError:
            cancel_event.set()
            await self._failure(
                request_id,
                ErrorPayload("E_BROWSER_TIMEOUT", "Browser task timed out", True),
                emit,
            )
        except Exception as error:
            # Keep exception chains and tracebacks out of stderr because upstream
            # provider errors may embed request headers or credentials.
            self._logger.error("browser task failed: %s", error)
            await self._failure(request_id, error_payload(error), emit)
        finally:
            self._run_task = None
            self._run_id = None
            self._cancel_event = None

    async def _cancel(self, request_id: str, params: dict[str, Any], emit: FrameSink) -> None:
        run_id = params.get("runId")
        if not isinstance(run_id, str) or not run_id:
            raise BridgeError("E_BROWSER_INVALID_TASK", "runId is required")
        cancelled = self._run_task is not None and self._run_id == run_id
        if cancelled:
            assert self._cancel_event is not None and self._run_task is not None
            self._cancel_event.set()
            self._run_task.cancel()
        await self._success(request_id, {"cancelled": cancelled}, emit)

    async def _stop(self) -> None:
        task = self._run_task
        if task is not None:
            if self._cancel_event is not None:
                self._cancel_event.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if self._engine is not None:
            await self._engine.stop()
            self._engine = None

    @staticmethod
    async def _success(request_id: str, result: Any, emit: FrameSink) -> None:
        await emit({"v": 1, "id": request_id, "kind": "response", "ok": True, "result": result})

    @staticmethod
    async def _failure(request_id: str, error: ErrorPayload, emit: FrameSink) -> None:
        await emit(
            {
                "v": 1,
                "id": request_id,
                "kind": "response",
                "ok": False,
                "error": error.to_json(),
            }
        )


async def serve_stdio(
    server: BridgeServer,
    stdin: TextIO = sys.stdin,
    stdout: TextIO = sys.stdout,
) -> None:
    """Run the cross-platform stdio loop; stdout remains protocol-only."""

    write_lock = asyncio.Lock()

    async def emit(frame: dict[str, Any]) -> None:
        encoded = json.dumps(frame, ensure_ascii=False, separators=(",", ":"))
        async with write_lock:
            stdout.write(f"{encoded}\n")
            stdout.flush()

    try:
        while True:
            line = await asyncio.to_thread(stdin.readline)
            if line == "":
                break
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                await server._failure(
                    "",
                    ErrorPayload("E_BROWSER_PROTOCOL", "Input is not valid JSON"),
                    emit,
                )
                continue
            if not await server.handle(frame, emit):
                break
    finally:
        await server.close()
