# Third-Party Notices

This package depends at runtime on `dsh-luban-core` and integrates with peer packages from DSH
(`@deepseek-ai/cordis`, host webserver, client runtime/settings/slots, and React). Those packages
retain their own copyright and license notices.

The package invokes but does not redistribute Ubuntu system components:

- systemd (`systemctl` and user units), licensed by its upstream project primarily under LGPL-2.1-or-later.
- systemd-logind (`loginctl`), supplied by the Ubuntu/systemd installation.

No compiler, build toolchain, tmux binary, or systemd binary is bundled.
