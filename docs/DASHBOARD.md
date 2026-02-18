# Dashboard

Signet's web dashboard at `http://localhost:3850` gives you a visual interface for your agent's memory, config, skills, and more.

---

## Opening the Dashboard

```bash
signet dashboard
```

This opens your default browser. If the daemon isn't running, it starts it first.

You can also navigate directly to `http://localhost:3850` — the dashboard is served statically by the daemon on that port.

---

## Config Editor

The config editor loads all `.md` and `.yaml` files from `~/.agents/`. It shows them as editable tabs.

**Files shown (in priority order):**
- `agent.yaml`
- `AGENTS.md`
- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- Any other `.md` or `.yaml` files in `~/.agents/`

**How to save:**

Use `Cmd+S` (or `Ctrl+S`) to save the current file. Changes are written to disk immediately and the daemon's file watcher picks them up automatically. If `AGENTS.md` is saved, harness syncing happens within 2 seconds.

The editor is syntax-aware for markdown and YAML but doesn't enforce schema validation — you're working with plain text files.

---

## Embeddings Visualization

The **Embeddings** tab renders a 2D projection of your memory space. Each memory that has a vector embedding appears as a dot.

- **Layout:** UMAP dimensionality reduction brings similar memories close together. Clusters represent related topics.
- **Color coding:** dots are colored by source harness (who saved the memory).
- **Edges:** KNN edges connect each memory to its nearest neighbors — denser areas indicate tightly related content.
- **Interaction:** click a dot to see the memory content and find similar memories.

If you have no embeddings yet (either because you haven't saved memories or because the embedding provider isn't configured), this view shows an empty graph.

**To populate embeddings:** save memories via `/remember` in any harness, or use the API. Embedding generation is asynchronous — memories appear in the keyword search immediately but may take a moment to show in the visualization.

---

## Memory Browser

The memory browser lets you search, filter, and explore your memories.

### Search

Type in the search box to run a hybrid search (semantic + keyword). Results appear in order of relevance score. The score and search method (hybrid, vector, or keyword) are shown for each result.

### Filters

The filter panel on the side lets you narrow results by:

| Filter | Values |
|--------|--------|
| Type | fact, preference, decision, rule, learning, issue, session_summary |
| Tags | comma-separated tag names |
| Source | which harness saved it (claude-code, openclaw, etc.) |
| Pinned | show only pinned/critical memories |
| Importance | minimum score (0–1) |
| Date | memories saved since a date |

Filters can be combined. An empty search with filters returns memories matching only the filter criteria.

### Memory card actions

Each memory card has a **Find Similar** button that runs a vector similarity search against that memory's embedding, returning the most conceptually related memories.

---

## Skills Panel

The skills panel shows installed skills and lets you browse and install from skills.sh.

**Installed tab:** lists skills with name, description, and version. Each skill has a remove button.

**Browse tab:** search the skills.sh registry. Results show name, description, and install count. Skills already installed are marked. Click Install to add a skill.

**Detail view:** clicking a skill name shows the full SKILL.md content, so you can read what the skill does before installing.

---

## Harness Status

The **Harnesses** section shows which harness config files exist on disk:

| Harness | File checked |
|---------|-------------|
| Claude Code | `~/.claude/CLAUDE.md` |
| OpenCode | `~/.config/opencode/AGENTS.md` |
| OpenClaw (Source) | `~/.agents/AGENTS.md` |

A green check means the file exists. Missing files mean that harness isn't configured or the auto-sync hasn't run yet.

Click **Regenerate** to manually trigger a re-sync of all harness configs from AGENTS.md.

---

## Secrets Panel

The secrets panel (in Settings) shows all stored secret names. Values are always masked — there is no way to view a stored secret value through the dashboard.

You can:
- Add a new secret (enters via a password input field)
- Delete a secret

For adding secrets from the command line, use `signet secret put <NAME>`.

---

## Logs Viewer

The logs section shows recent daemon logs in real-time via Server-Sent Events. Log entries are color-coded by level:

- `INFO` — normal operations (gray)
- `WARN` — non-fatal issues (yellow)
- `ERROR` — errors worth investigating (red)

You can filter by log level and category (memory, harness, git, skills, etc.).

---

## API-Only Mode

If the dashboard build is not present (e.g., you're running the daemon from source without building the frontend), the daemon falls back to an API-only mode. Visiting `http://localhost:3850` shows a minimal HTML page listing available API endpoints.

To build the dashboard:
```bash
cd packages/cli/dashboard
bun run build
```

---

## Port Configuration

The default port is 3850. To change it:

```bash
SIGNET_PORT=4000 signet start
```

Or set it in your environment permanently. The dashboard URL will change accordingly.
