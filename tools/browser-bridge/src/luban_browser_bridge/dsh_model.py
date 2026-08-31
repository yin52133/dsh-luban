"""browser-use chat model backed by DSH's in-process LLM runtime."""

from __future__ import annotations

import os
from typing import Any, TypeVar, overload
from urllib.parse import urlsplit

import httpx
from browser_use.llm.exceptions import ModelProviderError
from browser_use.llm.messages import BaseMessage
from browser_use.llm.views import ChatInvokeCompletion, ChatInvokeUsage
from pydantic import BaseModel

from .errors import BridgeError

_ENDPOINT_ENVIRONMENT = "LUBAN_BROWSER_DSH_LLM_URL"
_TOKEN_ENVIRONMENT = "LUBAN_BROWSER_DSH_LLM_TOKEN"
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
T = TypeVar("T", bound=BaseModel)


class DshChatModel:
    """Forward browser-use model turns to the parent DSH process over loopback."""

    _verified_api_keys = True
    model = "dsh-default"

    def __init__(
        self,
        endpoint: str,
        token: str,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._endpoint = _loopback_endpoint(endpoint)
        if len(token) < 32 or any(character.isspace() for character in token):
            raise BridgeError(
                "E_BROWSER_MODEL_UNAVAILABLE",
                "DSH model bridge token is unavailable",
            )
        self._token = token
        self._client = client

    @classmethod
    def from_environment(cls) -> DshChatModel:
        """Create the model from parent-owned ephemeral bridge settings."""

        endpoint = os.environ.get(_ENDPOINT_ENVIRONMENT, "")
        token = os.environ.get(_TOKEN_ENVIRONMENT, "")
        if not endpoint or not token:
            raise BridgeError(
                "E_BROWSER_MODEL_UNAVAILABLE",
                "DSH model bridge is not configured",
            )
        return cls(endpoint, token)

    @property
    def provider(self) -> str:
        return "dsh"

    @property
    def name(self) -> str:
        return self.model

    @property
    def model_name(self) -> str:
        """Expose the legacy browser-use model identifier."""

        return self.model

    @overload
    async def ainvoke(
        self,
        messages: list[BaseMessage],
        output_format: None = None,
        **kwargs: Any,
    ) -> ChatInvokeCompletion[str]: ...

    @overload
    async def ainvoke(
        self,
        messages: list[BaseMessage],
        output_format: type[T],
        **kwargs: Any,
    ) -> ChatInvokeCompletion[T]: ...

    async def ainvoke(
        self,
        messages: list[BaseMessage],
        output_format: type[T] | None = None,
        **kwargs: Any,
    ) -> ChatInvokeCompletion[T] | ChatInvokeCompletion[str]:
        """Invoke the current DSH default model without exposing its credentials."""

        del kwargs
        request: dict[str, Any] = {
            "messages": [message.model_dump(mode="json", exclude_none=True) for message in messages]
        }
        if output_format is not None:
            request["outputSchema"] = output_format.model_json_schema()
        try:
            response = await self._post(request)
            response.raise_for_status()
            if len(response.content) > _MAX_RESPONSE_BYTES:
                raise ValueError("DSH model bridge response is too large")
            decoded = response.json()
            if not isinstance(decoded, dict) or not isinstance(decoded.get("text"), str):
                raise ValueError("DSH model bridge response is invalid")
            text = decoded["text"]
            completion: T | str = (
                text if output_format is None else output_format.model_validate_json(text)
            )
            usage = _usage(decoded.get("usage"))
            stop_reason = decoded.get("stopReason")
            if stop_reason is not None and not isinstance(stop_reason, str):
                raise ValueError("DSH model bridge stop reason is invalid")
            return ChatInvokeCompletion(
                completion=completion,
                usage=usage,
                stop_reason=stop_reason,
            )
        except BridgeError:
            raise
        except Exception as error:
            raise ModelProviderError(
                message="DSH model bridge request failed",
                model=self.name,
            ) from error

    async def _post(self, request: dict[str, Any]) -> httpx.Response:
        headers = {"authorization": f"Bearer {self._token}"}
        if self._client is not None:
            return await self._client.post(self._endpoint, headers=headers, json=request)
        async with httpx.AsyncClient(timeout=120.0) as client:
            return await client.post(self._endpoint, headers=headers, json=request)


def _loopback_endpoint(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise BridgeError(
            "E_BROWSER_MODEL_UNAVAILABLE",
            "DSH model bridge endpoint is invalid",
        ) from error
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "::1"}
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path != "/v1/browser-use/complete"
    ):
        raise BridgeError(
            "E_BROWSER_MODEL_UNAVAILABLE",
            "DSH model bridge endpoint must be an exact loopback URL",
        )
    return value


def _usage(value: Any) -> ChatInvokeUsage | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("DSH model bridge usage is invalid")
    input_tokens = _token_count(value.get("inputTokens"), "inputTokens")
    output_tokens = _token_count(value.get("outputTokens"), "outputTokens")
    cache_read_tokens = _optional_token_count(value.get("cacheReadTokens"), "cacheReadTokens")
    cache_write_tokens = _optional_token_count(
        value.get("cacheWriteTokens"), "cacheWriteTokens"
    )
    return ChatInvokeUsage(
        prompt_tokens=input_tokens + (cache_read_tokens or 0) + (cache_write_tokens or 0),
        prompt_cached_tokens=cache_read_tokens,
        prompt_cache_creation_tokens=cache_write_tokens,
        prompt_image_tokens=None,
        completion_tokens=output_tokens,
        total_tokens=input_tokens
        + output_tokens
        + (cache_read_tokens or 0)
        + (cache_write_tokens or 0),
    )


def _token_count(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"DSH model bridge {name} is invalid")
    return value


def _optional_token_count(value: Any, name: str) -> int | None:
    return None if value is None else _token_count(value, name)
