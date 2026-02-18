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
3. **OpenClaw Workspace** - If OpenClaw selected and config exists, optionally set workspace
4. **Description** - Short agent description
5. **Embedding Provider**:
   - Ollama (local, recommended)
   - OpenAI API
   - Skip embeddings
6. **Embedding Model** - Based on provider:
   - Ollama: nomic-embed-text, all-minilm, mxbai-embed-large
   - OpenAI: text-embedding-3-small, text-embedding-3-large
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

---

## Future Commands (Planned)

### `signet secret`

Manage encrypted secrets:

```bash
signet secret put OPENAI_API_KEY
signet secret list
signet secret delete GITHUB_TOKEN
signet secret has OPENAI_API_KEY
```

### `signet skill`

Manage agent skills:

```bash
signet skill list
signet skill install browser-use
signet skill search github
signet skill remove weather
signet skill update
signet skill create my-skill
```
