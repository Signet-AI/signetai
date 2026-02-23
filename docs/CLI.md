---
title: "CLI Reference"
description: "Complete reference for all Signet CLI commands."
order: 9
section: "Reference"
---

Signet CLI Reference
====================

Complete reference for all Signet CLI commands.

---

Installation
---

```bash
# Via npm/npx
npx signet setup

# Via bun
bunx signet setup

# Via installer script
curl -sL https://signetai.sh/install | bash
```

Runtime operations that need package execution (skills, updates) follow
the primary package manager captured during setup, with deterministic
fallback when unavailable.

---

Commands Overview
---

| Command | Description |
|---------|-------------|
| `signet` | Interactive TUI menu |
| `signet setup` | First-time setup wizard |
| `signet config` | Interactive config editor |
| `signet status` | Show daemon and agent status |
| `signet dashboard` | Open web UI in browser |
| `signet start` | Start the daemon |
| `signet stop` | Stop the daemon |
| `signet restart` | Restart the daemon |
| `signet logs` | View daemon logs |
| `signet daemon` | Grouped daemon subcommands |
| `signet remember` | Save a memory |
| `signet recall` | Search memories |
| `signet migrate` | Import from other platforms |
| `signet migrate-schema` | Migrate database to unified schema |
| `signet migrate-vectors` | Migrate BLOB vectors to sqlite-vec format |
| `signet sync` | Sync built-in templates and skills |
| `signet secret` | Manage encrypted secrets |
| `signet skill` | Manage agent skills from registry |
| `signet git` | Git sync management for ~/.agents |
| `signet hook` | Lifecycle hook commands |
| `signet update` | Check, install, and manage auto-updates |
| `signet embed` | Manage memory embeddings |

---

`signet` (No Arguments)
---

Opens an interactive TUI menu for common operations.

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

  ● Daemon running
    PID: 12345 | Uptime: 2h 15m

? What would you like to do?
  Open dashboard
  View status
  Configure settings
  Manage harnesses
  View logs
  Restart daemon
  Stop daemon
  Exit
```

If the daemon is not running, you'll be prompted to start it.

---

`signet setup`
---

Interactive first-time setup wizard. Creates the `~/.agents/` directory
and all necessary files.

```bash
signet setup
signet setup --path /custom/path
```

Options:

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Custom base path (default: `~/.agents`) |

Wizard steps:

1. **Agent Name** - What to call your agent
2. **Harnesses** - Which AI platforms you use:
   - Claude Code (Anthropic CLI)
   - OpenCode
   - OpenClaw
   - Cursor
   - Windsurf
   - ChatGPT
   - Gemini
3. **OpenClaw Workspace** - Appears only when an existing OpenClaw config
   is detected; workspace is patched only if you opt in
4. **Description** - Short agent description
5. **Embedding Provider**:
   - Ollama (local, recommended)
   - OpenAI API
   - Skip embeddings
6. **Embedding Model** - Based on provider:
   - Ollama: nomic-embed-text, all-minilm, mxbai-embed-large
   - OpenAI: text-embedding-3-small, text-embedding-3-large
   - Ollama selections run preflight checks for binary availability,
     service health, and model presence; if checks fail, setup offers
     retry, switch-to-OpenAI, or continue-without-embeddings
7. **Search Balance** - Semantic vs keyword weighting
8. **Advanced Settings** (optional):
   - `top_k` - Search candidates per source
   - `min_score` - Minimum search score threshold
   - `session_budget` - Context character limit
   - `decay_rate` - Memory importance decay
9. **Import** - Optionally import from another platform
10. **Git** - Initialize version control
11. **Launch Dashboard** - Open web UI

What gets created:

```
~/.agents/
├── agent.yaml           # Configuration
├── AGENTS.md            # Agent identity
├── MEMORY.md            # Working memory
├── memory/
│   ├── memories.db      # SQLite database
│   └── scripts/         # Memory tools
├── harnesses/
├── hooks/               # OpenClaw hooks (if selected)
│   └── agent-memory/
└── .daemon/
    └── logs/
