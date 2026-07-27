---
title: "Plan-Driven Setup Redesign"
id: setup-redesign-plan
status: draft
section: "CLI"
depends_on:
  - "portable-remote-connectors"
success_criteria:
  - "`signet setup` gathers decisions as grouped sections (identity, harnesses, providers, embeddings, skills, sources, secrets, network, plugins, advanced) ending in a reviewable summary instead of ~18 flat sequential prompts"
  - "A single typed SetupPlan schema is the seam between interactive prompts, `--json`/`--file` headless payloads, and the apply engine; `signet setup --schema` dumps it as JSON"
  - "`signet setup --dry-run` prints the plan and the files it would write without mutating anything"
  - "Non-TTY invocation never blocks on a prompt; incomplete input fails with a structured error"
  - "The wizard can add roster agents via the same code path as `signet agent add`, reconciled into the agents table at daemon boot"
  - "Setup can write a distinct synthesis provider route and a secrets backend selection that the daemon already supports"
scope_boundary: "CLI onboarding UX and headless setup payload only; does not specify Signet Cloud onboarding, dashboard onboarding UI (#948 consumes the same plan shape), an in-CLI identity interview engine, or runtime semantics for new config keys (phase 2)"
---

# Plan-driven `signet setup` redesign

Issue: #967. Status: draft for discussion.

## Idea

Split `signet setup` into three phases with a single seam:

```
gather  ──>  SetupPlan  ──>  validate  ──>  apply
```

- **SetupPlan** — one typed, serializable object capturing every decision
  setup makes. No prompts, no side effects.
