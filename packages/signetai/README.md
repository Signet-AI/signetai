# Signet

**Local-first identity, memory, and secrets for AI agents.**

Signet keeps an agent's identity, memory, secrets, and skills outside
any single model or harness. Claude Code, OpenCode, OpenClaw, Codex,
Hermes Agent, and other tools can change while the agent keeps its
state.

## Install

```bash
# bun (recommended)
bun add -g signetai

# npm
npm install -g signetai
```

## Quick Start

```bash
# Run the setup wizard
signet setup

# Or start immediately
signet daemon start
signet dashboard
```

## Features

- **Ambient Memory** - context is captured and recalled across sessions
- **Portable Identity** - identity files sync across connected harnesses
- **Background Daemon** - Always-on API at localhost:3850
- **Web Dashboard** - Visual memory browser and config editor
- **Agent-Blind Secrets** - credentials stay out of model context
- **Git Sync** - Auto-commit and push to GitHub
- **Skills System** - Extend capabilities from skills.sh

## Commands

```bash
signet                  # Show help and command map
signet setup            # Setup wizard
signet status           # Daemon status
signet dashboard        # Open web dashboard
signet daemon start     # Start daemon
signet daemon stop      # Stop daemon

# Memory
signet remember <text>  # Save a memory
signet recall <query>   # Search memories

# Secrets
signet secret put KEY   # Store a secret
signet secret list      # List secrets

# Skills
signet skill list       # List installed skills
signet skill install X  # Install from skills.sh

# Git sync
signet git status       # Sync status
signet git sync         # Pull + push
signet git enable       # Enable auto-sync

# Updates
signet update           # Check for updates
signet update install   # Install latest
signet update enable    # Enable unattended installs
```

## How It Works

1. **Setup** creates `~/.agents/` with your agent config
2. **Daemon** runs in background, serves API and dashboard
3. **Harnesses** connect through hooks or plugins
4. **Memories** persist in SQLite, markdown, transcripts, and semantic indexes
5. **Identity files** sync without moving ownership out of your workspace

## Requirements

- **Node.js 18+** for CLI commands (setup, configure, status, recall, etc.)
- **Bun 1.0+** required for the daemon (`signet daemon start`) — uses `bun:sqlite`

## Documentation

Full docs at [signetai.sh/docs](https://signetai.sh/docs)

- [Quick Start](https://signetai.sh/docs/quickstart)
- [Configuration](https://signetai.sh/docs/configuration)
- [Memory System](https://signetai.sh/docs/memory)
- [Hooks API](https://signetai.sh/docs/hooks)
- [Secrets](https://signetai.sh/docs/secrets)

## License

Apache-2.0
