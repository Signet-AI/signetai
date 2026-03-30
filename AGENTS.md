---
Repo: github.com/signetai/signetai
GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".
Branching: <username>/<feature> off main
Conventional commits: type(scope) subject — reserve `feat:` for user-facing features only; use `fix:`, `refactor:`, `chore:`, or `perf:` for internal changes (feat bumps minor version)
Last Updated: 2026/03/24
This file: AGENTS.md -> Symlinked to CLAUDE.md
---

IMPORTANT: Do not overwrite or destroy this document or its symbolic links.
Running `/init` is **strongly** discouraged.

This file provides guidance to AI assistants working on this repository.
It is version controlled and co-maintained by human developers and AI
assistants. Changes to this document should be thoughtful and express good judgement.

Session Protocol (MANDATORY)
---

Before starting any new feature, implementation, fix, refactor, or review,
agents MUST:

1. Read `docs/specs/INDEX.md` at the start of the session.
2. Validate planned work against `docs/specs/dependencies.yaml`.
3. Confirm the target spec status (`planning`/`approved`/`complete`) before coding.
4. Keep `INDEX.md` and `dependencies.yaml` in sync when adding or changing spec work.
5. Re-check implementation decisions against the integration contracts and invariants in `INDEX.md` before finishing.

If work is not represented in the spec system, add a planning stub first (or update
a relevant existing spec) before implementation.

Incident -> Guardrail Loop (MANDATORY)
---

When a bug/regression/incident is discovered (in CI, review, or production),
the fix is not complete until at least one durable prevention mechanism is added:

1. A regression test, invariant check, or CI guard.
2. A spec/index/dependency contract update if behavior or sequencing changed.
3. An AGENTS.md rule/checklist refinement if the failure mode was process-related.

Every incident should leave the codebase harder to break in the same way twice.

Recurring PR Failure Modes (Last 2 Weeks)
---

