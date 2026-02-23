---
title: "Agents"
description: "Agent identity and configuration format."
order: 26
section: "Project"
---

---
Repo: github.com/signetai/signetai 
GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".
Branching: `<username>/<feature>` off main
Conventional commits: `type(scope): subject`
Last Updated: 2026/02/21
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

**Always read `VISION.md` at the start of every session.** It describes
what Signet is building toward and should anchor development decisions.

Commands
---

```bash
bun install              # Install dependencies
bun run build            # Build workspace packages (ordered, see below)
bun run dev              # Dev mode all packages
bun test                 # Run tests
bun run lint             # Biome check (no biome.json — uses defaults)
bun run format           # Biome format --write
bun run typecheck        # TypeScript check all packages
bun run build:publish    # Build for npm publish
bun run version:sync     # Sync version across all packages
bun run dev:web          # Shortcut for web wrangler dev
bun run deploy:web       # Shortcut for web wrangler deploy
```

`bun run build` runs an ordered sequence — building packages out of
order will cause dependency errors:

```
build:core → build:connector-base → build:deps (parallel) → build:signetai
```

### Testing

Test discovery is scoped to `packages/` via `bunfig.toml` (excludes
`references/` directory). Run a single test file directly:

```bash
bun test packages/daemon/src/pipeline/worker.test.ts
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

Svelte 5 + Tailwind v4 + bits-ui + CodeMirror 6 + 3d-force-graph.
Built to static files, served by daemon at `/`.

```bash
cd packages/cli/dashboard
bun install
bun run dev      # Dev server at localhost:5173
bun run build    # Static build to build/
```

### Website Development

```bash
cd web
bun run dev      # Local dev (wrangler dev) at localhost:8787
bun run deploy   # Deploy to Cloudflare
bun run test     # Tests (vitest + workers pool)
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
| `@signetai/adapter-openclaw` | OpenClaw runtime plugin for calling Signet daemon | node |
| `signetai` | Meta-package bundling CLI + daemon | - |
| `@signet/web` | Marketing website (Cloudflare Worker) | cloudflare |

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
- Pipeline V2 (`src/pipeline/`) — LLM-based memory extraction
- Session tracker — plugin vs legacy runtime path mutex

**@signet/sdk** - Third-party integration
- SignetSDK class for embedding Signet in apps

**@signet/connector-* packages** - Platform-specific connectors (install-time)
- Install hooks into harness config files
- Generate harness-specific CLAUDE.md/AGENTS.md
- Symlink skills directories
- Call daemon API for session lifecycle
- Distinct from `packages/daemon/src/connectors/` which is the
  daemon-side runtime connector framework (filesystem watch, registry)

**@signet/web** - Marketing website
- Cloudflare Worker serving static landing page
- `web/src/index.ts` — Worker fetch handler (routes `/message`, `/random`)
- `web/public/index.html` — Single-file landing page (~2000 LOC, no build step)
- Design: Chakra Petch (display), IBM Plex Mono (body)
- Dark: `#08080a` bg, `#d4d4d8` text | Light: `#e4dfd8` bg, `#2a2a2e` text
- CSS vars: `--color-*`, `--space-*`, `--font-*`
- Use the `signet-design` skill for visual changes

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

### Memory Pipeline (Phase G)

The daemon runs a plugin-first memory pipeline at
`packages/daemon/src/pipeline/`. Connectors send hook requests with
an `x-signet-runtime-path` header (`"plugin"` or `"legacy"`). The
session tracker enforces one active path per session (409 on conflict).

Pipeline stages: extraction (Ollama, default model `qwen3:4b`) →
decision (write/update/skip) → optional knowledge graph → retention
decay → document ingest → maintenance → session summary. Config
modes: `shadowMode` (extract without writing), `mutationsFrozen`
(reads only), `graphEnabled`, `autonomousEnabled`.

Notable pipeline files beyond the main worker:
- `summary-worker.ts` — async session-end summarizer (writes dated .md)
- `reranker.ts` — search result re-ranking
- `url-fetcher.ts` — URL content fetching for document ingest
- `provider.ts` — LLM provider abstraction

### Database Migrations

`packages/core/src/migrations/` contains numbered migrations
(001-baseline through 010-umap-cache). These run automatically on
daemon startup. Add new migrations as sequential `.ts` files and
register them in the migrations index.

