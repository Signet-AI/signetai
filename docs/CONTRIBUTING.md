---
title: "Contributing"
description: "How to contribute to Signet."
order: 24
section: "Project"
---

Contributing to Signet
===

This guide is for developers contributing to the `signetai/` monorepo,
the reference implementation of the Signet open standard.

**New to git or GitHub?** Start with [Your First PR](./FIRST-PR.md),
a step-by-step walkthrough of making your first contribution.

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
├── connector-codex/       # @signet/connector-codex — Codex wrapper + session hooks
├── opencode-plugin/       # @signet/opencode-plugin — OpenCode runtime plugin (bundled)
├── adapters/openclaw/     # @signetai/signet-memory-openclaw — OpenClaw runtime adapter
├── native/                # @signet/native — native embedding accelerators (Rust)
├── tray/                  # @signet/tray — Tauri system tray application
├── extension/             # @signet/extension — browser extension (popup, highlight-to-remember)
├── signetai/              # signetai — meta-package bundling CLI + daemon
└── web/                   # @signet/web — marketing site (Cloudflare Pages)
```

> Note: `predictor/` is a Rust sidecar (predictive memory scorer, WIP) at the monorepo root.

Key Modules
---

These are the areas most likely to be touched in non-trivial contributions.
Familiarize yourself with them before diving in.

**`packages/daemon/src/pipeline/`** is the LLM-based [[pipeline|memory extraction
pipeline]]. It runs in stages: extraction (`extraction.ts`, uses Ollama by
default with `qwen3:4b`) → decision (`decision.ts`, write/update/skip) →
optional graph operations → retention decay. The entrypoint is `worker.ts`;
`provider.ts` wires up the stages. Config modes like `shadowMode` and
`mutationsFrozen` are respected here. For live prompt checks against local
Ollama models, see `packages/daemon/src/pipeline/README.md`.

**`packages/daemon/src/auth/`** handles token-based [[auth]] for the
HTTP API. Key files: `middleware.ts` (Hono middleware), `tokens.ts` (token
lifecycle), `policy.ts` (access rules), `rate-limiter.ts`.

**`packages/daemon/src/connectors/`** is the [[connectors|connector framework]] used by
the daemon. `registry.ts` manages connector registration; `filesystem.ts`
handles connector-driven file operations.

**`packages/daemon/src/analytics.ts`**, **`timeline.ts`**, and
**`diagnostics.ts`** provide observability. [[analytics|Analytics]] tracks pipeline
events; timeline records structured agent history; [[diagnostics]] exposes
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

### Naming

Use single word names by default. Multi-word names only when a single
word would be ambiguous. Reduce variable count by inlining values used once.

```ts
// Good
const foo = 1
function journal(dir: string) {}
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

Pull Requests
---

Keep PRs focused. A PR that touches the pipeline, auth, and CLI in
unrelated ways is harder to review and more likely to introduce regressions.
If you are unsure whether an architectural change fits, open an issue first.

Before contributing a connector or adapter, look at how
`connector-claude-code` or `connector-openclaw` are structured. Connectors
are designed to be idempotent — safe to install multiple times. Follow
that pattern.

PRs with UI changes (dashboard, web, extension) must include
screenshots. No screenshots, no merge.

Be transparent about AI assistance in PRs where applicable. See the
[AI Policy](../AI_POLICY.md) for disclosure requirements and expectations.

Conventional Commits and Versioning
---

Commit types drive automated version bumps:

- `feat:` or `feat(scope):` → **minor** version bump (user-facing features only)
- `fix:`, `refactor:`, `chore:`, `perf:`, `docs:`, etc. → **patch** bump
- `BREAKING CHANGE:` in subject or `!` after type (e.g. `feat!:`) → **major** bump

Use `feat:` only for genuinely new user-facing functionality. Internal
improvements, helpers, and plumbing should use `fix:`, `refactor:`,
`chore:`, or `perf:` to avoid unnecessary minor bumps.

Release Workflow
---

Releases are fully automated via GitHub Actions (`.github/workflows/release.yml`).
**Do not publish packages manually.** Push to `main` and CI handles the rest.

### What triggers a release

Every push to `main` triggers the workflow, **unless** the commit message
contains `chore: release` (prevents infinite loops from release commits)
or the push only changes non-code files (markdown, images, etc.).

### Automated steps

