---
title: "Files and integrations"
description: "Configure identity files, storage, harnesses, and Git integration."
---

## AGENTS.md

The main agent identity file. Synced to all configured harnesses on
change (2-second debounce). Write it in plain markdown — there is no
required structure, but a typical layout looks like this:

```markdown
# Agent Name

Short introduction paragraph.

## SOUL.md

Optional personality file for deeper character definition. Loaded by
harnesses that support separate personality and instruction files.

```markdown
# Soul

## MEMORY.md

Auto-generated working memory summary. Updated by the synthesis system.
Do not edit by hand — changes will be overwritten on the next synthesis
run. Loaded at session start when `hooks.sessionStart.includeRecentContext`
is `true`.

## Database Schema

The SQLite database at `memory/memories.db` contains three main tables.

### memories

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Primary key (UUID) |
| `content` | TEXT | Memory content |
| `type` | TEXT | `fact`, `preference`, `decision`, `daily-log`, `episodic`, `procedural`, `semantic`, `system` |
| `source` | TEXT | Source system or harness |
| `importance` | REAL | 0-1 score, decays over time |
| `tags` | TEXT | Comma-separated tags |
| `who` | TEXT | Source harness name |
| `pinned` | INTEGER | 1 if critical/pinned (never decays) |
| `is_deleted` | INTEGER | 1 if soft-deleted (tombstone) |
| `deleted_at` | TEXT | ISO timestamp of soft-delete |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |
| `last_accessed` | TEXT | Last access timestamp |
| `access_count` | INTEGER | Number of times recalled |
| `confidence` | REAL | Extraction confidence (0-1) |
| `version` | INTEGER | Optimistic concurrency version |
| `manual_override` | INTEGER | 1 if user has manually edited |

### embeddings

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Primary key (UUID) |
| `content_hash` | TEXT | SHA-256 hash of embedded text |
| `vector` | BLOB | Float32 array (raw bytes) |
| `dimensions` | INTEGER | Vector size (e.g. 768) |
| `source_type` | TEXT | `memory`, `conversation`, etc. |
| `source_id` | TEXT | Reference to parent memory UUID |
| `chunk_text` | TEXT | The text that was embedded |
| `created_at` | TEXT | ISO timestamp |

### memories_fts

FTS5 virtual table for keyword search over `content`, backed by the
`memories` table and created with the `unicode61` tokenizer. Triggers
keep the index in sync when rows are inserted, deleted, or updated.

## Harness-Specific Configuration

### Claude Code

Location: `~/.claude/`

`settings.json` installs hooks that fire at session lifecycle events:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "python3 $SIGNET_WORKSPACE/memory/scripts/memory.py load --mode session-start",
        "timeout": 3000
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "python3 $SIGNET_WORKSPACE/memory/scripts/memory.py load --mode prompt",
        "timeout": 2000
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "python3 $SIGNET_WORKSPACE/memory/scripts/memory.py save --mode auto",
        "timeout": 10000
      }]
    }]
  }
}
```

### OpenCode

Location: `~/.config/opencode/plugins/`

`signet.mjs` is a bundled OpenCode plugin installed by
`@signet/connector-opencode` that exposes `/remember` and `/recall`
as native tools within the harness.

> **Note:** Legacy `memory.mjs` installations are automatically migrated
> to `~/.config/opencode/plugins/signet.mjs` on reconnect.

### OpenClaw

Location: `$SIGNET_WORKSPACE/hooks/agent-memory/` (hook directory)

Also configures the OpenClaw workspace in `~/.openclaw/openclaw.json`
(and compatible `clawdbot` / `moltbot` config locations):

```json
{
  "agents": {
    "defaults": {
      "workspace": "$SIGNET_WORKSPACE"
    }
  }
}
```

See [HARNESSES.md](/harnesses/) for the full OpenClaw adapter docs.

## Git Integration

If your Signet workspace is a git repository, the daemon auto-commits file changes
with a 5-second debounce after the last detected change. Commit messages
use the format `YYYY-MM-DDTHH-MM-SS_auto_<filename>`. The setup wizard
offers to initialize git on first run and creates a backup commit before
making any changes.

Recommended `.gitignore` for your workspace:

```text
.daemon/
.secrets/
__pycache__/
*.pyc
*.log
```

### Watcher ignore file

Create `$SIGNET_WORKSPACE/.sigignore` to keep local runtime files in the
Signet workspace without triggering daemon watcher work or git auto-commits.
Patterns are matched relative to the workspace root and support common
gitignore-style globs such as `*`, `?`, `**`, directory prefixes, comments
with `#`, and later `!` negation inside the same file.

When no `.sigignore` exists, the daemon creates one with sensible defaults
covering known runtime artifacts (for example Fly harness homes). Example:

```text
# Harness runtimes and sockets
agents/*/.fly-*-home/
*.sock

# Keep a specific socket visible to the watcher
!agents/<agent-name>/keep.sock
```

The `.sigignore` file itself is still watched, and new ignore patterns take
effect without a daemon restart. If you remove a pattern that previously hid a
whole existing directory, restart the daemon to guarantee that subtree is added
back to the watcher. Signet also always ignores its managed source checkout,
memory database files, generated memory artifacts, and per-agent generated
`workspace/AGENTS.md`.
