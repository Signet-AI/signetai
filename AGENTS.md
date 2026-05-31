---
Repo: "github.com/signetai/signetai"
GitHub issues/comments/PR comments: >-
  Use literal multiline strings or `-F - <<'EOF'` (or `$'...'`) for real
  newlines; never embed "\\n".
Branching: "`<username>/<feature>` off `main`."
Conventional commits: >-
  `type(scope): subject`. Reserve `feat:` for user-facing features only; use
  `fix:`, `refactor:`, `chore:`, `perf:`, `test:`, `docs:`, `build:`, or
  `ci:` for internal changes.
Last Updated: "2026/05/21"
This file: "AGENTS.md (canonical), `CLAUDE.md -> AGENTS.md`."
---

This file guides AI assistants working in the Signet monorepo. The goal is
durable repo work: inspect the real checkout, make scoped changes, add the
guardrail that would have prevented the issue, and verify the affected runtime.

## Operating Stance

- Prefer repo truth and runtime truth over inference. Inspect the current
  files, package scripts, installed binary, daemon health, GitHub state, or
  failing test before proposing a fix.
- Stay on task. Do not widen a bug fix into a product redesign unless the
  user asks for it.
- Preserve unrelated work. The checkout may be dirty; never reset, checkout,
  or delete user changes unless explicitly asked.
- Work on a branch named `<username>/<feature>` from `main` for repo changes.
- Keep changes maintainable. Shared behavior belongs in shared code, not in
  repeated local patches.
- If a public claim, README, docs page, or API contract is affected, update
  the source of truth in the same PR.

## Definition Of Done

For code changes, a complete pass normally includes:

1. Reproduce or identify the behavior from the current checkout.
2. Make the smallest durable change that fits the existing architecture.
3. Add a prevention mechanism: regression test, invariant, validation check,
   CI guard, or process rule.
4. Run the narrowest meaningful checks first, then broader checks when the
   blast radius justifies them.
5. Validate the real daemon, CLI, package, dashboard, or installed runtime
   when the bug is runtime-specific.
6. Inspect `git diff` and make sure unrelated files are not included.

Typecheck, build, lint, and tests are not substitutes for runtime validation
when the failure involves an installed CLI, daemon process, desktop shell,
connector install, browser extension, or generated bundle.

## Incident -> Guardrail Loop

A bug fix is incomplete until the same failure mode is harder to repeat.

Use at least one durable guardrail:

- Regression test for the failing behavior.
- Input/config validation at the boundary.
- Invariant check for scoped data, timers, runtime paths, or publish output.
- CI/publish manifest check for packaging failures.
- `AGENTS.md` or checklist refinement when the failure was process-related.

## High-Risk Failure Modes

Prevent these proactively.

### Scoping Leaks

- Thread `agent_id` / `agentId` through every read and write touching user
  data.
- Thread `visibility` where the data model supports it.
- Never hardcode `"default"` for scoped paths when a real agent id is known.
- Scope ontology, source-backed rows, memories, sessions, analytics, and
  diagnostics consistently.
- Reject or explicitly handle cross-agent links, proposal applies, claim
  updates, and token scopes.

### Validation And Bounds

- Validate external inputs, config, CLI flags, request bodies, and environment
  variables at the boundary.
- Clamp counters, limits, latencies, intervals, offsets, and retry values to
  sane non-negative ranges.
- Reject out-of-range values with clear structured errors.
- Fail closed for auth, graph policy, mutation gates, source access, and
  publish/install integrity.

### Silent Failure And Fallbacks

- Do not swallow errors or silently downgrade behavior.
- Log with enough context to diagnose path, agent id, source id, session key,
  runtime path, route, or package surface.
- Return structured failures from APIs and CLIs.
- For retry or refresh loops, enforce timeout floors, single-flight or
  serialization, and timer cleanup.

### Security And Auth

- Admin, refresh, diagnostics, source, connector, secret, and mutation
  endpoints need explicit permission checks.
- Expensive or abuse-prone paths need rate limiting in `team` and `hybrid`
  modes.
- Never leak tokens or secret values into chat, logs, memory rows, fixtures,
  generated docs, or source files.
- Never inject GitHub tokens into non-GitHub remotes.

### Docs Drift

