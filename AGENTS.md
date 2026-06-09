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
Last Updated: "2026/06/09"
This file: "AGENTS.md (canonical), `CLAUDE.md -> AGENTS.md`."
---

This file guides AI assistants working in the Signet monorepo. The goal is
durable repo work: inspect the real checkout, make scoped changes, add the
guardrail that would have prevented the issue, and verify the affected
runtime. Telegraph style below — root owns hard policy and routing;
scoped `AGENTS.md` files own subtree guidance; skills own workflows.

## Start

- Replies: repo-root refs only (e.g. `platform/daemon/src/server.ts:42`).
  No absolute paths, no `~/`.
- Fix/triage answers need source, tests, current/shipped behavior, and
  dependency contract proof.
- Reviews/answers: high confidence required. Default to exhaustive relevant
  codebase search/read, including owners, callers, siblings, tests, docs,
  and upstream/dependency contracts before verdict. Diff-only review is
  insufficient.
- Review default: read the whole changed function/module plus callers,
  callees, sibling implementations, adjacent tests, scoped docs, and
  dependency contracts before saying `good`, `bad`, `best fix`, `proof
  sufficient`, or posting a comment. If challenged, keep reading first.
- Dependency-touching work: direct dependency inspection is mandatory when
  feasible. Most dependencies are OSS, so read their source/docs/types.
  Subagent reports, PR text, Signet wrappers, generated schemas, memory,
  and prior reviews do not satisfy this gate. Cite files/lines checked.
- Harness-integration work (`integrations/<harness>/`) has a hard gate:
  the acting agent must personally inspect the sibling harness repo
  under `references/` for the exact protocol/runtime behavior before
  any verdict, comment, approval, code change, or `proof sufficient`
  claim. If missing, clone it there first. No direct sibling-harness
  check means no verdict on that integration.
- External API work: live test required. Prefer official docs/source/types;
  cite current proof. No memory-only API claims.
- Live-verify when feasible. Never print secrets.
- Missing deps: `bun install`, retry once, then report first actionable
  error.

## Map

- Engine/runtime: `platform/core`, `platform/daemon`, `platform/daemon-rs`,
  `platform/native`.
- Human surfaces: `surfaces/cli`, `surfaces/dashboard`, `surfaces/desktop`,
  `surfaces/tray`, `surfaces/browser-extension`.
- Integrations: `integrations/<harness>/{plugin,connector,extension,...}`.
  Sibling references live in `references/` (e.g. `references/openclaw/`,
  `references/pi-mono/`, `references/claude-code/`). The directory
  name on disk is not always identical to the harness name.
- Reusable libs: `libs/`, `dist/signetai`.
- Docs: `docs/**` (generated from root sources via
  `bun scripts/sync-root-docs.ts`); marketing: `web/marketing`.
- Architecture: `docs/ARCHITECTURE.md`. Directory map and risk
  metadata: `repo.map.yaml`.

## Source Truth Model

Signet is a local source-backed substrate for agent continuity. Do not
collapse it into "a memory app" or "a vector search wrapper."

- Source artifacts, transcripts, imported files, notes, configs, and
  documents are evidence.
- Memory rows are scoped, searchable recall records.
- Source-backed recall rows must preserve provenance and remain
  purgeable by source.
- Ontology stores reviewed structure, currentness, versions, links, and
  evidence.
- Epistemic assertions preserve who claimed, believed, observed, decided,
  preferred, denied, or questioned something.
- Skills own reviewed repeated behavior.
- Identity and AGENTS files hold operating policy.
- Secrets stay out of chat, memory, logs, and source files.

Automatic extraction is not permission to silently author policy,
ontology, identity, or skill behavior.

## High-Risk Failure Modes

Prevent these proactively.

### Scoping Leaks

- Thread `agent_id` / `agentId` through every read and write touching
  user data.
- Thread `visibility` where the data model supports it.
- Never hardcode `"default"` for scoped paths when a real agent id is
  known.
- Scope ontology, source-backed rows, memories, sessions, analytics, and
  diagnostics consistently.
- Reject or explicitly handle cross-agent links, proposal applies, claim
  updates, and token scopes.

### Validation And Bounds

- Validate external inputs, config, CLI flags, request bodies, and
  environment variables at the boundary.
- Clamp counters, limits, latencies, intervals, offsets, and retry values
  to sane non-negative ranges.
- Reject out-of-range values with clear structured errors.
- Fail closed for auth, graph policy, mutation gates, source access, and
  publish/install integrity.

### Silent Failure And Fallbacks

- Do not swallow errors or silently downgrade behavior.
- Log with enough context to diagnose path, agent id, source id, session
  key, runtime path, route, or package surface.
- Return structured failures from APIs and CLIs.
- For retry or refresh loops, enforce timeout floors, single-flight or
  serialization, and timer cleanup.

