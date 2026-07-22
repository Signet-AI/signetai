# Dashboard Inference Settings — Design Proposal (#947, workstream A follow-on)

**Status:** DRAFT v2 for sign-off. Visual treatment now resolved — adopt the
OpenCode desktop settings-v2 pattern (verified in
`~/signet/signetai/references/opencode/packages/app/src/components/settings-v2/`).
Solid/Svelte translation is mechanical; the *structure* is what we're adopting.

## Decisions locked

- **Scope (C):** full redesign of the inference portion of the settings page.
- **Config layer (1):** the UI edits the **routing registry**
  (`inference.accounts` / `inference.targets` / `inference.workloads`), the
  graph `InferenceRouter` consumes.
- **Model picker:** backed by **pi-ai** (`getProviders()` + `getModels(provider)`),
  via a new `GET /api/inference/catalog` route.
- **Write path unchanged:** dashboard saves raw `agent.yaml` via `POST /api/config`;
  `SettingsStore` rebinds from `memory.pipelineV2.*` to `inference.*` paths.
- **Visual treatment (NEW, from OpenCode reference):** a vertical-tab settings
  modal with three peer sections — **Providers**, **Models**, **Endpoints** —
  where each section has exactly one job. This replaces my earlier single-form
  "AccountManager/TargetManager" sketch with a cleaner separation that OpenCode
  has already pressure-tested.

## The OpenCode pattern (what we're adopting)

OpenCode separates three concerns that Signet currently conflates into one
`PipelineSection` dropdown. Verified by reading their source:

### Providers tab = auth/identity
- Two sections: **Connected** (with Disconnect) and **Popular** (with Connect).
- Each provider row: icon, name, a `Tag` for source
  (`env` / `apiKey` / `config` / `custom`).
- **Connect** opens a dialog that handles both API-key entry and OAuth login
  (provider-dependent). **Disconnect** removes the credential.
- A **Custom provider** row at the bottom for OpenAI-compatible gateways.

### Models tab = visibility filter
- One big **searchable list**, grouped by provider, each model a toggle
  (visible/hidden in the picker). Not a create/edit form — a filter over the
  catalog the connected providers expose.
- `useFilteredList` with fuzzy search; groups sorted by "popular" then alpha.

### Servers tab = connection endpoints
- List of HTTP endpoints (URL + auth), each with a **health indicator**,
  version, default badge, and an edit menu.
- Add via a dialog (URL + optional username). This is where custom/local
  OpenAI-compatible endpoints live.

## Mapping onto Signet's routing registry

The OpenCode three-way split maps almost 1:1 onto our registry entities:

| OpenCode concept | Signet registry entity | Notes |
|---|---|---|
| **Providers** (Connect/Disconnect, auth) | `inference.accounts.*` | API key → `kind: api`, `credentialRef`. OAuth → `kind: subscription_session`, `sessionRef`. |
| **Models** (visibility toggle) | derived from pi-ai catalog, filtered by connected accounts | A model "visible" = listed in some target's `models.*`. Toggle adds/removes it from a default target. |
| **Servers** (HTTP endpoints, health) | `inference.targets.*` with `executor: openai-compatible` / `ollama` / `llama-cpp` | Health = our `available()` probe (`/models` reachability, already implemented in pi-provider). |
| (implicit: ACPX agents) | `inference.targets.*` with `executor: acpx` | ACPX targets surface as a fourth concept or a tag on Servers — see open question. |

### The one wrinkle: targets vs OpenCode's "servers"

OpenCode's Servers are purely HTTP endpoints. Our `inference.targets` are richer
— they also carry the workload bindings and the executor kind (incl. ACPX).
Two options for how to present targets:

- **(a)** Keep OpenCode's shape: Servers = HTTP/local endpoints only; ACPX
  targets appear under Providers (since ACPX is "connect a harness") or a
  separate small section. Workload bindings live in an Advanced area.
- **(b)** Generalize "Servers" → "Endpoints" that lists *all* targets (HTTP
  and ACPX), tagged by kind, with workload binding as a per-endpoint field.

I lean **(b)** — it keeps the registry's target concept intact and avoids
splitting ACPX away from its peers. But this is the main thing to confirm.

## Proposed component breakdown (revised)

Replaces `PipelineSection.svelte`'s provider/model controls. Svelte
equivalents of the OpenCode Solid components:

```
InferenceSettingsModal (vertical tabs)
├── ProvidersTab
│   ├── ConnectedList     (account rows: icon, name, auth-kind tag, Disconnect)
│   ├── PopularList       (provider rows from pi-ai getProviders(), Connect button)
│   └── ConnectDialog     (API-key field OR OAuth button, switched by provider)
├── ModelsTab
│   ├── SearchInput       (fuzzy filter)
│   └── ModelList         (grouped by provider, toggle visible/hidden)
├── EndpointsTab          [was "Servers"]
│   ├── EndpointList      (target rows: name, executor tag, health dot, edit menu)
│   └── EndpointDialog    (executor picker → conditional fields:
│                          openai-compat/ollama/llama-cpp: URL + key + model
│                          acpx: agent picker (claude/codex/opencode/…))
└── (daemon) GET /api/inference/catalog  → { providers, models per provider, acpxAgents }
    (daemon) GET /api/inference/health/:target  → reachability for the health dot
```

## What this resolves (vs my v1 draft)

- ✅ **Visual treatment** — adopted from OpenCode (was open #1).
- ✅ **OAuth mechanics** — Connect/Disconnect dialog pattern, provider-switched
  (was open #2). Exact OAuth callback wiring still to confirm against pi-ai,
  but the UI shell is defined.
- ⏳ **Simple-default shortcut** — OpenCode's "Models as visibility toggle"
  *is* the simple mode: casual users connect one provider, toggle a model on,
  done. No separate hybrid needed (was open #3, largely resolved).

## Open question to confirm with you

**Targets presentation (the wrinkle above):** option (a) keep OpenCode's
HTTP-only Servers + ACPX elsewhere, or (b) generalize to "Endpoints" listing
all target kinds? I recommend (b).

## Risk / sequencing

- **SettingsStore:** add/edit of named keys works natively; **delete needs a
  new `aDelete(path)` method** (small, bounded — confirmed against source).
- **Build order:** catalog+health routes → ProvidersTab → ModelsTab →
  EndpointsTab. Each independently testable.
- **Existing-config safety:** a working `inference.accounts/targets` config
  populates the tabs correctly on first load (round-trips). Hide the legacy
  `memory.pipelineV2.*` provider controls once any account/target exists.

## Out of scope

- Non-inference parts of `PipelineSection` (worker concurrency, continuity,
  reranker, retention) — stay.
- `inference.policies` / `taskClasses` advanced routing — default
  `mode: automatic`; expose only if needed later.
- `EmbeddingsSection` — untouched.
