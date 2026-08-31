---
title: "Dashboard"
description: "Use the local Signet dashboard to inspect memory, sources, graph, Dreams, secrets, and runtime settings."
---

The Signet dashboard is a React 19 + Vite single-page application served by the local daemon. It is a visual interface for the same local daemon API used by the CLI and integrations.

Start the daemon, then open the dashboard:

```bash
signet daemon start
signet dashboard
```

The default URL is `http://localhost:3850`. If you set `SIGNET_PORT`, use that port instead.

## Current navigation

The dashboard uses hash routes. These routes are available in the current application:

| Route | Surface | What it is for |
|---|---|---|
| `#home` | Home | Daemon and workspace overview. |
| `#memory` | Memory | Browse and search stored memory. |
| `#sources` | Sources | Connect supported sources, import files, inspect source health, re-index, snapshot, or remove a source. |
| `#graph` | Graph | Inspect the knowledge graph. |
| `#dreaming` | Dreams | Inspect Dreaming status and attention. |
| `#secrets` | Secrets | Inspect stored secret names and manage secrets without exposing their values. |

Unknown hashes fall back to the current/default view rather than opening a legacy route.

`Agents` and `Skills` are visible as disabled “Coming soon” navigation rows in the current build. They are not finished management surfaces. The retired Overview, Ontology, Tasks, and Audit tabs are not part of this dashboard.

## Settings

Select the gear in the lower-left account row to open the settings modal. The current modal groups controls into:

- Network: local daemon address and sync settings.
- Inference: provider accounts, model routing, embedding configuration, and route checks.
- Logs: runtime log controls.
- Advanced: additional daemon configuration.

Settings are a modal, not a hash-routed dashboard tab. Treat the daemon and configuration references as the authority for operational behavior.

## Sources and imports

Open `#sources` to work with source-backed recall:

- **Connect a source** offers the dashboard’s basic Obsidian, GitHub, and Discord forms.
- **Import files** uploads text, Markdown, JSON, HTML, CSV, and supported document formats as durable source artifacts.
- Existing source cards show health and index status and provide re-index, snapshot, and remove actions.

The dashboard connect form intentionally exposes only a small set of fields. In particular, Discord uses a guild ID, optional display name, and a secret reference for its bot token. Advanced Discord options such as sync mode, filters, cache paths, and bounded indexing settings belong in the [Discord source API reference](/api/documents-sources/#post-api-sources-discord), not in the dashboard form.

For the source lifecycle and import behavior, see [Sources](/sources/). For HTTP request and response shapes, see [Documents and sources API](/api/documents-sources/).

The Sources dashboard distinguishes file-import job progress from Dreaming
attention and consumption. It shows the job id immediately, per-file states,
imported/duplicate/rejected/pending counts, bounded rejection details, and
reconciliation. Pause, resume, retry, and cancel call the daemon controls; the
browser does not maintain a second client-only queue. The target agent is
required, and any embedded transcript agent id is displayed as provenance only.

## Serving behavior

The daemon serves the built dashboard as a generic static SPA. Its dashboard handler passes `/api/*`, `/health`, and `/sse` through to their own handlers; remaining extensionless paths fall back to `index.html`.

A packaged daemon can also serve embedded dashboard assets. If neither a built nor embedded dashboard is available, `/` shows a small API-only fallback page rather than a dashboard.

## Development

The dashboard source lives in `surfaces/dashboard/` and uses React, Vite, Tailwind, and shadcn/ui. Run its development server from that package:

```bash
cd surfaces/dashboard
bun run dev
```

The development server serves the frontend separately from the daemon. Start a daemon as well when you need live API data.
