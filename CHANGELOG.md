# Changelog

All notable changes are described by their user-visible behavior. Versions follow Semantic
Versioning and remain fixed across all publishable workspace packages.

## [Unreleased]

## [0.1.3] - 2026-09-05

### Changed

- Accepted short and Chinese usernames, including spaces, with shared form and
  authentication validation.
- Added an Ubuntu terminal command for administrator password recovery after
  sudo authentication, with hidden input, backups, session revocation, and
  service stop/restart handling. No web recovery endpoint is exposed.
- Upgraded the market and sidebar companions for DSH `0.1.2-rc.1`. The optional
  Python memory companion now starts only after explicit configuration.
- Added visible account/logout controls and an image file picker. Unavailable
  Server Mode hosts now show setup guidance instead of endless reconnect errors.
- Kept workspace directory selection inside the browser when using the login
  gateway, including from a remote device.
- Raised the tested DeepSeek Harness baseline to `0.1.2-rc.1` and Cordis to
  `4.0.2` across all 13 public packages.
- Migrated browser plugins from the retired client runtime to the split Session
  Controller and UI Renderer services introduced by DeepSeek Harness.
- Adapted Session history access, event lookup, headers, and branded sequence
  identifiers to the new public APIs.
- Documented explicit native-build allowlists for terminal and serial support so
  pnpm installations do not silently skip required bindings.
- Made generated host profiles keep DSH peers host-provided, preventing pnpm
  from resolving unpublished stable versions while installing release candidates.

### Fixed

- Applied account isolation to the new DSH Remote WebSocket streams and event
  replies. Logging out now closes live streams immediately.
- Bound sessions created through Typert routes to the signed-in account, restoring
  session visibility in HUD and Session Share.
- Fixed same-origin registration and login being rejected as cross-site requests.
  Forms now identify invalid fields, retain usernames, and allow password retries.
- Removed environment-based administrator bootstrap; first-run account creation
  is guided entirely by the login page.
- Bridged Luban sessions to the upstream DSH browser authentication without
  exposing the upstream authentication token to the browser.
- Fixed Session Share preventing client plugins from loading due to a missing
  service declaration, and caught failed plan/build live-update refreshes.
- Fixed the aggregate package's missing TypeScript declarations and added tarball
  checks for declared type entry points.
- Made DSH peer ranges prerelease-aware and pinned the development settings
  service so pnpm resolves the `0.1.2-rc.1` graph without requesting unpublished
  stable versions.
- Made idempotent npm publishing fall back to dist-tags when an exact-version
  lookup has not propagated yet.

## [0.1.2] - 2026-09-02

### Added

- Added an in-browser first-run setup page that creates the initial administrator
  and signs in without requiring a password environment variable.

### Changed

- Made port `42600` the documented browser entry for both local and LAN users,
  while keeping the DSH listener on loopback as an internal upstream.
- Moved all 13 public packages to the npm registry so installation no longer
  requires a GitHub account or personal access token.
- Updated protected releases to use npm trusted publishing with short-lived
  GitHub Actions identity tokens.

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

[Unreleased]: https://github.com/yin52133/dsh-luban/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/yin52133/dsh-luban/releases/tag/v0.1.3
[0.1.2]: https://github.com/yin52133/dsh-luban/releases/tag/v0.1.2
[0.1.1]: https://github.com/yin52133/dsh-luban/releases/tag/v0.1.1
[0.1.0]: https://github.com/yin52133/dsh-luban/releases/tag/v0.1.0
