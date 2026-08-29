from __future__ import annotations

import unittest

from luban_browser_bridge.security import assert_url_allowed, host_matches, redact


class SecurityTests(unittest.TestCase):
    def test_redacts_credentials(self) -> None:
        value = "token=abc123 Bearer secret-token sk_test_123456789 password: hunter2"
        redacted = redact(value)
        self.assertNotIn("abc123", redacted)
        self.assertNotIn("secret-token", redacted)
        self.assertNotIn("123456789", redacted)
        self.assertNotIn("hunter2", redacted)

    def test_domain_patterns_are_boundary_aware(self) -> None:
        self.assertTrue(host_matches("api.example.com", "*.example.com"))
        self.assertTrue(host_matches("example.com", "*.example.com"))
        self.assertFalse(host_matches("example.com.evil.test", "*.example.com"))
        with self.assertRaisesRegex(ValueError, "outside allowDomains"):
            assert_url_allowed("https://evil.test", ["example.com"])


if __name__ == "__main__":
    unittest.main()
