---
title: "Agents"
description: "Agent identity and configuration format."
order: 26
section: "Project"
---
<!-- Source of truth: /CLAUDE.md (AGENTS.md) — do not edit manually -->

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
for portable AI agent identity. It includes a [[cli|CLI tool]], background
[[daemon]] with [[api|HTTP API]] and MCP server, static [[dashboard]],
harness connectors, [[sdk|SDK]], website, and supporting runtime packages.

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
build:core → build:connector-base → build:opencode-plugin → build:native → build:deps → build:signetai
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
| `@signet/daemon` | Background service: HTTP API, MCP server, file watching | bun |
| `@signet/extension` | Browser extension: popup dashboard, highlight-to-remember | browser |
| `@signet/sdk` | Integration SDK for third-party apps | node |
| `@signet/connector-claude-code` | Claude Code connector: hooks, CLAUDE.md generation | node |
| `@signet/connector-codex` | Codex connector: wrapper install, config patching, session hooks | node |
| `@signet/connector-opencode` | OpenCode connector: plugin, AGENTS.md sync | node |
| `@signet/connector-openclaw` | OpenClaw connector: config patching, hook handlers | node |
| `@signet/opencode-plugin` | OpenCode runtime plugin: memory tools and session hooks | node |
| `@signetai/signet-memory-openclaw` | OpenClaw runtime plugin for calling Signet daemon | node |
| `@signet/native` | Native accelerators for built-in embeddings and future local fast paths | native |
| `@signet/tray` | Tauri-based system tray application | desktop |
| `signetai` | Meta-package bundling CLI + daemon | - |
| `@signet/web` | Marketing website (Astro static, Cloudflare Pages) | cloudflare |
| `predictor` | Predictive memory scorer sidecar (WIP) | rust |

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
- Streamable HTTP MCP server plus stdio MCP entrypoint
- File watching with debounced sync
- Auto-commit on config changes
- System service (launchd/systemd)
- Pipeline V2 (`src/pipeline/`) — LLM-based memory extraction
- Session tracker — plugin vs legacy runtime path mutex
- Update system (`update-system.ts`) — extracted singleton module
  with `getUpdateState()` / `getUpdateSummary()` accessors

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
│    /              Dashboard (Svelte 5 + Tailwind v4 + bits-ui) │
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
decay → document ingest → maintenance → session summary. See
[[pipeline]] for full details. Config modes: `shadowMode` (extract
without writing), `mutationsFrozen` (reads only), `graphEnabled`,
`autonomousEnabled`.

Notable pipeline files beyond the main worker:
- `summary-worker.ts` — async session-end summarizer (writes dated .md)
- `reranker.ts` — search result re-ranking
- `url-fetcher.ts` — URL content fetching for document ingest
- `provider.ts` — LLM provider abstraction

### Database Migrations

`packages/core/src/migrations/` contains numbered migrations
(currently `001-baseline.ts` through `017-task-skills.ts`). These run
automatically on daemon startup. Add new migrations as sequential `.ts`
files and register them in the migrations index.

### Auth Middleware

