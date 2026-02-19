# Signet CLI Reference

Complete reference for all Signet CLI commands.

---

## Installation

```bash
# Via npm/npx
npx signet setup

# Via bun
bunx signet setup

# Via installer script
curl -sL https://signetai.sh/install | bash
```

Runtime operations that need package execution (skills/update install) follow the primary package manager captured during setup, with deterministic fallback when unavailable.

---

## Commands Overview

| Command | Description |
|---------|-------------|
| `signet` | Interactive TUI menu |
| `signet setup` | First-time setup wizard |
| `signet config` | Interactive config editor |
| `signet start` | Start the daemon |
| `signet stop` | Stop the daemon |
| `signet restart` | Restart the daemon |
| `signet status` | Show daemon and agent status |
| `signet dashboard` | Open web UI in browser |
| `signet logs` | View daemon logs |
| `signet migrate` | Import from other platforms |
| `signet migrate-schema` | Migrate database to unified schema |
| `signet secret` | Manage encrypted secrets |
| `signet skill` | Manage agent skills from registry |
| `signet git` | Git sync management for ~/.agents |
| `signet hook` | Lifecycle hook commands |
| `signet update` | Check and install updates |

---

## `signet` (No Arguments)

Opens an interactive TUI menu for common operations.

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

  ● Daemon running
    PID: 12345 | Uptime: 2h 15m

? What would you like to do?
  🌐 Open dashboard
  📊 View status
  ⚙️  Configure settings
  🔗 Manage harnesses
  📜 View logs
  🔄 Restart daemon
  ⏹  Stop daemon
  👋 Exit
```

If the daemon is not running, you'll be prompted to start it.

---

## `signet setup`

Interactive first-time setup wizard. Creates the `~/.agents/` directory and all necessary files.

```bash
signet setup
signet setup --path /custom/path
```

### Options

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Custom base path (default: `~/.agents`) |

### Wizard Steps

1. **Agent Name** - What to call your agent
2. **Harnesses** - Which AI platforms you use:
   - Claude Code (Anthropic CLI)
   - OpenCode
   - OpenClaw
   - Cursor
   - Windsurf
   - ChatGPT
   - Gemini
3. **OpenClaw Workspace** - Prompt appears only when an existing OpenClaw config is detected; workspace is patched only if you opt in
4. **Description** - Short agent description
5. **Embedding Provider**:
    - Ollama (local, recommended)
    - OpenAI API
    - Skip embeddings
6. **Embedding Model** - Based on provider:
    - Ollama: nomic-embed-text, all-minilm, mxbai-embed-large
    - OpenAI: text-embedding-3-small, text-embedding-3-large
   - Ollama selections run preflight checks for binary availability, service health, and model presence
   - If checks fail, setup offers retry, switch-to-OpenAI, or continue-without-embeddings
7. **Search Balance** - Semantic vs keyword weighting
8. **Advanced Settings** (optional):
   - top_k: Search candidates per source
   - min_score: Minimum search score threshold
   - session_budget: Context character limit
   - decay_rate: Memory importance decay
9. **Import** - Optionally import from another platform
10. **Git** - Initialize version control
11. **Launch Dashboard** - Open web UI

### What Gets Created

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

### Harness Configurations

If harnesses are selected, their configs are also created:

- **Claude Code**: `~/.claude/settings.json` with hooks, `~/.claude/CLAUDE.md`
- **OpenCode**: `~/.config/opencode/memory.mjs` plugin, `~/.config/opencode/AGENTS.md`
- **OpenClaw**: `~/.agents/hooks/agent-memory/` hook directory

---

## `signet config`

Interactive configuration editor for modifying `~/.agents/agent.yaml`.

```bash
signet config
```

### Sections

1. **Agent identity** - Name and description
2. **Harnesses** - AI platform selection
3. **Embedding provider** - Ollama/OpenAI settings
4. **Search settings** - Alpha, top_k, min_score
5. **Memory settings** - Session budget, decay rate
6. **View current config** - Display agent.yaml contents

Changes are saved to `agent.yaml` immediately.

---

## `signet start`

Start the Signet daemon if not already running.

```bash
signet start
```

### Output

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

✔ Daemon started
  Dashboard: http://localhost:3850
```

If already running:
```
  Daemon is already running
```

---

## `signet stop`

Stop the running Signet daemon.

```bash
signet stop
```

### Output

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

✔ Daemon stopped
```

---

## `signet restart`

Restart the Signet daemon.

```bash
signet restart
```

### Output

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

✔ Daemon restarted
  Dashboard: http://localhost:3850
```

---

## `signet status`

Show comprehensive status of Signet installation.

```bash
signet status
signet status --path /custom/path
```

### Options

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Custom base path |

### Output

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

## `signet dashboard`

Open the Signet web dashboard in your default browser.

```bash
signet dashboard
signet ui          # Alias
```

### Options

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Custom base path |

If the daemon is not running, it will be started automatically.

---

## `signet logs`

View daemon logs.

```bash
signet logs
signet logs -n 100
signet logs --follow    # Not yet implemented
```

### Options

| Option | Description |
|--------|-------------|
| `-n, --lines <n>` | Number of lines to show (default: 50) |
| `-f, --follow` | Follow log output (planned) |

### Output

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

  Recent Logs