### Auth Middleware

The daemon includes an auth module at `packages/daemon/src/auth/`.
Routes under `/api/*` can be protected via token-based middleware
(`middleware.ts`), with policy rules (`policy.ts`) and rate limiting
(`rate-limiter.ts`). Tokens are managed in `tokens.ts`.

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
- `packages/core/src/migrations/` - Database migrations (001 through 010)
- `packages/core/src/skills.ts` - Skills unification across harnesses
- `packages/cli/src/cli.ts` - Main CLI entrypoint (~4600 LOC)
- `packages/daemon/src/daemon.ts` - HTTP server + watcher
- `packages/daemon/src/db-accessor.ts` - ReadDb/WriteDb typed accessor (used everywhere)
- `packages/daemon/src/db-helpers.ts` - Vector blob helpers, FTS sync utilities
- `packages/daemon/src/umap-projection.ts` - Server-side UMAP dimensionality reduction
- `packages/daemon/src/session-tracker.ts` - Plugin/legacy session mutex
- `packages/daemon/src/pipeline/` - V2 memory extraction pipeline
- `packages/daemon/src/pipeline/document-worker.ts` - Document ingest worker
- `packages/daemon/src/pipeline/maintenance-worker.ts` - Maintenance worker
- `packages/daemon/src/pipeline/summary-worker.ts` - Session summary writer
- `packages/daemon/src/auth/` - Auth module (tokens, middleware, policy, rate limiting)
- `packages/daemon/src/analytics.ts` - Analytics accumulator
- `packages/daemon/src/timeline.ts` - Timeline builder
- `packages/daemon/src/diagnostics.ts` - Health scoring
- `packages/daemon/src/repair-actions.ts` - Repair actions for broken state
- `packages/daemon/src/connectors/` - Connector framework
- `packages/daemon/src/content-normalization.ts` - Content normalization
- `packages/sdk/src/index.ts` - SDK client
- `packages/connector-claude-code/src/index.ts` - Claude Code connector
- `packages/connector-opencode/src/index.ts` - OpenCode connector
- `packages/connector-openclaw/src/index.ts` - OpenClaw connector
- `packages/adapters/openclaw/src/index.ts` - OpenClaw runtime adapter
- `web/src/index.ts` - Website Worker fetch handler
- `web/public/index.html` - Landing page (single-file, no build step)
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
bun run start             # Run directly
bun run dev               # Watch mode
bun run install:service   # Install as system service (systemd/launchd)
bun run uninstall:service # Uninstall system service
```

### Environment Variables

```
SIGNET_PATH    # Override ~/.agents/ data directory
SIGNET_PORT    # Override daemon port (default: 3850)
SIGNET_HOST    # Override daemon host (default: localhost)
OPENAI_API_KEY # Used when embedding provider is openai
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
| `/api/embeddings/status` | GET | Embedding processing status |
| `/api/embeddings/projection` | GET | UMAP 2D/3D projection (server-side) |
| `/api/memory/:id/history` | GET | Memory version history |
| `/api/memory/:id` | PATCH | Update a memory |
| `/api/skills` | GET | List installed skills |
| `/api/skills/browse` | GET | Browse available skills |
| `/api/skills/search` | GET | Search skills |
| `/api/skills/:name` | GET/DELETE | Get or uninstall a skill |
| `/api/skills/install` | POST | Install a skill |
| `/api/secrets` | GET | List secret names |
| `/api/hooks/*` | POST/GET | Session + synthesis hooks |
| `/api/harnesses` | GET | List harnesses |
| `/api/auth/*` | POST/GET | Auth token management |
| `/api/documents/*` | GET/POST/DELETE | Document ingest and retrieval |
| `/api/connectors/*` | GET/POST | Connector status and management |
| `/api/diagnostics/*` | GET | Health scoring and system diagnostics |
| `/api/repair/*` | POST | Repair actions for broken state |
| `/api/analytics/*` | GET | Usage analytics and metrics |
| `/api/timeline/*` | GET | Event timeline |
| `/api/git/*` | GET/POST | Git sync status and operations |
| `/api/update/*` | GET/POST | Update check and apply |
| `/api/logs/*` | GET | Daemon log access |
| `/api/logs/stream` | GET | SSE log streaming |
| `/api/identity` | GET/POST | Identity file read/write |


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
