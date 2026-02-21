Contributing to Signet
===

This guide is for developers contributing to the `signetai/` monorepo,
the reference implementation of the Signet open standard.

Development Setup
---

```bash
git clone https://github.com/Signet-AI/signetai.git
cd signetai
bun install
bun run build
bun test
```

Before submitting changes, run the full check suite:

```bash
bun run typecheck   # TypeScript strict mode check
bun run lint        # Biome static analysis
bun run format      # Biome auto-format
bun test            # All tests
```

Project Structure
---

This is a Bun workspace monorepo. Packages live under `packages/`:

```
packages/
├── core/                  # @signet/core — types, database, search, identity
├── cli/                   # @signet/cli — setup wizard, TUI, daemon management
├── daemon/                # @signet/daemon — HTTP API, file watcher, pipeline
├── sdk/                   # @signet/sdk — integration SDK for third-party apps
├── connector-base/        # @signet/connector-base — shared connector primitives
├── connector-claude-code/ # @signet/connector-claude-code — Claude Code integration
├── connector-opencode/    # @signet/connector-opencode — OpenCode integration
├── connector-openclaw/    # @signet/connector-openclaw — OpenClaw integration
├── adapters/openclaw/     # @signet/adapter-openclaw — OpenClaw runtime plugin
├── signetai/              # signetai — meta-package bundling CLI + daemon
└── web/                   # @signet/web — marketing site (Cloudflare Worker)
```

Key Modules
---

These are the areas most likely to be touched in non-trivial contributions.
Familiarize yourself with them before diving in.

**`packages/daemon/src/pipeline/`** is the LLM-based memory extraction
pipeline. It runs in stages: extraction (`extraction.ts`, uses Ollama by
default with `qwen3:4b`) → decision (`decision.ts`, write/update/skip) →
optional graph operations → retention decay. The entrypoint is `worker.ts`;
`provider.ts` wires up the stages. Config modes like `shadowMode` and
`mutationsFrozen` are respected here.

**`packages/daemon/src/auth/`** handles ERC-8128 wallet-based auth for the
HTTP API. Key files: `middleware.ts` (Hono middleware), `tokens.ts` (token
lifecycle), `policy.ts` (access rules), `rate-limiter.ts`.

**`packages/daemon/src/connectors/`** is the connector framework used by
the daemon. `registry.ts` manages connector registration; `filesystem.ts`
handles connector-driven file operations.

**`packages/daemon/src/analytics.ts`**, **`timeline.ts`**, and
**`diagnostics.ts`** provide observability. Analytics tracks pipeline
events; timeline records structured agent history; diagnostics exposes
health and repair tooling. Tests live alongside each file.

**`packages/core/src/database.ts`** owns the SQLite schema and migrations.
Any schema change must go through here. The wrapper supports both
`bun:sqlite` (under Bun) and `better-sqlite3` (under Node.js) via runtime
detection.

Development Workflow
---

Make changes, rebuild the affected package, then test:

```bash
# Rebuild a single package
cd packages/daemon && bun run build

# Run a single test file
bun test packages/daemon/src/pipeline/worker.test.ts

# Full rebuild
bun run build
```

For daemon changes specifically:

```bash
cd packages/daemon
bun run dev           # watch mode
bun run start         # run directly without watch
```

The daemon serves its HTTP API on port 3850 by default. You can override
with `SIGNET_PORT`, `SIGNET_HOST`, and `SIGNET_PATH` environment variables.

Conventions
---

**Package manager:** Bun everywhere. Do not use npm or pnpm.

**Linting and formatting:** Biome. Run `bun run lint` and
`bun run format` before committing. CI will enforce this.

**TypeScript:** Strict mode is enforced by convention. Specifically:
no `any` (use `unknown` with narrowing), no `as` casts (fix the types),
no non-null assertions (`!`), explicit return types on all exported
functions, `readonly` where mutation is not intended, `as const` unions
over `enum`.

**Commit messages:** Conventional commits with a 50-character subject
line and 72-character body width. Use imperative mood. Types: `feat`,
`fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore`, `revert`. Scope the subject to the package or area changed,
e.g. `feat(daemon): add rate limiting to auth middleware`.

**File size:** Aim to keep files under ~700 LOC. Split or refactor when
a file grows unwieldy, especially if it improves testability.

**Comments:** Explain why, not what. Self-explanatory code needs no
inline narration; non-obvious logic or workarounds deserve a brief note.

Pull Requests
---

Keep PRs focused. A PR that touches the pipeline, auth, and CLI in
unrelated ways is harder to review and more likely to introduce regressions.
If you are unsure whether an architectural change fits, open an issue first.

Before contributing a connector or adapter, look at how
`connector-claude-code` or `connector-openclaw` are structured. Connectors
are designed to be idempotent — safe to install multiple times. Follow
that pattern.

Be transparent about AI assistance in PRs where applicable.
