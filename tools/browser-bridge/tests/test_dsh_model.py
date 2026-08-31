"""Tests for the browser-use model adapter backed by the DSH parent process."""

from __future__ import annotations

import json
import unittest

import httpx
from browser_use.llm.exceptions import ModelProviderError
from browser_use.llm.messages import SystemMessage, UserMessage
from pydantic import BaseModel

from luban_browser_bridge.dsh_model import DshChatModel
from luban_browser_bridge.errors import BridgeError


class _Output(BaseModel):
    answer: str


class DshChatModelTests(unittest.IsolatedAsyncioTestCase):
    async def test_forwards_messages_schema_and_usage_without_a_provider_key(self) -> None:
        observed: dict[str, object] = {}

        async def handler(request: httpx.Request) -> httpx.Response:
            observed["authorization"] = request.headers.get("authorization")
            observed["payload"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "text": '{"answer":"ok"}',
                    "stopReason": "stop",
                    "usage": {
                        "inputTokens": 10,
                        "outputTokens": 3,
                        "cacheReadTokens": 2,
                    },
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            model = DshChatModel(
                "http://127.0.0.1:42601/v1/browser-use/complete",
                "token-" + "a" * 40,
                client=client,
            )
            result = await model.ainvoke(
                [SystemMessage(content="system"), UserMessage(content="question")],
                _Output,
            )

        self.assertEqual(result.completion, _Output(answer="ok"))
        self.assertEqual(result.usage.prompt_tokens, 12)
        self.assertEqual(result.usage.completion_tokens, 3)
        self.assertEqual(observed["authorization"], "Bearer token-" + "a" * 40)
        payload = observed["payload"]
        assert isinstance(payload, dict)
        self.assertEqual([message["role"] for message in payload["messages"]], ["system", "user"])
        self.assertEqual(payload["outputSchema"]["required"], ["answer"])

    async def test_rejects_non_loopback_or_missing_parent_configuration(self) -> None:
        with self.assertRaises(BridgeError):
            DshChatModel("https://example.com/v1/browser-use/complete", "a" * 64)
        with self.assertRaises(BridgeError):
            DshChatModel("http://127.0.0.1:42601/wrong", "a" * 64)

    async def test_contains_parent_failures(self) -> None:
        async def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, text="credential-bearing parent diagnostic")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            model = DshChatModel(
                "http://127.0.0.1:42601/v1/browser-use/complete",
                "a" * 64,
                client=client,
            )
            with self.assertRaises(ModelProviderError) as raised:
                await model.ainvoke([UserMessage(content="question")])

        self.assertEqual(str(raised.exception), "DSH model bridge request failed")