- **Gather** — three interchangeable frontends that produce a plan:
  interactive wizard (grouped sections), `--json`/`--file` payload
  (agents, CI, tests), existing flags (mapped into the same shape).
  Later: the dashboard onboarding (#948) POSTs the same shape.
- **Apply** — the existing `runFreshSetup` engine, re-pointed to consume a
  validated plan instead of a hand-assembled `FreshSetupConfig`.

This delivers the issue's UX restructure *and* agent-DX headless operation
(raw JSON payload, `--schema`, `--dry-run`, non-TTY behavior) as the same
refactor, because both need prompts decoupled from the engine.

## SetupPlan shape (sketch)

```typescript
// surfaces/cli/src/features/setup-plan.ts
interface SetupPlan {
  version: 1;
  basePath: string;

  agent: { name: string; description: string };

  // Multi-agent: additional roster agents, provisioned via the SAME code
  // path as `signet agent add` (scaffold agents/<name>/, roster entry,
  // daemon /api/agents registration with offline fallback).
  extraAgents: Array<{
    name: string;
    description?: string;
    identityPreset: "minimal" | "hermes" | "openclaw" | "custom";
    readPolicy: "isolated" | "shared" | "group";
    policyGroup?: string; // required iff readPolicy === "group"
  }>;

  identity: {
    mode: "managed" | "passthrough" | "off";
    preset: "minimal" | "hermes" | "openclaw" | "custom";
    // No interview engine in CLI. Stubs are written; output points to
    // the /onboarding skill for the guided identity interview.
    customStartupFiles?: string[]; // preset === "custom" only
  };

  harnesses: Array<{
    id: HarnessChoice; // claude-code | codex | opencode | forge | openclaw | oh-my-pi | pi | hermes-agent | gemini
    openclaw?: { runtimePath: "plugin" | "legacy"; configureWorkspace: boolean };
  }>;

  pipeline: {
    extraction: { provider: ExtractionProviderChoice; model: string; endpoint?: string };
    synthesis: { mode: "same" } | { mode: "custom"; provider: string; model: string; endpoint?: string };
    dreaming: { enabled: boolean }; // default true
  };

  embedding:
    | { provider: "native" }                       // model/dims fixed
    | { provider: "ollama" | "llama-cpp"; model: string }
    | { provider: "openai"; model: "text-embedding-3-small" | "text-embedding-3-large" }
    | { provider: "none" };

  skills: { selected: string[] }; // builtin skill names; dreaming always included

  secrets: { enabled: boolean; backend: "builtin" | "1password" | "bitwarden" };

  sources: Array<
    | { type: "obsidian"; vaultPath: string }
    | { type: "github" }               // auth deferred to `signet sources`
    | { type: "chatgpt-export"; exportPath: string }
  >;

  network: { mode: "localhost" | "tailscale" };
  plugins: { graphiq: boolean };

  advanced: {
    searchBalance: number;   // 0..1
    searchTopK: number;      // >= 1
    searchMinScore: number;  // 0..1
    sessionBudget: number;   // chars, > 0
    decayRate: number;       // 0..1
  };

  git: { init: boolean };
  openDashboard: boolean;
}
```

Every field is required in the schema; defaults live in one
`defaultSetupPlan(detection)` function. "Required + defaulted" keeps
impossible states unrepresentable instead of nullable-field soup.

## Validation

One validator over the plan (zod — see open question — or the existing
`normalizeChoice`/manual style):

- `endpoint` must be `http(s)://` when provider is `openai-compatible`.
- `policyGroup` required iff `readPolicy === "group"`.
- numeric clamps: `searchBalance/minScore/decayRate ∈ [0,1]`,
  `searchTopK ≥ 1`, `sessionBudget > 0`.
- `skills.selected` ⊆ builtin skill names; `dreaming` always present.
- `customStartupFiles` non-empty iff `preset === "custom"`.
- basePath normalized + no traversal outside HOME unless `--path` explicit.
- clear structured errors (`failSetupValidation` style), one per field.

## Interactive wizard sections (gather frontend #1)

Grouped sections, each a small pure-ish async fn `plan -> plan`:

1. **Landing gate** (fresh only): Create new / Import from GitHub /
   Connect to remote instance. (No Signet Cloud — product doesn't exist.)
   Existing-install detection keeps today's dashboard/reconfigure/import/exit.
2. **Agent identity**: name + description → mode → preset →
   "write stubs now, run `/onboarding` later" note.
   Then loop: "Add another agent?" → name/description/preset/read-policy.
3. **Harness detection**: scan PATH for harness CLIs, multi-select with
   detected ones pre-checked ("We see Claude Code and OpenCode...").
4. **Provider & pipeline**: extraction provider+model → synthesis
   (same-as-extraction default) → dreaming confirm (default on).
5. **Embeddings**: native default; ollama/llama-cpp/openai model prompts.
6. **Skills**: checkbox of builtins, all on, dreaming locked on.
7. **Sources**: optional Obsidian path / ChatGPT export path / skip
   (GitHub auth deferred to `signet sources` post-setup).
8. **Secrets**: enable? → backend (builtin / 1Password / Bitwarden —
   daemon already ships `onepassword.ts`/`bitwarden.ts`).
9. **Network**: localhost / tailscale.
10. **Plugins**: GraphIQ confirm.
11. **Advanced**: single confirm → the numeric fields.
12. **Summary**: render the plan (same renderer as `--dry-run`), confirm,
    apply.

Non-interactive mode is unchanged conceptually: flags/payload → plan →
apply, never prompts. New: when stdout is not a TTY and no payload/flags
fully specify the plan, fail with a structured error instead of hanging.

## CLI surface additions

```
signet setup                          # interactive wizard (today's entry)
signet setup --json '<payload>'       # full plan payload, headless
signet setup --file setup.yaml        # same, from file
signet setup --schema                 # dump plan schema as JSON
signet setup --dry-run [--json ...]   # print plan + files-to-write, no mutation
signet setup --output json            # machine-readable result
```

Existing flags keep working (mapped into the plan) for one release,
marked deprecated in favor of `--json`/`--file` in help text.

## File layout

```
surfaces/cli/src/features/
  setup-plan.ts        # SetupPlan types, defaults, validation, schema dump
  setup-plan.test.ts
  setup-wizard/        # interactive gather, one file per section (~small)
    index.ts           # section sequencing
    identity.ts harness.ts pipeline.ts embeddings.ts skills.ts
    sources.ts secrets.ts network.ts plugins.ts advanced.ts summary.ts
  setup.ts             # entry: detection, route to wizard/payload, apply
  setup-fresh.ts       # apply engine (consumes SetupPlan; mostly unchanged)
  setup-migrate.ts     # untouched this phase
```

`setup.ts` shrinks from ~1280 LOC to detection + routing; prompt logic
moves to small section modules. Net non-test LOC should drop.

## What this phase deliberately does NOT do

- No Signet Cloud branch (product doesn't exist).
- No identity interview engine (stubs + `/onboarding` pointer).
- `setup-migrate.ts` (existing-identity path) untouched.

## Phase 2 findings (code-verified)

Implemented (config-driven, runtime-honored):
- **Distinct aggregate-recall provider** — `aggregateRecallProvider/Model/Endpoint`.
  Aggregate recall is query-time evidence synthesis; it is the only per-operation
  override over the extraction provider (the dashboard's main selector reads "memory
  extraction and synthesis" — session synthesis is NOT a separate provider).
  Setup writes a modern `inference.targets.aggregation` target bound to
  `workloads.aggregateRecall`; the daemon merges `inference.*` atop the legacy
  `pipeline.*` base, so extraction/session-synthesis are unaffected
  (`parseRoutingConfig`, `inference-router.ts`, verified). pi-ai-only
  (no harness subprocess — spawn latency would dominate).
- **dreaming toggle** — `dreamingEnabled` → `memory.dreaming.enabled`;
  `loadDreamingConfig` reads it (`DEFAULT_DREAMING.enabled=false`, verified).

Deferred with rationale (NOT setup config keys):
- **secrets.backend** — the active provider is RUNTIME state, not config:
  `setActiveSecretProvider` writes `SIGNET_SECRETS_ACTIVE_PROVIDER` to the
  secrets store; 1Password uses a stored service-account token. There is no
  `agent.yaml` key the daemon reads to select the backend, so it is not a
  SetupPlan field. Backend selection stays a post-setup dashboard/API action.
- **skills.selected** — the `skills` allowlist lives on `AgentDefinition`
  (per roster entry, `agents.ts`), not the flat top-level config. It belongs
  in phase 3 (multi-agent roster), not the single-agent fresh plan.

## Open questions

1. **zod vs hand-rolled validation.** CLI deps are currently minimal
   (inquirer/commander/chalk/ora/open); nothing in core/CLI uses zod.
   AGENTS.md says "prefer zod or existing schema helpers." zod makes
   `--schema` dumping and dashboard reuse much easier; hand-rolled keeps
   the dep tree at zero. Lean: add zod. **Approved (Nicholai): use zod.**

## Resolved (code-verified 2026-06)

2. **Roster reconciliation — no gap.** `syncAgentRoster()` in
   `platform/daemon/src/daemon.ts` (~L1274) runs at daemon boot: reads
   `agents.roster` from agent.yaml and upserts every entry into the
   `agents` SQLite table (`INSERT ... ON CONFLICT(id) DO UPDATE`). Agents
   added during setup while the daemon is down are reconciled on first
   boot. Nothing to build.
3. **Remote-instance path — mostly exists.** The CLI daemon client
   (`createDaemonClient` → `resolveSignetDaemonUrl`,
   `platform/core/src/daemon-url.ts`) already honors `SIGNET_DAEMON_URL`
   (validated/normalized) and `SIGNET_HOST`/`SIGNET_PORT`. `signet
   connector` already takes `--url <url>` to point installed connectors at
   a remote daemon (`surfaces/cli/src/commands/connector.ts` ~L502).
   The one real gap: **persistence** — the remote URL only comes from env
   vars today. The remote setup path needs a small spec: write the remote
   URL into agent.yaml (e.g. `daemon.url`) and teach
   `resolveSignetDaemonUrl` a config fallback, install connectors with
   `--url`, skip local daemon start.
4. **Synthesis provider — runtime already supports it.** Two independent
   mechanisms: (a) `PipelineSynthesisConfig` has its own
   `provider/model/endpoint` separate from extraction
   (`platform/core/src/types.ts` L438); (b) the daemon routes synthesis as
   a distinct workload — `session_synthesis` vs `memory_extraction` —
   through the inference routing layer (`platform/daemon/src/daemon.ts`
   ~L1342-1471), and setup already writes per-workload routes
   (`applySetupInferenceRoute` in `setup-pipeline.ts` handles both
   `workloads.memoryExtraction` and `workloads.sessionSynthesis`). The
   wizard just needs to ask, and write a second route/config block when
   the user picks a distinct synthesis provider.