1. **Build** — `bun install && bun run build` on all packages
2. **Version bump** — Reads the current version from `packages/signetai/package.json`,
   compares with remote, computes bump level from commit messages, and increments
   accordingly. All `package.json` files (except `packages/cli/dashboard/package.json`)
   are updated to the new version.
3. **Changelog** — `bun scripts/changelog.ts` generates a new entry in `CHANGELOG.md`
   from conventional commit subjects since the last tag.
4. **npm publish** — Publishes `signetai` and `@signetai/signet-memory-openclaw`
   to npm with the `next` tag, then promotes to `latest` (unless it's a major bump).
5. **Commit and tag** — Commits the version bump and changelog as `chore: release <version>`,
   creates a `v<version>` git tag, and pushes both.
6. **GitHub Release** — Creates a GitHub release with the changelog section as notes.

### Published packages

- `signetai` (meta-package bundling CLI + daemon)
- `@signetai/signet-memory-openclaw` (OpenClaw runtime adapter)

### Adding a new package to the publish step

Append an additional `cd ../path && npm publish --tag next --access public`
line to the "Publish to npm" step in `.github/workflows/release.yml`, and
add a corresponding `npm dist-tag add` in the "Promote to latest" step.

Scripts
---

All scripts live in `scripts/` and are written in TypeScript (run via
`bun`) or bash.

| Script | Description |
|--------|-------------|
| `changelog.ts` | Generates a CHANGELOG.md entry from conventional commits since the last git tag. Groups commits by type (`feat`, `fix`, `perf`, `refactor`, `docs`). Also writes a `.bump-level` file used by CI to determine the semver bump. Called automatically during the release workflow. |
| `bump-level.ts` | Exports `computeBumpLevel()` — scans commit subjects for `BREAKING CHANGE:` (→ major), `feat:` (→ minor), or defaults to patch. Used by `changelog.ts`. |
| `version-sync.ts` | Aligns the `version` field in all workspace `package.json` files to match the reference version in `packages/signetai/package.json`. Run manually with `bun run version:sync` or pass `--to <version>` to set an explicit version. |
| `extract-changelog-section.ts` | Extracts a single version's section from CHANGELOG.md. Used by CI to populate GitHub release notes. |
| `check-install-guide.ts` | Validates that the install guide (`web/public/skill.md`), README, and landing page components contain the expected install prompt and don't reference deprecated commands. |
| `post-push-sync.sh` | Watches for the release workflow to complete after a push to `main`, then pulls the resulting release commit locally. Useful for staying in sync after pushing. |

Identity Files
---

Signet recognizes these standard identity files at `$SIGNET_WORKSPACE/`:

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

The `detectExistingSetup()` function in `packages/core/src/identity.ts`
detects existing setups from OpenClaw, Claude Code, and OpenCode.

Reference Repos
---

Use these as implementation references when designing protocol handling,
integrations, and operational safeguards.

- [lossless-claw](https://github.com/Martian-Engineering/lossless-claw) — lossless context handling
- [openclaw](https://github.com/openclaw/openclaw) — agent runtime reference
- [acpx](https://github.com/openclaw/acpx) — agent communication protocol
- [arscontexta](https://github.com/agenticnotetaking/arscontexta) — agentic notetaking
- [ACAN](https://github.com/HongChuanYang/Training-by-LLM-Enhanced-Memory-Retrieval-for-Generative-Agents-via-ACAN) — LLM-enhanced memory retrieval
- [cli](https://github.com/entireio/cli) — CLI patterns
- [codex/cli](https://github.com/openai/codex.git)
- [opencode](https://github.com/anomalyco/opencode.git)

To run any script manually:

```bash
bun scripts/changelog.ts
bun scripts/version-sync.ts --to 1.2.3
bun scripts/extract-changelog-section.ts 0.14.5
bun scripts/check-install-guide.ts
./scripts/post-push-sync.sh
```

Test Discovery
---

Test discovery is configured in `bunfig.toml`:

```toml
[test]
root = "packages"
```

This scopes `bun test` to only discover test files under `packages/`.
The `references/` directory (which contains third-party codebases like
OpenClaw for local development reference) is explicitly excluded to
prevent foreign test files from running.

To run tests for a specific package:

```bash
# Run all tests in a package
bun test packages/daemon/

# Run a single test file
bun test packages/daemon/src/pipeline/worker.test.ts

# Run all tests across all packages
bun test
```
