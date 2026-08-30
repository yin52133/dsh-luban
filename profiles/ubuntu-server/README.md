# ubuntu-server profile template

Minimal DSH `0.1.1-rc.2` Web profile for the Ubuntu build host. The in-box
`dsh-base` and `dsh-web-app` bundles resolve from the installed DSH runtime;
out-of-tree Luban and A-class bundles are added with `dsh plugin`.

1. Preview and create the profile with the repository-owned safe wrapper. It
   defaults to preview mode and refuses to overwrite an existing target:

   ```sh
   scripts/deploy/setup-ubuntu.sh
   scripts/deploy/setup-ubuntu.sh --apply
   ```

2. Preview the pinned A-class additions:

   ```sh
   bash scripts/install-3rd-party.sh --profile ubuntu-server --dry-run
   ```

   The schema-v2 lock pins `dshmarket@1.36.0`, `dsh-better-sidebar@0.17.1`,
   and `@furongjun1999/dsh-memory@0.4.0`, including npm metadata identity,
   repository, license, and SHA-512 integrity. Preview mode makes no registry
   request and starts no `dsh` child process.

3. Apply only on a Linux host after reviewing the exact package specs. Apply
   requires an absolute, non-root DSH home and an approval actor:

   ```sh
   bash scripts/install-3rd-party.sh --profile ubuntu-server \
     --dsh-home /tmp/dsh-acceptance --approved-by operator-name --apply
   ```

   `--version latest` or an explicit semantic version additionally requires
   `--approve-unpinned`; the installer verifies official-registry metadata and
   resolves exact versions before spawning `dsh`. DSH_HOME and registry values
   are injected only into that child process.

4. Run the M12 target-host acceptance runner. It defaults to a non-writing plan;
   `--live` requires project-local DSH `0.1.1-rc.2` and uses an isolated DSH_HOME:

   ```sh
   node scripts/acceptance/m12-profile-smoke.mjs
   node scripts/acceptance/m12-profile-smoke.mjs --live \
     --output /tmp/m12-ubuntu-server.json
   ```

   A live pass covers the temporary host/client fixture on this Linux host only.
   It does not prove Windows acceptance or install the three A-class packages.

5. Validate without booting: `dsh --profile ubuntu-server --dump-config`.

Do not commit credentials or machine-specific network topology to this
template. Keep DSH bound to loopback when the M01 authenticated sidecar is the
LAN entry point. The lock records MIT npm metadata, but source LICENSE files and
post-install notices still require explicit verification during authorized live
installation.
