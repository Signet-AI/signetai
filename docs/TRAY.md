---
title: "Tray App"
description: "Desktop system tray companion for the Signet daemon."
order: 19
section: "Infrastructure"
---

Tray App
=========

The Signet tray app is a lightweight desktop companion that sits in your
system tray and shows the daemon's current state. It provides quick
controls — start, stop, restart, open dashboard — without requiring a
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

Seven Tauri commands are registered:

| Command | Description |
|---------|-------------|
| `start_daemon` | Start the daemon |
| `stop_daemon` | Stop the daemon (SIGTERM → 3s wait → cleanup) |
| `restart_daemon` | Stop then start with 500ms pause |
| `get_daemon_pid` | Read the PID file |
| `open_dashboard` | Open `http://localhost:3850` in the default browser |
| `update_tray` | Apply a new `TrayState` to the icon and menu |
| `quit_app` | Exit the Tauri process |

A `DaemonManager` platform trait abstracts start/stop/is_running.
`linux.rs` is fully implemented. macOS and Windows are stubs.

**Linux process management:**

Start order: check for `~/.config/systemd/user/signet.service` — if
present, use `systemctl --user start signet`. Otherwise: locate bun
binary → locate `signet-daemon` → fall back to `bunx signetai daemon start`.

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

TypeScript is compiled with `bun build --target browser` (output to
`src-tauri/`). Tauri is built separately with `cargo tauri build`,
producing a self-contained `.AppImage` on Linux.

The tray build is independent of the monorepo root `bun run build`.

```bash
cd packages/tray/src-ts
bun install && bun run build

cd packages/tray
cargo tauri build
```


Deferred Features
-----------------

The following are planned for future phases and are not yet implemented:

- Autostart on login (systemd `Install` section / launchd / Windows registry)
- Desktop notifications on state transitions
- Full macOS and Windows `DaemonManager` implementations
