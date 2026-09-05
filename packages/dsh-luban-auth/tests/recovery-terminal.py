"""Linux PTY regression checks using only synthetic passwords and the standard library."""

import argparse
import errno
import os
import pty
import select
import shutil
import signal
import time
from pathlib import Path


def exercise(command, steps, expected_exit, expected_output, secrets=()):
    pid, terminal = pty.fork()
    if pid == 0:
        os.execv(command[0], command)
    transcript = b""
    cursor = 0
    reaped = False
    try:
        for label, answer in steps:
            deadline = time.monotonic() + 10
            marker = label.encode()
            while marker not in transcript[cursor:]:
                if time.monotonic() > deadline:
                    raise AssertionError("Prompt timeout: " + label)
                if select.select([terminal], [], [], 0.1)[0]:
                    transcript += os.read(terminal, 65536)
            cursor = transcript.index(marker, cursor) + len(marker)
            os.write(terminal, answer)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if select.select([terminal], [], [], 0.1)[0]:
                try:
                    chunk = os.read(terminal, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if not chunk:
                    break
                transcript += chunk
        while time.monotonic() < deadline:
            finished, status = os.waitpid(pid, os.WNOHANG)
            if finished:
                reaped = True
                break
            time.sleep(0.01)
        if not reaped:
            raise AssertionError("Child did not exit")
        assert os.waitstatus_to_exitcode(status) == expected_exit
        text = transcript.decode(errors="replace")
        assert expected_output in text
        for secret in secrets:
            assert secret not in text, "Secret was echoed"
    finally:
        os.close(terminal)
        if not reaped:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--tsx", default="node_modules/tsx/dist/cli.mjs")
    args = parser.parse_args()
    if args.node is None:
        parser.error("Node.js is required")
    tests = Path(__file__).resolve().parent
    command = [args.node, args.tsx, str(tests / "recovery-terminal.fixture.ts")]
    exercise(
        command,
        [
            ("新密码（不回显）：", b"short\r"),
            ("请重新输入。", b""),
            ("新密码（不回显）：", b"Recovery test 2026!\r"),
            ("再次输入新密码：", b"Mismatch test 2026!\r"),
            ("两次密码不一致，请重新输入。", b""),
            ("新密码（不回显）：", b"Recovery test 2026!\r"),
            ("再次输入新密码：", b"Recovery test 2026!\r"),
        ],
        0,
        "PROMPT_SMOKE_PASS",
        ("short", "Recovery test 2026!", "Mismatch test 2026!"),
    )
    print("PASS: hidden input, invalid-password retry, mismatch retry, confirmation")
    exercise(
        command,
        [
            ("新密码（不回显）：", b"Never echo this"),
            ("", b"\x03"),
        ],
        1,
        "已取消，未提交密码。",
        ("Never echo this",),
    )
    print("PASS: Ctrl+C cancels without echoing input")
    if os.geteuid() != 0:
        exercise(
            [
                args.node,
                str(tests.parent / "dist/recovery-cli.js"),
                "reset-admin",
                "--users-file",
                str(tests / "nonexistent-users.json"),
            ],
            [],
            1,
            "需要服务器 sudo 管理权限",
        )
        print("PASS: packaged CLI rejects an unprivileged Linux terminal")


if __name__ == "__main__":
    main()
