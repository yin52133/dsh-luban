# Third-party notices

`dsh-luban-win-debug` bundles no third-party source code, executables, native
bindings, UI assets, firmware, or command templates copied from another
project. `dsh-luban-core` is part of this MIT-licensed repository. DSH, Cordis,
React, and their licenses are supplied by the host profile as peer dependencies.

The following are optional integrations. `serialport` is declared as an optional
dependency and may be installed by the package manager; the other tools are
independently installed. Exact deployed versions must be recorded in the hardware
profile, and no integration is executed automatically during package installation.

| Integration                         | Typical upstream license                            | Integration boundary                                                |
| ----------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| Node SerialPort (`serialport` 13.x) | MIT                                                 | Dynamically loaded optional COM HAL                                 |
| OpenOCD                             | GPL-2.0-or-later                                    | Allowlisted executable and fixed argument templates                 |
| SEGGER J-Link                       | SEGGER proprietary terms                            | Allowlisted executable and CommanderScript path                     |
| Espressif esptool                   | GPL-2.0-or-later                                    | Allowlisted executable and fixed flash/erase templates              |
| STM32CubeProgrammer                 | STMicroelectronics proprietary terms                | Allowlisted CLI executable and fixed templates                      |
| GNU GDB                             | GPL-3.0-or-later                                    | Batch snapshot subprocess                                           |
| Android adb/fastboot                | Apache-2.0                                          | Device enumeration and fixed/allowlisted commands                   |
| Windows OpenSSH                     | BSD-family notices distributed by Microsoft/OpenBSD | Configured SSH command channel                                      |
| Windows-MCP/CursorTouch-like server | Project-specific; verify before enabling            | Disabled-by-default stdio MCP 2024-11-05 + DSH tool registry bridge |

License names above describe common upstream distributions and are not a
substitute for checking the exact binary/package installed on a workstation.
Users are responsible for complying with each external tool's license and, for
proprietary tools, vendor redistribution restrictions. No external binary is
redistributed by this npm package.
