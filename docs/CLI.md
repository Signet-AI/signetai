---
title: "CLI Reference"
description: "Complete reference for all Signet CLI commands."
order: 9
section: "Reference"
---

Signet CLI Reference
====================

Complete reference for all Signet CLI commands. For the [[daemon]]
HTTP API, see [[api]]. For initial setup walkthrough, see [[quickstart]].

> Path note: `$SIGNET_WORKSPACE` means your active Signet workspace path.
> Default is `~/.agents`, configurable via `signet workspace set <path>`.

---

Installation
---

```bash
# bun (recommended)
bun add -g signetai

# npm
npm install -g signetai

# or installer script
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
| `signet` | Show help, examples, and command map |
| `signet setup` | First-time setup wizard |
| `signet configure` | Interactive config editor (`signet config` alias) |
| `signet status` | Show daemon and agent status |
| `signet doctor` | Run local health checks |
| `signet dashboard` | Open web UI in browser |
| `signet daemon` | Grouped daemon subcommands |
| `signet daemon start` | Start the daemon |
| `signet daemon stop` | Stop the daemon |
| `signet daemon restart` | Restart the daemon |
| `signet daemon logs` | View daemon logs |
| `signet remember` | Save a memory |
| `signet recall` | Search memories |
| `signet export` | Export a portable bundle |
| `signet import` | Import a portable bundle |
| `signet migrate-schema` | Migrate database to unified schema |
| `signet migrate-vectors` | Migrate BLOB vectors to sqlite-vec format |
| `signet sync` | Sync built-in templates and skills |
| `signet secret` | Manage encrypted secrets |
| `signet skill` | Manage agent skills from registry |
| `signet git` | Git sync management for $SIGNET_WORKSPACE |
| `signet hook` | Lifecycle hook commands |
| `signet update` | Check, install, and manage auto-updates |
| `signet bypass` | Per-session hook bypass toggle |
| `signet embed` | Manage memory embeddings |

---

`signet` (No Arguments)
---

Shows the top-level help output with examples. This keeps the CLI safe
to call from scripts and agents without dropping into an interactive
menu.

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

  Usage: signet [options] [command]

  Examples:
    signet setup
    signet status
    signet doctor
    signet daemon start
    signet remember "Nicholai prefers command-first CLIs"
```

Use explicit commands for interactive flows:

- `signet setup` — initialize or migrate a workspace
- `signet configure` — edit agent settings interactively
- `signet doctor` — troubleshoot local issues

---

`signet setup`
---

Interactive first-time setup wizard (with optional non-interactive mode).
Creates the `$SIGNET_WORKSPACE/` directory and all necessary files.

```bash
signet setup
signet setup --path /custom/path
signet setup --non-interactive \
  --name "My Agent" \
  --harness claude-code \
  --deployment-type vps \
  --embedding-provider native
```

Options:

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Custom base path (default: `$SIGNET_WORKSPACE`) |
| `--non-interactive` | Run setup without prompts |
| `--name <name>` | Agent name in non-interactive mode |
| `--description <description>` | Agent description in non-interactive mode |
| `--deployment-type <type>` | Deployment context (`local`, `vps`, `server`) used for interactive guidance and non-interactive inferred defaults |
| `--harness <harness>` | Repeatable/comma-separated harness list (`claude-code`, `opencode`, `openclaw`, `codex`) |
| `--embedding-provider <provider>` | Non-interactive embedding provider (`ollama`, `openai`, `native`, `none`) |
| `--embedding-model <model>` | Non-interactive embedding model |
| `--extraction-provider <provider>` | Non-interactive extraction provider (`claude-code`, `codex`, `ollama`, `opencode`, `openrouter`, `none`) |
| `--extraction-model <model>` | Non-interactive extraction model |
| `--search-balance <alpha>` | Non-interactive search alpha (`0-1`) |
| `--openclaw-runtime-path <mode>` | Non-interactive OpenClaw mode (`plugin`, `legacy`) |
| `--configure-openclaw-workspace` | Patch discovered OpenClaw configs to `$SIGNET_WORKSPACE` |
| `--open-dashboard` | Open dashboard after non-interactive setup |
| `--skip-git` | Skip git initialization/commits in non-interactive mode |
| `--create-local-backup` | If OpenClaw points at this workspace and no origin exists, create a local snapshot automatically |
| `--allow-unprotected-workspace` | Explicitly allow setup to finish without origin or snapshot in non-interactive mode |

Non-interactive behavior:

- setup method: create new identity (no GitHub import)
- provider flags are optional; setup infers defaults from `--deployment-type`
  when omitted
