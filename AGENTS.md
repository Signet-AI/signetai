---
Repo: github.com/signetai/signetai
GitHub issues/comments/PR comments: use literal multiline strings or `-F - <<'EOF'` (or $'...') for real newlines; never embed "\\n".
Branching: <username>/<feature> off main
Conventional commits: type(scope) subject — reserve `feat:` for user-facing features only; use `fix:`, `refactor:`, `chore:`, or `perf:` for internal changes (feat bumps minor version)
Last Updated: 2026/04/02
This file: AGENTS.md (canonical), `CLAUDE.md -> AGENTS.md`
---

This file guides AI assistants working on this repository. Prefer durable,
spec-aligned, maintainable changes over local fixes or convenience hacks.

## Required workflow

### Spec-governed work

Use the spec pipeline for major features, architectural changes,
schema/API boundaries, cross-package coordination, dependency changes, or
other roadmap-level capabilities.

Before coding spec-governed work, you must:

1. Read `docs/specs/INDEX.md`.
2. Validate `docs/specs/dependencies.yaml`.
3. Confirm the target spec status. Do not implement major feature work
   from `planning`; it must be `approved` first.
4. Keep `INDEX.md` and `dependencies.yaml` in sync when adding or
   changing spec work.
5. Re-check integration contracts and invariants in `INDEX.md` before
   finishing.

Skip the planning tier for routine bug fixes, narrow refactors, tests,
and docs-only edits that stay within existing contracts.

### Incident -> guardrail loop

A bug fix is not complete until it adds at least one durable prevention
mechanism:

1. Regression test, invariant check, or CI guard.
2. Spec/index/dependency update if behavior or sequencing changed.
3. `AGENTS.md` rule or checklist refinement if the failure was process
   related.

Every incident should make the same failure mode harder to repeat.

## Common PR failure modes

Prevent these proactively:

1. **Scoping leaks**
   - Thread `agent_id` through every read/write touching user data.
   - Thread `visibility` where relevant.
   - Never hardcode `"default"` for scoped paths.

2. **Validation and bounds gaps**
   - Validate external inputs and config at boundaries.
   - Clamp counters, latency values, and limits to sane non-negative
     ranges.
   - Reject out-of-range values with clear errors.

3. **Silent failures / weak fallbacks**
   - Do not swallow errors.
   - Log with context and return structured failures.
   - For retries or refresh loops, enforce timeout floors,
     single-flight/serialization, and timer cleanup.

4. **Doc/spec drift**
   - Update behavior, API, schema, and status docs in the same PR.
   - Keep `docs/API.md`, `docs/specs/INDEX.md`, and
     `docs/specs/dependencies.yaml` accurate when affected.
   - Root docs duplicated into `docs/` are generated artifacts. Edit the
     root source, then run `bun scripts/sync-root-docs.ts`. Do not hand-edit
     `docs/CONTRIBUTING.md` or `docs/ROADMAP.md`.

5. **Duplication / parity drift**
   - Do not duplicate constants, maps, dependency types, descriptions,
     or config defaults across files.
   - Extract shared sources of truth.

6. **Missing regression tests**
   - Every bug fix needs a test that would fail before the fix.
   - Add edge-case tests for scoping, invalid inputs, timer lifecycle,
     and fallback behavior.

7. **Security/auth oversights**
   - Admin, refresh, and mutation endpoints need explicit permission
     checks.
   - Add rate limiting to expensive or abuse-prone paths.

8. **Code hygiene misses**
   - Run lint and remove dead vars/imports before review.
   - Keep comments aligned with implementation.
   - In `packages/cli/dashboard/`, never run broad Biome autofix
     blindly. Scope it narrowly, inspect the diff, and rerun:

```bash
cd packages/cli/dashboard && bun run check
```

9. **Publish/install integrity drift**
   - Publishable packages must not ship runtime dependencies on
     unpublished workspace packages.
   - Validate publish manifests after version rewriting and before npm
     publish.

