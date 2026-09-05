"""End-to-end sudo recovery against a disposable account and isolated user service."""

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path


def run(*args):
    return subprocess.run(
        args, check=True, capture_output=True, text=True, timeout=30
    ).stdout.strip()


def main():
    tests = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location(
        "terminal", tests / "recovery-terminal.py"
    )
    terminal = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(terminal)
    node = shutil.which("node")
    assert node is not None
    # This test requires the runner's actual sudo policy, never a recovery bypass flag.
    assert run("sudo", "-n", "/usr/bin/id", "-u") == "0"
    uid, gid = os.getuid(), os.getgid()
    assert uid != 0, "Run as the service owner with sudo authorization, not as root"
    run("sudo", "-n", "/usr/bin/systemctl", "start", f"user@{uid}.service")
    os.environ["XDG_RUNTIME_DIR"] = f"/run/user/{uid}"
    os.environ["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path=/run/user/{uid}/bus"
    directory = Path(tempfile.mkdtemp(prefix="luban-recovery-systemd-"))
    service = f"luban-recovery-test-{uuid.uuid4().hex}.service"
    fixture = [
        node,
        "node_modules/tsx/dist/cli.mjs",
        str(tests / "recovery-systemd.fixture.ts"),
    ]
    run(*fixture, "prepare", str(directory))
    users = directory / "users.json"
    before = users.read_bytes()
    command = [
        "/usr/bin/sudo",
        "-n",
        node,
        str(tests.parent / "dist/recovery-cli.js"),
        "reset-admin",
        "--users-file",
        str(users),
        "--service",
        service,
    ]
    unit = directory / service
    unit.write_text(
        "[Unit]\nDescription=Luban recovery test\n"
        "[Service]\nType=exec\nExecStart=/usr/bin/sleep infinity\n"
    )
    run("systemctl", "--user", "link", str(unit))
    try:
        run("systemctl", "--user", "start", service)
        previous_pid = run(
            "systemctl", "--user", "show", "--property=MainPID", "--value", service
        )
        terminal.exercise(
            command,
            [
                ("要复位的管理员用户名：", "不存在\r".encode()),
                ("未找到该管理员", b""),
                ("要复位的管理员用户名：", "王\r".encode()),
                ("新密码（不回显）：", b"Recovery test 2026!\r"),
                ("再次输入新密码：", b"Recovery test 2026!\r"),
                ("输入 yes 继续：", b"no\r"),
            ],
            0,
            "已取消，未修改账号或服务。",
            ("Recovery test 2026!",),
        )
        assert users.read_bytes() == before
        assert (
            run("systemctl", "--user", "show", "--property=MainPID", "--value", service)
            == previous_pid
        )
        terminal.exercise(
            command,
            [
                ("要复位的管理员用户名：", "王\r".encode()),
                ("新密码（不回显）：", b"Recovery test 2026!\r"),
                ("再次输入新密码：", b"Recovery test 2026!\r"),
                ("输入 yes 继续：", b"yes\r"),
            ],
            0,
            "已撤销 1 个登录会话",
            ("Recovery test 2026!",),
        )
        assert run("systemctl", "--user", "is-active", service) == "active"
        assert (
            run("systemctl", "--user", "show", "--property=MainPID", "--value", service)
            != previous_pid
        )
        metadata = users.stat()
        assert (metadata.st_uid, metadata.st_gid, metadata.st_mode & 0o777) == (
            uid,
            gid,
            0o600,
        )
        backups = [
            file
            for file in directory.glob("users.json.recovery-*.json")
            if not file.name.endswith(".audit.json")
        ]
        assert len(backups) == 1 and backups[0].read_bytes() == before
        assert json.loads(users.read_text())["sessions"] == {}
        run(*fixture, "verify", str(directory))
        print(
            "PASS: real sudo, privilege drop, retry, cancellation, backup, service restart, new login and session revocation"
        )
    finally:
        run("systemctl", "--user", "stop", service)
        run("systemctl", "--user", "disable", service)
        # Keep synthetic fixtures for failed-run inspection; the CI runner owns their lifetime.


if __name__ == "__main__":
    main()
