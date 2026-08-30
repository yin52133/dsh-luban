"""Cross-platform browser profile resolution."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import BridgeError

_KERNELS = {"auto", "chrome", "edge", "chromium-headless"}
_BINARY_KINDS = {"chrome", "edge", "chromium"}
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_VERSION = re.compile(r"^\d+(?:\.\d+){1,3}(?:[-+._A-Za-z0-9]*)?$")


@dataclass(frozen=True, slots=True)
class BrowserBinary:
    """Canonical executable and non-sensitive identity returned to the host."""

    path: Path
    kind: str
    version: str
    sha256: str


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
    read_os_release: Callable[[], str] | None = None,
) -> ResolvedProfile:
    """Resolve a profile to one explicit, attested browser executable."""

    source = raw or {}
    current_platform = platform or sys.platform
    kernel = source.get("kernel", "auto")
    if not isinstance(kernel, str) or kernel not in _KERNELS:
        raise BridgeError("E_BROWSER_INVALID_PROFILE", "Unsupported browser kernel")

    requested_headless = source.get("headless")
    if requested_headless is not None and not isinstance(requested_headless, bool):
        raise BridgeError("E_BROWSER_INVALID_PROFILE", "headless must be a boolean")

    executable_path = source.get("executablePath")
    if executable_path is not None and (
        not isinstance(executable_path, str) or not executable_path.strip()
    ):
        raise BridgeError("E_BROWSER_INVALID_PROFILE", "executablePath must be a non-empty string")

    resolved_kernel = _resolve_kernel(kernel, current_platform, read_os_release)
    if resolved_kernel == "chromium-headless" and requested_headless is False:
        raise BridgeError(
            "E_BROWSER_INVALID_PROFILE",
            "chromium-headless cannot be configured with headless=false",
        )
    binary = _resolve_browser_binary(
        resolved_kernel,
        current_platform,
        executable_path.strip() if isinstance(executable_path, str) else None,
    )
    if resolved_kernel == "auto":
        resolved_kernel = "chrome" if binary.kind == "chrome" else "edge"

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
        # browser-use gives an explicit path priority over every fallback and its
        # uvx Playwright installer. Never let the dependency choose another binary.
        "executable_path": str(binary.path),
    }

    return ResolvedProfile(
        public={
            "kernel": resolved_kernel,
            "headless": headless,
            "isolated": isolated_dir is not None,
            "binary": {
                "kind": binary.kind,
                "version": binary.version,
                "sha256": binary.sha256,
            },
        },
        browser_kwargs=browser_kwargs,
        isolated_dir=isolated_dir,
    )


def _resolve_kernel(
    requested: str,
    current_platform: str,
    read_os_release: Callable[[], str] | None,
) -> str:
    if current_platform == "win32":
        if requested == "chromium-headless":
            raise BridgeError(
                "E_BROWSER_INVALID_PROFILE",
                "chromium-headless is supported only on Ubuntu",
            )
        if requested == "auto":
            return "auto"
        return requested
    if current_platform != "linux":
        raise BridgeError(
            "E_BROWSER_INVALID_PROFILE", "Browser bridge supports only Windows and Ubuntu"
        )
    release_reader = read_os_release or (lambda: Path("/etc/os-release").read_text("utf-8"))
    try:
        release = release_reader()
    except (OSError, UnicodeError) as error:
        raise BridgeError("E_BROWSER_INVALID_PROFILE", "Ubuntu identity is unavailable") from error
    if len(release.encode("utf-8")) > 64 * 1024 or _os_release_id(release) != "ubuntu":
        raise BridgeError(
            "E_BROWSER_INVALID_PROFILE",
            "Linux browser bridge requires ID=ubuntu in /etc/os-release",
        )
    if requested not in {"auto", "chromium-headless"}:
        raise BridgeError("E_BROWSER_INVALID_PROFILE", "Ubuntu supports only chromium-headless")
    return "chromium-headless"


def _resolve_browser_binary(
    kernel: str,
    current_platform: str,
    explicit_path: str | None,
) -> BrowserBinary:
    expected_kinds = (
        ("chrome", "edge")
        if current_platform == "win32" and kernel == "auto"
        else (_kind_for_kernel(kernel),)
    )
    if explicit_path is not None:
        candidate = _attest_browser_binary(Path(explicit_path), current_platform)
        if candidate.kind not in expected_kinds:
            raise BridgeError(
                "E_BROWSER_INVALID_PROFILE",
                "Explicit browser executable does not match the requested kernel",
            )
        return candidate

    failures: list[Exception] = []
    for kind in expected_kinds:
        for candidate_path in _browser_candidates(current_platform, kind):
            try:
                candidate = _attest_browser_binary(candidate_path, current_platform)
            except (BridgeError, OSError, subprocess.SubprocessError) as error:
                failures.append(error)
                continue
            if candidate.kind == kind:
                return candidate
            failures.append(ValueError("browser product did not match its candidate kind"))
    message = (
        "No supported Windows Chrome or Edge executable is installed"
        if current_platform == "win32" and kernel == "auto"
        else f"No supported {_kind_for_kernel(kernel)} executable is installed"
    )
    raise BridgeError("E_BROWSER_UNAVAILABLE", message) from (failures[-1] if failures else None)


def _kind_for_kernel(kernel: str) -> str:
    return {"chrome": "chrome", "edge": "edge", "chromium-headless": "chromium"}[kernel]


def _browser_candidates(current_platform: str, kind: str) -> tuple[Path, ...]:
    candidates: list[Path] = []
    if current_platform == "win32":
        names = {
            "chrome": (
                ("ProgramFiles", "Google/Chrome/Application/chrome.exe"),
                ("ProgramFiles(x86)", "Google/Chrome/Application/chrome.exe"),
                ("LOCALAPPDATA", "Google/Chrome/Application/chrome.exe"),
            ),
            "edge": (
                ("ProgramFiles", "Microsoft/Edge/Application/msedge.exe"),
                ("ProgramFiles(x86)", "Microsoft/Edge/Application/msedge.exe"),
                ("LOCALAPPDATA", "Microsoft/Edge/Application/msedge.exe"),
            ),
        }[kind]
        for variable, suffix in names:
            root = os.environ.get(variable)
            if root:
                candidates.append(Path(root, *suffix.split("/")))
        command = shutil.which("chrome.exe" if kind == "chrome" else "msedge.exe")
        if command:
            candidates.append(Path(command))
    elif kind == "chromium":
        for path in (
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/local/bin/chromium",
            "/snap/bin/chromium",
        ):
            candidates.append(Path(path))
        command = shutil.which("chromium") or shutil.which("chromium-browser")
        if command:
            candidates.append(Path(command))
    return tuple(dict.fromkeys(candidates))


def _attest_browser_binary(path: Path, current_platform: str) -> BrowserBinary:
    try:
        invocation = Path(os.path.abspath(path.expanduser()))
        invocation_metadata_before = invocation.lstat()
        canonical_before = invocation.resolve(strict=True)
        metadata_before = canonical_before.stat()
    except OSError as error:
        raise BridgeError("E_BROWSER_UNAVAILABLE", "Browser executable is unavailable") from error
    if (
        not canonical_before.is_file()
        or metadata_before.st_size <= 0
        or (current_platform != "win32" and not os.access(invocation, os.X_OK))
    ):
        raise BridgeError("E_BROWSER_UNAVAILABLE", "Browser executable is not a regular file")
    try:
        identity_before = _probe_browser_identity(invocation, current_platform)
        digest = _sha256_file(invocation)
        identity_after = _probe_browser_identity(invocation, current_platform)
        invocation_metadata_after = invocation.lstat()
        canonical_after = invocation.resolve(strict=True)
        metadata_after = canonical_after.stat()
    except BridgeError:
        raise
    except (OSError, subprocess.SubprocessError, UnicodeError) as error:
        raise BridgeError("E_BROWSER_UNAVAILABLE", "Browser version probe failed") from error
    if (
        identity_before != identity_after
        or canonical_before != canonical_after
        or _file_signature(invocation_metadata_before) != _file_signature(invocation_metadata_after)
        or _file_signature(metadata_before) != _file_signature(metadata_after)
    ):
        raise BridgeError("E_BROWSER_UNAVAILABLE", "Browser executable changed during attestation")
    kind, version = identity_after
    if kind not in _BINARY_KINDS or len(version) > 128 or _VERSION.fullmatch(version) is None:
        raise BridgeError("E_BROWSER_UNAVAILABLE", "Browser executable identity is invalid")
    if _SHA256.fullmatch(digest) is None:
        raise BridgeError("E_BROWSER_UNAVAILABLE", "Browser executable digest is invalid")
    launch_path = invocation if invocation.is_symlink() else canonical_after
    return BrowserBinary(path=launch_path, kind=kind, version=version, sha256=digest)


def _probe_browser_identity(path: Path, current_platform: str) -> tuple[str, str]:
    if current_platform == "win32":
        script = (
            "$v=(Get-Item -LiteralPath $env:LUBAN_BROWSER_BINARY_PATH).VersionInfo; "
            "[Console]::Out.Write((@{product=$v.ProductName;version=$v.ProductVersion}"
            " | ConvertTo-Json -Compress))"
        )
        environment = _probe_environment(current_platform)
        environment["LUBAN_BROWSER_BINARY_PATH"] = str(path)
        completed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=5,
            env=environment,
        )
        try:
            value = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise BridgeError("E_BROWSER_UNAVAILABLE", "Browser version probe failed") from error
        product = value.get("product") if isinstance(value, dict) else None
        version = value.get("version") if isinstance(value, dict) else None
    else:
        completed = subprocess.run(
            [str(path), "--version"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=5,
            env=_probe_environment(current_platform),
        )
        product = completed.stdout.strip() or completed.stderr.strip()
        version = _version_from_product(product)
    if not isinstance(product, str) or not isinstance(version, str):
        raise BridgeError("E_BROWSER_UNAVAILABLE", "Browser version probe returned no identity")
    normalized = product.casefold()
    kind = (
        "edge"
        if "microsoft edge" in normalized
        else "chrome"
        if "google chrome" in normalized
        else "chromium"
        if "chromium" in normalized
        else ""
    )
    return kind, version.strip()


def _version_from_product(value: str) -> str:
    match = re.search(r"\b\d+(?:\.\d+){1,3}(?:[-+._A-Za-z0-9]*)?\b", value)
    return match.group(0) if match is not None else ""


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _file_signature(metadata: os.stat_result) -> tuple[int, int, int, int]:
    return (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns)


def _probe_environment(current_platform: str) -> dict[str, str]:
    names = (
        ("SystemRoot", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP")
        if current_platform == "win32"
        else (
            "PATH",
            "HOME",
            "LANG",
            "LC_ALL",
            "LD_LIBRARY_PATH",
            "TMPDIR",
            "XDG_RUNTIME_DIR",
        )
    )
    return {name: value for name in names if (value := os.environ.get(name)) is not None}


def _os_release_id(contents: str) -> str | None:
    for line in contents.splitlines():
        match = re.fullmatch(r"ID=(?:\"([^\"]+)\"|'([^']+)'|([^\s#]+))\s*", line.strip())
        if match is not None:
            return next((value for value in match.groups() if value is not None), None)
    return None
