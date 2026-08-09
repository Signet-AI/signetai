---
title: "Workspace and identity"
description: "Configure the Signet workspace, agent identity, and primary agent.yaml fields."
---

## Configuration Files

All files live in your active Signet workspace.

- Default workspace: `~/.agents/`
- Persisted workspace setting: `~/.config/signet/workspace.json`
- Override for a single process: `SIGNET_PATH=/some/path`

| File | Purpose |
|------|---------|
| `agent.yaml` | Main configuration and manifest |
| `AGENTS.md` | Agent-managed operating rules and instructions (synced to harnesses) |
| `DREAMING.md` | Dreaming/reflection prompt used only for dreaming sessions; not loaded during normal startup |
| `HEARTBEAT.md` | Heartbeat/background-check prompt used only for heartbeat sessions |
| `BOOTSTRAP.md` | Bootstrap/setup prompt used only for first-run/bootstrap sessions |
| `SOUL.md` | Agent-managed personality, tone, values, and temperament |
| `MEMORY.md` | System-managed working memory summary (auto-generated, do not edit manually) |
| `IDENTITY.md` | Agent-managed identity metadata |
| `USER.md` | Agent-managed user profile and relationship context |

The loader checks `agent.yaml`, `AGENT.yaml`, and `config.yaml` in that
order, using the first file it finds. All sections are optional; omitting
a section falls back to the documented defaults.

## Workspace selection and persistence

Use the CLI to inspect or change the default workspace path:

```bash
signet workspace status
signet workspace set ~/.openclaw/workspace
```

`signet workspace set` is idempotent. It safely migrates files, stores the
new default workspace in `~/.config/signet/workspace.json`, and updates
detected OpenClaw-family configs to keep `agents.defaults.workspace` aligned.

Resolution order for the effective workspace is:

1. `--path` CLI option
2. `SIGNET_PATH` environment variable
3. Stored CLI workspace setting (`~/.config/signet/workspace.json`)
4. Default `~/.agents/`

## agent.yaml

The primary configuration file. Created by `signet setup` and editable
via `signet configure` or the dashboard's config editor.

```yaml
version: 1
schema: signet/v1

agent:
  name: "My Agent"
  description: "Personal AI assistant"
  created: "2025-02-17T00:00:00Z"
  updated: "2025-02-17T00:00:00Z"

owner:
  address: "0x..."
  localId: "user123"
  ens: "user.eth"
  name: "User Name"

harnesses:
  - claude-code
  - openclaw
  - opencode

embedding:
  provider: ollama
  model: nomic-embed-text
  dimensions: 768
  base_url: http://localhost:11434
  promptSubmitTimeoutMs: 1000
  # llama.cpp only: truncate inputs to stay below its physical batch limit
  llamaCppMaxInputTokens: 1400
  # USD per million input tokens; local providers default to zero
  costRates:
    openai: 0.02
    openrouter: 0.004

search:
  alpha: 0.7
  top_k: 20
  min_score: 0.3

memory:
  database: memory/memories.db
  session_budget: 2000
  decay_rate: 0.95
  synthesis:
    harness: openclaw
    model: sonnet
    schedule: daily
    max_tokens: 4000
  pipelineV2:
    enabled: true
    shadowMode: false
    extraction:
      provider: llama-cpp
      model: qwen3:4b
    synthesis:
      enabled: true
      provider: ollama
      model: qwen3:4b
    graph:
      enabled: true
    autonomous:
      enabled: true
      maintenanceMode: execute

identity:
  preset: minimal
  startup:
    load:
      - path: AGENTS.md
        role: operating_instructions
        budget: 12000
  special:
    - path: DREAMING.md
      kind: dreaming
      role: dreaming_prompt
      budget: 4000

hooks:
  sessionStart:
    recallLimit: 10
    includeIdentity: true
    includeRecentContext: true
    recencyBias: 0.7
  userPromptSubmit:
    enabled: true
    recallLimit: 10
    maxInjectChars: 500
    minScore: 0.8
  preCompaction:
    includeRecentMemories: true
    memoryLimit: 5

auth:
  mode: local
  defaultTokenTtlSeconds: 604800
  sessionTokenTtlSeconds: 86400
  login:
    password:
      username: admin
      passwordHash: null
    sso:
      enabled: false
    saml:
      enabled: false

trust:
  verification: none
```


### agent

Core agent identity metadata.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Agent display name |
| `description` | string | no | Short description |
| `created` | string | yes | ISO 8601 creation timestamp |
| `updated` | string | yes | ISO 8601 last update timestamp |


### owner

Optional owner identification. Reserved for future cryptographic identity
verification.

| Field | Type | Description |
|-------|------|-------------|
| `address` | string | Cryptographic identity address or external identity ID, reserved for future use |
| `localId` | string | Local user identifier |
| `ens` | string | Optional ENS or human-friendly identity alias |
| `name` | string | Human-readable name |


### harnesses

List of AI platforms to integrate with. Valid values: `claude-code`,
`opencode`, `openclaw`, `codex`, `gemini`, `oh-my-pi`, `pi`, and
`hermes-agent`. Support for `cursor`, `windsurf`, and `chatgpt` is planned.


### embedding

