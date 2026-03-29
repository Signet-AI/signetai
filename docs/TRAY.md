---
title: "Tray App"
description: "Desktop system tray companion for the Signet daemon."
order: 19
section: "Infrastructure"
---

Tray App
=========

The Signet tray app is a lightweight desktop companion that sits in your
system tray and shows the [[daemon]]'s current state. It provides quick
controls — start, stop, restart, open [[dashboard]] — without requiring a
terminal or browser.

Source: `packages/tray/`


Architecture
------------

The app is built with Tauri v2. Rust handles the tray lifecycle, menu
rendering, and process management. A TypeScript polling loop drives state
detection and communicates with the Rust layer via Tauri commands.

This split keeps the hot path (HTTP polling) in TypeScript and reserves
Rust for platform-specific work (signal handling, PID file management,
systemd interaction).


TypeScript side (`src-ts/`)
----------------------------

`state.ts` defines the `DaemonState` discriminated union:

- `unknown` — initial state before the first poll
- `running` — daemon is up; carries `version`, `pid`, `uptime`,
  `healthScore`, `healthStatus`
- `stopped` — daemon is not running
- `error` — poll failed unexpectedly; carries `message`

`index.ts` runs the polling loop. It polls `/health` every 5 seconds
when the daemon is running, or every 2 seconds when stopped (for fast
startup detection). Only calls the `update_tray` Tauri command when the
state actually changes.

`menu.ts` translates `DaemonState` into a `TrayUpdate` struct passed to
`update_tray`.


Rust side (`src-tauri/src/`)
-----------------------------

Eleven Tauri commands are registered:

| Command | Description |
|---------|-------------|
| `start_daemon` | Start the daemon |
| `stop_daemon` | Stop the daemon (SIGTERM → 3s wait → cleanup) |
| `restart_daemon` | Stop then start with 500ms pause |
| `get_daemon_pid` | Read the PID file |
| `open_dashboard` | Open `http://localhost:3850` in the default browser |
| `update_tray` | Apply a new `TrayState` to the icon and menu |
| `quick_capture` | Open the quick-capture popup window |
| `search_memories` | Open the memory search popup window |
| `quit_capture_window` | Close the capture window |
| `quit_search_window` | Close the search window |
| `quit_app` | Exit the Tauri process |

A `DaemonManager` platform trait abstracts start/stop/is_running.
All three platform managers are implemented.

Start order prefers an existing systemd user service when configured.
Otherwise, the tray launches its bundled daemon sidecar
(`signet-daemon*`) first so desktop builds stay self-contained. If the
sidecar is unavailable, it falls back to system-installed runtimes
(`signet`, `signet-daemon`, or Bun+daemon script).

**Linux process management:**

Start order: check for `~/.config/systemd/user/signet.service` — if
present, use `systemctl --user start signet`. Otherwise: launch bundled
`signet-daemon*` first, then try installed `signet daemon start`, then
Bun-driven fallbacks (`signet-daemon`, `daemon.js`,
`bun x signetai daemon start`).

Stop: send SIGTERM, poll at 100ms intervals up to 3 seconds, then clean
up the PID file.


Menu by State
-------------

| State | Menu items |
|-------|-----------|
| Running | Open Dashboard · Stop · Restart · Quit |
| Stopped | Start · Quit |
| Error | Retry / View Logs · Quit |


Icon States
-----------

Icon assets live at `packages/tray/icons/`. Three variants:

- **Running** — full opacity
- **Stopped** — gray / desaturated
- **Error** — red accent

All icons are 32×32 PNG.


Build
-----

### Prerequisites

- **Bun** — for building the TypeScript frontend
- **Rust toolchain** (stable) — for compiling the Tauri backend
- **System libraries** — Tauri v2 on Linux requires `webkit2gtk-4.1`,
  `libayatana-appindicator3`, and related GTK/GLib dev packages. On
  Arch: `webkit2gtk-4.1 libayatana-appindicator`. On Ubuntu/Debian:
  `libwebkit2gtk-4.1-dev libappindicator3-dev`.

### Build from source