```

If harnesses are selected, their configs are also created:

- **Claude Code**: `~/.claude/settings.json` with hooks, `~/.claude/CLAUDE.md`
- **OpenCode**: `~/.config/opencode/memory.mjs` plugin, `~/.config/opencode/AGENTS.md`
- **OpenClaw**: `~/.agents/hooks/agent-memory/` hook directory

---

`signet config`
---

Interactive configuration editor for modifying `~/.agents/agent.yaml`.

```bash
signet config
```

Sections:

1. **Agent identity** - Name and description
2. **Harnesses** - AI platform selection
3. **Embedding provider** - Ollama/OpenAI settings
4. **Search settings** - Alpha, top_k, min_score
5. **Memory settings** - Session budget, decay rate
6. **View current config** - Display agent.yaml contents

Changes are saved to `agent.yaml` immediately.

---

`signet status`
---

Show comprehensive status of the Signet installation.

```bash
signet status
signet status --path /custom/path
```

Options:

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Custom base path |

Output:

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

  Status

  ● Daemon running
    PID: 12345
    Uptime: 2h 15m
    Dashboard: http://localhost:3850

  ✓ AGENTS.md
  ✓ agent.yaml
  ✓ memories.db

  Memories: 42
  Conversations: 7

  Path: /home/user/.agents
```

---

`signet dashboard`
---

Open the Signet web dashboard in your default browser.

```bash
signet dashboard
signet ui          # Alias
```

Options:

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Custom base path |

If the daemon is not running, it will be started automatically.

---

Daemon Commands
---

Daemon operations are available both as top-level shortcuts and under the
`signet daemon` subcommand group. Both forms are equivalent.

```bash
# Top-level shortcuts (backwards compatible)
signet start
signet stop
signet restart
signet logs

# Grouped form
signet daemon start
signet daemon stop
signet daemon restart
signet daemon status
signet daemon logs
```

### `signet start` / `signet daemon start`

Start the Signet daemon if not already running.

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

✔ Daemon started
  Dashboard: http://localhost:3850
```

### `signet stop` / `signet daemon stop`

Stop the running Signet daemon.

### `signet restart` / `signet daemon restart`

Stop and start the daemon. Useful after installing an update.

### `signet logs` / `signet daemon logs`

View daemon logs.

```bash
signet logs
signet logs -n 100
signet logs --follow
signet logs --level warn
signet logs --category memory
```

Options:

| Option | Description |
|--------|-------------|
| `-n, --lines <n>` | Number of lines to show (default: 50) |
| `-f, --follow` | Follow log output in real-time |
| `-l, --level <level>` | Filter by level: `debug`, `info`, `warn`, `error` |
| `-c, --category <category>` | Filter by category: `daemon`, `api`, `memory`, `sync`, `git`, `watcher` |

### Service Installation

The daemon can be installed as a system service (systemd on Linux,
launchd on macOS) using the daemon package's bun scripts:

```bash
cd packages/daemon
bun run install:service    # Install as systemd/launchd service
bun run uninstall:service  # Remove the service
```

These are package-level scripts, not top-level `signet` CLI commands.
They register a unit that starts the daemon automatically at login.

---

`signet remember`
---

Save a memory to the database. The daemon embeds it for vector search if
an embedding provider is configured.

```bash
signet remember "User prefers dark mode"
signet remember "critical: never push to main" --critical
signet remember "deploy runs on Friday" --tags devops,deploy --who user
```

Options:

| Option | Description |
|--------|-------------|
| `-w, --who <who>` | Who is remembering (default: `user`) |
| `-t, --tags <tags>` | Comma-separated tags |
| `-i, --importance <n>` | Importance score, 0-1 (default: 0.7) |
| `--critical` | Mark as critical/pinned |

Output:

```
✔ Saved memory: mem_abc123 (embedded)
  Tags: devops,deploy