- Code is the authority. Refresh docs from implementation truth, not from old
  prose.
- Update behavior, API, schema, status, and user-facing docs in the same PR
  when affected.
- Keep `docs/API.md` accurate for daemon route changes.
- Root docs duplicated into `docs/` are generated artifacts. Edit the root
  source, then run `bun scripts/sync-root-docs.ts`.
- Do not hand-edit `docs/CONTRIBUTING.md` or `docs/ROADMAP.md`.
- Use `bun scripts/doc-drift.ts` when architecture or migration docs might be
  stale.

### Duplication And Parity Drift

- Do not duplicate constants, maps, dependency types, config defaults, package
  lists, or descriptions across files.
- Extract a shared source of truth when duplication would create drift.
- JS daemon changes must preserve Rust shadow/parity expectations in
  `platform/daemon-rs` when the behavior overlaps.
- Connector install-time code and daemon runtime connector code are different
  surfaces; do not conflate them.

### Tests And Runtime Coverage

- Every bug fix needs a test that would fail before the fix.
- Test behavior, not implementation plumbing.
- Prefer integration-style tests when the contract crosses modules.
- Add edge-case tests for scoping, invalid inputs, timer lifecycle,
  permission checks, fallback behavior, generated manifests, and publish
  output.
- Keep prompt/model-dependent tests opt-in unless the existing command already
  defines a model-backed test loop.

## Source Truth Model

Signet is a local source-backed substrate for agent continuity. Do not collapse
it into "a memory app" or "a vector search wrapper."

- Source artifacts, transcripts, imported files, notes, configs, and documents
  are evidence.
- Memory rows are scoped, searchable recall records.
- Source-backed recall rows must preserve provenance and remain purgeable by
  source.
- Ontology stores reviewed structure, currentness, versions, links, and
  evidence.
- Epistemic assertions preserve who claimed, believed, observed, decided,
  preferred, denied, or questioned something.
- Skills own reviewed repeated behavior.
- Identity and AGENTS files hold operating policy.
- Secrets stay out of chat, memory, logs, and source files.

Automatic extraction is not permission to silently author policy, ontology,
identity, or skill behavior.

## Architecture Contracts

### Daemon Surface

- HTTP server defaults to port `3850`.
- `/` serves the dashboard.
- `/api/*` covers config, memory, skills, hooks, updates, diagnostics, auth,
  ontology, sources, and related daemon APIs.
- `/memory/*` keeps search and similarity aliases.
- `/health` is the simple health check.
- File watcher behavior includes debounced auto-commit and harness sync.

### Data Location

User data lives in `$SIGNET_WORKSPACE/` (default `~/.agents/`):

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

Do not present `MEMORY.md` as the database or as full source truth. It is a
generated working summary.

### Pipeline And Runtime Paths

- The daemon pipeline lives in `platform/daemon/src/pipeline/`.
- Connectors send `x-signet-runtime-path: plugin|legacy`.
- A session may use one active runtime path; conflicts should return `409`.
- Pipeline stages include extraction, decision, optional knowledge graph,
  retention decay, document ingest, maintenance, and session summary.
- Important modes include `shadowMode`, `mutationsFrozen`, `graphEnabled`,
  and `autonomousEnabled`.

For harness duplication or high-token memory reports, inspect the installed
config and confirm only the intended Signet hook/plugin path is active.

### Ontology Control Plane

- Use audited ontology operations for structured graph changes.
- Pending proposals are for large refactors, risky/destructive changes, or
  explicit review queues.
- Clear single operations should usually apply directly with provenance.
- Claim slots use `group_key` + `claim_key`; version history must remain
  inspectable.
- Raw source artifacts and transcripts must not be rewritten when graph or
  memory rows change.
- `relations` is legacy; new audited links use `entity_dependencies`.

Useful commands:

```bash
signet ontology pipeline explain --json
signet ontology proposals --status pending --json
signet ontology assertions --limit 50 --json
signet ontology entity merge-plan "Target" "Source" --json
signet ontology stream apply ops.jsonl --dry-run --json
```

### Git Sync

Credential resolution order:

1. SSH remote (`git@...`).
2. Credential helper.
3. `GITHUB_TOKEN` / `gh` CLI for `github.com` only.

Rules:

- If no remote is configured, push/pull should skip gracefully.
- All git subprocesses that operate on the workspace must set `cwd` to
  `AGENTS_DIR`.
- Sync must not trample unrelated dirty files.

## Package And Directory Map

| Package / area | Location | Purpose | Target |
|---|---|---|---|
| `@signet/core` | `platform/core` | Types, DB, migrations, search, manifest, identity | node/bun |
| `@signet/daemon` | `platform/daemon` | Hono API, hooks, file watching, pipeline, dashboard server | bun |
| `platform/daemon-rs` | `platform/daemon-rs` | Rust shadow runtime and parity logging | rust |
| `@signet/native` | `platform/native` | Native accelerators | node |
| `@signet/cli` | `surfaces/cli` | Setup, config, daemon management, secrets, skills, sync | node/bun |
| `signet-dashboard` | `surfaces/dashboard` | Svelte dashboard served by daemon | browser |
| `@signet/desktop` | `surfaces/desktop` | Electron desktop shell and packaging | node/electron |
| `@signet/tray` | `surfaces/tray` | Shared tray/menu state utilities | node |
| `@signet/extension` | `surfaces/browser-extension` | Browser extension UI | browser |
| `@signet/sdk` | `libs/sdk` | Third-party integration SDK | node |
| `@signet/connector-base` | `libs/connector-base` | Shared connector primitives | node |
| `@signet/connector-*` | `integrations/*/connector` | Install-time harness integrations | node |
| `@signet/opencode-plugin` | `integrations/opencode/plugin` | OpenCode runtime plugin | node |
| `@signet/oh-my-pi-extension` | `integrations/oh-my-pi/extension` | Oh My Pi extension/runtime bundle | browser |
| `@signet/pi-extension-base` | `integrations/pi/extension-base` | Shared Pi/OMP extension utilities, source-only | node |
| `@signet/pi-extension` | `integrations/pi/extension` | Pi extension/runtime bundle | node |
| `@signetai/signet-memory-openclaw` | `integrations/openclaw/memory-adapter` | OpenClaw runtime adapter | node |
| `signetai` | `dist/signetai` | Installable distribution package | npm |
| `@signet/web` | `web/marketing` | Astro marketing/docs site | cloudflare |
| `signet-reviews-worker` | `web/workers/reviews` | Cloudflare review worker | cloudflare |
| `plugins/core/secrets` | `plugins/core/secrets` | Core Signet-native secrets plugin | bun |
| `memorybench` | `memorybench` | Benchmark harness, datasets, reports, local UI | node |

`@signet/pi-extension-base` has no standalone build step. The Oh My Pi and Pi
extension builds consume it directly from workspace source.

## Workspace Commands

```bash
bun install
bun run build
bun test
bun run lint
bun run format
bun run typecheck
bun run build:publish
bun run version:sync
bun run dev:web
bun run deploy:web
```

`bun run build` must preserve this order:

```text
build:core -> build:connector-base -> build:opencode-plugin -> build:native
-> build:oh-my-pi-extension -> build:connector-oh-my-pi
-> build:pi-extension -> build:connector-pi -> build:deps
-> build:signetai
```

Run focused checks directly:

```bash
bun test platform/daemon/src/pipeline/worker.test.ts
bun run --filter '@signet/daemon' build
bun run --filter '@signet/cli' test
```

## Area-Specific Guidance

### Daemon

```bash
cd platform/daemon
bun run dev
bun run start
bun run install:service
bun run uninstall:service
```

- Migrations live in `platform/core/src/migrations/`. Add migrations
  sequentially and register them in the index.
- Auth lives in `platform/daemon/src/auth/` with middleware, policy, rate
  limiting, and token management.
- Route changes usually need API docs and route tests.
- Long-running workers need timeout floors, cleanup, and single-flight
  protection where applicable.

### CLI

```bash
cd surfaces/cli
bun src/cli.ts setup
bun src/cli.ts status
```

- CLI behavior should match daemon API contracts and return clear failures.
- Prefer `--json` support for surfaces that agents or scripts consume.
- Setup and connector commands must be idempotent.

### Dashboard

Dashboard stack: Svelte 5, Tailwind v4, bits-ui, CodeMirror 6,
3d-force-graph. Built static files are served by the daemon.

