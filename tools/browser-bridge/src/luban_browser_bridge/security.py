"""Credential redaction and navigation policy helpers."""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable
from urllib.parse import urlparse

_SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(
        r"\b(api[_-]?key|token|password|passwd|secret)\s*([:=])\s*([^\s,;]+)",
        re.IGNORECASE,
    ),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE),
    re.compile(r"\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b"),
    re.compile(r"-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----"),
)


def redact(value: str) -> str:
    """Redact common credential shapes from diagnostics."""

    output = value
    output = _SECRET_PATTERNS[0].sub(r"\1\2[REDACTED]", output)
    for pattern in _SECRET_PATTERNS[1:]:
        output = pattern.sub("[REDACTED]", output)
    return output


class RedactingFilter(logging.Filter):
    """Redact the fully rendered log record before a handler emits it."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage())
        record.args = ()
        return True


def configure_logging() -> None:
    """Configure stderr-only logs and attach redaction to every handler."""

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    redactor = RedactingFilter()
    root = logging.getLogger()
    for handler in root.handlers:
        handler.addFilter(redactor)


def normalize_domain_pattern(pattern: str) -> str:
    """Return only the host portion of a browser-use domain pattern."""

    value = pattern.strip().lower()
    if not value:
        raise ValueError("Domain patterns must not be empty")
    if "://" in value:
        parsed = urlparse(value)
        if parsed.hostname is None:
            raise ValueError(f"Invalid domain pattern: {pattern}")
        normalized = parsed.hostname
    else:
        normalized = value.split("/", 1)[0].split(":", 1)[0]
    if normalized.rstrip(".") == "*":
        raise ValueError("Wildcard domain pattern '*' is not allowed")
    return normalized


def host_matches(host: str, pattern: str) -> bool:
    """Match exact hosts and `*.example.com` subdomain patterns."""

    normalized_host = host.rstrip(".").lower()
    normalized_pattern = normalize_domain_pattern(pattern).rstrip(".")
    if normalized_pattern.startswith("*."):
        suffix = normalized_pattern[2:]
        return normalized_host == suffix or normalized_host.endswith(f".{suffix}")
    return normalized_host == normalized_pattern


def assert_url_allowed(url: str | None, allow_domains: Iterable[str]) -> None:
    """Reject a start URL outside a non-empty domain allowlist."""

    patterns = tuple(normalize_domain_pattern(pattern) for pattern in allow_domains)
    if url is None or not patterns:
        return
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname is None:
        raise ValueError("startUrl must be an absolute http(s) URL")
    if not any(host_matches(parsed.hostname, pattern) for pattern in patterns):
        raise ValueError("startUrl is outside allowDomains")