```

---

`signet recall`
---

Search memories using hybrid vector + keyword search.

```bash
signet recall "user preferences"
signet recall "deploy process" --limit 5
signet recall "auth" --tags backend --who claude-code
signet recall "secrets" --json
```

Options:

| Option | Description |
|--------|-------------|
| `-l, --limit <n>` | Max results (default: 10) |
| `-t, --type <type>` | Filter by memory type |
| `--tags <tags>` | Filter by tags (comma-separated) |
| `--who <who>` | Filter by author |
| `--json` | Output raw JSON |

---

`signet migrate`
---

Import conversations and memories from other platforms.

```bash
signet migrate
signet migrate chatgpt
```

Supported sources:

- **ChatGPT** - Import from conversations.json export
- **Claude** - Import from Claude export
- **Gemini** - Import from Google AI Studio export
- **Custom** - Custom JSON format

The interactive flow prompts for the source platform and the path to the
export file, then confirms how many items were imported.

---

`signet migrate-schema`
---

Migrate an existing memory database to Signet's unified schema. Useful
when upgrading from an older version or copying `~/.agents/` between
machines.

```bash
signet migrate-schema
signet migrate-schema --path /custom/path
```

Supported source schemas:

| Schema | Source |
|--------|--------|
| `python` | Original Python memory system |
| `cli-v1` | Early Signet CLI (v0.1.x) |
| `core` | Current unified schema (no migration needed) |

Migration is idempotent - safe to run multiple times. All existing
memories are preserved. The daemon is stopped and restarted automatically
during the process.

Output:

```
- Checking database schema...
  Migrating from python schema...
  ✓ Migrated 261 memories from python to core

  Migration complete!
