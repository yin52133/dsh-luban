"""Cross-platform browser profile resolution."""

from __future__ import annotations

import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import BridgeError

_KERNELS = {"auto", "chrome", "edge", "chromium-headless"}


@dataclass(slots=True)
class ResolvedProfile:
    """Resolved browser-use kwargs plus ownership of an isolated profile."""

    public: dict[str, Any]
    browser_kwargs: dict[str, Any]
    isolated_dir: Path | None

    def cleanup(self) -> None:
        if self.isolated_dir is not None:
            shutil.rmtree(self.isolated_dir, ignore_errors=True)


def resolve_profile(
    raw: dict[str, Any] | None,
    *,
    platform: str | None = None,
) -> ResolvedProfile:
    """Resolve `auto` to a safe browser-use profile on Windows or Linux."""

    source = raw or {}
    current_platform = platform or sys.platform
    kernel = source.get("kernel", "auto")
    if not isinstance(kernel, str) or kernel not in _KERNELS:
        raise BridgeError("E_BROWSER_INVALID_PROFILE", "Unsupported browser kernel")

    requested_headless = source.get("headless")
    if requested_headless is not None and not isinstance(requested_headless, bool):
        raise BridgeError("E_BROWSER_INVALID_PROFILE", "headless must be a boolean")

    executable_path = source.get("executablePath")
    if executable_path is not None and not isinstance(executable_path, str):
        raise BridgeError("E_BROWSER_INVALID_PROFILE", "executablePath must be a string")

    user_data_dir = source.get("userDataDir")
    isolated_dir: Path | None = None
    if user_data_dir is None:
        isolated_dir = Path(tempfile.mkdtemp(prefix="luban-browser-profile-"))
        profile_dir = isolated_dir
    elif isinstance(user_data_dir, str) and user_data_dir.strip():
        profile_dir = Path(user_data_dir).expanduser().resolve()
        profile_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    else:
        raise BridgeError("E_BROWSER_INVALID_PROFILE", "userDataDir must be a non-empty string")

    if kernel == "auto":
        resolved_kernel = "chrome" if current_platform == "win32" else "chromium-headless"
    else:
        resolved_kernel = kernel

    if resolved_kernel == "chromium-headless" and requested_headless is False:
        raise BridgeError(
            "E_BROWSER_INVALID_PROFILE",
            "chromium-headless cannot be configured with headless=false",
        )

    channel = {
        "chrome": "chrome",
        "edge": "msedge",
        "chromium-headless": "chromium",
    }[resolved_kernel]
    headless = (
        requested_headless
        if requested_headless is not None
        else resolved_kernel == "chromium-headless"
    )
    browser_kwargs: dict[str, Any] = {
        "channel": channel,
        "headless": headless,
        "user_data_dir": str(profile_dir),
        "enable_default_extensions": False,
    }
    if executable_path is not None:
        browser_kwargs["executable_path"] = str(Path(executable_path).expanduser().resolve())

    return ResolvedProfile(
        public={
            "kernel": resolved_kernel,
            "headless": headless,
            "isolated": isolated_dir is not None,
        },
        browser_kwargs=browser_kwargs,
        isolated_dir=isolated_dir,
    )
