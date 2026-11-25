Contributing to Signet
===

This guide is for developers contributing to the `signetai/` monorepo,
the reference implementation of the Signet open standard.

**New to git or GitHub?** Start with [Your First PR](https://docs.signetai.sh/first-pr/),
a step-by-step walkthrough of making your first contribution.

This guide is for contributing from source. If you just want to use
Signet as a product, follow [Quickstart](https://docs.signetai.sh/quickstart/) and
install the global `signet` CLI instead of cloning the repo.

Development Setup
---

Contributor workflow, from source:

```bash
git clone https://github.com/Signet-AI/signetai.git
cd signetai
bun install
bun run hooks:install
bun run build
bun test
```

The build needs a Rust toolchain from [rustup](https://rustup.rs). Native
accelerators build with it, and the dashboard's graph layout compiles to
WebAssembly from `surfaces/app`; its build adds the `wasm32-unknown-unknown`
target through rustup when it is missing. CI runs these checks from
`surfaces/app`; run the same commands there before pushing Rust changes:

```bash
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --target wasm32-unknown-unknown -- -D warnings
```

`bun install` also installs the tracked Git hooks for the current worktree through
the `prepare` script. Run `bun run hooks:install` explicitly when re-enabling
them after changing worktrees or Git configuration.

Before submitting changes, run the full check suite:

```bash
bun run typecheck   # Workspace typecheck (includes the daemon backlog tracked in #969)
bun run lint        # Biome static analysis
bun run format      # Biome auto-format
bun run comments:check # Maintained source, test, script, and config comment policy
bun run build       # Production packages and staged runtime artifacts
bun test            # All maintained repository tests (excludes vendored references/)
```

Git hooks
---

The pre-commit hook runs staged Biome validation and the typechecks of the
workspaces affected by the staged files, including their workspace dependencies.
It selects the affected workspaces from staged paths only; unrelated packages
are not checked. Documentation- and asset-only changes skip the TypeScript
checks entirely. The full workspace typecheck remains in CI
(`bun run typecheck`), and shared root files (`package.json`, `tsconfig.json`,
`biome.json`, `bunfig.toml`, `bun.lock`) plus `scripts/` and `tests/` widen the
scoped check back to all workspaces. Packages whose typechecks need built
workspace artifacts build them on demand during the hook. The scoped checks
observe the current working tree rather than reconstructing the staged index,
so unrelated unstaged changes can affect their result. The hook also prints a
documentation reminder when a commit may change user-visible behavior, APIs,
schemas, configuration, or lifecycle. The documentation step is intentionally
advisory; it does not run a separate documentation checker.

```bash
# Reinstall the hooks for this worktree
bun run hooks:install

# Run the pre-commit checks without creating a commit
bun run hooks:pre-commit
```

Common local loops:

```bash
# Full workspace build
bun run build

# Daemon local dev
cd platform/daemon && bun run dev

# Website local dev
cd web/marketing && bun run dev
```

Project Structure
---

This is a Bun workspace monorepo organized by intent:

```
platform/               # engine/runtime: core, daemon, native
surfaces/               # human-facing surfaces: CLI, dashboard, desktop, tray
integrations/           # external harness integrations grouped by tool
libs/                   # reusable developer libraries: SDK, connector-base
plugins/                # Signet-native plugins loaded by Signet
dist/                   # assembled shipping artifacts, including signetai
web/                    # marketing site and Cloudflare workers
memorybench/            # benchmark harness, datasets, reports, and local UI
```

Key packages:

```
platform/core/                         # @signet/core — types, database, search, identity
platform/daemon/                       # @signet/daemon — HTTP API, file watcher, pipeline
surfaces/cli/                          # @signet/cli — setup wizard and daemon management
surfaces/dashboard/                    # signet-dashboard — Svelte dashboard
surfaces/desktop/                      # @signet/desktop — Electron desktop application
libs/sdk/                              # @signet/sdk — integration SDK for third-party apps
libs/connector-base/                   # @signet/connector-base — shared connector primitives
integrations/<tool>/connector/         # install-time harness connectors
integrations/<tool>/plugin/            # plugins loaded by external tools
integrations/openclaw/memory-adapter/  # @signetai/signet-memory-openclaw
plugins/core/secrets/                  # core Signet-native secrets plugin
dist/signetai/                         # signetai — installable distribution package
web/marketing/                         # @signet/web — marketing site (Cloudflare Pages)
web/workers/reviews/                   # Cloudflare Worker for review automation
memorybench/                           # benchmark harness and benchmark UI
```

Key Modules
---

These are the areas most likely to be touched in non-trivial contributions.
Familiarize yourself with them before diving in.

**`platform/daemon/src/pipeline/`** is the LLM-based memory extraction
pipeline. It runs in stages: extraction (`extraction.ts`, shared JSON
recovery/parsing helpers) → decision (`decision.ts`, write/update/skip) →
optional graph operations → retention decay. The entrypoint is `worker.ts`;
`provider.ts` wires up the stages. Config modes like `shadowMode` and
`mutationsFrozen` are respected here. For live prompt checks against local
Ollama models, see `platform/daemon/src/pipeline/README.md`.

**`platform/daemon/src/auth/`** handles token-based auth for the
HTTP API. Key files: `middleware.ts` (Hono middleware), `tokens.ts` (token
lifecycle), `policy.ts` (access rules), `rate-limiter.ts`.

**`platform/daemon/src/connectors/`** is the connector framework used by
the daemon. `registry.ts` manages connector registration; `filesystem.ts`
handles connector-driven file operations.

**`platform/daemon/src/analytics.ts`**, **`timeline.ts`**, and
**`diagnostics.ts`** provide observability. Analytics tracks pipeline
events; timeline records structured agent history; diagnostics exposes
health and repair tooling. Tests live alongside each file.

**`platform/core/src/database.ts`** owns the SQLite schema and migrations.
Any schema change must go through here. The wrapper supports both
`bun:sqlite` (under Bun) and `better-sqlite3` (under Node.js) via runtime
detection.

Development Workflow
---

Make changes, rebuild the affected package, then test:

```bash
# Rebuild a single package
cd platform/daemon && bun run build

# Run a single test file
bun test platform/daemon/src/pipeline/worker.test.ts

# Full rebuild
bun run build
```

For daemon changes specifically:

```bash
cd platform/daemon
bun run dev           # watch mode
bun run start         # run directly without watch
```

The daemon serves its HTTP API on port 3850 by default. You can override
with `SIGNET_PORT`, `SIGNET_HOST`, and `SIGNET_PATH` environment variables.

Conventions
---

**Package manager:** Bun everywhere. Do not use npm or pnpm.

**Linting and formatting:** Biome. Run `bun run lint` and
`bun run format` before committing. The repository baseline is defined by
`biome.json`; mandatory CI enforcement is tracked in #919.

**TypeScript:** `strict` and `noUncheckedIndexedAccess` are the shared baseline
for configs that extend the root `tsconfig.json`. The daemon has a known
typecheck backlog tracked in [#969](https://github.com/Signet-AI/signetai/issues/969)
and remains a visible, non-blocking check until that backlog is cleared. All
other TypeScript changes must preserve the applicable strict configuration.
Specifically:
no `any` (use `unknown` with narrowing), no `as` casts (fix the types),
no non-null assertions (`!`), explicit return types on all exported
functions, `readonly` where mutation is not intended, `as const` unions
over `enum`.

**Legacy synchronous DB access:** `@ts-expect-error LEGACY_SYNC_DB_ACCESS` marks
the remaining synchronous `withReadDb`/`withWriteTx` call sites in the daemon;
CI (`bun scripts/audit-event-loop-contract.ts`) ratchets the count in
`scripts/legacy-sync-db-baseline.json` down only. To convert a site, switch the
call to `withReadDbAsync`/`withWriteTxAsync` (thread an async wrapper up to the
nearest await boundary), delete the marker, and when the count drops, re-run
`bun scripts/legacy-sync-db-baseline.ts` in the same PR.

**Event-loop ledger:** `scripts/event-loop-contract-baseline.json` lists every
synchronous filesystem, process and database call in `platform/daemon/src`,
identified by file, API, statement text and site token. CI
(`bun scripts/audit-event-loop-contract.ts` and
`bun test scripts/audit-event-loop-contract.test.ts`) fails when the source and
the ledger disagree. Line numbers are kept for diagnostics only, so moving code
does not fail the check. When you add, remove or change one of those calls, run
`bun scripts/audit-event-loop-contract.ts --write-baseline`, update the expected
counts in `scripts/audit-event-loop-contract.test.ts` if they changed, and
commit the ledger and `scripts/event-loop-contract-audit.md` with the change.

**Database ownership:** Runtime packages may import SQLite implementations only
from the exact owner modules listed by `bun run audit:database-ownership`.
Type-only SQLite imports remain valid. New runtime owners require an explicit
architecture change rather than a directory-wide exception.

**Architecture ratchet:** `bun run audit:ratchet` compares committed `HEAD` to
its merge-base with `origin/main` (`--base <ref>` selects another base ref).
Per-file counts of raw SQL, swallowed errors, and unchecked request/database
casts may only decrease. Git-detected renames and copies share their source's
count, so a copy cannot duplicate debt. New files start at zero; an existing
destination keeps its own count. There is no generated baseline to update.

Raw SQL has two parts. SQL text is allowed only in the owner files listed in
the script and in numbered core migrations and their registry. Raw owner
requests (`ownerReadAll`, `ownerReadOne`, `ownerRun`, `ownerBatch`, and
`query`/`transaction`/`batch` request kinds) and legacy accessor calls
(`withReadDb`, `withWriteTx`, `LEGACY_SYNC_DB_ACCESS` markers) count in every
file, owner files included. Transport modules are not owners merely because the
worker imports them.

Use core's `attempt` or `attemptAsync` for deliberate expected misses rather
than adding an empty catch. Only those helpers' own catches are exempt.
The audit is syntactic: field-level casts such as `row.id as string` are out
of scope, and `.all`/`.get`/`.run`/`.values` assertions are conservatively
classified as database boundaries. Retired paths are recorded in
`scripts/retired-paths.json`; they cannot reappear or be referenced by tracked
files outside Markdown, `docs/`, and the retirement registry.

**Agent identity:** Harness names describe provenance; they are not fallback
agent IDs. `bun run audit:agent-identity` rejects implicit `hermes-agent`
fallbacks while preserving explicit harness labels and comparisons.

**Commit messages:** Conventional commits with a 50-character subject
line and 72-character body width. Use imperative mood. Types: `feat`,
`fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore`, `revert`. Scope the subject to the package or area changed,
e.g. `feat(daemon): add rate limiting to auth middleware`.

**File size:** Aim to keep files under ~700 LOC. Split or refactor when
a file grows unwieldy, especially if it improves testability.

**Comments:** Maintained source, tests, scripts, and configuration stay
comment-free. Express invariants through names, types, structure, and tests.
Run `bun run comments:write` after rebasing a branch, then verify with
`bun run comments:check`. The deterministic rewrite excludes documentation,
asset trees, generated output, vendored/reference trees, lockfiles, and license
artifacts; it preserves shebangs, legal notices, and compiler, linter, coverage,
bundler, and language-server directives whose comment syntax changes tool
behavior.

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

Issue Triage
---

Use the issue forms under `.github/ISSUE_TEMPLATE/` whenever possible. A useful
issue separates the observed behavior from its explanation and includes enough
evidence for another maintainer to reproduce it on current `main`.

Triage is multidimensional. Apply one label from each relevant axis rather than
using labels as a single bucket:

- Type: `bug`, `enhancement`, `documentation`, or another existing type.
- Priority: `priority: P0` through `priority: P3`, based on user impact and urgency.
- Component: `component: core`, `component: daemon`, `component: cli`,
  `component: dashboard`, `component: desktop`, `component: connector`,
  `component: dreaming`, `component: inference`, or `component: native`.
- Risk: use every applicable `risk:` label for the invariant that could be
  damaged while fixing the issue.
- Blast radius: `blast: contained`, `blast: subsystem`, `blast: broad`, or
  `blast: invariant`.
- Triage state: use one `triage:` label when evidence or a decision is still
  missing.

Priority and risk are separate. A P2 configuration issue can still be a
security-boundary risk; a P1 delivery issue can be narrowly contained. Do not
infer risk from priority.

Before calling an issue a confirmed bug:

1. Search for duplicates and related work.
2. Reproduce on current `main` or record exactly why reproduction is unavailable.
3. Trace the relevant code path and distinguish confirmed behavior from a
   root-cause hypothesis.
4. Check adjacent callers and sibling paths for the same failure class.
5. Record the smallest regression proof the eventual fix must add.

Use `triage: needs-repro`, `triage: needs-decision`, or `triage: blocked` when
that is the honest current state. Automated or batch triage may identify
`triage: implemented-on-main`, `triage: cannot-reproduce`, or
`triage: incoherent`, but those labels require evidence in the issue comment.
Do not close an issue merely because the proposed direction is unpopular or
out of scope; that remains a maintainer decision. Use `duplicate` only after an
overlap audit names the canonical issue and explains what is distinct.

For new capabilities, prefer the smallest correct route: extend an existing
surface, then CLI or skill, connector or plugin, MCP, and only then daemon/core
API. Label telemetry and usage-attribution work with `telemetry` and the
relevant privacy risk; it requires an explicit opt-in and privacy contract
before implementation.

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
[AI Policy](./AI_POLICY.md) for disclosure requirements and expectations.

Conventional Commits and Versioning
---

Commit types guide the version chosen during release preparation:

- `feat:` or `feat(scope):` → **minor** version bump (user-facing features only)
- `fix:`, `refactor:`, `chore:`, `perf:`, `docs:`, etc. → **patch** bump
- `BREAKING CHANGE:` in subject or `!` after type (e.g. `feat!:`) → **major** bump

Use `feat:` only for genuinely new user-facing functionality. Internal
improvements, helpers, and plumbing should use `fix:`, `refactor:`,
`chore:`, or `perf:` to avoid unnecessary minor bumps.

Release Workflow
---

Releases are manual. Merging to `main` never bumps a version, creates a tag, or
publishes a release. **Do not publish packages or push release tags by hand.**

### Versioning

Starting with `1.0.0`, stable releases use SemVer: a major version changes an
incompatible public contract, a minor version adds a feature, and a patch
version fixes behavior or makes compatible maintenance changes. Earlier `0.x`
versions remain in the release history.

The root `package.json` owns the committed release version. A maintainer
prepares one version-and-changelog commit in a PR; automation never commits a
version bump to `main`. Development and check versions exist only in build
workspaces:

- If the committed version `X.Y.Z` has not been tagged, a development build is
  `X.Y.Z-next.N`.
- If `vX.Y.Z` already exists, a development build increments the patch first:
  `X.Y.(Z+1)-next.N`.
- A check build is `X.Y.Z-check.N`.

`N` is the Release workflow run number. Re-running the same run retains that
number. Development builds do not consume stable version numbers.

### Dispatch channels

The **Release** workflow (`.github/workflows/release.yml`) runs only through
`workflow_dispatch` and has one input, `channel`:

| Dispatch channel | Result |
| --- | --- |
| `check` (default) | Build, sign, and smoke-test the candidate; publish no release, git tag, or npm package |
| `next` | Build a development prerelease from `main` and advance npm `next` |
| `stable` | Release the committed plain version from `main` and advance npm `latest` and `next` |

`check` runs from any branch and skips the stable planning checks (changelog
section, npm ordering, existing releases), so a green check proves the builds,
not that a stable plan will pass.

All build jobs use the same planned commit SHA. Next and check jobs stamp the
resolved version, then install dependencies before building. Native platforms,
desktop packaging, macOS signing and notarization, and runtime acceptance checks
are release gates. The reusable Desktop Build workflow also supports a manual
unpublished build of its current ref; tags do not trigger desktop builds. AUR
metadata omits the prerelease hyphen in `pkgver` (for example, `1.0.1next.42`)
because Arch forbids hyphens there; download URLs keep the exact SemVer version.
Desktop auto-update from a development build is untested.

The linux-x64 native job also gates on shipped dependencies. Every bundler that
produces a release artifact records the third-party packages it bundled in
`dist/shipped-packages/`; `bun scripts/sbom.ts generate` turns those records
into the release SBOM and `bun scripts/sbom.ts audit` fails on any high or
critical npm advisory. Fix a failure by updating the package, not by pinning:
root `overrides` are floors such as `^3.1.9`, used only when a parent's range
excludes the fixed version, because an exact pin keeps every later advisory.

### Cut a stable release

1. Start a PR branch from current `main`, with release tags fetched.
2. Run `bun run release:prepare [version]`. Use `1.0.0` explicitly for the
   first release under this policy. An explicit version must be plain `x.y.z`
   and greater than the committed version. With no argument, conventional
   commit subjects since the last stable tag determine major, minor, or patch.
   Prerelease tags never shorten the changelog or bump range.
3. Review the new `CHANGELOG.md` section, workspace versions, Cargo versions,
   and lockfiles. The script runs version sync, changelog generation, and
   `bun install`.
4. Open a PR titled `chore: release <version>`. Merge the deliberate release
   commit after review and normal checks. Do not push a release tag.
5. Dispatch **Release** on `main` with `channel=check`. Inspect its results.
6. Dispatch **Release** on the same candidate with `channel=stable`.
7. Confirm the workflow succeeds, the public GitHub release has all native and
   desktop assets, and npm dist-tags point to the intended versions:

   ```bash
   npm view signetai dist-tags --json
   gh release view v<version>
   ```

To distribute development work instead, dispatch **Release** with
`channel=next`. No preparation commit is needed.

### Publication and resume

Planning validates the stable branch, version, changelog section, remote tag,
existing GitHub release, and current npm `latest`. A version already on npm is
reused only by a run that resumes its own draft for the same commit; otherwise
planning stops and a new version must be prepared. A remote stable tag must
name the exact planned commit. A draft targeting a different commit is rejected
with an instruction to delete it.

Stable and next runs create or reuse a draft release targeting the planned SHA.
No git tag exists at this stage. All native and desktop jobs finish and upload
to the draft first. The publish job then checks every expected native, desktop,
and manifest asset, verifies the merged macOS update manifest, builds and stages
npm packages, and publishes each missing version with the `release-staging`
dist-tag. `release-staging` points at the newest published version; the release
token cannot delete dist-tags.

Only after that does it publish the GitHub release, which creates the tag.
Stable is marked normal/latest; next is marked prerelease/not latest. A
separate `promote` job then advances the channel dist-tags. Stable advances
`latest` and `next`; development advances only `next`. Tags move forward in
SemVer order only: `1.0.1` replaces `1.0.1-next.5`, but `1.0.2` does not
replace `1.1.0-next.3`.

The required publish set is `signetai`, the scoped core and connector-base
packages, all listed harness connectors, and the Codex plugin. The OpenClaw
memory adapter is optional; its absence does not block the release. Native npm
tarballs are GitHub release assets, not separately published registry packages.
Add new required scoped packages to both the publish/staging list and the
rollback package list, with tests.

Last, a stable release calls the **Docker Image** workflow, which builds
`ghcr.io/signet-ai/signet` from the new tag and pushes `vX.Y.Z` and `X.Y.Z`. It
moves the floating `latest`, `X.Y`, and `X` tags only when the version is
GitHub's latest release. Development releases publish no image. If only the
Docker job fails, dispatch **Docker Image** with the released version.

A build or upload failure leaves no new tag and at most a draft release. A
later npm failure can also leave staged npm versions. Re-run the failed jobs to
reuse the run's SHA, version, draft, and already-published npm versions. A
fresh stable dispatch can also resume the same version, but only from the same
commit and only while the release is still a draft. For next, use GitHub's
re-run action to retain the run number; a fresh dispatch has a new prerelease
version. Do not advance `main` and expect it to resume an old draft.

Publication is not a transaction across npm and GitHub. Once a release is
public, planning and the publish job refuse to run for it, so public assets are
never rebuilt or replaced, and a build-job re-run after publication fails.
Finalization treats an API error as success when the release did become public.
If `promote` fails, re-run only that job. If the publish job still fails after
the release is public, or a `promote` re-run cannot succeed, run **Point Stable
at Release** with the version. Concurrent `promote` jobs are serialized. If npm
publishing fails partway, the versions it did publish carry only
`release-staging` until a re-run of `publish` succeeds and `promote` moves the
user-facing tags.

### Roll back stable

**Point Stable at Release** (`.github/workflows/promote-release.yml`) is an
explicit stable-pointer override, not development-to-stable promotion. Supply a
plain `x.y.z` version whose required npm packages already exist and whose GitHub
release is public, not a draft. It points each required package's npm `latest`
at that version, includes the optional adapter only if published, verifies the
tags, and marks the GitHub release latest. It advances npm `next` to the same
version only when `next` is older, so a rollback never moves `next` backward. It
does not rebuild assets or publish packages.

This rolls the stable pointer back. It does not force already-installed newer
clients to downgrade. Verify the selected release and npm `latest` afterward.

### Release integrity and trust

Native self-updates validate each selected asset's size and SHA-256 against
`native-manifest.json` from the same release. The direct installer checks the
asset's SHA-256. These checks detect incomplete, corrupted, or mismatched
downloads; they do not independently authenticate the manifest, which is not
signed. macOS native binaries use Developer ID signing, and official macOS
desktop builds are signed, notarized, and checked with Gatekeeper.

The release workflow, repository release permissions, and HTTPS delivery from
GitHub are the distribution trust boundary.

Scripts
---

All scripts live in `scripts/` and are written in TypeScript (run via
`bun`) or bash.

| Script | Description |
|--------|-------------|
| `changelog.ts` | Generates release sections and rebuilds the changelog from stable tags only. Prerelease tags never truncate a stable range. `--bump-only` writes `.bump-level` for local inspection. |
| `release-prepare.ts` | Chooses a stable version, runs version sync and changelog generation, installs dependencies to update the lockfile, and prints PR and dispatch instructions. |
| `bump-level.ts` | Exports `computeBumpLevel()` — scans commit subjects for `BREAKING CHANGE:` (→ major), `feat:` (→ minor), or defaults to patch. Used by changelog and release preparation. |
| `version-sync.ts` | Aligns the `version` field in versioned Signet runtime/package workspaces to match the reference version in root `package.json`. Web manifests are intentionally excluded. Run manually with `bun run version:sync` or pass `--to <version>` to set an explicit version. |
| `extract-changelog-section.ts` | Extracts a single version's section from CHANGELOG.md. Used by CI to populate GitHub release notes. |
| `check-install-guide.ts` | Validates that the install guide (`web/marketing/public/skill.md`), README, and landing page components contain the expected install prompt and don't reference deprecated commands. |

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
bun run release:prepare 1.0.0
bun scripts/changelog.ts --bump-only
bun scripts/changelog.ts --version 1.2.3
bun scripts/changelog.ts --rebuild
bun scripts/version-sync.ts --to 1.2.3
bun scripts/extract-changelog-section.ts 0.14.5
bun scripts/check-install-guide.ts
```

Test Discovery
---

Test discovery runs through workspace package scripts. Prefer targeted
package tests or `bun run --filter ... test` over bare root `bun test`, since
`references/` contains third-party codebases with their own tests.

To run tests for a specific package:

```bash
# Run all tests in a package
bun test platform/daemon/

# Run a single test file
bun test platform/daemon/src/pipeline/worker.test.ts

# Run all tests across all workspaces
bun run test
```