```bash
cd surfaces/dashboard
bun install
bun run dev
bun run build
bun run check
```

- Use shadcn-svelte components where practical.
- Never run broad Biome autofix blindly in `surfaces/dashboard/`. Scope it
  narrowly, inspect the diff, then rerun `cd surfaces/dashboard && bun run check`.
- For Svelte issues reported from root, reproduce with the root-level command
  if needed:

```bash
bunx svelte-check --tsconfig surfaces/dashboard/tsconfig.json
```

### Desktop, Tray, And Installed Runtime

- Desktop bugs require checking the installed app or active launcher path when
  the report is about shipped behavior.
- Verify daemon process path, symlink target, package version, and health
  endpoint before assuming the repo build is active.
- Keep tray logic in `@signet/tray`; do not duplicate menu state in desktop.

### Website And Docs

Astro site:

```bash
cd web/marketing
bun run dev
bun run build
bun run deploy
```

- Follow the current `web/marketing` implementation patterns.
- Edit generator/source files rather than generated artifacts.
- Keep public copy honest: source truth, provenance, accepted changes, skills,
  and agent continuity are stronger framing than generic "memory app" claims.

### Publish And Install

- Publishable packages must not ship runtime dependencies on unpublished
  workspace packages.
- Validate publish manifests after version rewriting and before npm publish.
- Bundle/install changes need smoke tests against the real generated package,
  installer script, or global command path.

Useful checks:

```bash
bun test scripts/check-publish-manifests.test.ts
bun run build:publish
```

## Style

- Package manager: Bun.
- Lint/format: Biome.
- Build tool: `bun build` and package scripts.
- Line width: 80-100 soft, 120 hard.
- Add comments only for tricky or non-obvious logic.
- Aim for files under roughly 700 LOC when it improves clarity or testability.

TypeScript conventions:

- Avoid `any`, `as`, and non-null assertions (`!`). Use `unknown`, narrowing,
  and explicit null checks.
- Prefer discriminated unions over optional-property bags.
- Use `readonly` when mutation is not intended.
- Do not use `enum`; prefer `as const` and union types.
- Exported functions should have explicit return types.
- Prefer result types over exceptions at recoverable boundaries.
- Keep module scope effect-free.
- Prefer `const`, early returns, and ternaries.
- Avoid unnecessary reassignment and `else` chains.
- Prefer functional array methods and type-guard filters when they improve
  inference and clarity.
- Reduce variable count by inlining values used once.
- Avoid unnecessary destructuring.
- Prefer short single-word names unless they become ambiguous.

See `CONTRIBUTING.md` for fuller style examples.

## Environment Variables

```text
SIGNET_PATH      workspace data dir override
SIGNET_PORT      daemon port override
SIGNET_HOST      daemon client address override
SIGNET_BIND      daemon bind address override
SIGNET_BYPASS    set to 1 to bypass hooks
OPENAI_API_KEY   used when embedding provider is OpenAI
```

## PR Checklist

Before opening a PR, verify:

- The branch is based on `main` and named `<username>/<feature>`.
- Agent scoping and visibility are correct on changed data queries.
- Inputs, config, env vars, and bounds are validated.
- Error handling and fallback paths are explicit and tested.
- Admin, refresh, diagnostics, source, secret, and mutation endpoints have
  permission checks and rate limits where needed.
- Runtime paths, timers, and cleanup behavior are covered when touched.
- Docs were updated for API, schema, status, or behavior changes.
- Generated docs were produced from root sources, not hand-edited.
- Publish manifests were validated if publishable packages changed.
- Each bug fix has a regression test or an explicit prevention guard.
- Lint, typecheck, build, and tests were run at the right scope.
- The real daemon, CLI, desktop app, connector, extension, installer, or site
  was validated when the change affects runtime behavior.

## Reference Docs

- `AI_POLICY.md`
- `CONTRIBUTING.md`
- `docs/API.md`
- `docs/AUTH.md`
- `docs/ARCHITECTURE.md`
- `docs/DASHBOARD.md`
- `docs/HOOKS.md`
- `docs/PIPELINE.md`
- `docs/SOURCES.md`
- `docs/knowledge-graph-control-plane.md`
- `docs/specs/INDEX.md`
- `docs/research/`
