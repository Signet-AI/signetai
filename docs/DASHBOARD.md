Dashboard
=========

The Signet dashboard is a SvelteKit static app served by the daemon at
`http://localhost:3850`. It is a supplementary visual interface — useful
for browsing memory, editing config files, and inspecting daemon state,
but not the primary way to interact with Signet. The CLI and harness
integrations are the primary interfaces.


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

**Config** — A plain-text editor for your agent's identity files. Files
are loaded from `~/.agents/`. Use `Cmd+S` / `Ctrl+S` to save. Saving
`AGENTS.md` triggers harness sync within 2 seconds.

**Memory** — Browse and search your memory database. Search runs hybrid
(semantic + keyword) lookup. You can filter by type, tags, source
harness, pinned status, importance score, and date. Each memory card has
a "Find Similar" button that runs a vector similarity search. The count
shown reflects your current filter state.

**Embeddings** — A 2D graph of your memory space. Memories with vector
embeddings appear as dots; UMAP dimensionality reduction clusters
related memories together. Dots are colored by source harness. Click a
dot to inspect the memory content and view its nearest neighbors. If no
embeddings exist, the graph is empty.

**Logs** — Real-time daemon log stream via Server-Sent Events. Entries
are color-coded by level (info, warn, error). You can filter by level
and toggle auto-scroll.

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


Port Configuration
------------------

The default port is 3850. To change it:

```bash
SIGNET_PORT=4000 signet start
```

The dashboard URL changes accordingly.
