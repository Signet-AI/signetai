# Signet

Signet is a local-first memory and context layer for AI agents. A daemon on the user's machine records what their agents see and do, turns it into memory, and gives it back at the right moment in every harness they use: Claude Code, Codex, OpenCode, OpenClaw, Pi, Hermes, and others. The CLI, dashboard, desktop app, SDK, and harness connectors are clients of that daemon.

## What we never compromise

### 1. Users own their memory

Transcripts, source files, and memories the user wrote are evidence. We record evidence durably before deriving anything from it, and nothing derived ever silently replaces it. Derived state (claims, embeddings, indexes, summaries, `MEMORY.md`) stays attributable, inspectable, correctable, rebuildable from its source, and purged with it; a change that relies on that proves it through the rebuild or purge path. State that cannot be rebuilt is authoritative and needs an explicit owner and lifecycle. Dreaming is the only automatic author of semantic claims. Source ingestion may maintain structural source entities and containment links; indexing, embeddings, retention, and sync only preserve, move, or derive supporting state.

### 2. Memory never leaks across scopes

Every read, write, derivation, deletion, import, export, token operation, and background job runs under a resolved agent and scope that survives every layer. Missing, ambiguous, expired, or unauthorized identity fails closed: it never becomes `default` and never widens to another agent, session, source, or visibility. Harness names are provenance, not agent IDs. Cross-agent access requires explicit authorization. Untrusted input is validated and bounded where it enters; auth, source access, mutation gates, publishing, and install integrity fail closed.

### 3. The daemon stays responsive

A wedged daemon hangs prompts in every harness at once. Daemon database work crosses the async DB owner protocol and never runs synchronous SQLite on the event loop. If the owner is down, the operation fails; nothing runs it somewhere else. The CLI opens the database directly only for work that must run without a daemon (setup, update, migration, restore, repair, offline import and export), and a direct write never races a live daemon. Read-only snapshots (`VACUUM INTO`, the backup API) are safe from any process. Work that grows with the corpus has an owner, an admission limit, bounded batches, a deadline, cancellation, and cleanup, and runs off the event loop. A Promise around synchronous work is still synchronous.

### 4. Status is honest

Partial, stale, degraded, blocked, cancelled, and failed results are reported as what they are. Accepting or dispatching work is not completing it; say which happened, and never report completion before the durable state and cleanup are done. Retries are bounded. A fallback may degrade visibly; it never changes identity, authority, durability, or semantics to produce a success.

## How we work

Fix the cause at the layer that owns it. A guard, retry, or fallback that hides a symptom is not a fix. Every core application transition has one owner and one implementation, in the daemon; clients request it and never reimplement it. Install, bootstrap, and offline maintenance live in the CLI and never duplicate a live transition. Compatibility code translates old input into the canonical call and nothing else. When you move a transition, the old path must stop being able to run.

Prefer the smallest model that makes correct behavior obvious. Delete what your change displaces. Moving, wrapping, or renaming code is not simplification unless it removes an owner, a path, or something callers need to know. Net-negative diffs are welcome, never at the cost of durability or of leaving bad data at rest.

Some existing code predates these rules: default-agent fallbacks in `agent-id.ts`, synchronous accessor calls, harness paths in `platform/core`, config reloads in routes, `lifecycle-proof` emitters in production. That is debt. Do not copy or extend it; the ratchets and ledgers make it shrink.

Existing behavior shows what the code does, not what it should do. Public contracts and deliberate compatibility commitments constrain the implementation. When the task, this file, the docs, and the code disagree, say so rather than quietly picking one. If a rule here fights the task, say so plainly and get a maintainer's sign-off before breaking it. Changing a rule means migrating its callers and durable state, removing the old path, and updating this file in the same change. Nested `AGENTS.md` files add local facts, not competing policy.

## Glossary

- **agent**: a Signet identity that owns memory (`agent_id`). Not the harness, and not a harness's sub-agent.
- **harness**: the tool the user runs agents in, such as Claude Code or Codex. A **connector** installs Signet into one; its plugin or extension talks to the daemon at runtime.
- **workspace**: the directory holding the database, `agent.yaml`, transcripts, and runtime state. Defaults to `~/.agents`.
- **evidence**: transcripts, source artifacts, and user-authored memories.
- **source**: an external corpus indexed in place, such as an Obsidian vault or a harness's own memory files.
- **Dreaming**: background passes that read evidence and write claims, entities, and relationships.
- **recall**: finding memory relevant to a prompt and injecting it as non-evidence context.
- **DB owner**: the worker process that owns the workspace database for the daemon.

## The three ways to hurt yourself