- with `--deployment-type vps`, setup prefers non-local extraction defaults
  from selected harnesses when those tools are available locally, then other
  detected tooling (`claude-code`, `codex`, `opencode`), and falls back to
  `none` when needed
- for existing-identity migration, previously configured extraction providers
  are preserved unless `--extraction-provider` is explicitly passed
- explicit provider flags override inferred defaults
- git: enabled unless `--skip-git` is passed
- when OpenClaw points at this workspace and no `origin` remote exists, setup
  requires either backup creation (`--create-local-backup`) or explicit bypass
  (`--allow-unprotected-workspace`)
- snapshot-backed protection is treated as "fresh" for 7 days; after that,
  status/doctor warn again unless a remote origin exists or a new snapshot is made

Extraction safety note:

- intended usage is `claude-code` on Haiku, `codex` on GPT Mini with a
  Pro/Max subscription, or local `ollama` with at least `qwen3:4b`
- with `--deployment-type vps`, setup avoids defaulting to local `ollama`
  extraction and prefers non-local providers
- set `--extraction-provider none` on a VPS if you do not want
  background extraction
- remote API extraction can create extreme usage fees fast

Wizard steps:

1. **Agent Name** - What to call your agent
2. **Harnesses** - Which AI platforms you use:
   - Claude Code (Anthropic CLI)
   - OpenCode
   - OpenClaw
   - Codex
3. **OpenClaw Workspace** - Appears only when an existing OpenClaw config
   is detected; workspace is patched only if you opt in, and setup warns
   that uninstalling OpenClaw can delete this workspace unless backups exist
4. **Description** - Short agent description
5. **Deployment Context** - Where Signet is running (`local`, `vps`, `server`)
   to show environment-aware guidance before extraction provider selection
6. **Embedding Provider**:
   - Built-in (recommended, no setup required)
   - Ollama (local)
   - OpenAI API
   - Skip embeddings
7. **Embedding Model** - Based on provider:
   - Built-in: `nomic-embed-text-v1.5`
   - Ollama: `nomic-embed-text`, `all-minilm`, `mxbai-embed-large`
   - OpenAI: text-embedding-3-small, text-embedding-3-large
   - Ollama selections run preflight checks for binary availability,
     service health, and model presence; if checks fail, setup offers
     retry, switch to built-in embeddings, switch to OpenAI, or
     continue without embeddings
8. **Search Balance** - Semantic vs keyword weighting
9. **Advanced Settings** (optional):
   - `top_k` - Search candidates per source
   - `min_score` - Minimum search score threshold
   - `session_budget` - Context character limit
   - `decay_rate` - Memory importance decay
10. **Import** - Optionally import from another platform
11. **Git** - Initialize version control
12. **Launch Dashboard** - Open web UI

What gets created:

```
$SIGNET_WORKSPACE/
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
- **OpenCode**: `~/.config/opencode/plugins/signet.mjs` plugin, `~/.config/opencode/AGENTS.md`
- **OpenClaw**: `$SIGNET_WORKSPACE/hooks/agent-memory/` hook directory
- **Codex**: wrapper installed at `~/.config/signet/bin/codex` with session hooks

---

`signet configure`
---

Interactive configuration editor for modifying `$SIGNET_WORKSPACE/agent.yaml`.

```bash
signet configure
signet config      # Alias
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

Daemon operations live under the `signet daemon` subcommand group. The
top-level shortcuts still exist as backwards-compatible aliases, but the
grouped form is the preferred surface.

```bash
signet daemon start
signet daemon stop
signet daemon restart
signet daemon status
signet daemon logs

# Backwards-compatible aliases
signet start
signet stop
signet restart
signet logs
```

### `signet daemon start`

Start the Signet daemon if not already running.

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

✔ Daemon started
  Dashboard: http://localhost:3850
```

Top-level alias: `signet start`

### `signet daemon stop`

Stop the running Signet daemon.

Top-level alias: `signet stop`

### `signet daemon restart`

Stop and start the daemon. Useful after installing an update.

Top-level alias: `signet restart`

### `signet daemon logs`

View daemon logs.

```bash
signet daemon logs
signet daemon logs -n 100
signet daemon logs --follow
signet daemon logs --level warn
signet daemon logs --category memory
```

Top-level alias: `signet logs`

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

`signet export` / `signet import`
---

Export and import portable Signet bundles. This is the supported path
for moving an agent between machines or backing up identity + memory
state from the CLI.

```bash
signet export
signet export --json
signet import ./signet-export-2026-03-22
signet import ./signet-export-2026-03-22.json --json --conflict merge
```

`signet export` writes a portable bundle containing:

- identity files
- `agent.yaml`
- memories
- entities
- relations
- installed skills

`signet import` restores those files into `$SIGNET_WORKSPACE/`. Conflict
handling for memories is controlled with `--conflict`:

- `skip` — keep existing memories and skip duplicates
- `overwrite` — replace matching memories
- `merge` — merge compatible records when supported

---

`signet migrate-schema`
---

Migrate an existing memory database to Signet's unified schema. Useful
when upgrading from an older version or copying `$SIGNET_WORKSPACE/` between
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

Sync built-in template files and skills to your `$SIGNET_WORKSPACE/` directory,
and re-register hooks for any detected harnesses. Run this after an
upgrade if built-in skills appear stale.

```bash
signet sync
```

---

`signet secret`
---

Manage encrypted [[secrets]] stored via the daemon, including 1Password
service-account integration.

```bash
signet secret put OPENAI_API_KEY
signet secret put GITHUB_TOKEN ghp_...   # value inline
signet secret list
signet secret delete GITHUB_TOKEN
signet secret has OPENAI_API_KEY

