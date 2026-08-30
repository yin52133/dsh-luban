# Changelog

All notable changes are grouped by milestone and module. Versions follow
Semantic Versioning and remain fixed across all publishable workspace packages.

## [Unreleased]

### Added

- Added a fail-closed M12 target-host profile smoke runner for isolated DSH
  fixture installation, host/client lifecycle checks, restart, and cleanup.

### Changed

- Standardized the canonical authentication entry at `/luban-auth/login`.
- Corrected the Ubuntu user systemd launcher to run
  `dsh --profile ubuntu-server --no-open` and made the exact
  `LUBAN_BOOT_RESTORE=1` sentinel force M03 recovery even when profile config
  disables boot restore.
- Hardened the A-class installers with a schema-v2 identity/integrity lock,
  official-registry metadata checks, target-host and DSH_HOME binding, explicit
  approval attribution, and separately approved exact unpinned resolution.
- Made night-task capacity reservation and terminal scheduler accounting a
  single crash-safe ledger transaction across concurrent schedulers and days.
- Aligned HUD context usage with the DSH rc2 session projection and retained a
  bounded fallback for missing or unloaded projection services.
- Strengthened direct acceptance evidence for durable plan rejection feedback,
  serial snippet injection, and agent-facing context archive retrieval.

## [0.1.0] - 2026-08-30

### Added

- Initial DSH Luban monorepo foundation and module implementations.
- M12 plugin scaffolding with optional DSH `0.1.1-rc.2` lazy-CJS client output.
- Cross-platform pinned A-class installer previews and dual profile templates.
- Fixed-version, README, manifest, secret, and npm payload release gates.
- Protected tag release workflow that reuses identical tarballs for npm and
  GitHub Release artifacts.

[Unreleased]: https://github.com/yin52133/dsh-luban/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yin52133/dsh-luban/releases/tag/v0.1.0