1. **Touching the live workspace.** `~/.agents` is the developer's real memory, held open by their running daemon. Without explicit isolation, a daemon, migration, script, or test can resolve to it through `SIGNET_PATH`, `SIGNET_WORKSPACE`, the configured workspace file, or `HOME`. Set disposable values and verify the resolved path. Reading is fine; for real data, copy it (see Running a daemon).
2. **Rewriting real harness configs.** Connector installs and tests write hooks and MCP entries into `~/.claude`, `~/.codex`, `~/.hermes`, and similar. A source daemon also scans harness transcript and memory directories under `HOME` and harness overrides such as `HERMES_HOME`. Run tests through `bun run test:hermetic`, which supplies a temporary `HOME`, and isolate any daemon you start.
3. **Killing the developer's daemon.** The live daemon listens on port 3850 and is usually running. Never run `signet daemon stop` or `restart`, and never kill by name or port, unless you started that process. Use another port and stop only what you launched.

## Hit every surface

The most common defect is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Harnesses.** Each connector has its own hook timing, payload shape, and install path. Lifecycle and context changes need a decision per harness, even if it is "not supported here". Verify against the harness's real source in `references/`, and any other external package, protocol, or API against its current source or official contract.
- **Clients.** Daemon API, CLI, dashboard, desktop and tray, SDK, and MCP tools. What a user can do, an agent usually should reach through MCP. That only works when the behavior is a daemon operation, not route or command code.
- **Scope.** Default and non-default workspaces, multiple agents, project and session scope, cross-agent paths. Prove the wrong scope is denied, not only that the right one works.
- **Reverse paths.** Every way in needs a way out: connect needs disconnect and purge, derived state needs rebuild and delete, import needs export.
- **Restart and failure.** Daemon and DB owner restart, interrupted upgrades, a hanging provider, an empty or very large corpus.
- **Runtimes.** Bun and Node, the compiled native binary, and Linux, macOS, and Windows paths.
- **Contracts and docs.** Update the owning public contract (`web/docs`, API reference, schemas) when behavior, APIs, configuration, or lifecycle change, and check whether `docs/` became wrong.

## Running a daemon

- Run `bun install` and `bun run build:core`. A source daemon imports every connector's `dist`, so also run `bun run build:workspace-deps` in `surfaces/cli`. Check `git status` first; afterwards restore only the tracked `dist/` files your build changed.
- Launch an isolated daemon from `platform/daemon` with `bun src/daemon.ts` and disposable `HOME`, `SIGNET_PATH`, and `SIGNET_PORT`, plus `SIGNET_HOST=127.0.0.1`, `SIGNET_BIND=127.0.0.1`, and `SIGNET_TELEMETRY_OPTOUT=1`. Unset harness home overrides such as `HERMES_HOME` and `CODEX_HOME`. Start it under `setsid` and record its process group.
- The daemon refuses a workspace without a database. Create one first with `initDbAccessor(<path>)` from `platform/daemon/src/db/owner/accessor.ts` at the path the error names.
- Give a scratch `agent.yaml` the current `configVersion`. Without it, the boot-time legacy migration turns feature toggles back on.
- An empty workspace is a weak test. For real data, `VACUUM INTO` the live database to `<ws>/data/signet.db` and write a fresh `workspace-layout.json` containing `{"version":2}`. A copied layout can carry absolute overrides that escape the sandbox. Never copy `sources.json` or `.secrets`. Copy in; never symlink or write back.
- `/health` reports `pid` and `agentsDir`; check both before trusting a probe. On a busy port the daemon logs a warning and keeps retrying instead of exiting.
- Point the CLI at your daemon with `SIGNET_DAEMON_URL`; `SIGNET_PATH` and `SIGNET_PORT` alone can still route it to the live one.
- Stop it with `kill -TERM -- -<pgid>` so the DB owner child exits too, then confirm both are gone.
- Measure latency and performance on the compiled binary users run.

## Verifying

- While iterating, run `bun run test:hermetic <files>`. `bun run test` builds and runs everything; leave it to CI unless asked.
- Before pushing, run `bun run lint`, `bun run typecheck`, `bun run comments:check`, `bun run check:production-comments --base <base> --head HEAD`, and the audits `audit:database-ownership`, `audit:agent-identity`, and `audit:ratchet`. The ratchet reads committed `HEAD`, so commit first.
- Changing a synchronous filesystem, process, or database call in `platform/daemon/src` needs an event-loop ledger update; editing a root document mirrored into `web/docs` needs `bun scripts/sync-root-docs.ts`. See `CONTRIBUTING.md`.
- A bug fix starts with a test that fails on the old code for the reported reason. Assert external behavior, not call choreography. Extend an existing test before writing a new one, and test at the lowest layer that fails.
- Lifecycle, process ownership, packaging, cancellation, and cleanup need a real daemon run. Probabilistic behavior (recall quality, Dreaming output, prompts) needs a fixed-input eval with measurable criteria.
- Report what behavior changed, which owner implements it, what you deleted, which checks ran, and what remains unproven.