# 1Password integration
signet secret onepassword connect
signet secret onepassword status
signet secret onepassword vaults
signet secret onepassword import --vault Engineering --prefix OP
signet secret onepassword disconnect
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet secret put <name> [value]` | Store a secret; prompts if value omitted |
| `signet secret list` | List all secret names (never values) |
| `signet secret delete <name>` | Delete a secret (prompts for confirmation) |
| `signet secret has <name>` | Check existence; exits 0 if found, 1 if not |
| `signet secret onepassword connect [token]` | Save/validate a 1Password service account token |
| `signet secret onepassword status` | Show 1Password connection and vault access status |
| `signet secret onepassword vaults` | List accessible 1Password vaults |
| `signet secret onepassword import` | Import password-like fields from 1Password into Signet secrets |
| `signet secret onepassword disconnect` | Remove stored 1Password service account token |

A `GITHUB_TOKEN` secret is used by `signet git` to authenticate pushes to
a remote repository.

---

`signet skill`
---

Manage agent [[skills]] from the GitHub-based registry. Skills are installed
to `$SIGNET_WORKSPACE/skills/` and symlinked into [[harnesses|harness]] config directories.

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

Git sync management for the `$SIGNET_WORKSPACE` directory. A `GITHUB_TOKEN`
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

When hook payloads are provided over stdin, the CLI now prefers canonical
`session_key` / `sessionKey` fields before legacy `session_id` aliases.
`signet hook user-prompt-submit` forwards preferred `userMessage` when it is
provided, while still carrying legacy `userPrompt` compatibility fields.
`signet hook session-end` forwards both stdin `transcript_path` /
`transcriptPath` and inline `transcript` content for lossless capture.
`signet hook compaction-complete` also forwards stdin `cwd` as the fallback
`project` scope when transcript persistence has not landed yet.
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

`signet bypass`
---

Toggle per-session hook bypass. When bypass is enabled for a session, all
Signet hooks return empty no-op responses — the daemon is still running,
but it stays silent for that session. MCP tools (memory_search, memory_store,
etc.) continue to work normally.

```bash
signet bypass                   # List active sessions with bypass status
signet bypass --list            # Same as above
signet bypass <session-key>     # Enable bypass for a session
signet bypass --off <session-key>  # Disable bypass for a session
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet bypass` | List active sessions and their bypass status |
| `signet bypass --list` | Same as `signet bypass` with no arguments |
| `signet bypass <session-key>` | Enable bypass for the given session |
| `signet bypass --off <session-key>` | Disable bypass for the given session |

You can also bypass hooks entirely at the process level using the
`SIGNET_BYPASS` environment variable (see below).

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
| `SIGNET_PATH` | Base agents directory | `$SIGNET_WORKSPACE` |
| `SIGNET_HOST` | Daemon host for local calls and default bind address | `127.0.0.1` |
| `SIGNET_BIND` | Explicit daemon bind address override | `SIGNET_HOST` |
| `SIGNET_LOG_FILE` | Explicit daemon log file path | unset |
| `SIGNET_LOG_DIR` | Daemon log directory override | `$SIGNET_WORKSPACE/.daemon/logs` |
| `SIGNET_SQLITE_PATH` | macOS explicit SQLite dylib override used by the daemon before opening the database | unset |
| `SIGNET_SESSION_START_TIMEOUT` | Session-start hook timeout in ms for Signet-managed clients and generated Claude Code hook configs | `15000` |
| `SIGNET_FETCH_TIMEOUT` | Legacy fallback for session-start timeout in ms when `SIGNET_SESSION_START_TIMEOUT` is unset | `15000` |
| `SIGNET_BYPASS` | Skip all hook processing (exit immediately) | unset |

---

Exit Codes
---

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
