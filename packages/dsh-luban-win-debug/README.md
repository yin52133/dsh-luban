# dsh-luban-win-debug

Windows embedded-debug control plane for DeepSeek Harness (DSH). Serial logs,
safe flash/reset templates, GDB snapshots, adb/fastboot, desktop MCP, SSH,
telnet, and TCP serial all enter one `ChannelAdapter` surface and can produce a
redacted file-plus-excerpt for a DSH session.

## Features

- Optional `serialport` HAL with COM enumeration, baud configuration, bounded
  data streams, and non-overlapping hot-plug polling.
- One responsive Settings panel for every channel kind, with live scrolling,
  timestamps, literal/regex filters, highlighting, range selection, and DSH
  session injection.
- Built-in OpenOCD, J-Link, esptool, STM32CubeProgrammer, adb, and fastboot
  templates. Executables and templates are allowlisted; arguments never pass
  through a shell. Destructive templates require an exact second confirmation.
- Managed OpenOCD lifetime and batch-only GDB breakpoints, variables,
  registers, and backtrace snapshots.
- Explicit adb states (`device`, `offline`, `unauthorized`) and fastboot
  `bootloader` state.
- Disabled-by-default stdio desktop-MCP bridge. Every local allowlist entry is
  registered through the public DSH rc2 tool registry and forwarded over a
  bounded MCP 2024-11-05 session.
- Configured SSH command allowlists plus raw telnet and TCP-serial endpoints.
- Authenticated `/luban-win-debug` REST/SSE API, bounded bodies/events/output,
  timeout and cancellation propagation, credential redaction, and atomic
  snippet writes.

## Installation

Install the authentication boundary first, then add this Windows-only plugin to
the same profile:

```powershell
dsh plugin --profile web add dsh-luban-auth dsh-luban-win-debug
```

`serialport` 13 is an optional native dependency and is loaded only when COM
support is used. Package managers may skip it when the native build is unavailable;
install it explicitly in the DSH profile if COM discovery reports it missing:

```powershell
pnpm add serialport@^13.0.0
```

Install each external debugger/flasher independently and set its executable in
the local profile. Keep DSH WebServer on loopback and expose it only through the
`dsh-luban-auth` sidecar.

## Configuration

```yaml
- insert:
    - id: luban-win-debug
      name: dsh-luban-win-debug
      config:
        serial:
          defaultBaud: 115200
          timestamp: true
          pollIntervalMs: 1500
        snippet:
          dir: ~/.dsh/luban/win-debug/snippets
          maxLines: 500
          maxBytes: 524288
        execution:
          timeoutMs: 120000
          startupTimeoutMs: 10000
          processLifetimeMs: 28800000
          maxOutputBytes: 1048576
          cwd: D:/firmware
          allowedRoots: [D:/firmware, D:/tool-config]
        tools:
          openocd: C:/Tools/OpenOCD/bin/openocd.exe
          jlink: C:/Program Files/SEGGER/JLink/JLink.exe
          esptool: C:/Tools/esptool/esptool.exe
          stm32cubeprogrammer: C:/Program Files/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin/STM32_Programmer_CLI.exe
          gdb: C:/Tools/gcc-arm/bin/arm-none-eabi-gdb.exe
          adb: C:/Android/platform-tools/adb.exe
          fastboot: C:/Android/platform-tools/fastboot.exe
          ssh: C:/Windows/System32/OpenSSH/ssh.exe
        gdb: { target: 127.0.0.1:3333 }
        remote:
          - id: lab-board
            label: Lab board SSH
            kind: ssh
            host: board.lab
            port: 22
            user: debug
            allowedCommands: [uname, journalctl]
          - id: uart-server
            label: Network UART
            kind: tcp-serial
            host: 192.0.2.10
            port: 7001
            allowedCommands: []
        desktopMcp:
          enabled: false
          command: C:/Tools/windows-mcp/windows-mcp.exe
          args: [--stdio]
          tools: [desktop.capture, desktop.click]
```