## Pull requests

- Fill in `.github/pull_request_template.md`. UI changes need screenshots.
- Conventional commits, subject at most 50 characters. `feat` is only for user-facing features, because it bumps the minor version.
- Add an `Assisted-by:` trailer to each commit, per `AI_POLICY.md`.
- One request is one PR.

## Documentation

Most code changes need no internal documentation. Agents can read the code.

- Root `docs/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Each entry names its owning code. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the code answers that, leave it out.
- Do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation.
- Do not add code comments; CI rejects them, keeping only the directives and legal notices `scripts/strip-comments.ts` preserves. A reason the code cannot show goes into a name, a type, a test, or a `docs/` entry.
- When a documented decision changes, rewrite or remove the entry. Do not append a second account.
- `web/docs` is user documentation: what a feature does, how to start, and what is unintuitive, in the product's voice. Never hand-edit generated output; rebuild it from its source with its script.
- `CONTRIBUTING.md` holds code conventions, commands, and release procedure.

## Plans and work artifacts

- Do not commit implementation plans, research notes, specs, or scratch files. Active work lives in its GitHub issue; a merged PR is the implementation record.
- When you delete a package, script, or file someone could revive, add a tombstone to `scripts/retired-paths.json`.

## How it works

A harness plugin calls the daemon's hook routes (`/api/hooks/session-start`, `user-prompt-submit`, `stop`, `session-end`, and others) on `127.0.0.1:3850`. The daemon records transcripts and source artifacts as evidence through the DB owner and indexes them for hybrid recall. It answers each prompt with memory context that is never treated as evidence; harnesses that persist hidden context have it filtered out when transcripts are reconstructed. Dreaming passes read evidence and write the ontology, and the daemon projects a `MEMORY.md` head from it. Sources such as Obsidian vaults are indexed in place and purged on disconnect.

Decisions and traps by subsystem live in `docs/`; the API and user-facing behavior in `web/docs`.

## Where code lives

- `platform/core`: shared types, the SQLite adapter (Bun and Node), migrations, search, workspace layout.
- `platform/daemon/src`: one folder per feature (`memory/`, `recall/`, `ontology/`, `dreaming/`, `sources/`, `transcripts/`, `sessions/`, `agents/`, `embeddings/`, `inference/`, ...) plus shared plumbing (`http/` for routes, hooks and MCP; `db/` for the DB owner; `runtime/`; `workers/`). Only the entry points (`daemon.ts`, `dev-daemon.ts`, `index.ts`) sit at the root.
- `platform/native`: Rust accelerators. `surfaces/`: `cli`, `dashboard` (React), `desktop` (Electron), `tray`, `app` (graph layout).
- `integrations/<harness>/`: connectors, plugins, and extensions. New harness-specific paths, config, install, and detection go here.
- `libs/`: `sdk`, `connector-base` (the base every connector extends), `lifecycle-proof`.
- `dist/signetai`: the published package. `web/`: docs site and marketing. `memorybench/`: benchmarks. `scripts/`: build, release, CI audits.
- Tests sit beside their code, following the package's existing `test/` or `__tests__/` convention where it has one. `tests/integration/` is for harnesses that span packages or boot the real daemon.
- `references/` (untracked): source of the harnesses we integrate with. Read it; never import from it.

## Taste

- Transports stay thin. A route, hook handler, CLI command, or MCP tool decodes input, calls one daemon operation, and maps errors.
- New SQL goes in the owner modules listed in `scripts/sql-owners.json` or in numbered core migrations. The ratchet fails any change that raises a file's raw-SQL, swallowed-error, or unchecked-cast count.
- Configuration is normalized once, at its boundary. Do not add fallback readers or reread environment variables downstream. Unsupported retired inputs fail loudly.
- Strict TypeScript: no `any`, no unsafe `as` casts (`as const` is fine), no `!`. Use core's `attempt` or `attemptAsync` for an expected miss instead of an empty `catch`.
- Test-only observers and execution paths stay out of production import graphs.
- Secrets stay out of source, logs, tests, fixtures, generated files, screenshots, and reports.
- Prose says **Signet**; CLI, package, path, and config names say `signet`. Write American English.
