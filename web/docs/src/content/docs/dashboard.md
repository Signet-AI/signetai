---
title: "Dashboard"
description: "Use the Signet Dashboard to inspect memory, sources, knowledge, secrets, and daemon state."
---

The Signet Dashboard is the daemon's browser-based operator interface. It gives you a visual way to inspect the installation and perform a small set of supported actions without replacing the CLI, harness integrations, or daemon configuration.

Use the [CLI](/cli/) for memory capture and recall, daemon lifecycle, diagnostics, scheduled tasks, source automation, and scripting. Use the [harness](/harnesses/) integrations for agent workflows. The Dashboard is a view over the running daemon and its current workspace, not a separate memory store.

## Start and open the Dashboard

The daemon must be running. The simplest path is:

```bash
signet dashboard
```

`signet dashboard` also has the `signet ui` alias. It starts the daemon when necessary, prints the local URL, and opens that URL in your default browser. To start the daemon yourself:

```bash
signet daemon start
signet status
```

The default address is:

```text
http://localhost:3850
```

You can pass a workspace path to the Dashboard command:

```bash
signet dashboard --path /path/to/workspace
```

For non-default daemon deployments, the address is determined by `SIGNET_PORT` and the binding settings in the daemon's launch environment. Open the URL reported by `signet dashboard` or daemon startup rather than assuming the default port. `SIGNET_HOST`, `SIGNET_BIND`, and `SIGNET_PATH` also affect where the daemon listens and which workspace it uses. See [CLI environment variables](/cli/environment/) and [Daemon](/daemon/) before binding the daemon beyond localhost. Do not expose a local or hybrid daemon directly to the public internet.

The Network section in Dashboard Settings reports the active port, bind address, and network mode. Those values are status information. Change daemon launch or configuration through the supported daemon configuration path, then restart the daemon if required.

## What you see

The current Dashboard sidebar is grouped into four areas. Counts and health indicators are loaded from the daemon and can be blank while a request is loading.

| Sidebar item | Purpose |
| --- | --- |
| **Home** | Installation overview: memory and ontology counts, configured agent state, connected sources, activity, and pending ontology review suggestions. This is the current overview surface. |
| **Memory** | Browse memories, search with keyword and semantic ranking, filter by memory type or recurring topics, inspect embedding-index coverage, pin a memory, or delete one. |
| **Sources** | View source health and indexing counts, connect or import sources, re-index a source, download a source snapshot, copy its root path, or remove it. Source removal is destructive to Signet-owned indexed data. Start with [Sources](/sources/) for connector and import behavior. |
| **Graph** | Explore the knowledge constellation built from entities, aspects, attributes, dependencies, and sources. The graph supports bounded density, node-category inspection, entity search, and a detail panel. |
| **Dreams** | Inspect dreaming worker state, the active or latest pass, tool-call trace, attention items, failures, and the last successful summary. When idle, **Trigger pass** starts an incremental pass; while a pass runs, the control is a status indicator. |
| **Secrets** | List secret names without revealing values, add or delete secrets, and use the available 1Password integration. Secret values are write-only from the Dashboard. |
| **Skills** | Present in the navigation as a disabled **Coming soon** item in the current build. It is not a skill or plugin management surface yet. Use the [Skills](/skills/) documentation and CLI instead. |
| **Agents** | Present as a disabled **Coming soon** item. The current Dashboard does not provide an agent-roster or multi-workspace editor. |

The sidebar footer includes the daemon version when it is available. The theme toggle changes the Dashboard's light or dark appearance. The Settings button opens a modal rather than a separate sidebar route.

### Names from older Dashboard versions

The current app does not have separate **Overview**, **Ontology**, **Tasks**, or **Audit** sidebar routes:

- **Overview** is now **Home**.
- **Ontology** is split between **Memory** and **Graph**.
- **Tasks** is not exposed by the current Dashboard. Use [Scheduled tasks](/scheduling/) and the CLI/API instead.
- **Audit** is not exposed as a Dashboard route. Use Settings → **Logs** for recent daemon logs, or `signet daemon logs` for CLI filtering and follow mode.

Do not use old URL hashes or screenshots as a guide to the current navigation. The supported deep links are the current view hashes such as `#home`, `#memory`, `#sources`, `#graph`, `#dreaming`, and `#secrets`.

## Safe operator actions

### Inspect status and health

Home, the sidebar, and Settings → Network poll daemon status. The Dashboard also uses `/health` as a liveness check. A loading state means the request has not completed; an empty value is not proof that the installation has no data.

For an independent CLI check:

```bash
signet status
signet doctor
curl http://localhost:3850/health
```

Use `signet doctor` for local health checks and suggested fixes. Use `signet status --json` when a script needs machine-readable status.

### Search and inspect memory

Memory starts with the current memory list. Enter a query to search memories, or use the memory-type and recurring-topic filters. Search results show their source and harness metadata where available. The index indicator reports embedding health and coverage.

