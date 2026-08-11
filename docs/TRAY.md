---
title: "Desktop Tray"
description: "Electron desktop shell and menu bar companion for the Signet daemon."
---

# Desktop Tray

The consumer desktop distribution for Signet is the Electron app in
`surfaces/desktop`. It owns the native window, menu bar tray, bundled Bun
runtime, and daemon process lifecycle for desktop installs.

`surfaces/tray` is intentionally small. It contains shared tray/menu state
utilities only. It is not a desktop shell and contains no legacy native-shell code.

## Runtime model

On startup, the Electron app probes the configured daemon port
(`SIGNET_PORT`, default `3850`). If a daemon is already running, the app
attaches to it. If not, it starts the bundled Bun daemon from the packaged
resources and marks that daemon as desktop-owned.

The daemon remains a separate local process. The desktop app is a
distribution and control layer, not a replacement for the daemon.

Update ownership is split by install surface. The CLI daemon updater owns the
CLI/native daemon used by headless and server-style installs. It does not own a
packaged Electron desktop app. Packaged desktop builds own their updates through
`electron-updater` and the Signet GitHub release feed. The app checks on startup
and from the tray menu on macOS, Windows, and Linux AppImage builds. Linux `.deb`
installs do not have an Electron auto-update path. The legacy CLI-managed Linux
AppImage refresh remains separate and does not detect or update packaged
macOS/Windows applications.

This keeps the dashboard/runtime bundle and its Electron shell on one update
channel. Users on an older packaged desktop build must first install a build
that includes the updater; older builds cannot self-bootstrap an updater.

## User-facing behavior

The Electron desktop app provides:

- native tray/menu bar status
- daemon start, stop, and restart actions
- hide-to-tray behavior when the main window closes
- dashboard launch/focus
- quick memory capture
- memory search
- bundled daemon fallback for consumer installs
- desktop update checks from the tray menu and on startup for packaged builds

When a packaged update is available, Signet prompts to download it and then
restart into the new build. The dashboard is bundled into the desktop app, so
desktop updates are how desktop users receive new dashboard pages such as
Sources.

The dashboard is still the same web dashboard served by the daemon. Browser
usage and desktop usage share the dashboard codepath.

## Development

```bash
bun run build:desktop
```

For focused desktop work:

```bash
cd surfaces/desktop
bun run build:desktop
bun run dev
```

The desktop build stages:

1. the shared tray utilities
2. the Bun daemon and dashboard bundle
3. a platform Bun runtime
4. Electron packaging artifacts

Generated desktop resources live under `surfaces/desktop/resources/` and are
not committed.

## Release artifacts

The desktop workflow builds Electron artifacts for:

| Platform | Artifact |
|---|---|
| Linux | `.AppImage` and `.deb` |
| macOS | `.dmg` and updater `.zip` |
| Windows | installer `.exe` |
| Arch | AppImage-backed AUR metadata |

AUR metadata is generated from the release AppImage URL and checksum by
`deploy/aur/generate-pkgbuild.sh`.