Vector embedding configuration for semantic memory search.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | `"ollama"` | `"ollama"` or `"openai"` |
| `model` | string | `"nomic-embed-text"` | Embedding model name |
| `dimensions` | number | `768` | Output vector dimensions |
| `base_url` | string | `"http://localhost:11434"` | Ollama API base URL |
| `api_key` | string | — | API key or `$secret:NAME` reference |
| `promptSubmitTimeoutMs` | number | `1000` | Explicit recall embedding timeout retained for compatibility, range 1000-300000 ms |
| `warmNative` | boolean | `true` | Kill-switch for the native ONNX embedding path. Set `false` to never warm or route to native — useful on Intel Macs where the native ONNX runtime can wedge (see #1073). Callers fall through to the llama.cpp/ollama fallback chain. Env override: `SIGNET_EMBEDDING_WARM_NATIVE=0`. |
| `costRates` | object | provider defaults | USD per million input tokens by billing provider; local provider defaults are zero. |

Increase the embedding timeout when local embedding models are slow to
cold-load. For example, Ollama with `mxbai-embed-large` may need `10000` ms
to avoid aborted explicit recall embeddings.

Changing the embedding provider, model, dimensions, or base URL starts a
background index migration. Existing semantic recall remains on the active
index until Signet has re-embedded every active memory and source chunk with
the new profile; only then is the new index promoted. Check
`GET /api/embeddings/status` for the active/staging profile and migration
coverage. If the daemon restarts, the incomplete staged build resumes; a
failed build leaves the active index unchanged.

Recommended Ollama models:

| Model | Dimensions | Notes |
|-------|------------|-------|
| `nomic-embed-text` | 768 | Default; good quality/speed balance |
| `all-minilm` | 384 | Faster, smaller vectors |
| `mxbai-embed-large` | 1024 | Better quality, more resource usage |

Recommended OpenAI models:

| Model | Dimensions | Notes |
|-------|------------|-------|
| `text-embedding-3-small` | 1536 | Cost-effective |
| `text-embedding-3-large` | 3072 | Highest quality |

Rather than putting an API key in plain text, store it with
`signet secret put OPENAI_API_KEY` and reference it as:

```yaml
api_key: $secret:OPENAI_API_KEY
```


### search

Hybrid search tuning. Controls the blend between semantic (vector) and
keyword (BM25) retrieval.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `alpha` | number | `0.7` | Vector weight 0-1. Higher = more semantic. |
| `top_k` | number | `20` | Candidate count fetched from each source |
| `min_score` | number | `0.3` | Minimum combined score to return a result |
| `temporal_prior_enabled` | boolean | `true` | Enable the freshness-aware rehearsal boost for explicit recency queries (`current`, `latest`, `recent`, `today`, …). Default-on is deliberate for the #903 fix: the bounded boost only breaks near-ties; set `false` to preserve unshaped ranking. |
| `temporal_prior_weight` | number | `0.15` | Maximum `created_at` recency boost for freshness queries (0-1) |
| `temporal_prior_half_life_days` | number | `14` | Freshness-query recency half-life in days (1-365) |

At `alpha: 0.9` results are heavily semantic, suitable for conceptual
queries. At `alpha: 0.3` results skew toward keyword matching, better for
exact-phrase lookups. The default of `0.7` works well generally.


### memory

Memory system settings.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `database` | string | `"memory/memories.db"` | SQLite path (relative to the active workspace) |
| `session_budget` | number | `2000` | Character limit for session context injection |
| `decay_rate` | number | `0.95` | Daily importance decay factor for non-pinned memories |

Non-pinned memories lose importance over time using the formula:

```
importance(t) = base_importance × decay_rate^days_since_access
```

Accessing a memory resets the decay timer.


### identity

Identity loading is configurable. Presets choose which Markdown files load
into normal startup context and which files are reserved for special sessions.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `preset` | string | `minimal` | One of `minimal`, `hermes`, `openclaw`, or `custom` |
| `startup.load` | array | preset-defined | Ordered files loaded into normal startup/static fallback context |
| `special` | array | preset-defined | Prompt files used only for special sessions, such as dreaming |

Built-in presets:

- `minimal` — startup loads only `AGENTS.md`; `DREAMING.md` is still created
  and available for dreaming sessions, but is not loaded every turn.
- `hermes` — startup loads `SOUL.md` then `AGENTS.md`, matching Hermes'
  current SOUL-primary identity plus project-context convention.
- `openclaw` — rich startup stack: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`,
  `USER.md`, and `MEMORY.md`, with `HEARTBEAT.md`, `DREAMING.md`, and
  `BOOTSTRAP.md` reserved as special-session prompts.
- `custom` — explicit ordered startup list chosen by the user.

Example custom order:

```yaml
identity:
  preset: custom
  startup:
    load:
      - path: USER.md
        role: user_profile
        budget: 6000
      - path: AGENTS.md
        role: operating_instructions
        budget: 12000
  special:
    - path: DREAMING.md
      kind: dreaming
      role: dreaming_prompt
      budget: 4000
```

Special session files are not startup context. `DREAMING.md` is the prompt for
reflection/consolidation runs and costs zero tokens in ordinary sessions.


### memory.synthesis

Configuration for periodic `MEMORY.md` regeneration. The synthesis
process reads all memories and asks a model to write a coherent summary.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `harness` | string | `"openclaw"` | Which harness runs synthesis (`openclaw`, `claude-code`, `codex`, `opencode`) |
| `model` | string | `"sonnet"` | Model identifier |
| `schedule` | string | `"daily"` | `"daily"`, `"weekly"`, or `"on-demand"` |
| `max_tokens` | number | `4000` | Max output tokens |
