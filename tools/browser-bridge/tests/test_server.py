from __future__ import annotations

import asyncio
import unittest
from typing import Any

from luban_browser_bridge.server import BridgeServer


class FakeEngine:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self.release = asyncio.Event()

    async def start(self, profile: dict[str, Any] | None) -> dict[str, Any]:
        self.started = True
        return {"kernel": (profile or {}).get("kernel", "auto"), "isolated": True}

    async def run(self, spec: dict[str, Any], emit, cancelled: asyncio.Event) -> dict[str, Any]:
        await emit({"type": "progress", "runId": spec["runId"], "step": 1, "detail": "mock"})
        await self.release.wait()
        return {
            "runId": spec["runId"],
            "status": "ok",
            "screenshots": [],
            "text": "mock result",
            "steps": 1,
            "durationMs": 1,
        }

    async def stop(self) -> None:
        self.stopped = True


def request(request_id: str, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"v": 1, "id": request_id, "kind": "request", "method": method, "params": params or {}}


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.engine = FakeEngine()
        self.server = BridgeServer(lambda: self.engine)
        self.frames: list[dict[str, Any]] = []

    async def asyncTearDown(self) -> None:
        await self.server.close()

    async def emit(self, frame: dict[str, Any]) -> None:
        self.frames.append(frame)

    async def test_streams_run_events_and_result(self) -> None:
        await self.server.handle(request("start", "start", {"profile": {}}), self.emit)
        await self.server.handle(
            request("run", "run", {"runId": "R1", "goal": "mock", "timeoutSec": 2}),
            self.emit,
        )
        await asyncio.sleep(0)
        self.engine.release.set()
        await asyncio.sleep(0.01)
        self.assertTrue(any(frame.get("kind") == "event" for frame in self.frames))
        result = next(
            frame
            for frame in self.frames
            if frame.get("id") == "run" and frame.get("kind") == "response"
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["text"], "mock result")

    async def test_cancel_returns_stable_error(self) -> None:
        await self.server.handle(request("start", "start", {"profile": {}}), self.emit)
        await self.server.handle(
            request("run", "run", {"runId": "R2", "goal": "mock", "timeoutSec": 2}),
            self.emit,
        )
        await asyncio.sleep(0)
        await self.server.handle(request("cancel", "cancel", {"runId": "R2"}), self.emit)
        await asyncio.sleep(0.01)
        failure = next(
            frame
            for frame in self.frames
            if frame.get("id") == "run" and frame.get("kind") == "response"
        )
        self.assertFalse(failure["ok"])
        self.assertEqual(failure["error"]["code"], "E_BROWSER_CANCELLED")

    async def test_rejects_concurrent_run(self) -> None:
        await self.server.handle(request("start", "start", {"profile": {}}), self.emit)
        await self.server.handle(
            request("first", "run", {"runId": "R1", "goal": "mock", "timeoutSec": 2}),
            self.emit,
        )
        await self.server.handle(
            request("second", "run", {"runId": "R2", "goal": "mock", "timeoutSec": 2}),
            self.emit,
        )
        busy = next(frame for frame in self.frames if frame.get("id") == "second")
        self.assertEqual(busy["error"]["code"], "E_BROWSER_BUSY")


if __name__ == "__main__":
    unittest.main()
