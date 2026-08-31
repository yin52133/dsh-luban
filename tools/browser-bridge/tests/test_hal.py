from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from luban_browser_bridge.errors import BridgeError
from luban_browser_bridge.hal import _probe_browser_identity, resolve_profile


class HalTests(unittest.TestCase):
    def test_windows_auto_attests_installed_chrome(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            chrome = _fake_binary(Path(directory), "chrome.exe")
            with (
                patch(
                    "luban_browser_bridge.hal._browser_candidates",
                    side_effect=lambda _platform, kind: (chrome,) if kind == "chrome" else (),
                ),
                patch(
                    "luban_browser_bridge.hal._probe_browser_identity",
                    return_value=("chrome", "140.0.7339.81"),
                ),
            ):
                profile = resolve_profile({}, platform="win32")
            profile_path = Path(profile.browser_kwargs["user_data_dir"])
            try:
                self.assertEqual(profile.public["kernel"], "chrome")
                self.assertFalse(profile.public["headless"])
                self.assertTrue(profile.public["isolated"])
                self.assertEqual(profile.browser_kwargs["executable_path"], str(chrome.resolve()))
                self.assertEqual(
                    profile.public["binary"],
                    {
                        "kind": "chrome",
                        "version": "140.0.7339.81",
                        "sha256": hashlib.sha256(b"browser-binary").hexdigest(),
                    },
                )
                self.assertTrue(profile_path.is_dir())
            finally:
                profile.cleanup()
            self.assertFalse(profile_path.exists())

    def test_windows_auto_falls_back_only_to_attested_edge(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            edge = _fake_binary(Path(directory), "msedge.exe")

            def candidates(_platform: str, kind: str) -> tuple[Path, ...]:
                return (edge,) if kind == "edge" else ()

            with (
                patch("luban_browser_bridge.hal._browser_candidates", side_effect=candidates),
                patch(
                    "luban_browser_bridge.hal._probe_browser_identity",
                    return_value=("edge", "140.0.3485.54"),
                ),
            ):
                profile = resolve_profile({}, platform="win32")
            try:
                self.assertEqual(profile.public["kernel"], "edge")
                self.assertEqual(profile.public["binary"]["kind"], "edge")
                self.assertEqual(profile.browser_kwargs["channel"], "msedge")
            finally:
                profile.cleanup()

    def test_windows_probe_passes_spaced_path_without_provider_environment(self) -> None:
        path = Path("C:/Program Files/Google/Chrome/Application/chrome.exe")
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout='{"product":"Google Chrome","version":"140.0.7339.81"}',
            stderr="",
        )
        with (
            patch.dict(os.environ, {"BROWSER_USE_API_KEY": "provider-secret"}),
            patch("luban_browser_bridge.hal.subprocess.run", return_value=completed) as run,
        ):
            identity = _probe_browser_identity(path, "win32")

        self.assertEqual(identity, ("chrome", "140.0.7339.81"))
        command = run.call_args.args[0]
        environment = run.call_args.kwargs["env"]
        self.assertNotIn(str(path), command)
        self.assertEqual(environment["LUBAN_BROWSER_BINARY_PATH"], str(path))
        self.assertNotIn("BROWSER_USE_API_KEY", environment)

    def test_ubuntu_attests_installed_chromium_without_dependency_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chromium = _fake_binary(root, "chromium")
            profile_dir = root / "profile"
            profile_dir.mkdir()
            with (
                patch(
                    "luban_browser_bridge.hal._browser_candidates",
                    return_value=(chromium,),
                ),
                patch(
                    "luban_browser_bridge.hal._probe_browser_identity",
                    return_value=("chromium", "140.0.7339.80"),
                ),
            ):
                profile = resolve_profile(
                    {"userDataDir": str(profile_dir)},
                    platform="linux",
                    read_os_release=lambda: 'NAME="Ubuntu"\nID=ubuntu\n',
                )
            self.assertEqual(profile.public["kernel"], "chromium-headless")
            self.assertTrue(profile.public["headless"])
            self.assertFalse(profile.public["isolated"])
            self.assertEqual(profile.public["binary"]["kind"], "chromium")
            self.assertEqual(profile.browser_kwargs["executable_path"], str(chromium.resolve()))
            profile.cleanup()
            self.assertTrue(profile_dir.exists())

    def test_ubuntu_probe_does_not_inherit_provider_credentials(self) -> None:
        path = Path("/snap/bin/chromium")
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout="Chromium 140.0.7339.80 snap",
            stderr="",
        )
        with (
            patch.dict(os.environ, {"BROWSER_USE_API_KEY": "provider-secret"}),
            patch("luban_browser_bridge.hal.subprocess.run", return_value=completed) as run,
        ):
            identity = _probe_browser_identity(path, "linux")

        self.assertEqual(identity, ("chromium", "140.0.7339.80"))
        self.assertEqual(run.call_args.args[0], [str(path), "--version"])
        self.assertNotIn("BROWSER_USE_API_KEY", run.call_args.kwargs["env"])

    def test_ubuntu_headless_falls_back_to_attested_google_chrome(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            chrome = _fake_binary(Path(directory), "google-chrome")

            def candidates(_platform: str, kind: str) -> tuple[Path, ...]:
                return (chrome,) if kind == "chrome" else ()

            with (
                patch("luban_browser_bridge.hal._browser_candidates", side_effect=candidates),
                patch(
                    "luban_browser_bridge.hal._probe_browser_identity",
                    return_value=("chrome", "146.0.7680.177"),
                ),
            ):
                profile = resolve_profile(
                    {"kernel": "chromium-headless"},
                    platform="linux",
                    read_os_release=lambda: "ID=ubuntu\n",
                )
            try:
                self.assertEqual(profile.public["kernel"], "chromium-headless")
                self.assertEqual(profile.public["binary"]["kind"], "chrome")
                self.assertEqual(profile.browser_kwargs["channel"], "chrome")
                self.assertTrue(profile.public["headless"])
            finally:
                profile.cleanup()

    @unittest.skipIf(os.name == "nt", "Windows symlink creation requires host policy")
    def test_ubuntu_preserves_snap_style_symlink_as_the_launch_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dispatcher = _fake_binary(root, "snap-dispatcher")
            chromium = root / "chromium"
            chromium.symlink_to(dispatcher)
            with patch(
                "luban_browser_bridge.hal._probe_browser_identity",
                return_value=("chromium", "140.0.7339.80"),
            ):
                profile = resolve_profile(
                    {
                        "kernel": "chromium-headless",
                        "executablePath": str(chromium),
                    },
                    platform="linux",
                    read_os_release=lambda: "ID=ubuntu\n",
                )
            try:
                self.assertEqual(
                    profile.browser_kwargs["executable_path"], str(chromium.absolute())
                )
            finally:
                profile.cleanup()

    def test_explicit_path_must_be_a_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for path in (Path(directory), Path(directory) / "missing.exe"):
                with self.subTest(path=path), self.assertRaises(BridgeError) as raised:
                    resolve_profile(
                        {"kernel": "chrome", "executablePath": str(path)},
                        platform="win32",
                    )
                self.assertEqual(raised.exception.payload.code, "E_BROWSER_UNAVAILABLE")

    def test_explicit_path_must_match_requested_browser(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            binary = _fake_binary(Path(directory), "browser.exe")
            with (
                patch(
                    "luban_browser_bridge.hal._probe_browser_identity",
                    return_value=("edge", "140.0.0.0"),
                ),
                self.assertRaises(BridgeError) as raised,
            ):
                resolve_profile(
                    {"kernel": "chrome", "executablePath": str(binary)},
                    platform="win32",
                )
        self.assertEqual(raised.exception.payload.code, "E_BROWSER_INVALID_PROFILE")

    def test_explicit_chrome_never_falls_back_to_edge(self) -> None:
        requested_kinds: list[str] = []

        def candidates(_platform: str, kind: str) -> tuple[Path, ...]:
            requested_kinds.append(kind)
            return ()

        with (
            patch("luban_browser_bridge.hal._browser_candidates", side_effect=candidates),
            self.assertRaises(BridgeError) as raised,
        ):
            resolve_profile({"kernel": "chrome"}, platform="win32")
        self.assertEqual(raised.exception.payload.code, "E_BROWSER_UNAVAILABLE")
        self.assertEqual(requested_kinds, ["chrome"])

    def test_missing_ubuntu_chromium_fails_closed(self) -> None:
        with (
            patch("luban_browser_bridge.hal._browser_candidates", return_value=()),
            self.assertRaises(BridgeError) as raised,
        ):
            resolve_profile(
                {"kernel": "chromium-headless"},
                platform="linux",
                read_os_release=lambda: "ID=ubuntu\n",
            )
        self.assertEqual(raised.exception.payload.code, "E_BROWSER_UNAVAILABLE")

    def test_non_ubuntu_linux_is_rejected_before_browser_lookup(self) -> None:
        with (
            patch("luban_browser_bridge.hal._browser_candidates") as candidates,
            self.assertRaises(BridgeError) as raised,
        ):
            resolve_profile(
                {"kernel": "chromium-headless"},
                platform="linux",
                read_os_release=lambda: "ID=debian\n",
            )
        self.assertEqual(raised.exception.payload.code, "E_BROWSER_INVALID_PROFILE")
        candidates.assert_not_called()

    def test_non_windows_non_linux_platform_is_rejected_before_browser_lookup(self) -> None:
        with (
            patch("luban_browser_bridge.hal._browser_candidates") as candidates,
            self.assertRaises(BridgeError) as raised,
        ):
            resolve_profile({"kernel": "auto"}, platform="darwin")
        self.assertEqual(raised.exception.payload.code, "E_BROWSER_INVALID_PROFILE")
        candidates.assert_not_called()

    def test_rejects_headful_headless_kernel_before_browser_lookup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            chromium = _fake_binary(Path(directory), "chromium")
            with (
                patch("luban_browser_bridge.hal._probe_browser_identity") as probe,
                self.assertRaises(BridgeError) as raised,
            ):
                resolve_profile(
                    {
                        "kernel": "chromium-headless",
                        "headless": False,
                        "executablePath": str(chromium),
                    },
                    platform="linux",
                    read_os_release=lambda: "ID=ubuntu\n",
                )
        self.assertEqual(raised.exception.payload.code, "E_BROWSER_INVALID_PROFILE")
        probe.assert_not_called()


def _fake_binary(directory: Path, name: str) -> Path:
    path = directory / name
    path.write_bytes(b"browser-binary")
    path.chmod(0o700)
    return path


if __name__ == "__main__":
    unittest.main()
