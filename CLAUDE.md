# CLAUDE.md

This file provides guidance for Claude Code (claude.ai/code) when working with code in this repository.

## What is Signetai?

Signetai is the reference implementation of Signet, an open standard
for portable AI agent identity. It includes a CLI tool, background
daemon with HTTP API, and web dashboard.

## Commands

```bash
bun install              # Install dependencies
bun run build            # Build all packages (parallel)
bun run dev              # Dev mode all packages
bun test                 # Run tests
bun run lint             # Biome check
bun run format           # Biome format --write
bun run typecheck        # TypeScript check all packages
bun run build:publish    # Build for npm publish
```

### Individual Package Builds

```bash
# Core library (target: node)
cd packages/core && bun run build

# CLI (target: node, bundles dashboard)
cd packages/cli && bun run build
cd packages/cli && bun run build:cli        # CLI only
cd packages/cli && bun run build:dashboard  # Dashboard only

# Daemon (target: bun)
cd packages/daemon && bun run build

# SDK
cd packages/sdk && bun run build
```

### Dashboard Development

```bash
cd packages/cli/dashboard
bun install
bun run dev      # Dev server at localhost:5173
bun run build    # Static build to build/
```

## Packages

| Package | Description | Target |
|---------|-------------|--------|
| `@signet/core` | Core library: types, database, search, manifest, identity | node |
| `@signet/cli` | CLI tool: setup wizard, daemon management | node |
| `@signet/daemon` | Background service: HTTP API, file watching | bun |
| `@signet/sdk` | Integration SDK for third-party apps | node |
| `@signet/connector-claude-code` | Claude Code connector: hooks, CLAUDE.md generation | node |
| `@signet/connector-opencode` | OpenCode connector: plugin, AGENTS.md sync | node |
| `signet` | Meta-package bundling CLI + daemon | - |

### Package Responsibilities

**@signet/core** - Shared foundation
- TypeScript interfaces (AgentManifest, Memory, etc.)
- SQLite database wrapper with FTS5
- Hybrid search (vector + keyword)
- YAML manifest parsing
- Constants and utilities

**@signet/cli** - User interface (~1600 LOC in cli.ts)
- Setup wizard with harness selection
- Config editor (interactive TUI)
- Daemon start/stop/status
- Dashboard launcher
- Secrets management

**@signet/daemon** - Background service
- Hono HTTP server on port 3850
- File watching with debounced sync
- Auto-commit on config changes
- System service (launchd/systemd)

**@signet/sdk** - Third-party integration
- SignetSDK class for embedding Signet in apps

**@signet/connector-* packages** - Platform-specific connectors
- Install hooks into harness config files
- Generate harness-specific CLAUDE.md/AGENTS.md
- Symlink skills directories
- Call daemon API for session lifecycle

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Signet Daemon                       │
├─────────────────────────────────────────────────────────┤
│  HTTP Server (port 3850)                                │
│    /              Dashboard (SvelteKit static)          │
│    /api/*         Configuration, memories, secrets      │
│    /memory/*      Search and similarity                 │
│    /health        Health check                          │
├─────────────────────────────────────────────────────────┤
│  File Watcher (chokidar)                                │
│    Auto-commit (5s debounce)                            │
│    Harness sync (2s debounce)                           │
└─────────────────────────────────────────────────────────┘
```

### Data Flow

```
User edits ~/.agents/AGENTS.md
    → File watcher detects change
    → Debounced git commit (5s)
    → Harness sync to ~/.claude/CLAUDE.md, etc. (2s)
```

### User Data Location

All user data lives at `~/.agents/`:

```
~/.agents/
├── agent.yaml       # Configuration manifest
├── AGENTS.md        # Agent identity/instructions
├── SOUL.md          # Personality & tone
├── MEMORY.md        # Generated working memory
├── memory/
│   ├── memories.db  # SQLite database
│   └── scripts/     # Python memory tools
├── skills/          # Installed skills
└── .daemon/
    └── logs/        # Daemon logs
```

## Key Files

- `packages/core/src/types.ts` - TypeScript interfaces
- `packages/core/src/identity.ts` - Identity file detection and loading (IDENTITY_FILES spec)
- `packages/core/src/database.ts` - SQLite wrapper
- `packages/core/src/search.ts` - Hybrid search
- `packages/core/src/skills.ts` - Skills unification from multiple harnesses
- `packages/cli/src/cli.ts` - Main CLI (~1600 LOC)
- `packages/daemon/src/daemon.ts` - HTTP server + watcher
- `packages/connector-claude-code/src/index.ts` - Claude Code connector
- `packages/connector-opencode/src/index.ts` - OpenCode connector
- `docs/ARCHITECTURE.md` - Full technical documentation

## Conventions

- Package manager: **bun**
- Linting/formatting: **Biome**
- Build tool: **bun build**
- Commit style: conventional commits
- Line width: 80-100 soft, 120 hard

## Development Workflow

1. Make changes to source files
2. Run `bun run build` to rebuild affected packages
3. Run `bun test` to verify
4. Run `bun run lint` before committing

### Testing Daemon Changes

```bash
cd packages/daemon
bun run start    # Run directly
bun run dev      # Watch mode
```

### Testing CLI Changes

```bash
cd packages/cli
bun src/cli.ts setup     # Run setup command
bun src/cli.ts status    # Check status
```

## HTTP API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/status` | GET | Full daemon status |
| `/api/config` | GET/POST | Config files CRUD |
| `/api/memories` | GET | List memories |
| `/memory/search` | GET | Hybrid search |
| `/api/embeddings` | GET | Export embeddings |
| `/api/harnesses` | GET | List harnesses |

## Identity Files

Signet recognizes these standard identity files at `~/.agents/`:

| File | Required | Description |
|------|----------|-------------|
| AGENTS.md | yes | Operational rules and behavioral settings |
| SOUL.md | yes | Persona, character, and security settings |
| IDENTITY.md | yes | Agent name, creature type, and vibe |
| USER.md | yes | User profile and preferences |
| HEARTBEAT.md | no | Current working state, focus, and blockers |
| MEMORY.md | no | Memory index and summary |
| TOOLS.md | no | Tool preferences and notes |
| BOOTSTRAP.md | no | Setup ritual (typically deleted after first run) |

The `detectExistingSetup()` function in `packages/core/src/identity.ts` detects existing setups from OpenClaw, Claude Code, and OpenCode.

## Notes

- Daemon targets **bun** for Hono/JSX support and Bun SQLite
- CLI targets **node** for broader compatibility, but also works with **bun**
- Dashboard is built to static files, served by daemon
- SQLite uses runtime detection: `bun:sqlite` under Bun, `better-sqlite3` under Node.js
- Memory embeddings currently use Python scripts
- Connectors are idempotent - safe to run install multiple times
