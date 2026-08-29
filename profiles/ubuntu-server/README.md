# ubuntu-server profile template

Minimal DSH `0.1.1-rc.2` Web profile for the Ubuntu build host. The in-box
`dsh-base` and `dsh-web-app` bundles resolve from the installed DSH runtime;
out-of-tree Luban and A-class bundles are added with `dsh plugin`.

1. Copy this directory to `$DSH_HOME/profiles/ubuntu-server` only when that
   target does not already exist.
2. Preview the pinned A-class additions:

   ```sh
   bash scripts/install-3rd-party.sh --profile ubuntu-server --dry-run
   ```

3. Re-run with `--apply` after reviewing the exact package specs.
4. Validate without booting: `dsh --profile ubuntu-server --dump-config`.

Do not commit credentials or machine-specific network topology to this
template. Keep DSH bound to loopback when the M01 authenticated sidecar is the
LAN entry point.
