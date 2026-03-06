# Documentation Audit - 2026-03-06

This audit compares the current documentation set against the codebase
as it exists on 2026-03-06. The goal is to identify factual drift,
contradictory sources of truth, and the documentation structure issues
that caused that drift.

Code and manifests were treated as canonical, especially:

- `package.json` and workspace package manifests
- `packages/daemon/src/daemon.ts`
- `packages/core/src/identity.ts`
- connector implementations under `packages/connector-*`
- `packages/core/src/migrations/`

## P0 - Contradictory Source-of-Truth Docs

These docs currently disagree with other docs that are meant to describe
the same thing. Fix these first.

| Doc | Current claim | Code-backed reality | Why it matters | Recommended fix |
|---|---|---|---|---|
| `docs/README.md` | Omits Codex, tasks, MCP, native embeddings, telemetry, several current packages, and newer setup options. | Top-level `README.md` was updated to reflect Codex, MCP, tasks, telemetry, 1Password, native embeddings, and the current package set. | New readers can get two incompatible project overviews depending on which README they land on. | Choose one canonical README. Either generate `docs/README.md` from `README.md`, or reduce `docs/README.md` to frontmatter plus a short pointer/include strategy. |
| `docs/AGENTS.md` | Preserves an older contributor snapshot: older build graph, older package inventory, older migration range, no Codex/native/tray/plugin coverage. | Top-level `AGENTS.md` now reflects the current build graph and current package inventory. | Contributors and agents can follow obsolete repo guidance depending on entry point. | Stop manually maintaining two divergent AGENTS docs. Make one canonical and derive the other. |
| `docs/VISION.md` | Not identical to top-level `VISION.md`; wording and several paragraphs differ. | `VISION.md` is explicitly called out as the document contributors should read at session start. | The repo advertises a single vision anchor, but there are two materially different copies. | Make top-level `VISION.md` canonical and mirror it mechanically into docs, or replace the docs copy with a pointer. |

## P1 - False Behavior Claims

These statements are currently wrong when compared to code.

| Doc | Current claim | Code-backed reality | Why it matters | Recommended fix |
|---|---|---|---|---|
| `docs/ARCHITECTURE.md` | "There is no telemetry." | Telemetry endpoints exist at `/api/telemetry/events`, `/api/telemetry/stats`, and `/api/telemetry/export`, and telemetry storage/collector code exists in `packages/daemon/src/telemetry.ts` and `packages/daemon/src/daemon.ts`. | This is a direct contradiction of implemented behavior and other docs. | Rewrite telemetry sections to describe telemetry as optional/local and disabled unless configured. |
| `docs/CONFIGURATION.md` | OpenCode uses `memory.mjs` in `~/.config/opencode/`. | The connector writes a bundled `signet.mjs` into `~/.config/opencode/plugins/` and migrates away from legacy `memory.mjs`. | Users following config docs will configure the old integration model. | Update OpenCode integration text to describe plugin bundle install and legacy migration. |
| `docs/HOOKS.md` | OpenCode uses a fetch-based `memory.mjs` plugin example. | The current connector installs a bundled plugin and registers it in config; `memory.mjs` is legacy. | Hook docs currently teach a stale integration path. | Replace with bundled-plugin architecture and clearly mark `memory.mjs` as legacy only. |
| `docs/CLI.md` | Setup only supports extraction provider values `claude-code`, `ollama`, `none`; harness list includes planned platforms as wizard choices; OpenCode config output is `memory.mjs`. | CLI supports Codex in harness selection and extraction provider choices; embedding provider now includes `native`; OpenCode output is `plugins/signet.mjs`. | Setup docs no longer match the interactive CLI. | Refresh setup flags, wizard steps, and generated-files section from current CLI code. |
| `docs/QUICKSTART.md` | OpenCode creates `~/.config/opencode/memory.mjs`; connectors list omits Codex. | OpenCode now uses bundled `signet.mjs`; Codex is supported as a harness/connector. | New users will miss a supported harness and follow stale file paths. | Update quickstart outputs and connector overview. |
| `docs/DAEMON.md` | "83+ endpoints across 17 domains." | The daemon now exposes additional domains and surfaces including tasks, telemetry, synthesis status/trigger, 1Password, and MCP. Fixed counts are stale. | Brittle counts age quickly and are already wrong. | Remove exact endpoint/domain counts unless they are generated automatically. |
| `docs/README.md` | "no outbound telemetry"; no tasks; no MCP; no Codex; stale API/domain overview. | Current top-level README reflects optional telemetry, tasks, MCP, and Codex support. | Public overview doc is outdated and conflicts with canonical README. | Replace with synced content or reduce to pointer. |
| `docs/AGENTS.md` | Build graph is `build:core -> build:connector-base -> build:deps -> build:signetai`; migrations stop at `010`; detectExistingSetup covers OpenClaw/Claude/OpenCode only; no MCP in daemon shape. | Root build now includes `build:opencode-plugin` and `build:native`; migrations go through `017`; setup detection includes Codex; daemon serves MCP. | Contributor guidance is materially wrong in multiple places. | Sync from top-level AGENTS or stop duplicating it. |
| `docs/CONTRIBUTING.md` | Package tree omits `connector-codex`, `opencode-plugin`, `native`, `tray`, `extension`, and `predictor`. | These packages exist in the workspace today. | New contributors get an incomplete mental model of the monorepo. | Refresh package tree from workspace manifests. |

