---
Repo: github.com/signetai/signetai 
GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".
Branching: `<username>/<feature>` off main
Conventional commits: `type(scope): subject`
Last Updated: 2026/02/19
This file: AGENTS.md -> Symlinked to CLAUDE.md
---

# Repository Guidelines 


This file provides guidance to AI assistants working on this repository.
It is version controlled and co-maintained by human developers and AI
assistants. Changes to this document (and the codebase) should be
thoughtful, intentional, and useful.

Do not overwrite or destroy this document or its symbolic links without
care. Running `/init` is **strongly** discouraged when working with less
*corrigible* agents.

What is Signetai?
---

Signetai is the reference implementation of Signet, an open standard
for portable AI agent identity. It includes a CLI tool, background
daemon with HTTP API, and web dashboard.

Commands
---

```bash
bun install              # Install dependencies
bun run build            # Build workspace packages
bun run dev              # Dev mode all packages
bun test                 # Run tests
bun run lint             # Biome check
bun run format           # Biome format --write
bun run typecheck        # TypeScript check all packages
bun run build:publish    # Build for npm publish
```

Individual Package Builds
---

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
| `@signet/connector-base` | Shared connector primitives/utilities | node |
| `@signet/cli` | CLI tool: setup wizard, daemon management | node |
| `@signet/daemon` | Background service: HTTP API, file watching | bun |
| `@signet/sdk` | Integration SDK for third-party apps | node |
| `@signet/connector-claude-code` | Claude Code connector: hooks, CLAUDE.md generation | node |
| `@signet/connector-opencode` | OpenCode connector: plugin, AGENTS.md sync | node |
| `@signet/connector-openclaw` | OpenClaw connector: config patching, hook handlers | node |
| `@signet/adapter-openclaw` | OpenClaw runtime plugin for calling Signet daemon | node |
| `signetai` | Meta-package bundling CLI + daemon | - |

### Package Responsibilities

**@signet/core** - Shared foundation
- TypeScript interfaces (AgentManifest, Memory, etc.)
- SQLite database wrapper with FTS5
- Hybrid search (vector + keyword)
- YAML manifest parsing
- Constants and utilities

**@signet/cli** - User interface (~4600 LOC in cli.ts)
- Setup wizard with harness selection
- Config editor (interactive TUI)
- Daemon start/stop/status
- Dashboard launcher
- Secrets management
- Skills management
- Git sync management
- Hook lifecycle commands
- Update checker

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
│    /api/*         Config, memory, skills, hooks, update │
│    /memory/*      Search and similarity aliases          │
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
├── IDENTITY.md      # Structured identity metadata
├── USER.md          # User profile/preferences
├── MEMORY.md        # Generated working memory
├── memory/
│   ├── memories.db  # SQLite database
│   └── scripts/     # Python memory tools
├── skills/          # Installed skills
├── .secrets/        # Encrypted secret store
└── .daemon/
    └── logs/        # Daemon logs
```

## Key Files

- `packages/core/src/types.ts` - TypeScript interfaces
- `packages/core/src/identity.ts` - Identity file detection/loading
- `packages/core/src/database.ts` - SQLite wrapper
- `packages/core/src/search.ts` - Hybrid search
- `packages/core/src/skills.ts` - Skills unification across harnesses
- `packages/cli/src/cli.ts` - Main CLI entrypoint (~4600 LOC)
- `packages/daemon/src/daemon.ts` - HTTP server + watcher
- `packages/connector-claude-code/src/index.ts` - Claude Code connector
- `packages/connector-opencode/src/index.ts` - OpenCode connector
- `packages/connector-openclaw/src/index.ts` - OpenClaw connector
- `packages/adapters/openclaw/src/index.ts` - OpenClaw runtime adapter
- `docs/ARCHITECTURE.md` - Full technical documentation

Style & Conventions
---

- Package manager: **bun**
- Linting/formatting: **Biome**
- Build tool: **bun build**
- Commit style: conventional commits
- Line width: 80-100 soft, 120 hard
- Add brief code comments for tricky or non-obvious logic.
- Aim to keep files under ~700 LOC; guideline only (not a hard guardrail).
- Split/refactor when it improves clarity or testability.

TypeScript Discipline
---

These rules are enforced by convention, not tooling.

- no `any` -- use `unknown` with narrowing
- no `as` -- fix the types instead of asserting
- no `!` -- check for null explicitly
- discriminated unions over optional properties
- `readonly` everywhere mutation isn't intended
- no `enum` -- use `as const` + union types
- explicit return types on exported functions
- result types over exceptions
- effect-free module scope

## Development Workflow

1. Make changes to source files
2. Run `bun run build` to rebuild affected packages
3. Run `bun test` to verify behavior
4. Run `bun run typecheck` for TS changes
5. Run `bun run lint` before committing

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
| `/api/memory/remember` | POST | Save a memory |
| `/api/memory/recall` | POST | Hybrid search |
| `/memory/search` | GET | Legacy keyword search |
| `/api/embeddings` | GET | Export embeddings |
| `/api/skills` | GET | List installed skills |
| `/api/secrets` | GET | List secret names |
| `/api/hooks/*` | POST/GET | Session + synthesis hooks |
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
- Daemon is the primary memory pipeline; Python scripts are optional batch tools
- Connectors are idempotent - safe to run install multiple times
