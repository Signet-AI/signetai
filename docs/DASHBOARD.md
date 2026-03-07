---
title: "Dashboard"
description: "Web dashboard for monitoring and management."
order: 17
section: "Infrastructure"
---

Dashboard
=========

The Signet dashboard is a Svelte 5 + Vite static app served by the [[daemon]] at
`http://localhost:3850`. It is a supplementary visual interface — useful
for browsing [[memory]], editing config files, and inspecting daemon state,
but not the primary way to interact with Signet. The [[cli|CLI]] and
[[harnesses|harness]] integrations are the primary interfaces.


Accessing the Dashboard
-----------------------

The daemon must be running first:

```bash
signet start
```

Then visit `http://localhost:3850` in your browser, or run:

```bash
signet dashboard
```

The `signet dashboard` command opens your default browser. If the daemon
is not already running, it starts it first.


Layout
------

The dashboard is a single-page app with three regions:

- **Left sidebar** — agent identity summary, connector status, and a
  file list for config editing.
- **Center panel** — the main tabbed workspace.
- **Right sidebar** — a compact memory panel with quick search. Hidden
  when the Memory tab is active.

The header shows daemon version, total memory count, and connected
harness count.


Left Sidebar
------------

The left sidebar has three sections.

**Identity** shows the agent name and creature type from `IDENTITY.md`,
plus a quick count of total memories and active connectors.

**Connectors** lists each configured harness (Claude Code, OpenCode,
OpenClaw, etc.) and whether the harness config file exists on disk. A
green indicator means the file is present and the harness is synced. If
a connector shows `OFF`, run `signet sync` or save `AGENTS.md` to
trigger a re-sync.

**Config Files** lists all `.md` and `.yaml` files found in `~/.agents/`.
Clicking a file opens it in the Config editor.


Tabs
----

**Config** — A CodeMirror 6 editor for your agent's identity files.
Files are loaded from `~/.agents/`. The editor provides syntax
highlighting (markdown for `.md` files, YAML for `.yaml`), line
numbers, bracket matching, fold gutters, search (`Ctrl+F`), and undo
history. Use `Cmd+S` / `Ctrl+S` to save. Saving `AGENTS.md` triggers
harness sync within 2 seconds. The editor uses a custom dark theme
matching the dashboard design language, with a light theme variant
activated by the `data-theme="light"` attribute.

**Settings** — A YAML editor (also CodeMirror 6) for `agent.yaml`.
Modify embedding provider, pipeline V2 flags, search settings, memory
retention windows, and auth configuration without leaving the browser.
Changes are saved directly to `~/.agents/agent.yaml`.

**Memory** — Browse and search your memory database. Search runs hybrid
(semantic + keyword) lookup. You can filter by type, tags, source
harness, pinned status, importance score, and date. Each memory card has
a "Find Similar" button that runs a vector similarity search. The count
shown reflects your current filter state.

**Embeddings** — A 3D force-directed graph of your memory space
(powered by `3d-force-graph` / Three.js). Memories with vector
embeddings appear as nodes; edges connect k-nearest neighbors.

Coordinates are computed server-side via UMAP dimensionality reduction
(`GET /api/embeddings/projection`) and cached until the embedding count
changes. The server returns both 2D and 3D projections; the dashboard
uses the 3D variant. Node positions are scaled by a factor of 52 and
seeded from the UMAP coordinates; the force simulation refines layout
from there.

Nodes are colored by source (the `who` field). Node size scales with
importance (base 0.6, up to 2.0). Click a node to inspect the memory
and view its nearest neighbors in a side panel. Hovering a node shows
a tooltip with the source and a truncated content label.

Filter presets let you slice the graph by source, memory type, or
importance range. Preset selections are persisted to `localStorage`.

**Cluster lens mode** highlights a selected node's neighborhood:
when active, only nodes in the `lensIds` set are rendered at full
opacity while the rest are dimmed. Edges are similarly filtered.
Pinned memories are visually distinguished.

