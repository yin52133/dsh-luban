# Changelog

All notable changes are described by their user-visible behavior. Versions follow Semantic
Versioning and remain fixed across all publishable workspace packages.

## [Unreleased]

## [0.1.1] - 2026-09-02

### Added

- Added `@yin52133/dsh-luban`, a complete aggregate package that installs all
  standalone Luban plugins together with pinned `dshmarket`,
  `dsh-better-sidebar`, and `@furongjun1999/dsh-memory` companions.
- Added a fail-closed target-host profile smoke runner for isolated DSH
  fixture installation, host/client lifecycle checks, restart, and cleanup.
- Added an opt-in production browser runner and Windows/Ubuntu result
  aggregator with browser progress, page readback, and screenshot evidence.
- Added a mounted visual readback acceptance runner through the production
  attachment and DSH followup path, with exact message/turn/route evidence and
  fail-closed cleanup.

### Changed

- Moved the implementation status ledger from the repository root to
  `design/checklist.json` and updated all validators and documentation links.
- Made generated GitHub Release notes and titles display the exact suite
  version prominently, and require a successful mainline CI run for the tag commit.
- Documented complete-suite and standalone installation paths in both READMEs.
- Standardized the canonical authentication entry at `/luban-auth/login`.
- Corrected the Ubuntu user systemd launcher to run
  `dsh --profile ubuntu-server --no-open` and made the exact
  `LUBAN_BOOT_RESTORE=1` sentinel force keepalive recovery even when profile config
  disables boot restore.
- Made third-party plugin installation repeatable with fixed package versions, target-host
  checks, an isolated DSH_HOME, idempotent reruns, and post-install load checks.
- Made night-task capacity reservation and terminal scheduler accounting a
  single crash-safe ledger transaction across concurrent schedulers and days.
- Aligned HUD context usage with the DSH rc2 session projection and retained a
  bounded fallback for missing or unloaded projection services.
- Strengthened direct acceptance evidence for durable plan rejection feedback,
  serial snippet injection, and agent-facing context archive retrieval.
- Reconciled checklist notes with the canonical status legend: runner availability
  no longer implies target-host or provider acceptance.

### Fixed

- Replaced the unreliable dynamic repository-license badge with an explicit MIT
  badge linked to the tracked license.
- Quoted Mermaid node labels in the Chinese and English architecture diagrams so
  GitHub can render package names and slash-separated labels correctly.

## [0.1.0] - 2026-08-30

### Added

- Initial DSH Luban monorepo foundation and module implementations.
- Plugin scaffolding with optional DSH `0.1.1-rc.2` lazy-CJS client output.
- Cross-platform pinned third-party installer previews and dual profile templates.
- Fixed-version, README, manifest, and package payload release checks for 12
  scoped `@yin52133/dsh-luban-*` packages.
- Protected tag workflow that publishes identical tarballs to GitHub Packages
  and attaches them to the GitHub Release using the repository `GITHUB_TOKEN`.

[Unreleased]: https://github.com/yin52133/dsh-luban/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/yin52133/dsh-luban/releases/tag/v0.1.1
[0.1.0]: https://github.com/yin52133/dsh-luban/releases/tag/v0.1.0