TypeScript is compiled with `bun build --target browser` (output to
`dist/`). Tauri reads from `dist/` as configured in `tauri.conf.json`.
Before packaging, a staged daemon sidecar is copied to
`src-tauri/binaries/` and bundled into the desktop artifact.
The bundled sidecar currently comes from `packages/daemon-rs` (shadow
rewrite) and is treated as a compatibility fallback, not the primary
runtime path.

The tray build is independent of the monorepo root `bun run build`.

```bash
cd packages/tray

# 1. Install TS dependencies
bun install

# 2. Build TypeScript frontend (runs automatically as beforeBuildCommand)
bun run build:ts

# 3. Build daemon sidecar binary (host target by default)
bun run build:daemon

# 4. Stage daemon sidecar (target-aware)
bun run stage:daemon

# 5. Build the Tauri app
bun tauri build
```

The `build:ts` script compiles `src-ts/index.ts` with `--target browser
--minify` and copies the HTML entry points (`index.html`,
`capture.html`, `search.html`) into `dist/`.

For development with hot-reload:

```bash
cd packages/tray
cargo tauri dev
```

This runs `bun run build:ts` as a `beforeDevCommand` and starts the
Tauri dev server.

### Output

| Platform | Output |
|----------|--------|
| Linux | `.deb` in `src-tauri/target/release/bundle/deb/` and `.AppImage` in `src-tauri/target/release/bundle/appimage/` |
| macOS | `.dmg` / `.app` in `src-tauri/target/release/bundle/dmg/` |
| Windows | `.msi` in `src-tauri/target/release/bundle/msi/` |

### Channel metadata

Release CI derives channel metadata from tagged assets:

- **Arch (AUR)**: `deploy/aur/PKGBUILD` + `.SRCINFO`
- **Homebrew Cask**: `deploy/channels/homebrew/signet.rb`
- **winget**: `deploy/channels/winget/*.yaml`

These manifests are emitted as CI artifacts so channel repos can be
updated without recomputing checksums locally.
Release CI also validates Arch packaging by building a
`signet-desktop-bin` `.pkg.tar.*` artifact from the generated
`PKGBUILD`.

Desktop CI supports two signing paths for macOS/Windows artifacts:
official signing when cert secrets are present, or self-signed fallback
when running without official signing credentials.


Configuration
-------------

The tray app currently has no user-facing configuration file. It
hardcodes `http://localhost:3850` as the daemon URL (matching the
daemon's default). If you change the daemon port via `SIGNET_PORT`,
the tray app will not detect it — this is a known limitation.

The Tauri app metadata is defined in `src-tauri/tauri.conf.json`:

- **identifier**: `ai.signet.app`
- **productName**: `Signet`
- **bundle targets**: all platforms enabled
- **CSP**: allows `connect-src` to `http://localhost:*` for daemon API access


Polling Architecture
--------------------

The TypeScript side runs four independent polling loops at staggered
intervals:

| Poller | Endpoint | Running interval | Stopped interval |
|--------|----------|-----------------|-----------------|
| Health | `/health` | 5s | 2s |
| Memories | `/api/memories?limit=10` | 15s | — |
| Diagnostics | `/api/diagnostics` | 30s | — |
| Embeddings | `/api/embeddings/status` | 60s | — |

Secondary pollers (memories, diagnostics, embeddings) only fire while
the daemon is alive. When the daemon comes online, all secondary
pollers kick off immediately. The tray icon and menu are only updated
via `invoke("update_tray")` when the assembled state actually changes
(JSON diff check).

The `DaemonState` union carries rich data when running: version, PID,
uptime, health score, memory counts, embedding provider/model/coverage,
queue depth, ingestion rate (exponential moving average), and the 10
most recent memories.


Known Limitations
-----------------

- **Hardcoded daemon URL** — the tray always connects to
  `http://localhost:3850`. Custom ports via `SIGNET_PORT` are not
  picked up.
- **No autostart** — the tray does not register itself to start on
  login (planned).
- **No desktop notifications** — state transitions are only reflected
  in the tray icon/menu, not via OS notifications (planned).