### Security And Auth

- Admin, refresh, diagnostics, source, connector, secret, and mutation
  endpoints need explicit permission checks.
- Expensive or abuse-prone paths need rate limiting in `team` and `hybrid`
  modes.
- Never leak tokens or secret values into chat, logs, memory rows,
  fixtures, generated docs, or source files.
- Never inject GitHub tokens into non-GitHub remotes.

### Docs Drift

- Code is the authority. Refresh docs from implementation truth, not
  from old prose.
- Update behavior, API, schema, status, and user-facing docs in the same
  PR when affected.
- Keep `docs/API.md` accurate for daemon route changes.
- Root docs duplicated into `docs/` are generated artifacts. Edit the
  root source, then run `bun scripts/sync-root-docs.ts`.
- Do not hand-edit `docs/CONTRIBUTING.md` or `docs/ROADMAP.md`.
- Use `bun scripts/doc-drift.ts` when architecture or migration docs
  might be stale.

### Duplication And Parity Drift

- Do not duplicate constants, maps, dependency types, config defaults,
  package lists, or descriptions across files.
- Extract a shared source of truth when duplication would create drift.
- JS daemon changes must preserve Rust shadow/parity expectations in
  `platform/daemon-rs` when the behavior overlaps.
- Connector install-time code and daemon runtime connector code are
  different surfaces; do not conflate them.

### Tests And Runtime Coverage

- Every bug fix needs a test that would fail before the fix.
- Test behavior, not implementation plumbing.
- Prefer integration-style tests when the contract crosses modules.
- Add edge-case tests for scoping, invalid inputs, timer lifecycle,
  permission checks, fallback behavior, generated manifests, and
  publish output.
- Keep prompt/model-dependent tests opt-in unless the existing command
  already defines a model-backed test loop.

## What We Will Not Merge (For Now)

- Hosted memory APIs, vendor cloud lock-in, or shared base models
  trained on user data.
- Shadow fine-tuning, federated learning, or any "learn what to remember"
  framing that ships user context off the user's machine.
- Runtime shims, silent compat for old/malformed config keys, or
  parallel fallback readers. Runtime reads canonical config only.
- JSON/JSONL/TXT/sidecar files as the default for app state, caches,
  queues, indexes, cursors, or plugin scratch data. SQLite is the
  default storage. JSON/JSONL sidecars are acceptable for genuine
  user-facing artifacts (import/export, attachments, logs, backups)
  when the storage owner is a named product artifact, not app state.
- A second path for the same behavior unless the old path is a cited
  shipped public contract.
- Marketing copy that frames Signet as a generic "memory app" or "vector
  search wrapper." Source truth, provenance, accepted changes, skills,
  and agent continuity are the framing.
- PRs over ~5,000 changed lines unless the user or owner asks.
- Bundling multiple unrelated fixes/features in one PR.

This list is a charter, not a law of physics. Strong user demand and
strong technical rationale can change it.

## Architecture Contracts

### Daemon Surface

- HTTP server defaults to port `3850`.
- `/` serves the dashboard.
- `/api/*` covers config, memory, skills, hooks, updates, diagnostics,
  auth, ontology, sources, and related daemon APIs.
- `/memory/*` keeps search and similarity aliases.
- `/health` is the simple health check.
- File watcher behavior includes debounced auto-commit and harness sync.

### Data Location

User data lives in `$SIGNET_WORKSPACE/`, defaulting to
`$HOME/.agents/`:

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

`MEMORY.md` is a generated working summary.

### Pipeline And Runtime Paths

- The daemon pipeline lives in `platform/daemon/src/pipeline/`.
- Connectors send `x-signet-runtime-path: plugin|legacy`.
- A session may use one active runtime path; conflicts should return
  `409`.
- Pipeline stages include extraction, decision, optional knowledge
  graph, retention decay, document ingest, maintenance, and session
  summary.
- Important modes include `shadowMode`, `mutationsFrozen`,
  `graphEnabled`, and `autonomousEnabled`.

For harness duplication or high-token memory reports, inspect the
installed config and confirm only the intended Signet hook/plugin path
is active.

### Ontology Control Plane

- Use audited ontology operations for structured graph changes.
- Pending proposals are for large refactors, risky/destructive changes,
  or explicit review queues.
- Clear single operations should usually apply directly with provenance.
- Claim slots use `group_key` + `claim_key`; version history must remain
  inspectable.
- Raw source artifacts and transcripts must not be rewritten when graph
  or memory rows change.
- `relations` is legacy; new audited links use `entity_dependencies`.

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

- If no remote is configured, push/pull should skip gracefully.
- All git subprocesses that operate on the workspace must set `cwd` to
  `AGENTS_DIR`.
- Sync must not trample unrelated dirty files.