The available memory actions are mutations:

- **Pin** changes the memory's pinned state.
- **Delete** soft-deletes the memory after confirmation.

Use the CLI for explicit capture and recall workflows:

```bash
signet remember "A durable fact to store"
signet recall "A question to search"
```

### Inspect knowledge and dreaming

Graph is an exploration surface. It loads a bounded constellation from the daemon, lets you adjust density, search for an entity, and inspect relationships and citations. It does not turn the graph visualization into a separate source of truth.

Dreams is an operational view of the dreaming worker. It refreshes frequently while a pass runs and shows status, timing, tokens, cost, attention, backlog, failures, and tool traces. Triggering a pass is an active operation. Do not start another pass while one is already running.

### Inspect and manage sources

Sources displays each connected source's kind, mode, root, health, artifacts, chunks, indexed count, and current indexing job. The page supports these actions:

- **Import files** through the file-upload flow. Supported file labels in the current UI include JSON, CSV, Markdown, and documents.
- **Connect a source** through the connector flow. The current choices include Obsidian, GitHub, and Discord.
- **Re-index** a connected source.
- **Snapshot** a source into a JSON download.
- **Remove** a source after confirmation. Removal purges Signet-owned indexed artifacts for that source; it does not edit the original source.

For path picking, the desktop app can use a native picker. In a plain browser, the daemon may report that the picker is unavailable and the flow will ask for a path instead. Read [Sources](/sources/) before connecting a vault, repository, or Discord source. It covers source ownership, tokens, read-only behavior, indexing, snapshots, and purge semantics.

### Inspect secrets without exposing them

Secrets shows names and the configured provider, never stored values. Add or delete a secret from the Dashboard when that is convenient. The 1Password panel can connect, list vaults, and import selected secret names when configured.

Never paste a secret into a log, issue, screenshot, support request, or public configuration. For CLI-managed secrets, use the commands in [Secrets](/secrets/), for example:

```bash
signet secret put SECRET_NAME
```

The value is sent to the secret store and is not read back by the Dashboard.

### Configure supported settings

Open Settings from the gear in the sidebar footer. The modal currently contains:

- **Network**: read-only daemon port, bind address, and network mode; editable sync toggles for cloud sync and automatic commits.
- **Inference**: backend inference, aggregation, embedding endpoint/model assignment, connected provider status, provider search, API-key or OAuth connection flows where supported, and route health.
- **Logs**: recent daemon logs with text filtering, level filters, expandable raw entries, JSON export, and privacy-safe telemetry delivery health when available.
- **Advanced**: privacy telemetry, pipeline and mutation safety switches, maintenance mode, extraction and recall tuning, dreaming, embedding extras, and related runtime settings.

Settings writes configuration through the daemon. Treat changes to pipeline, mutation, maintenance, inference, and embedding settings as operational changes. Read the relevant [configuration](/configuration/) and [pipeline](/pipeline/) references first, and verify the resulting state with `signet status` or the Dashboard's health indicators.

## Loading, errors, and recovery

The Dashboard reads from the daemon on the same origin. If a request fails, views show a loading or error state rather than fabricating counts. Use the following sequence when the page is unavailable or stale:

1. Check the daemon and workspace:

   ```bash
   signet status
   signet doctor
   ```

2. Check the health endpoint:

   ```bash
   curl http://localhost:3850/health
   ```

3. Restart the daemon if it is down or stale:

   ```bash
   signet daemon restart
   ```

4. Inspect recent errors:

   ```bash
   signet daemon logs --level warn
   signet daemon logs --follow
   ```

5. If the daemon is healthy but the page says the Dashboard is not installed, the frontend build is absent. In a source checkout, build it and restart or relaunch the daemon:

   ```bash
   cd surfaces/dashboard
   bun install
   bun run build
   ```

   The daemon serves the generated `surfaces/dashboard/build/index.html` in a monorepo checkout. Published packages may serve bundled dashboard assets instead.

If no dashboard assets are available, the daemon intentionally serves a minimal API-only page at `/`. That page links to the health check and a small set of inspection endpoints, including `/api/status`, `/api/config`, `/api/memories`, `/api/harnesses`, and `/api/skills`. This confirms that the daemon is alive but does not restore the Dashboard UI.

## CLI and daemon boundaries

Use the CLI when you need repeatable or scriptable operations:

```bash
signet status
signet doctor
signet recall "query"
signet remember "fact"
signet daemon logs --follow
```

Use the daemon and its documentation for lifecycle, network binding, authentication, configuration, and API behavior. Use the Dashboard for visual inspection and the supported actions described above. When a public page, CLI command, or API contract disagrees with the UI, verify the running daemon and consult the owning reference rather than assuming that an old Dashboard label is still valid.

## Development note

The public operator contract is the built Dashboard served by the daemon. For contributor setup and the Dashboard build contract, see the repository's [contributor documentation](https://github.com/Signet-AI/signetai/blob/main/surfaces/dashboard/README.md).