The `EmbeddingCanvas3D` component exposes `focusNode(id)` to animate
the camera toward a specific node, and `refreshAppearance()` to
re-apply color/opacity changes without rebuilding the graph.

**Constellation View — Entity Overlay**

The Embeddings tab's constellation view renders a 4-tier D3 force
simulation that layers the knowledge graph on top of the memory space:

- **Entities** (hexagons, 10–22px) — gravitational centers, sized by
  mention density
- **Aspects** (circles, 5–8px) — orbit their parent entity
- **Attributes** (small circles, 3–4px) — orbit their parent aspect
- **Memories** (dots, 2px) — leaf nodes, orbit their parent attribute

Performance caps keep the simulation responsive:
- Zero-mention entities are excluded unless pinned by the user
- Maximum 500 entities, ordered by pinned status then mention count
- Memory leaf nodes are dropped entirely if total node count exceeds 3,000

Clicking an entity node opens an inspector panel showing the entity type,
aspects list, dependency edges, and memory count. Clicking a memory node
opens the existing memory detail panel.

**Predictor Metrics Tab**

When the predictive memory scorer is enabled, a Predictor tab surfaces
scorer health metrics:

- NDCG@10 score from the most recent continuity evaluation
- EMA-smoothed model health signal (rolling quality indicator)
- Drift detection status (flags when model performance has degraded)
- Training pair count (total comparison pairs accumulated)

The predictor is disabled by default; the tab shows a "not enabled"
placeholder until `predictor.enabled: true` is set in `agent.yaml`.


**Logs** — Real-time daemon log stream via Server-Sent Events
(`/api/logs/stream`). A Live/Stop toggle controls the stream.
Entries are color-coded by level (`debug`, `info`, `warn`, `error`)
and labeled by category: `daemon`, `api`, `memory`, `sync`, `git`,
`watcher`, `embedding`, `harness`, `system`, `hooks`, `pipeline`,
`skills`, `secrets`, `auth`, `session-tracker`, `summary-worker`,
`document-worker`, `maintenance`, `retention`, `llm`. Click an
entry to open a split detail panel with the full JSON payload,
duration display, and a copy-to-clipboard button.

**Secrets** — Shows stored secret names. Values are always masked. You
can add new secrets (via a password input) or delete existing ones. For
CLI use, prefer `signet secret put <NAME>`.

**Skills** — Lists installed skills and lets you browse the skills.sh
registry. Click a skill name to read its full `SKILL.md` before
installing. Already-installed skills are marked.


API-Only Fallback
-----------------

If the dashboard build is missing (e.g., running the daemon from source
without building the frontend), visiting `http://localhost:3850` shows
a minimal HTML page listing available API endpoints instead.

Build the dashboard to restore the full UI:

```bash
cd packages/cli/dashboard
bun run build
```


Development
-----------

To run the dashboard in dev mode with hot reload:

```bash
cd packages/cli/dashboard
bun install
bun run dev
```

This starts a Vite dev server at `http://localhost:5173`. The daemon
must still be running at port 3850 for API calls to work.


Tasks Tab
---------

The Tasks tab shows a kanban board for scheduled agent prompts. Four
columns display task state:

- **Scheduled** — Enabled tasks waiting for their next run
- **Running** — Currently executing tasks with elapsed timer
- **Completed** — Recent successful runs
- **Failed** — Recent failed runs with error summary

Each card shows the task name, harness badge, cron schedule, and
next/last run time. Click a card to open the detail sheet with full
run history and stdout/stderr logs.

Use the **+ New Task** button to create tasks. The form includes
cron presets, harness selection, and a security warning for Claude
Code's `--dangerously-skip-permissions` flag.

Tasks can be enabled/disabled via the toggle switch on each card,
or triggered for an immediate manual run.


Port Configuration
------------------

The default port is 3850. To change it:

```bash
SIGNET_PORT=4000 signet start
```

The dashboard URL changes accordingly.