## PR checklist

Before opening a PR, verify:

- Spec alignment is checked (`INDEX.md` + `dependencies.yaml`) when the
  change touches spec-governed behavior.
- Agent scoping is correct on all changed data queries.
- Input/config validation and bounds checks were added.
- Error handling and fallback paths are tested.
- Security checks exist on admin or mutation endpoints.
- Docs were updated for API, spec, schema, or status changes.
- Publish manifests were validated if the PR changes a package that gets
  published to npm.
- Each bug fix has a regression test.
- Lint, typecheck, and tests pass locally.

## Priorities

1. Performance.
2. Reliability.
3. Predictable behavior under load and failure.
4. Correctness and robustness over short-term convenience.
5. Long-term maintainability and shared abstractions over local hacks.
6. Duplicate logic is a smell. Extract shared code where it clarifies.
7. Do not be afraid to change existing code when that produces a better
   system.

## Workspace commands

```bash
bun install
bun run build
bun run dev
bun test
bun run lint
bun run format
bun run typecheck
bun run build:publish
bun run version:sync
bun run dev:web
bun run deploy:web
```

`bun run build` must respect this order:

```text
build:core -> build:connector-base -> build:opencode-plugin -> build:native
-> build:oh-my-pi-extension -> build:connector-oh-my-pi
-> build:pi-extension -> build:connector-pi -> build:deps
-> build:signetai
```

`@signet/pi-extension-base` is a source-only shared package with no
standalone build step. `build:oh-my-pi-extension` and `build:pi-extension`
consume it directly from workspace source.

Run a single test file directly with:

```bash
bun test packages/daemon/src/pipeline/worker.test.ts
```

## Package map

| Package | Purpose | Target |
|---|---|---|
| `@signet/core` | Types, DB, search, manifest, identity | node |
| `@signet/connector-base` | Shared connector primitives | node |
| `@signet/cli` | Setup, config, daemon management, dashboard | node |
| `@signet/daemon` | HTTP API, hooks, file watching, memory pipeline | bun |
| `@signet/extension` | Browser extension UI | browser |
| `@signet/sdk` | Third-party integration SDK | node |
| `@signet/connector-claude-code` | Claude Code install-time integration | node |
| `@signet/connector-opencode` | OpenCode install-time integration | node |
| `@signet/connector-openclaw` | OpenClaw install-time integration | node |
| `@signet/connector-codex` | Codex CLI install-time integration | node |
| `@signet/connector-oh-my-pi` | Oh My Pi install-time integration | node |
| `@signet/connector-pi` | Pi install-time integration | node |
| `@signet/connector-hermes-agent` | Hermes Agent install-time integration + Python plugin | node |
| `@signet/opencode-plugin` | OpenCode runtime plugin | node |
| `@signet/oh-my-pi-extension` | Oh My Pi extension/runtime bundle | browser |
| `@signet/pi-extension-base` | Shared Pi/OMP extension utilities (raw TS) | node |
| `@signet/pi-extension` | Pi extension/runtime bundle | node |
| `@signetai/signet-memory-openclaw` | OpenClaw runtime adapter | node |
| `@signet/tray` | Desktop shell / packaging | node |
| `signetai` | Meta-package bundling CLI + daemon | - |
| `@signet/web` | Marketing website | cloudflare |
| `@signet/native` | Native accelerators | node |
| `predictor` | Rust predictive memory scorer | rust |

### Important package responsibilities

- **`@signet/core`**: shared types, SQLite/FTS5, hybrid search, YAML
  manifest parsing, common constants/utilities.
- **`@signet/cli`**: setup wizard, config editing, daemon
  start/stop/status, dashboard launcher, secrets, skills, git sync,
  hook lifecycle, session bypass, update checker.
- **`@signet/daemon`**: Hono HTTP server on port 3850, file watching,
  auto-commit, pipeline V2, session tracker, update system.
