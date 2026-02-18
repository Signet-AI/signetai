# Signet Roadmap

## Vision

Own your agent. Bring it anywhere.

Signet is the portable identity layer for AI agents. Your agent's personality, memory, skills, and secrets—all in `~/.agents/`, working across every AI tool.

---

## Current State (v0.1)

### ✅ Completed

- **CLI** - Full interactive setup wizard with:
  - Agent name & description configuration
  - Multi-harness selection (Claude Code, OpenCode, OpenClaw, Cursor, Windsurf)
  - OpenClaw workspace auto-configuration
  - Embedding provider & model selection
  - Hybrid search tuning (alpha, top_k, min_score)
  - Git repository initialization with auto-backup
  - System service installation

- **Daemon** - Background HTTP service:
  - Hono server on port 3850
  - Full REST API (config, memories, search, harnesses)
  - Static dashboard serving
  - File watcher with auto git commit
  - Auto-sync AGENTS.md to harness configs
  - systemd/launchd service installation

- **Dashboard** - SvelteKit web UI:
  - Config file editor with syntax highlighting
  - Embeddings visualization (UMAP projection)
  - Memory browser with hybrid search
  - Filter panel (type, tags, who, importance, date)
  - Similar memory search
  - Harness status display

- **Core Library** - @signet/core:
  - TypeScript types and interfaces
  - SQLite database with FTS5
  - Manifest parsing
  - Memory helpers

- **Harness Integrations**:
  - Claude Code hooks (session start/end, prompt submit)
  - OpenCode plugin (remember/recall tools)
  - OpenClaw hooks (agent-memory directory)

---

## Phase 1: Daemon & Service ✅ (Complete)

Everything runs as a background service.

### Daemon
- [x] HTTP server serving dashboard + API (Hono)
- [x] Full API endpoints (config, memories, search, embeddings, harnesses)
- [x] Port configuration (default 3850, via SIGNET_PORT)
- [x] Health check endpoint (/health)
- [x] Clean shutdown handling (SIGTERM/SIGINT)

### System Service
- [x] macOS: launchd plist installation
- [x] Linux: systemd user unit installation
- [x] Auto-start on boot (KeepAlive/WantedBy)
- [x] Log management (daily rotation)

### CLI Commands
- [x] `signet start/stop/restart/status`
- [x] `signet logs` - tail daemon logs
- [x] `signet` (no args) - TUI menu
- [x] Setup wizard starts daemon after install

---

## Phase 2: Secrets Management (Next Up)

Encrypted storage for API keys and sensitive values.

### Core Features
- [ ] `signet secret put/list/delete`
- [ ] Encrypted storage in ~/.agents/secrets/
- [ ] Machine-key encryption (libsodium)
- [ ] Optional passphrase protection

### Agent Integration
- [ ] Opaque secret references (`$secret:NAME`)
- [ ] Daemon-mediated execution (inject secrets without exposing)
- [ ] Output redaction (hide secrets in command output)

### Dashboard
- [ ] Secrets panel in settings
- [ ] Add/delete secrets
- [ ] Never display actual values

### Documentation
- [x] SECRETS.md design doc

## Phase 3: Skills Management

Install, manage, and discover agent skills.

### Core Features
- [ ] `signet skill list/install/remove/update`
- [ ] `signet skill search` - query skills.sh
- [ ] `signet skill create` - scaffold new skill
- [ ] `signet skill info` - show skill details

### Built-in Skills
- [ ] Ship remember/recall with Signet
- [ ] `builtin: true` frontmatter
- [ ] Daemon API integration (no Python dependency)

### skills.sh Integration
- [ ] Search API integration
- [ ] Download and extract skills
- [ ] Version tracking and updates

### Dashboard
- [ ] Skills panel
- [ ] Browse/search skills.sh
- [ ] Install/manage from UI

### Documentation
- [x] SKILLS.md design doc
- [x] MEMORY-SKILLS.md design doc

## Phase 4: Polish & Launch

