---
title: "Desktop Packaging and Distribution Research"
question: "What packaging and release contract should Signet use to ship signed desktop builds for macOS, Windows, Ubuntu, and Arch?"
---

# Desktop Packaging and Distribution Research

## Question

What packaging and release contract should Signet use to ship signed
desktop builds for macOS, Windows, Ubuntu, and Arch?

## Current baseline

- Desktop app exists in `packages/tray` (Tauri v2).
- CI has a `desktop-build.yml` workflow that builds target matrices.
- Linux builds currently rely on generic bundling; Arch channel
  automation is absent.
- Runtime startup still falls back to globally installed CLI/Bun paths
  and does not guarantee a packaged fallback runtime.
- Signing/notarization requirements are not enforced as a contract.

## Risks in current state

1. Packaging without bundled runtime produces install-time drift across
   machines (daemon availability differs by user environment).
2. Unspecified signing contract leads to ad-hoc release quality.
3. Arch users are underserved without AUR metadata and update flow.
4. Ubuntu users need native install (`.deb`) plus portable fallback
   (`.AppImage`) for reliability.

## Recommended contract

1. Bundle a platform daemon runtime with desktop artifacts as a fallback
   path when system-installed runtimes are unavailable.
2. Ship per-platform installers/artifacts:
   - macOS: `.dmg`/`.app`
   - Windows: `.msi`
   - Ubuntu: `.deb` + `.AppImage`
   - Arch: `.AppImage` + AUR `-bin` package metadata
3. Add signing preflight in CI so release jobs fail early when signing
   secrets are not configured.
4. Make channel automation explicit (AUR metadata generation now, remote
   publish hook when credentials exist).

## Practical implication

Desktop packaging is both release infrastructure and runtime behavior.
The app should preserve system-runtime parity where available, while
keeping a bundled daemon sidecar available as a no-install fallback.