- **`packages/daemon-rs`**: Rust shadow runtime for parity work and
  divergence logging. JS daemon changes must preserve parity
  expectations.
- **`@signet/connector-*`**: install-time harness integrations. Distinct
  from daemon-side runtime connector code.
- **`@signet/tray`**: desktop packaging and local runtime shell.
- **`@signet/web`**: Astro static marketing site on Cloudflare Pages.
  Use the `signet-design` skill for visual changes.

## Development notes

### Dashboard

Dashboard stack: Svelte 5, Tailwind v4, bits-ui, CodeMirror 6,
3d-force-graph. Built to static files and served by the daemon.

Use **shadcn-svelte** components for UI work whenever possible:
- https://www.shadcn-svelte.com
- https://www.shadcn-svelte.com/llms.txt

Dashboard commands:

```bash
cd packages/cli/dashboard
bun install
bun run dev
bun run build
bun run check
```

### Website

Astro static site deployed to Cloudflare Pages.

```bash
cd web
bun run dev
bun run build
bun run deploy
```

## Architecture

### Daemon surface

- HTTP server on port `3850`
- `/` dashboard
- `/api/*` config, memory, skills, hooks, updates
- `/memory/*` search and similarity aliases
- `/health` health check
- File watcher with debounced auto-commit (`5s`) and harness sync (`2s`)

### Data flow

```text
User edits $SIGNET_WORKSPACE/AGENTS.md
-> file watcher detects change
-> debounced git commit (5s)
-> harness sync to ~/.claude/CLAUDE.md, etc. (2s)
```

### Memory pipeline

The daemon runs a plugin-first memory pipeline in
`packages/daemon/src/pipeline/`.

- Connectors send `x-signet-runtime-path: plugin|legacy`.
- The session tracker allows one active runtime path per session and
  returns `409` on conflict.
- Default extraction model: `qwen3:4b` via Ollama.
- Stages: extraction -> decision -> optional knowledge graph ->
  retention decay -> document ingest -> maintenance -> session summary.
- Modes: `shadowMode`, `mutationsFrozen`, `graphEnabled`,
  `autonomousEnabled`.

Useful files:
- `summary-worker.ts` - async session-end summaries
- `reranker.ts` - search reranking
- `url-fetcher.ts` - URL ingest
- `provider.ts` - LLM provider abstraction

### Git sync

Credential resolution order:

1. SSH remote (`git@...`)
2. Credential helper
3. `GITHUB_TOKEN` / `gh` CLI for `github.com` only

Rules:
- Never inject GitHub tokens into non-GitHub remotes.
- If no remote is configured, push/pull should skip gracefully.
- All git subprocesses must set `cwd` to `AGENTS_DIR`.

### Database, auth, and data location

- Migrations live in `packages/core/src/migrations/` and run on daemon
  startup. Add new migrations sequentially and register them in the
  index.
- Auth lives in `packages/daemon/src/auth/` with middleware, policy,
  rate limiting, and token management.
- User data lives in `$SIGNET_WORKSPACE/` (default `~/.agents/`):

```text
$SIGNET_WORKSPACE/
├── agent.yaml
├── AGENTS.md
├── SOUL.md
├── IDENTITY.md
├── USER.md
├── MEMORY.md
├── memory/
│   ├── memories.db
│   └── scripts/
├── skills/
├── .secrets/
└── .daemon/logs/
```

## Style and conventions

- Package manager: **bun**
- Lint/format: **Biome**
- Build tool: **bun build**
- Commit style: conventional commits. `feat:` is reserved for
  user-facing features; use `fix:`, `refactor:`, `chore:`, or `perf:`
  for internal work.
- Line width: 80-100 soft, 120 hard.
- Add brief comments only for tricky or non-obvious logic.
- Aim for files under ~700 LOC when it improves clarity or testability.

### Code style rules

- Prefer Bun APIs where practical.
- Avoid `any`, `as`, and non-null assertions (`!`). Use `unknown`,
  narrowing, and explicit null checks instead.