```

---

`signet migrate-vectors`
---

Migrate existing BLOB-format embeddings to the sqlite-vec format. Run
this once after upgrading from a version that stored vectors as raw BLOBs.

```bash
signet migrate-vectors
signet migrate-vectors --keep-blobs
signet migrate-vectors --dry-run
```

Options:

| Option | Description |
|--------|-------------|
| `--keep-blobs` | Keep the old BLOB column after migration (safer rollback) |
| `--remove-zvec` | Delete `vectors.zvec` file after successful migration |
| `--dry-run` | Show what would be migrated without making changes |

---

`signet sync`
---

Sync built-in template files and skills to your `~/.agents/` directory,
and re-register hooks for any detected harnesses. Run this after an
upgrade if built-in skills appear stale.

```bash
signet sync
```

---

`signet secret`
---

Manage encrypted secrets stored via the daemon.

```bash
signet secret put OPENAI_API_KEY
signet secret put GITHUB_TOKEN ghp_...   # value inline
signet secret list
signet secret delete GITHUB_TOKEN
signet secret has OPENAI_API_KEY
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet secret put <name> [value]` | Store a secret; prompts if value omitted |
| `signet secret list` | List all secret names (never values) |
| `signet secret delete <name>` | Delete a secret (prompts for confirmation) |
| `signet secret has <name>` | Check existence; exits 0 if found, 1 if not |

A `GITHUB_TOKEN` secret is used by `signet git` to authenticate pushes to
a remote repository.

---

`signet skill`
---

Manage agent skills from the GitHub-based registry. Skills are installed
to `~/.agents/skills/` and symlinked into harness config directories.

```bash
signet skill list
signet skill install browser-use
signet skill uninstall weather
signet skill search github
signet skill show <name>
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet skill list` | List installed skills |
| `signet skill install <name>` | Install a skill from the registry |
| `signet skill uninstall <name>` | Remove an installed skill |
| `signet skill search <query>` | Search the GitHub skills registry |
| `signet skill show <name>` | Show skill details |

Registry search queries GitHub for repositories tagged `agent-skill` or
containing a `SKILL.md` file. Unauthenticated searches are limited to
10 requests per minute.

---

`signet git`
---

Git sync management for the `~/.agents` directory. A `GITHUB_TOKEN`
secret must be set for push operations.

```bash
signet git status
signet git sync
signet git pull
signet git push
signet git enable
signet git enable --interval 600
signet git disable
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet git status` | Show git status, sync state, and token presence |
| `signet git sync` | Pull remote changes then push |
| `signet git pull` | Pull changes from remote |
| `signet git push` | Push commits to remote |
| `signet git enable` | Enable daemon auto-sync |
| `signet git disable` | Disable daemon auto-sync |

`signet git enable` options:

| Option | Description |
|--------|-------------|
| `-i, --interval <seconds>` | Sync interval in seconds (default: 300) |

---

`signet hook`
---

Lifecycle hook commands for harness integration. These are called by
connector packages automatically; you rarely need to invoke them directly.

```bash
signet hook session-start --harness claude-code
signet hook user-prompt-submit --harness claude-code
signet hook session-end --harness claude-code
signet hook pre-compaction --harness claude-code
signet hook compaction-complete --harness claude-code --summary "..."
signet hook synthesis
signet hook synthesis-complete --content "..."
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet hook session-start` | Initialize session, inject context |
| `signet hook user-prompt-submit` | Inject relevant memories for a prompt |
| `signet hook session-end` | Extract and save memories from transcript |
| `signet hook pre-compaction` | Get summary instructions before compaction |
| `signet hook compaction-complete` | Save session summary after compaction |
| `signet hook synthesis` | Get the MEMORY.md synthesis prompt |
| `signet hook synthesis-complete` | Save synthesized MEMORY.md content |

Most subcommands require `-H, --harness <harness>` identifying the calling
platform (e.g. `claude-code`, `opencode`, `openclaw`). If the daemon is
not running, hooks exit cleanly with code 0 so the harness is not blocked.

---

`signet update`
---

Check for updates, install them manually, or configure unattended
auto-installs. Running `signet update` with no subcommand is equivalent
to `signet update check`.

```bash
signet update               # same as check
signet update check
signet update check --force
signet update install
signet update status
signet update enable
signet update enable --interval 3600
signet update disable
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet update check` | Check if a newer version is available |
| `signet update install` | Download and install the latest version |
| `signet update status` | Show auto-update settings and last result |
| `signet update enable` | Enable unattended background installs |
| `signet update disable` | Disable unattended background installs |

`signet update check` options:

| Option | Description |
|--------|-------------|
| `-f, --force` | Force a fresh check, ignoring cached result |

`signet update enable` options:

| Option | Description |
|--------|-------------|
| `-i, --interval <seconds>` | Check interval in seconds (default: 21600; range: 300-604800) |

After `signet update install` completes, a daemon restart is required to
run the new version: `signet daemon restart`.

---

`signet embed`
---

Manage memory embeddings. Requires the daemon to be running.

```bash
signet embed backfill
signet embed backfill --batch-size 100
signet embed backfill --dry-run
signet embed gaps
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet embed backfill` | Re-embed memories missing vector embeddings |
| `signet embed gaps` | Show count of memories missing embeddings |

`signet embed backfill` options:

| Option | Description |
|--------|-------------|
| `--batch-size <n>` | Memories per batch (default: 50) |
| `--dry-run` | Preview without calling the embedding provider |

After `backfill` completes, coverage is printed:

```
  Coverage: 100.0% (1200/1200 embedded)
```

---

Environment Variables
---

| Variable | Description | Default |
|----------|-------------|---------|
| `SIGNET_PORT` | Daemon HTTP port | `3850` |
| `SIGNET_PATH` | Base agents directory | `~/.agents` |
| `SIGNET_HOST` | Daemon bind address | `localhost` |

---

Exit Codes
---

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