`execution.allowedRoots` is mandatory in effect: it defaults to the DSH process
working directory and cannot be empty. Firmware, ELF, OpenOCD config, and script
parameters must resolve inside one of those roots. Tool and MCP executable paths
are exact profile-time allowlists; HTTP callers cannot replace them.

When `desktopMcp.enabled` is true, `desktopMcp.tools` must be non-empty. Each
name becomes a global DSH tool via `ctx.tools.register()`. The server process is
still lazy: an explicit **Start** action or the first tool call performs MCP
`initialize` and `tools/list`; startup fails closed unless the server advertises
every configured name. Calls then use `tools/call`, preserve the caller's abort
signal, bound every protocol message, and tear down the owned process before a
cancelled call settles. Input schemas are intentionally open objects because
tools must be visible before the external server is started; the profile
allowlist and the server's discovery response are both enforced.

Opening the same endpoint twice reports the owning Luban channel. For esptool
serial templates, the service also performs an immediate exclusive open/close
probe before launching the flasher. Keep serial monitors and vendor debug tools
closed; Windows/SerialPort cannot reliably identify an arbitrary external PID,
so the stable error names the likely owner class instead. OpenOCD/GDB and flash
templates hold an in-process target lease until their process completes.

The service is available to other Cordis plugins as `ctx.lubanWinDebug`.
Desktop-MCP consumers can read its local configured stdio descriptor, while DSH agents
invoke the registered tools directly. The HTTP API deliberately does not return
the configured command or arguments.

## Demo

1. Open **Settings → Windows Debug**, choose `COM3`, set `115200`, and select
   **Open**. Plug/unplug changes appear without reloading.
2. Filter for `fatal|assert` with **Regex**, click the first and last relevant
   line, enter a DSH session id, then select **Save & inject**. The session gets
   the redacted excerpt, file path, channel metadata, and time window.
3. Select `esptool · write image`, enter JSON parameters such as
   `{"chip":"esp32","port":"COM3","baud":"921600","address":"0x1000","firmware":"D:/firmware/app.bin"}`,
   then run it. Error lines return as structured `error` entries for direct AI
   follow-up.
4. For GDB, start OpenOCD with allowlisted interface/target config paths, enter
   the ELF path, and export registers/backtrace. Stop the managed server when
   finished.

No command runs during package installation, discovery, or tests. A user action
against a configured endpoint/template is always required.

## Compatibility

Tested against DeepSeek Harness **0.1.1-rc.2**, Cordis 4.0.1, React 18.2, and
Node.js 22.19+. Session injection uses the rc2 `AgentRegistry.get/resume` and
`Agent.followup` APIs; it does not depend on unreleased session-controller APIs.
Desktop MCP uses rc2's public `ctx.tools.register()` boundary rather than an
unpublished MCP registry.
The browser contribution is a DSH rc2 lazy-CJS module loaded through
`window.__ModuleLoader__` and keeps React/Cordis/DSH packages external.

External tool versions are deployment-owned. Record and qualify the exact
OpenOCD/J-Link/esptool/STM32CubeProgrammer/GDB/Android platform-tools/SSH/MCP
versions for each hardware profile before enabling its templates.

## Platform Support

The Cordis plugin and Settings panel deliberately reject non-Windows hosts with
`E_PLATFORM_UNSUPPORTED`. The raw TCP/telnet abstractions are portable code, but
this package does not mount them on Ubuntu. Native serial support depends on a
compatible optional `serialport` build for the installed Node ABI.

No automated test opens a real COM port, network device, debugger, flasher, adb,
fastboot, SSH, telnet, or MCP process; every external boundary is covered with a
fake runner/provider/connector or an in-memory stdio process. Real workstation,
hardware, and approved MCP qualification remain deployment acceptance steps.

## License

MIT. See `LICENSE` and `THIRD-PARTY-NOTICES.md`. External tools and the optional
serial binding are not bundled and retain their own licenses.
