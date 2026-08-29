from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from luban_browser_bridge.errors import BridgeError
from luban_browser_bridge.hal import resolve_profile


class HalTests(unittest.TestCase):
    def test_auto_uses_isolated_windows_chrome_profile(self) -> None:
        profile = resolve_profile({}, platform="win32")
        profile_path = Path(profile.browser_kwargs["user_data_dir"])
        try:
            self.assertEqual(profile.public["kernel"], "chrome")
            self.assertFalse(profile.public["headless"])
            self.assertTrue(profile.public["isolated"])
            self.assertTrue(profile_path.is_dir())
        finally:
            profile.cleanup()
        self.assertFalse(profile_path.exists())

    def test_auto_uses_headless_chromium_on_linux(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = resolve_profile({"userDataDir": directory}, platform="linux")
            self.assertEqual(profile.public["kernel"], "chromium-headless")
            self.assertTrue(profile.public["headless"])
            self.assertFalse(profile.public["isolated"])
            profile.cleanup()
            self.assertTrue(Path(directory).exists())

    def test_rejects_headful_headless_kernel(self) -> None:
        with self.assertRaises(BridgeError):
            resolve_profile({"kernel": "chromium-headless", "headless": False})


if __name__ == "__main__":
    unittest.main()
