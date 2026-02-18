# Quickstart

Get Signet running in about five minutes.

---

## Prerequisites

- Node.js 18+ (or Bun 1.0+)
- One of: Ollama (for local embeddings) or an OpenAI API key
- macOS or Linux (Windows support planned)

---

## Install

```bash
# Via npm/npx
npx signet setup

# Via bun
bunx signet setup

# Via one-line installer (when available)
curl -sL https://signetai.sh/install | bash
```

Running `signet setup` launches an interactive wizard that walks you through the full setup. You don't need to read anything else first.

---

## Setup Wizard

The wizard asks a series of questions:

**1. Agent name**

Pick a name for your agent — this appears in harness prompts and the dashboard.

**2. Harnesses**

Select which AI platforms you use. Signet will configure integrations for each:

- Claude Code — hooks + CLAUDE.md sync
- OpenCode — plugin + AGENTS.md sync
- OpenClaw — adapter-openclaw hooks
- Cursor (planned)
- Windsurf (planned)

**3. Embedding provider**

Embeddings power semantic (meaning-based) memory search. Choose:

- **Ollama** (recommended) — runs locally, free, no API key needed. Make sure Ollama is installed and running (`ollama serve`).
- **OpenAI** — uses the OpenAI embeddings API. Requires `OPENAI_API_KEY`.
- **Skip** — memory still works via keyword search, just no semantic search.

**4. Embedding model**

For Ollama, `nomic-embed-text` is a good default. Pull it first if you haven't:

```bash
ollama pull nomic-embed-text
```

**5. Search balance**

The `alpha` setting controls how much weight goes to semantic vs. keyword search. 0.7 (70% semantic, 30% keyword) works well for most people.

**6. Git & auto-commit**

The wizard can initialize a git repo in `~/.agents/` so every change to your agent files is automatically versioned.

After the wizard completes, the daemon starts automatically and the dashboard opens.

---

## What Gets Created

```
~/.agents/
├── agent.yaml           # Your config & manifest
├── AGENTS.md            # Agent identity & instructions
├── SOUL.md              # Personality & tone
├── MEMORY.md            # Generated working memory (starts empty)
├── memory/
│   ├── memories.db      # SQLite memory database
│   └── scripts/         # memory.py CLI tool
├── skills/
│   ├── remember/        # Built-in: /remember command
│   └── recall/          # Built-in: /recall command
└── .daemon/
    └── logs/            # Daemon logs
```

If you selected Claude Code:
- `~/.claude/CLAUDE.md` — auto-synced from AGENTS.md
- `~/.claude/settings.json` — hooks for session start/end

If you selected OpenCode:
- `~/.config/opencode/AGENTS.md` — auto-synced
- `~/.config/opencode/memory.mjs` — plugin with remember/recall tools

---

## Basic Usage

### Check status

```bash
signet status
```

Shows daemon state, file health, and memory count.

### Open the dashboard

```bash
signet dashboard
```

Opens `http://localhost:3850` in your browser. From here you can edit your agent config, browse memories, and manage skills.

### Save a memory

In any connected harness, use the `/remember` command:

```
/remember nicholai prefers bun over npm
/remember critical: never commit secrets to git
/remember [project,signet]: daemon runs on port 3850
```

The `critical:` prefix pins a memory so it never decays. The `[tag1,tag2]:` prefix adds searchable tags.

### Search memories

```
/recall coding preferences
/recall signet architecture
/recall what did we decide about authentication
```

### View daemon logs

```bash
signet logs
signet logs -n 100
```

### Stop/start the daemon

```bash
signet stop
signet start
signet restart
```

---

## Managing Secrets

Store API keys and other sensitive values encrypted at rest:

```bash
# Add a secret (value is never echoed)
signet secret put OPENAI_API_KEY

# List stored secrets (names only)
signet secret list

# Remove a secret
signet secret delete GITHUB_TOKEN
```

Secrets are encrypted with libsodium using a machine-bound key. Agents never see secret values directly.

---

## Managing Skills

Skills are packaged instructions in `~/.agents/skills/`. They extend what your agent can do.

```bash
# See what's installed
signet skill list

# Search the skills.sh registry
signet skill search browser

# Install a skill
signet skill install browser-use

# Remove a skill
signet skill remove weather
```

---

## Install as a System Service

To have Signet start automatically on boot:

```bash
signet install-service
```

**macOS (launchd):**
```bash
launchctl load ~/Library/LaunchAgents/ai.signet.daemon.plist
```

**Linux (systemd):**
```bash
systemctl --user enable signet.service
systemctl --user start signet.service
```

---

## Editing Your Agent

Your agent identity lives in two key files:

**`~/.agents/AGENTS.md`** — What the agent knows and how it should behave. This is the file that syncs to all your harnesses.

**`~/.agents/SOUL.md`** — Personality, voice, values. Mostly for your own reference or for harnesses that load it separately.

Edit them directly in your editor or via the dashboard's config editor. Changes sync to harnesses automatically within 2 seconds.

---

## Troubleshooting

**Daemon won't start**

Check if port 3850 is in use:
```bash
lsof -i :3850
```

Remove a stale PID file if needed:
```bash
rm ~/.agents/.daemon/pid
signet start
```

**Embeddings not working**

Make sure Ollama is running:
```bash
ollama serve &
ollama pull nomic-embed-text
```

Or check that `OPENAI_API_KEY` is set in your environment (or stored as a secret and referenced in `agent.yaml`).

**Changes not syncing to Claude Code**

Make sure `~/.claude/` exists and you have the harness configured:
```bash
ls ~/.claude/CLAUDE.md
signet status
```

**Dashboard not loading**

```bash
curl http://localhost:3850/health
signet logs
```

---

## Next Steps

- [Configuration Reference](./CONFIGURATION.md) — all agent.yaml options
- [Memory System](./MEMORY.md) — how remember/recall works
- [Hooks](./HOOKS.md) — lifecycle hooks for harness integration
- [Harnesses](./HARNESSES.md) — detailed integration docs
- [API Reference](./API.md) — HTTP API for scripting and tooling