## Package And Build Map

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

## Proof

- Typecheck, build, lint, and tests are not substitutes for runtime
  validation when the failure involves an installed CLI, daemon
  process, desktop shell, connector install, browser extension, or
  generated bundle.
- Validate the real daemon, CLI, package, dashboard, or installed
  runtime when the bug is runtime-specific.
- For dependency-backed behavior, cite files/lines inspected in
  upstream source/types. No API/default/error/timing guesses.
- Pre-land code changes: prove touched surface. Before landing to
  `main`: prove touched surface plus appropriate full/broad proof
  unless scope is clearly narrow.
- If proof is blocked, say exactly what is missing and why. Do not land
  related failing format/lint/type/build/tests.
- Visual proof: use a real runtime path; screenshot when the change is
  user-visible. No harness/bypass/shortcut unless explicitly asked.
- Skip findings for repo policy preference when changed code follows
  the relevant scoped guide and no user-visible, runtime, security, or
  maintainer-risk impact is shown.

## Git / PR / Commit

- Branch: `<username>/<feature>` off `main`. One PR = one issue/topic.
- Conventional commits: `type(scope): subject`. `feat:` is
  user-facing features only; use `fix:`, `refactor:`, `chore:`,
  `perf:`, `test:`, `docs:`, `build:`, or `ci:` for internal changes.
- `main`: no merge commits; rebase on latest `origin/main` before push.
- GitHub issues/comments/PR comments: use literal multiline strings or
  `-F - <<'EOF'` for real newlines; never embed `"\n"`.
- Preserve unrelated work. The checkout may be dirty; never reset,
  checkout, or delete user changes unless explicitly asked.
- Do not delete/rename unexpected files; ask if blocking, else ignore.
- Bulk PR close/reopen >50: ask with count/scope.

## Code

- TS strict. Avoid `any`; prefer real types, `unknown`, narrow adapters.
- No `@ts-nocheck`. Lint suppressions only intentional + explained.
- External boundaries: prefer `zod` or existing schema helpers.
- Runtime branching: discriminated unions/closed codes over freeform
  strings. Avoid semantic sentinels (`?? 0`, empty object/string).
- Cross-function state: when valid combos matter, return a closed
  mode/result shape. Avoid parallel nullable fields or derived booleans
  that callers must keep in sync; make impossible states unrepresentable.
- Prefer early returns over nested condition pyramids. Split code into
  gather -> normalize -> decide -> act.
- Use named intermediates only for domain meaning or readability; avoid
  temp-variable soup.
- Code size matters. Prefer small clear code; maintainability includes
  not growing LOC without payoff.
- Refactors should reduce non-test LOC unless they remove a larger
  architectural cost. Before closeout, run `git diff --numstat`; if
  non-test LOC grew, trim or explicitly justify why fewer paths now
  exist.
- Prefer deleting branches, modes, adapters, and tests over preserving
  them. A refactor that adds a second path has probably failed unless
  the old path is a cited shipped contract.
- New helpers/files must pay rent immediately: fewer call paths, fewer
  concepts, or less repeated logic. No helpers for one-off compat,
  naming translation, or speculative resilience.
- Keep APIs narrow: export only current caller needs; keep types/helpers
  local by default.
- Tests prove behavior/regressions, not every internal branch.
- Split files around ~700 LOC when clarity/testability improves.
- Naming: **Signet** product/docs; `signet` CLI/package/path/config.
- English: American spelling.

Full style examples: `CONTRIBUTING.md`.

## Environment Variables

```text
SIGNET_PATH      workspace data dir override
SIGNET_PORT      daemon port override
SIGNET_HOST      daemon client address override
SIGNET_BIND      daemon bind address override
SIGNET_BYPASS    set to 1 to bypass hooks
OPENAI_API_KEY   used when embedding provider is OpenAI
```

## Reference Docs

- `AI_POLICY.md` — disclosure and acceptable-use rules for AI-assisted
  contributions.
- `CONTRIBUTING.md` — setup, style, area guidance, PR conventions.
- `docs/ARCHITECTURE.md` — system architecture and module boundaries.
- `docs/API.md` — daemon HTTP API reference (route → method → body).
- `docs/AUTH.md` — auth, tokens, role names, rate limiting.
- `docs/DASHBOARD.md` — dashboard architecture and conventions.
- `docs/HOOKS.md` — connector / hook / harness plugin contract.
- `docs/PIPELINE.md` — daemon pipeline stages, modes, runtime paths.
- `docs/SOURCES.md` — external source lifecycle (connect, index,
  disconnect, purge).
- `docs/knowledge-graph-control-plane.md` — ontology operations,
  proposals, apply pipeline.
- `docs/specs/INDEX.md` — per-feature spec index.
- `docs/research/` — research notes and prior experiments.
