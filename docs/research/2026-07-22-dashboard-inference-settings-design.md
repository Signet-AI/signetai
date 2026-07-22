# Dashboard Inference Settings — Design Proposal (#947, workstream A follow-on)

**Status:** DRAFT for sign-off. Pending a UX reference from Nicholai; the
visual treatment section is the main thing it will shape. Scope and data model
are locked (see Decisions).

## Decisions locked

- **Scope (C):** full redesign of the inference portion of the settings page.
- **Config layer (1):** the UI edits the **routing registry**
  (`inference.accounts` / `inference.targets` / `inference.workloads`), the
  graph `InferenceRouter` actually consumes. Round-trips existing configs
  losslessly; makes ACPX agents + OAuth first-class.
- **Model picker:** backed by **pi-ai** (`getProviders()` + `getModels(provider)`),
  via a new `GET /api/inference/catalog` route — not our stale static
  `modelPresetsForProvider`. Live, auto-refreshable.
- **Write path unchanged:** dashboard still saves raw `agent.yaml` text via
  `POST /api/config`; `SettingsStore` rebinds from `memory.pipelineV2.*` paths
  to `inference.*` paths. No daemon config-write API changes.

## The three entities the UI manages

The registry is a small graph, not a form. The UI is a resource manager over:

### 1. Accounts (`inference.accounts.<name>`)
Named credential stores. Two auth shapes, picked per provider family:
- **API key** (`kind: api`, `credentialRef: <SECRET_NAME>`) — anthropic,
  openai, openrouter, deepseek, groq, mistral, … The UI shows a secret-picker
  (existing Signet secrets) + a "create new secret" affordance. Never displays
  the key value.
- **OAuth / subscription session** (`kind: subscription_session` /
  `oauth_session`, `sessionRef`) — ChatGPT/Codex, Claude Pro/Max, Copilot,
  Grok. The UI shows a **Login** button that kicks the OAuth flow; status
  (connected / expired) surfaced from the session store.

Fields: `name`, `kind`, `providerFamily` (drives the auth shape + the model
catalog), `label`, optional `usageTier`.

### 2. Targets (`inference.targets.<name>`)
Named execution endpoints — the thing a workload actually calls.
- `executor`: **anthropic | openrouter | ollama | llama-cp | openai-compatible | acpx**
  (the only six that exist post-cutover).
- `account`: ref into accounts (for the API/OAuth executors).
- `endpoint`: custom base URL — the **OpenAI-compatible endpoint** field
  (LM Studio, Ollama, llama.cpp, gateways). Shown for the openai-compat/local
  executors; hidden for cloud.
- `acpx: { agent }`: the **ACPX agent picker** (claude / codex / opencode /
  gemini / …). Shown only when `executor: acpx`.
- `privacy`: local_only / remote_ok (gates whether background work uses it).
- `models.<id>`: per-target model entries — `model`, `reasoning`, `toolUse`,
  `streaming`, `contextWindow`. The model id comes from the pi-ai catalog
  picker.

### 3. Workloads → targets (`inference.workloads.<op>`)
Binds each daemon workload to a target (or policy). Workloads:
`default`, `interactive`, `memoryExtraction`, `sessionSynthesis`,
`widgetGeneration`, `repair`. This is the "which model does extraction use vs
synthesis vs interactive" mapping — the thing the legacy flat
`extraction.provider`/`synthesis.provider` was a degenerate single-target
version of.

## Proposed component breakdown

Replaces the stale `PipelineSection.svelte` provider/model dropdowns with:

```
InferenceSettingsSection (new)
├── AccountManager          — list + add/edit/remove accounts
│   ├── AccountEditor       — fields switch on providerFamily:
│   │     • ApiKeyField     (secret picker)      when kind=api
│   │     • OAuthLoginButton + status            when kind=subscription/oauth
│   └── ProviderFamilyPicker (from pi-ai getProviders)
├── TargetManager           — list + add/edit/remove targets
│   ├── TargetEditor
│   │     • ExecutorPicker  (the 6 executors)
│   │     • AccountRefPicker (filtered to matching providerFamily)
│   │     • EndpointField   (shown for openai-compat/local)
│   │     • AcpxAgentPicker (shown for acpx)
│   │     └── ModelEntries   (pi-ai getModels(provider) picker, per model)
│   └── PrivacyToggle
├── WorkloadBindings        — one row per workload, target dropdown
└── (catalog route on the daemon: GET /api/inference/catalog)
```

`GET /api/inference/catalog` returns:
```json
{ "providers": ["anthropic","openai",...],
  "models": { "anthropic": [{id,name,contextWindow,input,reasoning,cost}, ...], ... },
  "acpxAgents": ["claude","codex","opencode","gemini",...] }
```
Server-side it calls pi-ai `getProviders()` / `getModels(provider)`; the acpx
agent list is the static `acpx --help` subcommand set (or probed).

## What the reference will resolve (open)

1. **Visual treatment.** A table-per-entity? Cards? A wizard for first-run?
   Split-pane master-detail? The data model is fixed; the reference picks the
   layout idiom.
2. **OAuth button mechanics.** Whether the login flow opens an in-dashboard
   modal or redirects. Depends on pi-ai's OAuth callback shape (to confirm
   against the reference).
3. **Whether workload bindings get a "simple default" shortcut.** The pure
   registry (decision 1) means every workload is a row. If the reference
   implies most users only set one target, we may add a non-config-writing
   convenience that points all workloads at one target — UI-only, no config
   duplication.

## Out of scope for this redesign

- The non-inference parts of `PipelineSection` (worker concurrency, continuity,
  reranker toggles, retention) — those stay; only the provider/model/endpoint
  controls move into the new section.
- Editing `inference.policies` / `taskClasses` (advanced routing). Exposed only
  if the reference calls for it; default is `mode: automatic` with workload
  bindings.
- The embeddings settings (`EmbeddingsSection`) — separate, untouched.

## Risk / sequencing

- **Largest risk:** the `SettingsStore` path-binding model assumes a stable
  YAML tree; nested maps keyed by user-chosen names (accounts/targets) need
  add/rename/delete semantics it may not have cleanly today. Verify before
  building the editors.
- **Build order:** catalog route → AccountManager → TargetManager →
  WorkloadBindings. Each is independently testable against the daemon.
- **Existing-config safety:** because the UI edits the registry directly, a
  user with a working `inference.targets` config sees it populated correctly on
  first load (round-trips). The legacy `memory.pipelineV2.*` fields become
  ignored UI — we should hide that section once the registry has any target.