- Prefer discriminated unions over optional-property bags.
- Use `readonly` when mutation is not intended.
- Do not use `enum`; prefer `as const` and union types.
- Exported functions should have explicit return types.
- Prefer result types over exceptions.
- Keep module scope effect-free.
- Prefer `const`, early returns, and ternaries. Avoid unnecessary
  reassignment and `else` chains.
- Prefer functional array methods and type-guard filters over loops when
  they improve inference and clarity.
- Reduce variable count by inlining values used once.
- Avoid unnecessary destructuring.
- Prefer short single-word names unless they become ambiguous.
  Preferred examples: `pid`, `cfg`, `err`, `opts`, `dir`, `root`,
  `child`, `state`, `timeout`.

See `docs/CONTRIBUTING.md` for fuller examples.

## Testing philosophy

Tests are the rewrite contract. Test what must remain true, not how the
current implementation happens to work.

Rules:
- Test behavior, not plumbing.
- Prefer integration-style tests over private helper tests.
- New features ship with tests that describe the contract.
- Specs define correctness; tests enforce it.
- Typecheck and build are not substitutes for runtime verification.

Before finishing:

1. Make the change.
2. Rebuild affected packages.
3. Run tests.
4. Run typecheck for TS changes.
5. Run lint.
6. Validate the running daemon or real runtime where relevant.

### Daemon commands

```bash
cd packages/daemon
bun run start
bun run dev
bun run install:service
bun run uninstall:service
```

### CLI commands

```bash
cd packages/cli
bun src/cli.ts setup
bun src/cli.ts status
```

### Environment variables

```text
SIGNET_PATH      workspace data dir override
SIGNET_PORT      daemon port override
SIGNET_HOST      daemon client address override
SIGNET_BIND      daemon bind address override
SIGNET_BYPASS    set to 1 to bypass hooks
OPENAI_API_KEY   used when embedding provider is OpenAI
```

## Notes

- Daemon targets **bun**.
- CLI targets **node** but also works with **bun**.
- Dashboard is statically built and served by the daemon.
- SQLite uses `bun:sqlite` under Bun and `better-sqlite3` under Node.
- Python scripts are optional batch tools; the daemon is the primary
  memory pipeline.
- Connectors are idempotent and safe to install multiple times.

## Spec pipeline

The spec pipeline is for major product capabilities, architectural work,
schema changes, API contracts, dependency sequencing, and other
research-backed decisions.

Tiers:

```text
research -> planning -> approved -> complete
```

- **`docs/research/`**: raw research and prior art. Every research doc
  must state the question it answers in frontmatter.
- **`docs/specs/planning/`**: design exploration. Must include
  `informed_by` links to research. Not an implementation contract.
- **`docs/specs/approved/`**: frozen implementation contract accepted by
  the INDEX, with integration contracts and plain-language success
  criteria.
- **`docs/specs/complete/`**: shipped work. Move the spec here when done.

### Spec rules

1. No spec without research.
2. No major feature implementation without approval.
3. Move specs between tiers; do not copy them.
4. Success criteria must describe observable outcomes, not compilation.
5. The INDEX is the EPIC and source of integration contracts and build
   sequencing.
6. Sprint briefs live in `docs/specs/sprints/` and break down approved
   specs; they are not standalone specs.

### Dependency tracking

- Source of truth: `docs/specs/dependencies.yaml`
- Validator: `bun scripts/spec-deps-check.ts`
- Every new spec needs a stable ID and dependency entry.
- Hard dependencies block merging; soft dependencies can proceed in
  parallel once interfaces are locked.

## Reference docs

- `AI_POLICY.md`
- `docs/API.md`
- `docs/CONTRIBUTING.md`
- `docs/DASHBOARD.md`
- `docs/ARCHITECTURE.md`
- `docs/PIPELINE.md`
- `docs/specs/INDEX.md`
- `docs/research/`
