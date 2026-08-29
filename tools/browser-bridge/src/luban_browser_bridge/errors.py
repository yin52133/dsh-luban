"""Stable, non-sensitive bridge error vocabulary."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class ErrorPayload:
    """Error body sent over the JSONL boundary."""

    code: str
    message: str
    retriable: bool = False

    def to_json(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "retriable": self.retriable,
        }


class BridgeError(Exception):
    """Expected bridge failure with a stable public error code."""

    def __init__(self, code: str, message: str, *, retriable: bool = False) -> None:
        super().__init__(message)
        self.payload = ErrorPayload(code=code, message=message, retriable=retriable)


def error_payload(error: BaseException) -> ErrorPayload:
    """Convert an exception without serializing causes or tracebacks."""

    if isinstance(error, BridgeError):
        return error.payload
    if isinstance(error, TimeoutError):
        return ErrorPayload("E_BROWSER_TIMEOUT", "Browser task timed out", True)
    return ErrorPayload("E_BROWSER_RUN", "Browser task failed", False)
