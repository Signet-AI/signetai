# @signet/extension

Browser extension for Chrome and Firefox that connects to the Signet
daemon running on `127.0.0.1:3850`. Provides a popup mini dashboard,
highlight-to-remember functionality, and keyboard shortcuts for saving
web content directly to Signet memory.

## Features

### Popup Dashboard

Click the toolbar icon to open a compact dashboard showing:

- Daemon health status (healthy / degraded / offline)
- Daemon version
- Memory stats (total, embedded, pipeline queue)
- Searchable list of recent memories (hybrid search via `/api/memory/recall`)
- Quick links to the full dashboard and settings

### Highlight to Remember

Select text on any page, then save it to Signet via:

- **Right-click context menu** — "Remember with Signet"
- **Keyboard shortcut** — `Ctrl+Shift+S` (Mac: `Cmd+Shift+S`)

Both trigger a floating save panel (shadow DOM isolated) where you can:

- Preview the selected text
- Add comma-separated tags
- Set importance (0.00 - 1.00 slider)
- View source metadata (page URL and title, captured automatically)

The memory is saved with `source_type: "browser-extension"` and
`type: "fact"`.

### Options Page

Configure the extension via the settings page:

- **Daemon URL** — defaults to `http://127.0.0.1:3850`
- **Auth Token** — optional, required only for team/hybrid auth mode
- **Theme** — auto (follows browser), dark, or light

### Background Service Worker

- Registers the "Remember with Signet" context menu item
- Polls daemon health every 60 seconds via `/health`
- Updates toolbar badge (green = healthy, yellow = degraded, red = offline)
- Routes messages between popup, content script, and options page

## Install

> Store distribution is coming soon. For now, install from the build
> output.

### Chrome

1. Run `bun run build` (see below)
2. Open `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the `dist/chrome/` directory

### Firefox

1. Run `bun run build` (see below)
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Select `dist/firefox/manifest.json`

## Build

```bash
cd surfaces/browser-extension
bun install
bun run build            # Build both Chrome and Firefox targets
bun run build:chrome     # Chrome only → dist/chrome/
bun run build:firefox    # Firefox only → dist/firefox/
bun run dev              # Watch mode (rebuilds on file changes)
```

The build script (`build.ts`) uses `Bun.build` with ESM output
targeting browser. Firefox gets a modified manifest with
`background.scripts` instead of `service_worker`, plus
`browser_specific_settings` for gecko compatibility (min version 128).

Source maps are included. Output is minified in production builds
and unminified in watch mode.

## Architecture

```
src/
├── background/
│   └── service-worker.ts    # Context menu, health polling, badge, message routing
├── content/
│   ├── content.ts           # Selection panel (shadow DOM), message handling
│   └── content.css          # Content script styles
├── options/
│   ├── index.html           # Settings page markup
│   └── options.ts           # Daemon URL, auth token, theme config
├── popup/
│   ├── index.html           # Popup markup (stats, search, memory list)
│   ├── popup.ts             # Popup orchestrator
│   ├── popup.css            # Popup styles
│   └── components/          # health-badge, memory-list, memory-stats, search-bar
├── shared/
│   ├── api.ts               # Daemon API client (fetch-based)
│   ├── config.ts            # chrome.storage config wrapper
│   ├── theme.ts             # Theme resolution and application
│   └── types.ts             # TypeScript interfaces
└── icons/                   # Extension icons (16, 48, 128px)
```

### Manifest

Manifest V3. Permissions: `storage`, `contextMenus`, `activeTab`.
Host permission: `http://127.0.0.1:3850/*`.

Content script runs on all URLs at `document_idle`.

## Configuration

All settings are stored in `chrome.storage.local` and managed through
the options page (`chrome://extensions` → Signet → Options).

| Setting | Default | Description |
|---------|---------|-------------|
| Daemon URL | `http://127.0.0.1:3850` | Signet daemon HTTP address |
| Auth Token | _(empty)_ | Bearer token for authenticated daemon instances |
| Theme | `auto` | `auto`, `dark`, or `light` |

## Daemon API Usage

The extension communicates with these daemon endpoints:

| Endpoint | Method | Used By |
|----------|--------|---------|
| `/health` | GET | Service worker health polling, popup health badge |
| `/api/status` | GET | Popup health badge (version display) |
| `/api/identity` | GET | Popup (agent identity) |
| `/api/memories` | GET | Popup recent memories list, stats |
| `/api/memory/recall` | POST | Popup search |
| `/api/memory/remember` | POST | Content script save panel |
| `/api/pipeline/status` | GET | Popup stats (pipeline queue) |