The most frequent reviewer callouts across high-comment / high-size PRs
(PRs #253, #267, #210, #217, #295, #202, #203, #211, #195, #277)
were the following. Prevent them proactively:

1. **Agent scoping leaks**
   - Every read/write query touching user data must thread `agent_id`
     (and `visibility` where relevant).
   - Never hardcode `"default"` for scoped data paths.

2. **Validation gaps and bounds bugs**
   - Validate all external inputs and config values at boundaries.
   - Clamp counters/latency/limits to sane non-negative ranges.
   - Reject out-of-range values explicitly with clear errors.

3. **Silent failures and weak fallback logic**
   - Do not swallow errors. Log with context and return structured failure.
   - For retries/refresh loops, enforce timeout floors, single-flight/serialization,
     and timer cleanup to avoid stale or duplicated background work.

4. **Doc and spec drift**
   - Any behavior/API/schema change must update relevant docs in same PR
     (`docs/API.md`, `docs/specs/INDEX.md`, `docs/specs/dependencies.yaml`,
     roadmap/status text if affected).
   - Story counts, status markers, and dependency edges must remain accurate.

5. **Duplication and parity drift**
   - No duplicated constants/maps/business rules across files.
   - Extract shared sources of truth for dependency types, descriptions,
     and config defaults.

6. **Missing regression tests for fixed bugs**
   - Every bug fix should include a test that would fail before the fix.
   - Add edge-case tests for scoping, invalid inputs, timer lifecycle,
     and fallback behavior.

7. **Security and auth oversights on operational endpoints**
   - Admin/refresh/mutation endpoints must have explicit permission checks.
   - Add rate limiting for potentially expensive or abuse-prone paths.

8. **Code hygiene misses (unused vars/assignments, stale comments)**
   - Run lint and remove dead variables/imports before review.
   - Keep inline comments aligned with actual implementation behavior.
   - Do **not** run `biome check --write` or `--unsafe` blindly across
     `packages/cli/dashboard/`. Biome currently misfires on Svelte 5 rune
     patterns (`$props`, `$state`, bindable refs, runtime component imports)
     and can mass-convert required `let` / runtime imports into broken
     `const` / `import type` forms. Scope autofix to a few files at a time,
     inspect the diff, and immediately rerun `cd packages/cli/dashboard &&
     bun run check` after any automated rewrite.

PR Readiness Checklist (MANDATORY Before Opening PR)
---

- [ ] Spec alignment validated (`INDEX.md` + `dependencies.yaml`).
- [ ] Agent scoping verified on all new/changed data queries.
- [ ] Input/config validation and bounds checks added.
- [ ] Error handling and fallback paths tested (no silent swallow).
- [ ] Security checks applied to admin/mutation endpoints.
- [ ] Docs updated for API/spec/status changes.
- [ ] Regression tests added for each bug fix.
- [ ] Lint/typecheck/tests pass locally.

Core Priorities
---

1. Performance.
2. Reliability.
3. Keep behavior predictable under load and during failures (session
restarts, reconnects, partial streams).
4. If a tradeoff is required, choose correctness and robustness over short-term
convenience.
5. All codebase changes are reviewed by agents during CI/CD, as well as human developers.
6. Long term maintainability is a core priority. If you add new functionality,
first check if there are shared logic that can be extracted to a separate module.
7. Duplicate logic across mulitple files is a code smell and should be avoided.
8. Don't be afraid to change existing code.
9. Don't take shortcuts by just adding local logic to solve a problem.

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

All UI work must use components from **shadcn-svelte**
(https://www.shadcn-svelte.com). LLM reference:
https://www.shadcn-svelte.com/llms.txt. Prefer existing shadcn-svelte
components over custom implementations.

Linting guardrail: Biome autofix is **not** currently safe to run blindly on
the whole dashboard. It has caused large-scale Svelte rune breakage by
rewriting mutable/bindable `let` bindings and runtime imports. If you use
Biome autofix in `packages/cli/dashboard/`, do it on a narrow file set only,
review the patch, then rerun:

```bash
cd packages/cli/dashboard
bun run check
```

```bash
cd packages/cli/dashboard
bun install
bun run dev      # Dev server at localhost:5173
bun run build    # Static build to build/
```

### Website Development

Astro static site, deployed to Cloudflare Pages via wrangler.

```bash
cd web
bun run dev      # Astro dev server
bun run build    # Static build to dist/
bun run deploy   # Deploy to Cloudflare (wrangler)
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
| `@signet/connector-opencode` | OpenCode connector: plugin, AGENTS.md sync | node |
| `@signet/connector-openclaw` | OpenClaw connector: config patching, hook handlers | node |
| `@signet/connector-codex` | Codex CLI connector: hooks and plugin | node |
| `@signet/opencode-plugin` | OpenCode runtime plugin: memory tools and session hooks | node |
| `@signetai/signet-memory-openclaw` | OpenClaw runtime plugin for calling Signet daemon | node |
| `@signet/tray` | System tray application | node |
| `signetai` | Meta-package bundling CLI + daemon | - |
| `@signet/web` | Marketing website (Astro static, Cloudflare Pages) | cloudflare |
| `@signet/native` | Native accelerators (SIMD vector ops, napi-rs) | node |
| `predictor` | Predictive memory scorer sidecar (Rust) | rust |


### Package Responsibilities

**@signet/core** - Shared foundation
- TypeScript interfaces (AgentManifest, Memory, etc.)
- SQLite database wrapper with FTS5
- Hybrid search (vector + keyword)
- YAML manifest parsing
- Constants and utilities

**@signet/cli** - User interface (modular command surface + setup flows)
- Setup wizard with harness selection
- Config editor (`signet configure`)
- Daemon start/stop/status
- Dashboard launcher
- Secrets management
- Skills management
- Git sync management
- Hook lifecycle commands
- Per-session bypass toggle (`signet bypass`)
- Update checker

**@signet/daemon** - Background service

> **Rust parity rule**: `packages/daemon-rs/` is a shadow rewrite of this package.
> Any behavioral change made to `@signet/daemon` must also be reflected in `packages/daemon-rs/`.
> The shadow proxy (`shadowEnabled: true` in agent.yaml) runs both in parallel and logs divergences
> to `$SIGNET_WORKSPACE/.daemon/logs/shadow-divergences.jsonl` (default workspace: `~/.agents`).

- Hono HTTP server on port 3850
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
- Astro static site deployed to Cloudflare Pages
- `web/src/pages/` — Astro page routes
- `web/src/components/` — Reusable UI components
- `web/src/styles/` — Global styles
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
User edits $SIGNET_WORKSPACE/AGENTS.md
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

### Git Sync

The daemon auto-commits changes in `$SIGNET_WORKSPACE/` and syncs with a
configured git remote. Credential resolution order matters:

1. **SSH** (`git@...`) — used as-is, no URL modification
2. **Credential helper** — per-host, works for any forge (gitea, gitlab, etc.)
3. **GITHUB_TOKEN / gh CLI** — only for `github.com` remotes

GitHub tokens must never be injected into non-GitHub remote URLs.
If no remote is configured, push/pull gracefully skip (no error).
The `buildAuthUrlFromToken`/`buildAuthUrlFromCreds` helpers work
with any HTTPS host, not just GitHub.

All git subprocess calls must pass `cwd` to run in `AGENTS_DIR`,
not the daemon's process working directory.

### Database Migrations

`packages/core/src/migrations/` contains numbered migrations
(001-baseline through 039-dedup-entity-dependencies). These run
automatically on daemon startup. Add new migrations as sequential
`.ts` files and register them in the migrations index.

### Auth Middleware

The daemon includes an auth module at `packages/daemon/src/auth/`.
Routes under `/api/*` can be protected via token-based middleware
(`middleware.ts`), with policy rules (`policy.ts`) and rate limiting
(`rate-limiter.ts`). Tokens are managed in `tokens.ts`.

### User Data Location

All user data lives at `$SIGNET_WORKSPACE/` (default: `~/.agents/`):

```
$SIGNET_WORKSPACE/
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

Style & Conventions
---

- Package manager: **bun**
- Linting/formatting: **Biome**
- Build tool: **bun build**
- Commit style: conventional commits — `feat:` is reserved for
  user-facing features (it bumps the minor version). For internal
  improvements, helpers, refactors, or plumbing use `fix:`, `refactor:`,
  `chore:`, or `perf:` instead
- Line width: 80-100 soft, 120 hard
- Add brief code comments for tricky or non-obvious logic.
- Aim to keep files under ~700 LOC; guideline only (not a hard guardrail).
- Split/refactor when it improves clarity or testability.
- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- Use single word names by default for new locals, params, and helper functions.
- Multi-word names are allowed only when a single word would be unclear or ambiguous.
- Do not introduce new camelCase compounds when a short single-word alternative is clear.
- Before finishing edits, review touched lines and shorten newly introduced identifiers where possible.
- Good short names to prefer: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`.
- Examples to avoid unless truly required: `inputPID`, `existingClient`, `connectTimeout`, `workerPath`.
- no `any` -- use `unknown` with narrowing
- no `as` -- fix the types instead of asserting
- no `!` -- check for null explicitly
- discriminated unions over optional properties
- `readonly` everywhere mutation isn't intended
- no `enum` -- use `as const` + union types
- explicit return types on exported functions
- result types over exceptions
- effect-free module scope
- Reduce total variable count by inlining when a value is only used once.
- Avoid unnecessary destructuring. Use dot notation to preserve context.
- Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.
- Avoid `else` statements. Prefer early returns.

For detailed style examples with code, see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

Testing Philosophy
---

Tests are the rewrite contract. Every test should encode *what must
be true* (the behavioral contract), not *how it's currently done*
(the implementation). A test that would break if you rewrote the
module in Rust with the same interface is testing plumbing, not theory.

Rules:
- Test the contract, not the implementation
- Tests should survive a language rewrite unchanged in logic
- Prefer integration-style tests over unit tests of private helpers
- Every new feature ships with tests that describe the behavior
- The specs define what's correct; the tests enforce it

Typecheck and build don't prove behavior. Always test changes against
the running daemon or actual runtime before calling something done.

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
SIGNET_PATH    # Override workspace data directory (default: ~/.agents)
SIGNET_PORT    # Override daemon port (default: 3850)
SIGNET_HOST    # Override daemon client connection address (default: 127.0.0.1)
SIGNET_BIND    # Override daemon listen/bind address (default: 127.0.0.1, use 0.0.0.0 for containers)
SIGNET_BYPASS  # Set to 1 to bypass all hooks (CLI exits immediately, daemon never contacted)
OPENAI_API_KEY # Used when embedding provider is openai
```

### Testing CLI Changes

```bash
cd packages/cli
bun src/cli.ts setup     # Run setup command
bun src/cli.ts status    # Check status
```

## Notes

- Daemon targets **bun** for Hono/JSX support and Bun SQLite
- CLI targets **node** for broader compatibility, but also works with **bun**
- Dashboard is built to static files, served by daemon
- SQLite uses runtime detection: `bun:sqlite` under Bun, `better-sqlite3` under Node.js
- Daemon is the primary memory pipeline; Python scripts are optional batch tools
- Connectors are idempotent - safe to run install multiple times

## Specs Pipeline

All feature design and research flows through a structured pipeline.
The [Spec Index](docs/specs/INDEX.md) is the EPIC — it defines how
approved specs compose into a coherent system. When deciding what
ships next, start there.

### Pipeline Tiers

```
research → planning → approved → complete
```

**`docs/research/`** — Raw material: papers, repo analyses, ideas,
competitive intel. Repos cloned to `references/`. Every research doc
MUST state what question it answers in frontmatter (`question` field).
Research has two subdirectories: `technical/` and `market/`.

**`docs/specs/planning/`** — Structured plans: how a capability
integrates, which patterns apply, how it fits the taxonomy. Plans
iterate freely. Each planning doc MUST link back to its research
sources via `informed_by` frontmatter. A planning doc is NOT an
implementation contract — it is a design exploration.

**`docs/specs/approved/`** — Frozen contracts. A planning doc moves
here when: (1) the INDEX accepts it with integration contracts defined,
(2) cross-cutting invariants are respected, (3) success criteria are
written in plain text. Once approved, the spec does NOT change —
amendments go through the INDEX or a new planning doc.

**`docs/specs/complete/`** — Delivered. The spec MOVES here (not
copied) when the implementation ships. The `dependencies.yaml` path
updates. The INDEX registry status updates.

### Rules

1. **No spec without research.** Every spec in planning/ or beyond
   must trace back to at least one research source. If there is no
   research doc, write one first — even a brief one stating the
   question and known prior art.
2. **No implementation without approval.** Do not begin feature
   implementation from a planning doc. It must be in approved/ with
   success criteria defined in the INDEX.
3. **Move, don't copy.** When a spec graduates (planning → approved,
   approved → complete), move the file. Update `dependencies.yaml`
   path. Update INDEX registry. Never have the same spec in two tiers.
4. **Success criteria are outcomes, not compilation.** The INDEX
   defines what "done" looks like in terms of observable behavior
   change, not "the code compiles" or "tests pass."
5. **The INDEX is the EPIC.** It links approved specs, defines
   integration contracts between them, tracks dependencies, and
   sequences build waves. If a new spec introduces a dependency,
   update both `dependencies.yaml` and the INDEX.
6. **Sprint briefs live in `docs/specs/sprints/`.** These are
   implementation breakdowns of approved specs, not standalone specs.

### Dependency Tracking

Source of truth: `docs/specs/dependencies.yaml`
Validation: `bun scripts/spec-deps-check.ts`

Every new spec gets a stable ID and entry in `dependencies.yaml`.
Hard dependencies block merging. Soft dependencies can run in
parallel but interfaces must lock before merge.

## Reference

- [AI Policy](AI_POLICY.md) — expectations for AI-assisted contributions
- [HTTP API](docs/API.md) — full endpoint catalog
- [Contributing](docs/CONTRIBUTING.md) — style examples, CI/CD, identity files, reference repos
- [Dashboard](docs/DASHBOARD.md) — design tokens, component org, Svelte 5 conventions
- [Architecture](docs/ARCHITECTURE.md) — deep system design
- [Pipeline](docs/PIPELINE.md) — memory extraction internals
- [Spec Index](docs/specs/INDEX.md) — EPIC: integration contract, dependency graph, build sequence
- [Research](docs/research/) — reference material informing spec design
