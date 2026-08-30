# win-debug profile template

Minimal DSH `0.1.1-rc.2` Web profile for the Windows debug host. The in-box
`dsh-base` and `dsh-web-app` bundles resolve from the installed DSH runtime;
out-of-tree Luban and A-class bundles are added with `dsh plugin`.

1. Preview and create the profile with the repository-owned safe wrapper. It
   defaults to preview mode and refuses to overwrite an existing target:

   ```powershell
   .\scripts\deploy\setup-windows.ps1
   .\scripts\deploy\setup-windows.ps1 -Apply
   ```

2. Preview the pinned A-class additions:

   ```powershell
   .\scripts\install-3rd-party.ps1 -Profile win-debug -DryRun
   ```

   The version lock pins `dshmarket@1.36.0`, `dsh-better-sidebar@0.17.1`, and
   `@furongjun1999/dsh-memory@0.4.0` so repeated installations resolve the same
   direct versions. Preview mode makes no registry request and starts no `dsh`
   child process.

3. Apply only on a Windows host after reviewing the exact package specs. Apply
   requires an absolute, non-root DSH home and an approval actor:

   ```powershell
   .\scripts\install-3rd-party.ps1 -Profile win-debug `
     -DshHome C:\dsh-acceptance -ApprovedBy operator-name -Apply
   ```

   `-Version latest` or an explicit semantic version additionally requires
   `-ApproveUnpinned`; the installer verifies official-registry metadata and
   resolves exact versions before spawning `dsh`. DSH_HOME and registry values
   are injected only into that child process.

4. Run the M12 target-host acceptance runner. It defaults to a non-writing plan;
   `--live` requires project-local DSH `0.1.1-rc.2` and uses an isolated DSH_HOME:

   ```powershell
   node scripts/acceptance/m12-profile-smoke.mjs
   node scripts/acceptance/m12-profile-smoke.mjs --live `
     --output "$env:TEMP\m12-win-debug.json"
   ```

   A live pass covers the temporary host/client fixture on this Windows host
   only. Repeat the installation and startup smoke on Ubuntu; this command does
   not install the three A-class packages.

5. Validate without booting: `dsh --profile win-debug --dump-config`.

Keep machine-specific paths out of this reusable template. The lock records MIT
npm metadata, while source LICENSE files and post-install notices still require
review during live installation.