### Dashboard Improvements
- [ ] Onboarding flow for new users
- [ ] Memory timeline view
- [ ] Conversation history browser
- [ ] Settings validation and help

### CLI Improvements
- [ ] Rich TUI with ink or blessed
- [ ] Interactive skill browser
- [ ] Memory query interface

### Documentation
- [ ] User guide
- [ ] Skill development guide
- [ ] API reference
- [ ] Migration guides (from ChatGPT, Claude, etc.)

### Distribution
- [ ] npm package: `npx signet`
- [ ] Homebrew formula
- [ ] AUR package
- [ ] One-line installer: `curl -sL signetai.sh/install | bash`

## Future Phases

### Sync & Backup
- [ ] Cloud sync (optional, encrypted)
- [ ] Git-based backup
- [ ] Export/import between machines

### Team Features
- [ ] Shared skill repositories
- [ ] Team secrets vault
- [ ] Multi-agent coordination

### Advanced Memory
- [ ] Conversation replay
- [ ] Memory consolidation (merge similar memories)
- [ ] Forgetting (importance-based cleanup)
- [ ] Context window optimization

### Harness Ecosystem
- [ ] Plugin SDK for new harnesses
- [ ] Cursor integration
- [ ] Windsurf integration
- [ ] VS Code extension

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     ~/.agents/                          │
├─────────────────────────────────────────────────────────┤
│  agent.yaml         Agent manifest & configuration      │
│  AGENTS.md          Agent identity & instructions       │
│  SOUL.md            Personality & tone                  │
│  MEMORY.md          Working memory (generated)          │
├─────────────────────────────────────────────────────────┤
│  memory/                                                │
│    memories.db      SQLite database                     │
│    vectors.zvec     Vector embeddings                   │
├─────────────────────────────────────────────────────────┤
│  secrets/                                               │
│    keyring.enc      Encrypted secrets                   │
│    meta.json        Secret metadata                     │
├─────────────────────────────────────────────────────────┤
│  skills/                                                │
│    remember/        Built-in memory skill               │
│    recall/          Built-in search skill               │
│    github/          Installed skill                     │
│    ...                                                  │
├─────────────────────────────────────────────────────────┤
│  .daemon/                                               │
│    pid              Daemon process ID                   │
│    logs/            Daemon logs                         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                   Signet Daemon                         │
├─────────────────────────────────────────────────────────┤
│  HTTP Server (port 3850)                                │
│    /              Dashboard (static)                    │
│    /api/config    Configuration CRUD                    │
│    /api/memory    Memory operations                     │
│    /api/secrets   Secret operations                     │
│    /api/skills    Skill management                      │
│    /health        Health check                          │
├─────────────────────────────────────────────────────────┤
│  Background Tasks                                       │
│    File watcher   Sync changes                          │
│    Embedding      Generate vectors                      │
│    Regeneration   Update MEMORY.md                      │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                    Signet CLI                           │
├─────────────────────────────────────────────────────────┤
│  signet           Interactive TUI menu                  │
│  signet setup     First-time setup wizard               │
│  signet start     Start daemon                          │
│  signet stop      Stop daemon                           │
│  signet status    Show status                           │
│  signet secret    Manage secrets                        │
│  signet skill     Manage skills                         │
│  signet dashboard Open dashboard in browser             │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│                    Harnesses                            │
├─────────────────────────────────────────────────────────┤
│  Claude Code      Reads CLAUDE.md (generated)           │
│  OpenCode         Plugin + AGENTS.md                    │
│  OpenClaw         Hooks + AGENTS.md                     │
│  Cursor           .cursorrules (generated)              │
│  ...              Any tool that reads markdown          │
└─────────────────────────────────────────────────────────┘
```

---

## Version History

### v0.1.0 (Current)

- Initial release
- CLI with interactive setup wizard
- Daemon with HTTP API
- Dashboard with config editor, embeddings viz, memory browser
- Claude Code, OpenCode, OpenClaw harness integrations
- Hybrid search (vector + keyword)
- Git auto-commit on changes
- systemd/launchd service support

---

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for development setup and guidelines.
