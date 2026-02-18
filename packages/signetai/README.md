# Signet

**Portable AI agent identity - own your agent, bring it anywhere.**

Signet gives your AI agents persistent memory and identity that follows them across any tool or harness - Claude Code, OpenCode, OpenClaw, and more.

## Install

```bash
# npm
npm install -g signetai

# bun (recommended)
bun add -g signetai
```

## Quick Start

```bash
# Run the setup wizard
signet

# Or start immediately
signet start
signet dashboard
```

## Features

- **Persistent Memory** - `/remember` and `/recall` work everywhere
- **Unified Identity** - AGENTS.md syncs to all your tools
- **Background Daemon** - Always-on API at localhost:3850
- **Web Dashboard** - Visual memory browser and config editor
- **Encrypted Secrets** - Secure API key storage with libsodium
- **Git Sync** - Auto-commit and push to GitHub
- **Skills System** - Extend capabilities from skills.sh

## Commands

```bash
signet                  # Interactive menu / setup wizard
signet status           # Daemon status
signet dashboard        # Open web dashboard
signet start            # Start daemon
signet stop             # Stop daemon

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
```

## How It Works

1. **Setup** creates `~/.agents/` with your agent config
2. **Daemon** runs in background, serves API and dashboard
3. **Harnesses** (Claude Code, etc.) connect via hooks
4. **Memories** persist in SQLite with vector embeddings
5. **AGENTS.md** syncs to all tool config locations

## Requirements

- Node.js 18+ or Bun 1.0+
- Bun recommended for the daemon (uses bun:sqlite)

## Documentation

Full docs at [signetai.sh/docs](https://signetai.sh/docs)

- [Quick Start](https://signetai.sh/docs/quickstart)
- [Configuration](https://signetai.sh/docs/configuration)
- [Memory System](https://signetai.sh/docs/memory)
- [Hooks API](https://signetai.sh/docs/hooks)
- [Secrets](https://signetai.sh/docs/secrets)

## License

MIT