The daemon includes an [[auth]] module at `packages/daemon/src/auth/`.
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
- `packages/core/src/migrations/` - Database migrations (001 through 017)
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
- `packages/daemon/src/scheduler/` - Scheduled task worker (cron, spawn, polling)
- `packages/daemon/src/embedding-tracker.ts` - Incremental embedding refresh tracker
- `packages/daemon/src/embedding-health.ts` - Embedding health metrics
- `packages/daemon/src/session-checkpoints.ts` - Session checkpoint persistence
- `packages/daemon/src/continuity-state.ts` - Continuity state for compaction boundaries
- `packages/daemon/src/telemetry.ts` - Telemetry event collection
- `packages/daemon/src/feature-flags.ts` - Runtime feature flags
- `packages/daemon/src/update-system.ts` - Update checker singleton
- `packages/sdk/src/index.ts` - SDK client
- `packages/connector-claude-code/src/index.ts` - Claude Code connector
- `packages/connector-codex/src/index.ts` - Codex connector
- `packages/connector-opencode/src/index.ts` - OpenCode connector
- `packages/connector-openclaw/src/index.ts` - OpenClaw connector
- `packages/adapters/openclaw/src/index.ts` - OpenClaw runtime adapter
- `packages/native/` - Native embedding accelerator package
- `packages/tray/` - Tauri tray application
- `web/src/pages/` - Astro page routes
- `docs/` - Full documentation suite (architecture, API, CLI, etc.)

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
| `/api/features` | GET | Feature flags |
| `/api/config` | GET/POST | Config files CRUD |
| `/api/identity` | GET | Identity file read |
| `/api/memories` | GET | List memories |
| `/api/memory/remember` | POST | Save a memory |
| `/api/memory/recall` | POST | Hybrid search |
| `/api/memory/forget` | POST | Batch forget memories |
| `/api/memory/modify` | POST | Modify a memory |
| `/api/memory/search` | GET | Search memories |
| `/api/memory/:id` | GET/PATCH/DELETE | Get, update, or delete a memory |
| `/api/memory/:id/history` | GET | Memory version history |
| `/api/memory/:id/recover` | POST | Recover a deleted memory |
| `/memory/search` | GET | Legacy keyword search |
| `/memory/similar` | GET | Vector similarity search |
| `/api/embeddings` | GET | Export embeddings |
| `/api/embeddings/status` | GET | Embedding processing status |
| `/api/embeddings/health` | GET | Embedding health metrics |
| `/api/embeddings/projection` | GET | UMAP 2D/3D projection (server-side) |
| `/api/skills` | GET | List installed skills |
| `/api/skills/browse` | GET | Browse available skills |
| `/api/skills/search` | GET | Search skills |
| `/api/skills/:name` | GET/DELETE | Get or uninstall a skill |
| `/api/skills/install` | POST | Install a skill |
| `/api/secrets` | GET | List secret names |
| `/api/secrets/:name` | POST/DELETE | Store or delete a secret |
| `/api/secrets/exec` | POST | Execute command with multiple secrets as env vars |
| `/api/hooks/session-start` | POST | Inject context into session |
| `/api/hooks/user-prompt-submit` | POST | Per-prompt context load |
| `/api/hooks/session-end` | POST | Extract session memories |
| `/api/hooks/remember` | POST | Save a memory via hook |
| `/api/hooks/recall` | POST | Search via hook |
| `/api/hooks/pre-compaction` | POST | Pre-compaction summary instructions |
| `/api/hooks/compaction-complete` | POST | Save compaction summary |
| `/api/hooks/synthesis/config` | GET | Synthesis configuration |
| `/api/hooks/synthesis` | POST | Request MEMORY.md synthesis |
| `/api/hooks/synthesis/complete` | POST | Save synthesized MEMORY.md |
| `/api/harnesses` | GET | List harnesses |
| `/api/harnesses/regenerate` | POST | Regenerate harness configs |
| `/api/auth/whoami` | GET | Current auth identity |
| `/api/auth/token` | POST | Issue auth token |
| `/api/documents` | GET/POST | List or enqueue documents |
| `/api/documents/:id` | GET/DELETE | Get or delete a document |
| `/api/documents/:id/chunks` | GET | Get document chunks |
| `/api/connectors` | GET/POST | List or register connectors |
| `/api/connectors/:id` | GET/DELETE | Get or delete a connector |
| `/api/connectors/:id/sync` | POST | Trigger incremental sync |
| `/api/connectors/:id/sync/full` | POST | Trigger full re-sync |
| `/api/connectors/:id/health` | GET | Connector health |
| `/api/diagnostics` | GET | Full health report |
| `/api/diagnostics/:domain` | GET | Per-domain health score |
| `/api/pipeline/status` | GET | Pipeline status snapshot |
| `/api/repair/requeue-dead` | POST | Requeue dead-letter jobs |
| `/api/repair/release-leases` | POST | Release stale job leases |
| `/api/repair/check-fts` | POST | Check/repair FTS consistency |
| `/api/repair/retention-sweep` | POST | Trigger retention sweep |
| `/api/repair/embedding-gaps` | GET | Count unembedded memories |
| `/api/repair/re-embed` | POST | Batch re-embed missing vectors |
| `/api/repair/clean-orphans` | POST | Remove orphaned embeddings |
| `/api/repair/dedup-stats` | GET | Deduplication statistics |
| `/api/repair/deduplicate` | POST | Deduplicate memories |
| `/api/checkpoints` | GET | List session checkpoints |
| `/api/checkpoints/:sessionKey` | GET | Checkpoints for a session |
| `/api/analytics/usage` | GET | Usage counters |
| `/api/analytics/errors` | GET | Recent error events |
| `/api/analytics/latency` | GET | Latency histograms |
| `/api/analytics/logs` | GET | Structured log entries |
| `/api/analytics/memory-safety` | GET | Mutation diagnostics |
| `/api/analytics/continuity` | GET | Session continuity scores over time |
| `/api/analytics/continuity/latest` | GET | Latest continuity score per project |
| `/api/telemetry/events` | GET | Query telemetry events |
| `/api/telemetry/stats` | GET | Aggregated telemetry statistics |
| `/api/telemetry/export` | GET | Export telemetry as NDJSON |
| `/api/timeline/:id` | GET | Entity event timeline |
| `/api/timeline/:id/export` | GET | Export timeline with metadata |
| `/api/git/status` | GET | Git sync status |
| `/api/git/pull` | POST | Pull from remote |
| `/api/git/push` | POST | Push to remote |
| `/api/git/sync` | POST | Pull then push |
| `/api/git/config` | GET/POST | Git sync configuration |
| `/api/update/check` | GET | Check for updates |
| `/api/update/config` | GET/POST | Update configuration |
| `/api/update/run` | POST | Apply pending update |
| `/api/tasks` | GET/POST | List/create scheduled tasks |
| `/api/tasks/:id` | GET/PATCH/DELETE | Get/update/delete task |
| `/api/tasks/:id/run` | POST | Trigger immediate run |
| `/api/tasks/:id/runs` | GET | Paginated run history |
| `/api/tasks/:id/stream` | GET | SSE stream of task output |
| `/api/logs` | GET | Daemon log access |
| `/api/logs/stream` | GET | SSE log streaming |
| `/mcp` | ALL | MCP server (Streamable HTTP, memory + secret tools) |


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
