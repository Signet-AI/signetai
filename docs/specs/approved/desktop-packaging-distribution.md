---
title: "Desktop Packaging and Distribution"
status: approved
informed_by:
  - "docs/research/technical/RESEARCH-DESKTOP-PACKAGING-DISTRIBUTION.md"
success_criteria:
  - "Desktop release CI produces installable artifacts for macOS, Windows, Ubuntu, and Arch deliverables from one contract"
  - "Tray runtime can launch bundled daemon binaries as a fallback when system-installed runtimes are unavailable"
  - "Ubuntu outputs include both .deb and .AppImage artifacts per release"
  - "Arch package metadata (PKGBUILD and .SRCINFO) is generated from release AppImage + checksum"
  - "Arch CI validates generated PKGBUILD by building a .pkg.tar.* artifact in an Arch Linux environment"
  - "Desktop release jobs resolve a signing mode (official or self-signed) before publish"
scope_boundary: "Desktop packaging, runtime bundling preference, CI workflows, and Arch metadata generation. Does not replace npm package publishing flows."
---

# Desktop Packaging and Distribution

## Context

Signet already has a Tauri desktop app, but distribution is still
incomplete as a release contract:

- runtime startup depends too heavily on global installs
- Linux channel expectations differ between Ubuntu and Arch users
- signing readiness is implicit rather than enforced

This spec locks the packaging contract for macOS, Windows, Ubuntu, and
Arch.

## Contract

1. Desktop build workflows must produce:
   - macOS installer artifacts
   - Windows installer artifacts
   - Ubuntu `.deb` and `.AppImage`
   - Arch deliverables as `.AppImage` + AUR metadata
2. Tray runtime startup must support bundled daemon binaries as a
   fallback path when system runtimes are unavailable.
3. Release workflows must resolve signing mode before publish:
   - official signing when certificate secrets are present
   - self-signed fallback when official signing is unavailable
4. AUR metadata generation must be deterministic from version, AppImage
   URL, and checksum.
5. Arch packaging must be validated in CI by building from the generated
   `PKGBUILD`.

## Integration notes

- Depends on `signet-runtime` for daemon behavior contracts.
- Desktop packaging remains independent of npm release train mechanics.
- Generated AUR metadata is emitted as CI artifacts and can be pushed by
  a separate credentialed job.
- `packages/daemon-rs` remains the shadow daemon rewrite. Desktop sidecar
  usage is intentionally fallback-only until parity cutover is approved.