## P2 - Incomplete or Lagging Reference

These docs are not necessarily wrong everywhere, but they are missing
important current behavior and should be refreshed after P0/P1.

| Doc | Gap | Why it matters | Recommended fix |
|---|---|---|---|
| `docs/HARNESSES.md` | Mostly current, but now needs to be treated as the source of truth for OpenCode/Codex integration and linked to from other docs instead of being re-explained elsewhere. | Good content is being undermined by stale duplicates in `CLI`, `HOOKS`, `CONFIGURATION`, and `QUICKSTART`. | Consolidate harness-specific details here and trim duplicate setup prose elsewhere. |
| `docs/API.md` | Broadly current, but still contains brittle wording around telemetry and dashboard serving details. | Large reference docs become semi-correct while overview docs drift. | Prefer generated route summaries or fewer hard-coded counts. |
| `docs/DASHBOARD.md` | Still describes the dashboard as "SvelteKit static app". | The dashboard package uses Svelte 5 + Vite build output; "SvelteKit static" is legacy wording carried across docs. | Update architecture wording to match the current package shape or use more stable wording such as "static Svelte dashboard". |
| `docs/README.md` and `docs/AGENTS.md` frontmatter copies | Frontmatter is useful for docs site navigation, but the body content is hand-copied and drifts. | The docs site wants frontmatter; the repo wants canonical top-level docs. | Adopt a sync strategy that preserves frontmatter while importing or generating the body from the canonical file. |
| `docs/WHAT-IS-SIGNET.md` | Still says "No cloud dependency, no telemetry, no vendor lock-in." | Telemetry now exists as an optional feature and should not be described as absent. | Align high-level marketing/explanation docs with "telemetry disabled by default" language. |
| `docs/SCHEDULING.md` | Scheduler docs currently describe Claude Code and OpenCode, but the daemon also allows Codex tasks. | Task docs understate current harness support. | Expand harness support and examples to include Codex. |

## P3 - Structural Problems Causing Drift

These are the documentation-system issues that keep recreating stale docs.

| Problem | Evidence | Impact | Recommended fix |
|---|---|---|---|
| Manual mirrors of canonical docs | `README.md` vs `docs/README.md`, `AGENTS.md` vs `docs/AGENTS.md`, `VISION.md` vs `docs/VISION.md` | Every important doc now has at least two versions, and they already diverged. | Make one version canonical and generate or import the other. |
| Repeated harness implementation details across many docs | OpenCode `memory.mjs` remains in `CLI`, `HOOKS`, `CONFIGURATION`, and `QUICKSTART` even though `HARNESSES.md` already has the newer model. | A single integration change requires too many manual edits. | Keep file paths and install behavior in `HARNESSES.md`; other docs should link there. |
| Brittle counts in prose | Endpoint/domain totals in `docs/DAEMON.md` and `docs/README.md` are already stale. | Docs rot immediately after each new route group lands. | Replace counts with grouped capability descriptions or generate them from route definitions. |
| Contributor docs maintain package inventories by hand | `docs/CONTRIBUTING.md`, `docs/AGENTS.md`, and `README.md` all maintain overlapping package tables. | Package additions require many coordinated doc updates. | Pick one canonical package inventory and link/import it elsewhere. |

## Suggested Remediation Order

1. Eliminate duplicate source-of-truth drift:
   - `docs/README.md`
   - `docs/AGENTS.md`
   - `docs/VISION.md`
2. Fix false behavior claims:
   - `docs/ARCHITECTURE.md`
   - `docs/CLI.md`
   - `docs/CONFIGURATION.md`
   - `docs/HOOKS.md`
   - `docs/QUICKSTART.md`
   - `docs/DAEMON.md`
   - `docs/CONTRIBUTING.md`
3. Refresh lagging reference and explanation docs:
   - `docs/SCHEDULING.md`
   - `docs/DASHBOARD.md`
   - `docs/WHAT-IS-SIGNET.md`
4. Add a docs maintenance rule:
   - no hand-maintained mirrors of top-level docs
   - no fixed endpoint counts in prose
   - no repeated harness file-path details outside canonical harness docs

## Defaults Chosen For This Audit

- Code won over docs whenever they disagreed.
- Top-level `README.md`, `AGENTS.md`, and `VISION.md` were treated as
  the intended canonical documents unless code proved them wrong.
- Planning/spec docs under `docs/specs/` were not treated as current
  product documentation unless they were obviously misleading.
