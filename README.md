# Signet

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Spec Version](https://img.shields.io/badge/spec-v0.2.1--draft-blue.svg)](./spec/SPEC.md)
[![GitHub Stars](https://img.shields.io/github/stars/Signet-AI/signet.svg)](https://github.com/Signet-AI/signet/stargazers)

**Own your agent. Bring it anywhere.**

Every AI platform has memory now. ChatGPT remembers you. Claude learns your preferences. Gemini knows your style.

**But you can't take it with you.**

Signet is an open standard for portable AI agent identity. Your agent's personality, memory, and preferences live in plain text files on YOUR machine—working across Claude Code, OpenClaw, OpenCode, and beyond.

```
~/.agents/
├── agent.yaml       # Configuration & manifest
├── AGENTS.md        # Agent identity & instructions
├── SOUL.md          # Personality & tone
├── MEMORY.md        # Working memory (generated)
├── memory/          # SQLite + vector embeddings
├── skills/          # Installed skills
└── .secrets/        # Encrypted API keys
```

One agent. Every platform. Zero lock-in.

---

## The Problem

They're not storing memories *for* you—they're locking you *in*.

- OpenAI won't let you export your memories
- Anthropic won't let you move your project context
- Google won't let you download what Gemini learned about you
- The best you get is a chat history export—raw transcripts, not structured knowledge

Switch tools? Start from zero. All those hours of context building, gone.

## The Solution

Signet stores your agent's identity in plain text files at `~/.agents/`. A background daemon syncs your identity to every AI tool you use, and hybrid search (vector + keyword) makes memories instantly accessible across all of them.

---

## Quick Start

```bash
# Install
curl -sL https://signetai.sh/install | bash

# Or with npm/bun
npx signet setup
```

The setup wizard will:
- Create your agent identity files
- Configure harness integrations (Claude Code, OpenCode, OpenClaw, etc.)
- Set up memory embedding (local Ollama or OpenAI API)
- Initialize the SQLite database
- Start the background daemon

```bash
# Open the dashboard
signet dashboard

# Or interact via CLI
signet            # Interactive TUI menu
signet status     # Check daemon & file status
signet start      # Start daemon
signet stop       # Stop daemon
signet logs       # View daemon logs
```

---

## Features

### 🧠 Hybrid Memory Search

Memories are embedded for semantic search and indexed for keyword matching. A configurable blend (default 70% semantic, 30% keyword) finds the right context every time.

```bash
# Save a memory (from any harness)
/remember nicholai prefers tabs over spaces
/remember critical: never push directly to main

# Search memories
/recall coding preferences
```

### 🔗 Multi-Harness Support

Signet syncs your agent identity across:

- **Claude Code** — Writes `~/.claude/CLAUDE.md` from your AGENTS.md
- **OpenCode** — Plugin + AGENTS.md auto-sync
- **OpenClaw** — Full hook system integration via `@signet/adapter-openclaw`
- **Cursor** — `.cursorrules` generation (planned)
- **Windsurf** — Integration (planned)

Changes to `~/.agents/AGENTS.md` auto-sync to all configured harnesses within 2 seconds.

### 📊 Web Dashboard

Interactive dashboard at `http://localhost:3850`:

- **Config editor** — Edit AGENTS.md, SOUL.md, agent.yaml with live save
- **Embeddings visualization** — UMAP projection of your memory space
- **Memory browser** — Search, filter, and explore memories
- **Skills manager** — Install, browse, and manage skills
- **Harness status** — See what's connected

### 🔐 Secrets Management

Encrypted storage for API keys using libsodium (XSalsa20-Poly1305). Agents can *use* secrets without being able to read or expose them.

```bash
signet secret put OPENAI_API_KEY
signet secret list
signet secret delete GITHUB_TOKEN
```

### ⚡ Skills System

Install and manage agent skills from the skills.sh registry:

```bash
signet skill list
signet skill install browser-use
signet skill search github
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Signet Daemon                       │
├─────────────────────────────────────────────────────────┤
│  HTTP Server (port 3850)                                │
│    /              Dashboard (SvelteKit static)          │
│    /api/config    Configuration CRUD                    │
│    /api/memories  Memory list & stats                   │
│    /api/memory/remember  Save a memory                  │
│    /api/memory/recall    Hybrid search                  │
│    /api/secrets   Secrets management                    │
│    /api/skills    Skills management                     │
│    /api/hooks     Lifecycle hooks (session/compaction)  │
│    /health        Health check                          │
├─────────────────────────────────────────────────────────┤
│  File Watcher                                           │
│    Auto-commit on changes (git, 5s debounce)            │
│    Auto-sync AGENTS.md to harnesses (2s debounce)       │
├─────────────────────────────────────────────────────────┤
│  System Service                                         │
│    macOS: launchd plist                                 │
│    Linux: systemd user unit                             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                    Signet CLI                           │
├─────────────────────────────────────────────────────────┤
│  signet           Interactive TUI menu                  │
│  signet setup     First-time setup wizard               │
│  signet config    Interactive config editor             │
│  signet start     Start daemon                          │
│  signet stop      Stop daemon                           │
│  signet status    Show status                           │
│  signet dashboard Open dashboard in browser             │
│  signet logs      View daemon logs                      │
│  signet secret    Manage encrypted secrets              │
│  signet skill     Manage agent skills                   │
│  signet migrate   Import from other platforms           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                    Harnesses                            │
├─────────────────────────────────────────────────────────┤
│  Claude Code      CLAUDE.md generated from AGENTS.md    │
│  OpenCode         Plugin + AGENTS.md                    │
│  OpenClaw         @signet/adapter-openclaw + hooks      │
│  Cursor           .cursorrules (planned)                │
│  Windsurf         Integration (planned)                 │
└─────────────────────────────────────────────────────────┘
```

---

## Packages

| Package | Description |
|---------|-------------|
| [`@signet/cli`](./packages/cli) | CLI and dashboard |
| [`@signet/core`](./packages/core) | Core library, types, database |
| [`@signet/daemon`](./packages/daemon) | Background daemon service |
| [`@signet/sdk`](./packages/sdk) | Integration SDK for apps |
| [`@signet/adapter-openclaw`](./packages/adapters/openclaw) | OpenClaw adapter |

---

## Configuration

All configuration lives in `~/.agents/agent.yaml`:

```yaml
version: 1
schema: signet/v1

agent:
  name: "My Agent"
  description: "Personal AI assistant"

harnesses:
  - claude-code
  - openclaw
  - opencode

embedding:
  provider: ollama          # or 'openai'
  model: nomic-embed-text
  dimensions: 768

search:
  alpha: 0.7        # Vector weight (0-1)
  top_k: 20
  min_score: 0.3

memory:
  session_budget: 2000
  decay_rate: 0.95
```

See [docs/CONFIGURATION.md](./docs/CONFIGURATION.md) for full reference.

---

## Documentation

- [Quickstart](./docs/QUICKSTART.md) — Install and get running in minutes
- [Configuration](./docs/CONFIGURATION.md) — Full agent.yaml reference
- [Memory](./docs/MEMORY.md) — How the memory system works
- [Skills](./docs/SKILLS.md) — Installing and using skills
- [Secrets](./docs/SECRETS.md) — Secrets management
- [Hooks](./docs/HOOKS.md) — Harness lifecycle hooks
- [Dashboard](./docs/DASHBOARD.md) — Dashboard features and usage
- [API Reference](./docs/API.md) — Daemon HTTP API
- [Harnesses](./docs/HARNESSES.md) — Platform integrations
- [Architecture](./docs/ARCHITECTURE.md) — Technical deep dive
- [Roadmap](./docs/ROADMAP.md) — What's coming

---

## Development

```bash
# Clone
git clone https://github.com/signetai/signet.git
cd signet

# Install dependencies
bun install

# Build all packages
bun run build

# Run CLI in dev mode
cd packages/cli
bun run dev

# Build dashboard
cd packages/cli/dashboard
bun run build
```

---

## Contributing

We welcome contributions. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

**Good first issues:**
- Documentation improvements
- New harness adapters
- Test coverage

**Ways to help:**
- Star the repo
- Share your experience on Twitter/HN
- Report bugs or request features via issues
- Contribute code or documentation

---

## License

Apache-2.0 — use it, fork it, ship it.

---

## Links

- **Website:** [signetai.sh](https://signetai.sh)
- **Documentation:** [signetai.sh/docs](https://signetai.sh/docs)
- **Specification:** [spec/SPEC.md](./spec/SPEC.md)
- **Twitter:** [@signet_ai](https://twitter.com/signet_ai)