[2025-02-17T18:00:00.000Z] [INFO] Signet Daemon starting...
[2025-02-17T18:00:00.001Z] [INFO]   Agents dir: /home/user/.agents
[2025-02-17T18:00:00.002Z] [INFO]   Port: 3850
[2025-02-17T18:00:00.003Z] [INFO]   PID: 12345
[2025-02-17T18:00:00.004Z] [INFO]   File watcher started
[2025-02-17T18:00:00.100Z] [INFO]   Server listening on http://localhost:3850
[2025-02-17T18:00:00.101Z] [INFO] Daemon ready
```

---

## `signet migrate`

Import conversations and memories from other platforms.

```bash
signet migrate
signet migrate chatgpt
```

### Supported Sources

- **ChatGPT** - Import from conversations.json export
- **Claude** - Import from Claude export
- **Gemini** - Import from Google AI Studio export
- **Custom** - Custom JSON format

### Interactive Flow

1. Select source platform
2. Provide path to export file
3. Import process runs
4. Confirmation of imported data

---

## `signet migrate-schema`

Migrate an existing memory database to Signet's unified schema. This is useful when:
- Copying `~/.agents/` from another machine with a different schema
- Upgrading from an older Signet version
- Using a database created by the Python memory system

```bash
signet migrate-schema
signet migrate-schema --path /custom/path
```

### Supported Schemas

Signet can detect and migrate from:

| Schema | Source | Notes |
|--------|--------|-------|
| **python** | `~/.agents/memory/scripts/memory.py` | Original Python memory system |
| **cli-v1** | Early Signet CLI | Created by `signet setup` in v0.1.x |
| **core** | Current unified schema | No migration needed |

### Field Mappings

During migration, fields are mapped to preserve data:

| Source Field | Unified Field |
|--------------|---------------|
| `who` | `updated_by` |
| `project` | `category` |
| `why` | Stored in `tags` as `why:...` |
| `session_id` | `source_id` |
| INTEGER `id` | TEXT `migrated_<id>` |

### Output

```
  ◈ signet v0.1.26
  own your agent. bring it anywhere.

- Checking database schema...
ℹ Migrating from python schema...
  ✓ Migrated 261 memories from python to core

  Migration complete!
```

If the database is already on the unified schema:
```
- Checking database schema...
✔ Database already on unified schema
```

### Safety

- Migration is **idempotent** - running multiple times is safe
- All existing memories are preserved
- The daemon is automatically stopped and restarted during migration

---

## `signet secret`

Manage encrypted secrets stored in `~/.agents/secrets.yaml`.

```bash
signet secret put OPENAI_API_KEY
signet secret list
signet secret delete GITHUB_TOKEN
signet secret has OPENAI_API_KEY
```

### Subcommands

| Command | Description |
|---------|-------------|
| `signet secret put <name>` | Store a secret (prompts for value) |
| `signet secret list` | List all secret names (not values) |
| `signet secret delete <name>` | Delete a secret |
| `signet secret has <name>` | Check if a secret exists |

### Output

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

? Enter value for OPENAI_API_KEY: ********

✔ Secret OPENAI_API_KEY stored
```

---

## `signet skill`

Manage agent skills from the skills.sh registry. Skills are installed to `~/.agents/skills/`.

```bash
signet skill list
signet skill install browser-use
signet skill uninstall weather
signet skill search github
signet skill show <name>
```

### Subcommands

| Command | Description |
|---------|-------------|
| `signet skill list` | List installed skills |
| `signet skill install <name>` | Install a skill from registry |
| `signet skill uninstall <name>` | Remove an installed skill |
| `signet skill search <query>` | Search the skills registry |
| `signet skill show <name>` | Show skill details |

### Output

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

  Installed Skills

  browser-use    Automate browser interactions
  weather        Get weather information

  2 skills installed
```

---

## `signet git`

Git sync management for the `~/.agents` directory.

```bash
signet git status    # Show git status
signet git sync      # Pull + push
signet git pull      # Pull changes
signet git push      # Push changes
signet git enable    # Enable auto-sync
signet git disable   # Disable auto-sync
```

### Subcommands

| Command | Description |
|---------|-------------|
| `signet git status` | Show working tree status |
| `signet git sync` | Pull remote changes then push |
| `signet git pull` | Pull changes from remote |
| `signet git push` | Push changes to remote |
| `signet git enable` | Enable daemon auto-sync |
| `signet git disable` | Disable daemon auto-sync |

### Output

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

  Git Status

  Branch: main
  Remote: origin

  Changes:
    M AGENTS.md
    ?? memory/new-conversation.json

  Auto-sync: enabled
```

---

## `signet hook`

Lifecycle hook commands for harness integration. These are typically called by harness connectors, not directly by users.

```bash
signet hook session-start      # Run session start hook
signet hook pre-compaction     # Run pre-compaction hook
signet hook compaction-complete # Run compaction complete hook
signet hook synthesis          # Get synthesis prompt
signet hook synthesis-complete # Complete synthesis
```

### Subcommands

| Command | Description |
|---------|-------------|
| `signet hook session-start` | Initialize session, load context |
| `signet hook pre-compaction` | Prepare for memory compaction |
| `signet hook compaction-complete` | Finalize compaction |
| `signet hook synthesis` | Get synthesis prompt for memory generation |
| `signet hook synthesis-complete` | Mark synthesis as finished |

### Output

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

  Session Start

  ✓ Loaded 42 memories
  ✓ Loaded context from MEMORY.md
  ✓ Session initialized
```

---

## `signet update`

Check for and install Signet updates.

```bash
signet update check    # Check for updates
signet update install  # Install updates
```

### Subcommands

| Command | Description |
|---------|-------------|
| `signet update check` | Check if a newer version is available |
| `signet update install` | Install the latest version |

### Output

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

  Update Check

  Current: v0.1.0
  Latest:  v0.1.5

  ? Update available. Install now? (y/N)
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SIGNET_PORT` | Daemon HTTP port | `3850` |
| `SIGNET_PATH` | Base agents directory | `~/.agents` |
| `SIGNET_HOST` | Daemon bind address | `localhost` |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
