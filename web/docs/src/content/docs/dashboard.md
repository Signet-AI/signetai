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

## Navigation and cached data

Home, Memory, Dreams, and Settings are client-rendered hash routes. Home includes
sources and memory search; Settings has its own sections for data and files,
connectors, network, inference, secrets, logs, advanced options, and licenses.
Select the three dots at the bottom of the sidebar to open Settings.

Dashboard reads share a session-only cache. Returning to a page shows its last
successful result immediately. Fresh results avoid another daemon request;
stale results refresh in the background. Simultaneous reads of the same query
share one request, and slow polls do not start overlapping requests.

The cache retains at most 48 results and 12 MiB of serialized payloads, with a
4 MiB per-result limit. Least recently used results are evicted first, and
inactive results expire after five minutes. These are payload bounds, not a
measurement of JavaScript heap usage. Parameterized reads, including constellation
density, memory searches, and individual Dreaming passes, have separate keys.
The cache is scoped to the daemon origin and authentication token, is cleared
on authorization failures. Successful dashboard mutations invalidate the affected
queries for background refresh. The cache is never
persisted to disk. Refreshing the application starts a new cache.

Visible pages poll at their existing intervals; hidden pages and windows stop
polling. Failed background reads retain their last successful result and show
that updates are unavailable. Read requests have a 20-second deadline. The daemon
continues to own database access and every durable transition, including in the
desktop application.

The constellation currently refreshes a bounded snapshot. This cache does not
introduce graph streaming or a change-feed protocol; external changes are picked
up on the next visible-page refresh.

## Sources and imports

Use the Sources section on Home to work with source-backed recall:

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
