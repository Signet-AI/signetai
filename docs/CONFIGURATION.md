---
title: "Configuration"
description: "Complete configuration reference for Signet."
order: 2
section: "Getting Started"
---

Configuration Reference
=======================

Complete reference for all Signet configuration options. For initial setup,
see [[quickstart]]. For the [[daemon]] runtime, see [[architecture]].


Configuration Files
-------------------

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


Workspace selection and persistence
-----------------------------------

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


agent.yaml
----------

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

Increase the embedding timeout when local embedding models are slow to
cold-load. For example, Ollama with `mxbai-embed-large` may need `10000` ms
to avoid aborted explicit recall embeddings.

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


Inference
-----------------

Signet's shared inference control plane is configured under the top-level
`inference` key in `agent.yaml`.

If `inference` is omitted, Signet preserves the old behavior by compiling
`memory.pipelineV2.extraction` and `memory.pipelineV2.synthesis` into an
implicit inference profile. That keeps existing agents working without change.

Use `inference` when you want Signet to choose models across harnesses,
accounts, APIs, and local runtimes per turn or per subtask.

Example:

```yaml
inference:
  enabled: true
  defaultPolicy: auto

  accounts:
    claude-dot:
      kind: subscription_session
      providerFamily: anthropic
      label: Dot Claude Connected
      sessionRef: CLAUDE_DOT_SESSION
    openrouter-main:
      kind: api
      providerFamily: openrouter
      credentialRef: OPENROUTER_API_KEY

  targets:
    opus:
      executor: claude-code
      account: claude-dot
      models:
        opus46:
          model: opus-4.6
          reasoning: high
          toolUse: true
          streaming: true
    sonnet:
      executor: openrouter
      account: openrouter-main
      privacy: remote_ok
      endpoint: https://openrouter.ai/api/v1
      models:
        default:
          model: anthropic/claude-sonnet-4-6
          reasoning: medium
          toolUse: true
          streaming: true
          costTier: medium
    local:
      executor: ollama
      endpoint: http://127.0.0.1:11434
      privacy: local_only
      models:
        gemma4:
          model: gemma4
          reasoning: medium
          streaming: true
          costTier: low

  policies:
    auto:
      mode: automatic
      defaultTargets:
        - opus/opus46
        - sonnet/default
        - local/gemma4

  taskClasses:
    casual_chat:
      reasoning: medium
      preferredTargets:
        - sonnet/default
    hard_coding:
      reasoning: high
      toolsRequired: true
      preferredTargets:
        - opus/opus46
    hipaa_sensitive:
      privacy: local_only
      preferredTargets:
        - local/gemma4

  workloads:
    interactive:
      policy: auto
      taskClass: casual_chat
    memoryExtraction:
      policy: auto
      taskClass: casual_chat
    sessionSynthesis:
      policy: auto
      taskClass: casual_chat

  agents:
    rose:
      defaultPolicy: auto
      roster:
        - opus/opus46
        - sonnet/default
        - local/gemma4
      pinnedTargets:
        hard_coding: opus/opus46
```

### inference.accounts

Named account or credential identities used by targets.

| Field | Type | Description |
|-------|------|-------------|
| `kind` | string | `subscription_session` or `api` |
| `providerFamily` | string | Provider family label, for example `anthropic`, `openai`, `openrouter` |
| `label` | string | Human-readable account label |
| `credentialRef` | string | Secret name or env var name for API-backed targets |
| `sessionRef` | string | Session identifier for subscription-backed targets |
| `usageTier` | string | Optional account tier label |

### inference.targets

Executable route targets. A target can be a local runtime, API backend,
subscription-backed CLI session, or gateway.

| Field | Type | Description |
|-------|------|-------------|
| `executor` | string | `acpx`, `claude-code`, `codex`, `opencode`, `anthropic`, `openrouter`, `ollama`, `llama-cpp`, `openai-compatible`, or `command` |
| `kind` | string | Optional explicit target kind. Inferred when omitted |
| `account` | string | Account id from `inference.accounts` |
| `endpoint` | string | Optional base URL override |
| `command` | object | Command executor config with `bin`, optional `args`, `cwd`, and `env` |
| `agent` | string | For `executor: acpx`, the ACPX adapter command to run, for example `codex`, `claude` for Claude Code, or `opencode`. Signet normalizes legacy `claude-code` values to ACPX's `claude` command. |
| `acpxVersion` / `version` | string | Optional ACPX package version. Defaults to Signet's pinned ACPX version |
| `mode` | string | Optional ACPX execution mode. Defaults to one-shot exec |
| `cwd` | string | Optional working directory for harness execution |
| `session` | string | Optional ACPX session identifier when a persistent session is desired |
| `permissions` | string | Optional ACPX permission policy passed through to the harness |
| `hooks` | string | Set to `disabled` for sterile/background execution (`SIGNET_NO_HOOKS=1`) |
| `terminal` | boolean | For ACPX, set `false` to pass `--no-terminal` |
| `allowedTools` | array | Optional ACPX allowed-tool list |
| `format` / `outputFormat` | string | ACPX output format. `quiet` is the default; `json` parses ACPX JSON events and extracts the final response |
| `captureEvents` | boolean | When true, defaults ACPX to JSON output and enables the provider event-capture path |
| `maxCapturedEvents` | number | Maximum number of JSON events delivered to the provider-side event callback; defaults to 200 |
| `timeoutMs` | number | Per-call ACPX subprocess deadline |
| `extraArgs` | array | Additional ACPX CLI args appended after Signet-managed args |
| `privacy` | string | `remote_ok`, `restricted_remote`, or `local_only` |
| `models` | map | Named model entries for this target |

Example ACPX background target (see also `docs/ACP-INTEGRATION.md` for the architecture and current limitations):

```yaml
inference:
  targets:
    background-codex:
      executor: acpx
      agent: codex
      hooks: disabled
      terminal: false
      format: json
      captureEvents: true
      timeoutMs: 120000
      models:
        mini:
          model: gpt-5.4-mini
          reasoning: medium
          toolUse: true
```

Model fields:

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Provider-native model identifier |
| `label` | string | Optional display label |
| `reasoning` | string | `low`, `medium`, or `high` |
| `contextWindow` | number | Maximum prompt tokens the model can accept |
| `toolUse` | boolean | Whether tool use is supported |
| `streaming` | boolean | Whether streaming is supported |
| `multimodal` | boolean | Whether multimodal input is supported |
| `costTier` | string | `low`, `medium`, or `high` |
| `averageLatencyMs` | number | Optional routing latency hint |

### inference.policies

Named routing policies that agents and workloads reference.

| Field | Type | Description |
|-------|------|-------------|
| `mode` | string | `strict`, `automatic`, or `hybrid` |
| `allow` | array | Route refs allowed by the policy |
| `deny` | array | Route refs denied by the policy |
| `defaultTargets` | array | Ordered preferred target refs |
| `taskTargets` | map | Task-class specific preferred target refs |
| `fallbackTargets` | array | Explicit fallback refs |
| `maxLatencyMs` | number | Hard latency ceiling used by routing |
| `costCeiling` | string | Hard cost ceiling used by routing |

### inference.taskClasses

Task-family hints for automatic routing.

| Field | Type | Description |
|-------|------|-------------|
| `reasoning` | string | Required reasoning depth |
| `toolsRequired` | boolean | Require tool use support |
| `streamingPreferred` | boolean | Prefer or require streaming support |
| `multimodalRequired` | boolean | Require multimodal support |
| `privacy` | string | Hard privacy tier, including `local_only` |
| `maxLatencyMs` | number | Task latency budget |
| `costCeiling` | string | Task cost ceiling |
| `expectedInputTokens` | number | Prompt-size hint |
| `expectedOutputTokens` | number | Output-size hint |
| `preferredTargets` | array | Preferred target refs |
| `keywords` | array | Lightweight classifier keywords |

### inference.workloads

Binds Signet-owned workloads to router policies or explicit targets.

Supported workload keys:

- `interactive`
- `memoryExtraction`
- `sessionSynthesis`

Each workload can define:

| Field | Type | Description |
|-------|------|-------------|
| `policy` | string | Named policy id |
| `taskClass` | string | Default task class for this workload |
| `target` | string | Explicit `target/model` pin |

### inference.agents

Per-agent routing overrides.

| Field | Type | Description |
|-------|------|-------------|
| `defaultPolicy` | string | Default policy for that agent |
| `roster` | array | Allowed target refs for that agent |
| `preferredTargets` | map | Task-class target preferences |
| `pinnedTargets` | map | Hard pins, usually managed by `signet route pin` |


Pipeline V2 Config
------------------

The V2 [[pipeline|memory pipeline]] lives at `platform/daemon/src/pipeline/`. It runs
LLM-based fact extraction against incoming conversation text, then decides
whether to write new memories, update existing ones, or skip. Config lives
under `memory.pipelineV2` in `agent.yaml`.

Inference selection for extraction and session synthesis can also be routed
through the top-level `inference.workloads` bindings. When explicit routing is
enabled for `default`, `memoryExtraction`, `sessionSynthesis`, `widgetGeneration`, or `repair`, those workloads use the
shared inference control plane. Legacy extraction and synthesis fields are treated as load-time compatibility input, not separate runtime providers.

The config uses a nested structure with grouped sub-objects. Legacy flat
keys (e.g. `extractionModel`, `workerPollMs`) are still supported for
backward compatibility, but nested keys take precedence when both are
present.

Enable the pipeline:

```yaml
memory:
  pipelineV2:
    enabled: true
    shadowMode: true        # extract without writing — safe first step
    extraction:
      provider: llama-cpp
      model: qwen3:4b
```


### Control flags

These top-level boolean fields gate major pipeline behaviors.

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch. Pipeline does nothing when false. |
| `shadowMode` | `false` | Extract facts but skip writes. Useful for evaluation. |
| `mutationsFrozen` | `false` | Allow reads; block all writes. Overrides `shadowMode`. |
| `semanticContradictionEnabled` | `true` | Enable LLM-based semantic contradiction detection for UPDATE/DELETE proposals. |
| `telemetryEnabled` | `false` | Enable anonymous telemetry reporting. |

The relationship between `shadowMode` and `mutationsFrozen` matters:
`shadowMode` suppresses writes from the normal extraction path only;
`mutationsFrozen` is a harder freeze that blocks all write paths
including repairs and graph updates.


### Extraction (`extraction`)

Controls the LLM-based extraction stage. Supports multiple providers.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `provider` | `"llama-cpp"` | — | `"none"`, `"acpx"`, `"llama-cpp"`, `"ollama"`, `"claude-code"`, `"opencode"`, `"codex"`, `"anthropic"`, `"openrouter"`, `"openai-compatible"`, or `"command"` |
| `fallbackProvider` | `"llama-cpp"` | — | `"llama-cpp"`, `"ollama"`, or `"none"`; legacy extraction configs compile this into an inference fallback target |
| `model` | `"qwen3:4b"` | — | Model name for the configured provider |
| `timeout` | `90000` | 5000-300000 ms | Extraction call timeout |
| `minConfidence` | `0.7` | 0.0-1.0 | Confidence threshold; facts below this are dropped |
| `structuredOutput` | `true` | — | Send JSON schema in the `format` field of LLM requests. Set `false` when the provider rejects structured output (e.g. GitHub Copilot API). The daemon also auto-detects unsupported providers at runtime and disables this transparently. |
| `command` | — | — | Command provider config (`bin`, `args[]`, optional `cwd`, optional `env`) — required when `provider: "command"` |
| `rateLimit.maxCallsPerHour` | `200` when `rateLimit` is set | 0-10000 | Max extraction-provider calls per hour; set `0` to disable rate limiting |
| `rateLimit.burstSize` | `20` when `rateLimit` is set | 1-1000 | Max burst size before throttling begins |
| `rateLimit.waitTimeoutMs` | `5000` when `rateLimit` is set | 0-60000 ms | How long to wait for a token before failing with `RateLimitExceededError` |

For `provider: openai-compatible`, set `endpoint` to the gateway's
OpenAI-compatible `/v1` base URL. Remote endpoints use `OPENAI_API_KEY` by
default when this legacy pipeline config is compiled into inference routing;
explicit top-level `inference.accounts.*.credentialRef` can point at any
stored secret or environment variable.

For safety, the intended extraction setups are:

- local `llama-cpp` with `qwen3:4b` (default)
- `claude-code` on a Haiku model
- `codex` on a gpt-5.4-mini model
- local `ollama` with `nemotron-3-nano:4b` (preferred) or `qwen3:4b` (deprecated — Nemotron's superior reasoning makes Qwen3 the weaker choice going forward; expect degraded extraction quality in future updates)

Set `provider: none` to disable extraction entirely, which is the
recommended default for VPS installs that should not make background LLM
calls.

Remote API extraction can accumulate extreme fees quickly because the
pipeline runs continuously in the background. Use `anthropic`,
`openrouter`, `openai-compatible`, or remote OpenCode routes only when you explicitly want
that billing behavior.

`rateLimit` is opt-in. If the stanza is omitted, Signet preserves the
provider's existing behavior with no throughput throttling. When
configured, it applies only to remote or paid providers
(`acpx`, `claude-code`, `anthropic`, `openrouter`, `openai-compatible`, `codex`, `opencode`).
Ollama and `command` providers are always exempt. If you set `rateLimit`
on an exempt provider, Signet logs a warning and passes calls through
unthrottled.

An empty `rateLimit: {}` block is treated as disabled. Set at least one
sub-field to opt in, or omit the stanza entirely to leave rate limiting
off.

When a rate-limited job fails (the bucket is empty and the wait timeout
expires), it is classified as non-retryable and sent directly to
dead-letter status. Dead-lettered jobs are not retried when the rate-limit
window resets. Choose `maxCallsPerHour` high enough to handle sustained
ingestion bursts, or you will permanently lose extraction for memories
queued during exhaustion. Dead-letter jobs are purged after 30 days by
the retention worker.

When configured via YAML, `burstSize` is clamped to a minimum of `1`.
The lower-level `withRateLimit()` helper is more defensive: passing
`burstSize: 0` or `maxCallsPerHour: 0` disables the wrapper entirely
instead of constructing a limiter that can never acquire a token.

Rate-limiter state is in-memory only. After a daemon restart the full
`burstSize` is available immediately (the token bucket starts full). In
environments with frequent restarts (crash-loops, rolling deployments),
this means the limiter cannot protect against a burst of calls right
after startup. Set `burstSize` conservatively if your daemon restarts
often under load.

When using `ollama`, the model must be available locally. When using
`claude-code`, the Claude Code CLI must be on PATH. `codex` uses the
Codex CLI as the extraction provider. Lower `minConfidence` to capture
more facts at the cost of noise; raise it to write only high-confidence
facts.

`acpx` is available as a setup compatibility value for installations that also
have a top-level `inference:` block. ACPX needs harness/session config, so
legacy `memory.pipelineV2.extraction.provider: acpx` by itself is not compiled
into an implicit `legacy-extraction` target; keep the generated
`inference.targets.*.executor: acpx` block or configure ACPX through top-level
inference routing.

There are two command paths with different contracts. Top-level
`inference.targets.*.executor: command` is a normal inference provider: the
prompt is sent on stdin, exposed as `SIGNET_PROMPT`, and the model response is
read from stdout.

Legacy `memory.pipelineV2.extraction.provider: command` keeps the old
side-effecting extractor contract. The summary worker executes
`memory.pipelineV2.extraction.command`, writes the transcript to a temporary
file, substitutes that path into args/env, and expects the command to write
memories to Signet state directly. Stdout and stderr are ignored except for
process failure.

Available legacy extraction command tokens:

- `$TRANSCRIPT` (alias `$TRANSCRIPT_PATH`) — temp transcript file path
- `$SESSION_KEY` — session key (or empty string)
- `$PROJECT` — project path (or empty string)
- `$AGENT_ID` — agent id for the queued job
- `$SIGNET_PATH` — active Signet workspace path

For safety, user-derived tokens (`$SESSION_KEY`, `$PROJECT`, `$TRANSCRIPT`) are
intended for args/env substitution. Keep `bin` and `cwd` fixed, or use only
trusted `$SIGNET_PATH` / `$AGENT_ID` there.

Example:

```yaml
memory:
  pipelineV2:
    extraction:
      provider: command
      command:
        bin: node
        args:
          - ./scripts/custom-extractor.mjs
          - --transcript
          - $TRANSCRIPT
          - --session
          - $SESSION_KEY
```


### Session synthesis (`synthesis`)

Controls the provider used by the `summary-worker` for session summaries.
This is separate from fact extraction once explicitly configured.

If the `synthesis` block is omitted entirely, Signet falls back to the
resolved extraction provider, model, endpoint, and timeout. When an explicit
top-level `inference:` block exists, workload bindings decide which target
handles synthesis.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Enable background session summary generation |
| `provider` | inherited from extraction when omitted | — | `"none"`, `"llama-cpp"`, `"ollama"`, `"claude-code"`, `"codex"`, `"opencode"`, `"anthropic"`, `"openrouter"`, or `"openai-compatible"` |
| `model` | inherited from extraction when omitted | — | Model name for the configured provider |
| `endpoint` | inherited from extraction when omitted | — | Optional base URL override for Ollama, OpenCode, OpenRouter, or OpenAI-compatible gateways |
| `timeout` | inherited from extraction when omitted | 5000-300000 ms | Summary generation timeout |
| `structuredOutput` | inherited from extraction when omitted | — | Send JSON schema in the `format` field of LLM requests. Set `false` when the synthesis provider rejects structured output (e.g. GitHub Copilot API). Falls back to `extraction.structuredOutput` when omitted. |
| `rateLimit.maxCallsPerHour` | `200` when `rateLimit` is set | 0-10000 | Max synthesis-provider calls per hour; set `0` to disable rate limiting |
| `rateLimit.burstSize` | `20` when `rateLimit` is set | 1-1000 | Max burst size before throttling begins |
| `rateLimit.waitTimeoutMs` | `5000` when `rateLimit` is set | 0-60000 ms | How long to wait for a token before failing with `RateLimitExceededError` |

Set `provider: none` or `enabled: false` to disable background session
summary synthesis entirely.

`synthesis.provider: command` is invalid and rejected during config load.

Widget HTML generation uses a separate provider instance by default, so
widget traffic does not consume the synthesis pipeline's `rateLimit`
bucket.

As with extraction, an empty `rateLimit: {}` block is treated as
disabled. Set at least one sub-field to opt in.

Rate-limited synthesis jobs that fail are sent to dead-letter without
retry. See the extraction `rateLimit` docs above for the full warning.


### Worker (`worker`)

The pipeline processes jobs through a queue with lease-based concurrency
control.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `pollMs` | `2000` | 100-60000 ms | How often the worker polls for pending jobs |
| `maxRetries` | `3` | 1-10 | Max retry attempts before a job goes to dead-letter |
| `leaseTimeoutMs` | `300000` | 10000-600000 ms | Time before an uncompleted job lease expires |
| `maxLoadPerCpu` | `0.8` | 0.1-8.0 | Load-per-CPU threshold above which extraction polling is deferred |
| `overloadBackoffMs` | `30000` | 1000-300000 ms | Delay between poll attempts while host load stays above threshold |

A job that exceeds `maxRetries` moves to dead-letter status and is
eventually purged by the retention worker.
Legacy flat keys `workerMaxLoadPerCpu` and `workerOverloadBackoffMs` are
still accepted for backward compatibility.


### Knowledge Graph (`graph`)

When `graph.enabled: true`, the pipeline builds entity-relationship links
from extracted facts and uses them to boost search relevance.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Enable knowledge graph building and querying |
| `extractionWritesEnabled` | `true` | — | Persist entities and links produced by background extraction. Set `false` to keep graph traversal/read paths enabled without letting the async extractor author graph structure. Graph persistence failures are non-fatal to extraction jobs. |
| `boostWeight` | `0.15` | 0.0-1.0 | Weight applied to graph-neighbor score boost |
| `boostTimeoutMs` | `500` | 50-5000 ms | Timeout for graph lookup during search |


### Structural Analysis (`structural`)

Structural workers classify extracted facts into entity aspects, extract
direct entity dependencies from facts, and synthesize cross-entity
dependency edges from the existing graph.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Enable structural classification and dependency workers |
| `classifyBatchSize` | `8` | 1-20 | Max facts per entity classification call |
| `dependencyBatchSize` | `5` | 1-10 | Max stale entities or dependency jobs per worker tick |
| `pollIntervalMs` | `10000` | 2000-120000 ms | Structural job polling interval |
| `synthesisEnabled` | `true` | — | Enable cross-entity dependency synthesis |
| `synthesisIntervalMs` | `60000` | 10000-600000 ms | Dependency synthesis polling interval |
| `synthesisTopEntities` | `20` | 5-100 | Candidate entities considered per synthesis call |
| `synthesisMaxFacts` | `10` | 3-50 | Facts included for the focal entity |
| `synthesisMaxStallMs` | `1800000` | 0-86400000 ms | Pause dependency synthesis when extraction has made no successful progress for this long; set `0` to disable the circuit breaker |

The aliases `dependencySynthesis.maxStallMs` and
`dependencySynthesis.synthesisMaxStallMs` are accepted for
`structural.synthesisMaxStallMs`.


### Hints (`hints`)

Prospective indexing generates hypothetical future queries at write
time. These "hints" are indexed in FTS5 so memories match by
anticipated cue, not just stored content. For example, a memory about
"switched from PostgreSQL to SQLite" might generate hints like
"database migration", "why SQLite", and "storage engine decision" —
queries the user is likely to ask later.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Enable prospective indexing |
| `max` | `5` | 1-20 | Maximum hints generated per memory |
| `timeout` | `30000` | 5000-120000 ms | Hint generation LLM timeout |
| `maxTokens` | `256` | 32-1024 | Max tokens for hint generation |
| `poll` | `5000` | 1000-60000 ms | Job polling interval |

```yaml
memory:
  pipelineV2:
    hints:
      enabled: true
      max: 5
      timeout: 30000
      maxTokens: 256
      poll: 5000
```


### Traversal (`traversal`)

Graph traversal controls how the knowledge graph is walked during
retrieval. When `primary: true`, graph traversal produces the base
candidate pool and flat search fills gaps. When `primary: false`,
traditional hybrid search runs first with graph boost as
supplementary.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Enable graph traversal |
| `primary` | `true` | — | Use traversal as primary retrieval strategy |
| `maxAspectsPerEntity` | `10` | 1-50 | Max aspects to collect per entity |
| `maxAttributesPerAspect` | `20` | 1-100 | Max attributes per aspect |
| `maxDependencyHops` | `10` | 1-50 | Max hops for dependency walking |
| `minDependencyStrength` | `0.3` | 0.0-1.0 | Minimum edge strength to follow |
| `maxBranching` | `4` | 1-20 | Max branching factor during traversal |
| `maxTraversalPaths` | `50` | 1-500 | Max paths to explore |
| `minConfidence` | `0.5` | 0.0-1.0 | Minimum confidence for results |
| `timeoutMs` | `500` | 50-5000 ms | Traversal timeout |
| `boostWeight` | `0.2` | 0.0-1.0 | Weight for traversal boost in hybrid search |
| `constraintBudgetChars` | `1000` | 100-10000 | Character budget for constraint injection |

```yaml
memory:
  pipelineV2:
    traversal:
      enabled: true
      primary: true
      maxAspectsPerEntity: 10
      maxAttributesPerAspect: 20
      maxDependencyHops: 10
      minDependencyStrength: 0.3
      maxBranching: 4
      maxTraversalPaths: 50
      minConfidence: 0.5
      timeoutMs: 500
      boostWeight: 0.2
      constraintBudgetChars: 1000
```

The `primary` flag determines the retrieval strategy. In primary mode,
entities are extracted from the query, the graph is walked to collect
related memories, and flat hybrid search only runs to fill remaining
slots. In supplementary mode (`primary: false`), the standard hybrid
search runs first and traversal results are blended in using
`boostWeight`. Primary mode is faster for entity-dense queries;
supplementary mode is more conservative and better for freeform text.


### Reranker (`reranker`)

An optional reranking pass that runs after initial retrieval. An
embedding-based reranker is built in (uses cached vectors, no extra
LLM calls). Optionally, reranking can call the active extraction
provider model.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Enable the reranking pass |
| `model` | `""` | — | Model name for the reranker (empty uses embedding-based) |
| `useExtractionModel` | `false` | — | When `true`, use the extraction provider LLM for reranking and emit a synthesized summary card |
| `topN` | `20` | 1-100 | Number of candidates to pass to the reranker |
| `timeoutMs` | `2000` | 100-30000 ms | Timeout for the reranking call |


### Autonomous (`autonomous`)

Controls autonomous maintenance, repair, and mutation behavior.

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Allow autonomous pipeline operations (maintenance, repair). |
| `frozen` | `false` | Block autonomous writes; autonomous reads still allowed. |
| `allowUpdateDelete` | `true` | Permit the pipeline to update or delete existing memories. |
| `maintenanceIntervalMs` | `1800000` | How often maintenance runs (30 min). Range: 60s-24h. |
| `maintenanceMode` | `"execute"` | `"observe"` logs issues; `"execute"` attempts repairs. |

In `"observe"` mode the worker emits structured log events but makes no
changes. When `frozen` is true, the maintenance interval never starts,
though the worker's `tick()` method remains callable for on-demand
inspection.


### Repair budgets (`repair`)

Repair sub-workers limit how aggressively they re-embed, re-queue, or
deduplicate items to avoid overloading providers.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `reembedCooldownMs` | `300000` | 10s-1h | Min time between re-embed batches |
| `reembedHourlyBudget` | `10` | 1-1000 | Max re-embed operations per hour |
| `requeueCooldownMs` | `60000` | 5s-1h | Min time between re-queue batches |
| `requeueHourlyBudget` | `50` | 1-1000 | Max re-queue operations per hour |
| `dedupCooldownMs` | `600000` | 10s-1h | Min time between dedup batches |
| `dedupHourlyBudget` | `3` | 1-100 | Max dedup operations per hour |
| `dedupSemanticThreshold` | `0.92` | 0.0-1.0 | Cosine similarity threshold for semantic dedup |
| `dedupBatchSize` | `100` | 10-1000 | Max candidates evaluated per dedup batch |


### Document ingest (`documents`)

Controls chunking for ingesting large documents into the memory store.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `workerIntervalMs` | `10000` | 1s-300s | Poll interval for pending document jobs |
| `chunkSize` | `2000` | 200-50000 | Target chunk size in characters |
| `chunkOverlap` | `200` | 0-10000 | Overlap between adjacent chunks (chars) |
| `maxContentBytes` | `10485760` | 1 KB-100 MB | Max document size accepted |

Chunk overlap ensures context is not lost at chunk boundaries. A value of
10-15% of `chunkSize` is a reasonable starting point.


### Guardrails (`guardrails`)

Content size limits applied during extraction and recall to prevent
oversized content from degrading pipeline performance.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `maxContentChars` | `500` | 50-100000 | Max characters stored per memory |
| `chunkTargetChars` | `300` | 50-50000 | Target chunk size for content splitting |
| `recallTruncateChars` | `500` | 50-100000 | Max characters returned per memory in recall results |

These limits are enforced at the pipeline level. Content exceeding
`maxContentChars` is truncated before storage. Recall results are
truncated at `recallTruncateChars` to keep session context budgets
predictable.


### Continuity (`continuity`)

Session checkpoint configuration for continuity recovery. Checkpoints
capture periodic snapshots of session state (focus, prompts, memory
activity) to aid recovery after context compaction or session restart.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Master switch for session checkpoints |
| `promptInterval` | `10` | 1-1000 | Prompts between periodic checkpoints |
| `timeIntervalMs` | `900000` | 60s-1h | Time between periodic checkpoints (15 min default) |
| `maxCheckpointsPerSession` | `50` | 1-500 | Per-session checkpoint cap (oldest pruned) |
| `retentionDays` | `7` | 1-90 | Days before old checkpoints are hard-deleted |
| `recoveryBudgetChars` | `2000` | 200-10000 | Max characters for recovery digest |

Checkpoints are triggered by five events: `periodic`, `pre_compaction`,
`session_end`, `agent`, and `explicit`. Secrets are redacted before
storage.


### Sub-agents (`subagents`)

Controls deterministic parent-session context inherited by sub-agent sessions
at `session-start`. This uses stored active transcripts and checkpoints; it
does not make an LLM call.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `inheritContext` | `true` | — | Inject a compact parent context block when parent lineage is available |
| `tailChars` | `3000` | 0-20000 | Max transcript tail characters included from the parent session |

```yaml
memory:
  pipelineV2:
    subagents:
      inheritContext: true
      tailChars: 3000
```

Set `inheritContext: false` to disable automatic inherited context while
leaving the explicit `session_search` MCP/API surface available.


### Telemetry (`telemetry`)

Anonymous usage telemetry. Only active when `telemetryEnabled: true`.
Events are batched and flushed periodically.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `posthogHost` | `""` | — | PostHog instance URL (empty disables) |
| `posthogApiKey` | `""` | — | PostHog project API key |
| `flushIntervalMs` | `60000` | 5s-10min | Time between event flushes |
| `flushBatchSize` | `50` | 1-500 | Max events per flush batch |
| `retentionDays` | `90` | 1-365 | Days before local telemetry data is purged |
| `memorySearchQaEnabled` | `false` | boolean | Capture local-only recall QA rows with query text and result snapshots |

`memorySearchQaEnabled` is separate from anonymous telemetry. It writes a
local review ledger to SQLite and intentionally includes recall query text
and recalled result content, so it is exposed only through analytics-gated
endpoints and is never sent to PostHog.


### Embedding tracker (`embeddingTracker`)

Background polling loop that detects stale or missing embeddings and
refreshes them in small batches. Runs alongside the extraction pipeline.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Master switch |
| `pollMs` | `5000` | 1s-60s | Polling interval between refresh cycles |
| `batchSize` | `8` | 1-20 | Max embeddings refreshed per cycle |

The tracker detects embeddings that are missing, have a stale content
hash, or were produced by a different model than the currently configured
one. It uses `setTimeout` chains for natural backpressure.


Auth Config
-----------

Auth configuration lives under the `auth` key in `agent.yaml`. Signet
uses short-lived signed tokens for dashboard and API access.

```yaml
auth:
  mode: local
  defaultTokenTtlSeconds: 604800    # 7 days
  sessionTokenTtlSeconds: 86400     # 24 hours
  rateLimits:
    forget:
      windowMs: 60000
      max: 30
    modify:
      windowMs: 60000
      max: 60
    inferenceExplain:
      windowMs: 60000
      max: 120
    inferenceExecute:
      windowMs: 60000
      max: 20
    inferenceGateway:
      windowMs: 60000
      max: 30
```

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `"local"` | Auth mode: `"local"`, `"team"`, or `"hybrid"` |
| `defaultTokenTtlSeconds` | `604800` | API token lifetime (7 days) |
| `sessionTokenTtlSeconds` | `86400` | Session token lifetime (24 hours) |

In `"local"` mode the token secret is generated automatically and stored
at `$SIGNET_WORKSPACE/.daemon/auth-secret`. In `"team"` and `"hybrid"` modes,
the daemon validates HMAC-signed bearer tokens with role and scope
claims.


### Rate limits

Rate limits are sliding-window counters that reset on daemon restart.
Each key controls a category of potentially destructive operations.

| Operation | Default window | Default max | Description |
|-----------|---------------|-------------|-------------|
| `forget` | 60 s | 30 | Soft-delete a memory |
| `modify` | 60 s | 60 | Update memory content |
| `batchForget` | 60 s | 5 | Bulk soft-delete |
| `forceDelete` | 60 s | 3 | Hard-delete (bypasses tombstone) |
| `admin` | 60 s | 10 | Admin API operations |
| `inferenceExplain` | 60 s | 120 | Dry-run route decisions |
| `inferenceExecute` | 60 s | 20 | Native routed prompt execution |
| `inferenceGateway` | 60 s | 30 | OpenAI-compatible gateway completions |
| `recallLlm` | 60 s | 60 | LLM-backed recall summarization |

Override any limit under `auth.rateLimits.<operation>`:

```yaml
auth:
  rateLimits:
    forceDelete:
      windowMs: 60000
      max: 1
```


Retention Config
----------------

The retention worker runs on a fixed interval and purges data that has
exceeded its retention window. It is not directly configurable in
`agent.yaml`; the defaults below are compiled in and apply unconditionally
when the pipeline is running.

| Field | Default | Description |
|-------|---------|-------------|
| `intervalMs` | `21600000` | Sweep frequency (6 hours) |
| `tombstoneRetentionMs` | `2592000000` | Soft-deleted memories kept for 30 days before hard purge |
| `historyRetentionMs` | `15552000000` | Memory history events kept for 180 days |
| `completedJobRetentionMs` | `1209600000` | Completed pipeline jobs kept for 14 days |
| `deadJobRetentionMs` | `2592000000` | Dead-letter jobs kept for 30 days |
| `batchLimit` | `500` | Max rows purged per step per sweep (backpressure) |

The retention worker also cleans up graph links and embeddings that
belong to purged tombstones, and orphans entity nodes with no remaining
mentions. The `batchLimit` prevents a single sweep from locking the
database for too long under high load.

Soft-deleted memories remain recoverable via `POST /api/memory/:id/recover`
until their tombstone window expires.


Hooks Config
------------

Controls what Signet injects during [[harnesses|harness]] lifecycle events.
See [[hooks]] for full details.

```yaml
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
    summaryGuidelines: "Focus on technical decisions."
```

`hooks.sessionStart` controls what is injected at the start of a new
harness session:

| Field | Default | Description |
|-------|---------|-------------|
| `recallLimit` | `50` | Number of memories to inject |
| `candidatePoolLimit` | `100` | Number of candidate memories to rank before token budgeting |
| `includeIdentity` | `true` | Include agent name and description |
| `includeRecentContext` | `true` | Include `MEMORY.md` content |
| `recencyBias` | `0.7` | Weight toward recent vs. important memories (0-1) |
| `maxInjectTokens` | `12000` | Maximum session-start injection budget after context assembly |

Predicted context from recent session summaries is scoped to the active
project. If the harness does not provide a project path, Signet skips
predicted-context FTS at session start to avoid global broad-term scans
over large memory stores.

`hooks.preCompaction` controls what is included when the harness triggers
a pre-compaction summary:

| Field | Default | Description |
|-------|---------|-------------|
| `includeRecentMemories` | `true` | Include recent memories in the prompt |
| `memoryLimit` | `5` | How many recent memories to include |
| `summaryGuidelines` | built-in | Custom instructions for session summary |

`hooks.userPromptSubmit` controls per-prompt entity current-view injection:

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable per-prompt entity context injection |
| `recallLimit` | `10` | Legacy field retained for config compatibility; prompt-submit no longer runs generic recall |
| `maxInjectChars` | `500` | Prompt-time entity-context character budget |
| `minScore` | `0.8` | Minimum attribute relevance score required before injecting current-view aspect context |


Environment Variables
---------------------

Environment variables take precedence over `agent.yaml` for runtime
overrides. They are useful in containerized or CI environments where
editing the config file is impractical.

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNET_PATH` | — | Runtime override for agents directory |
| `SIGNET_PORT` | `3850` | Daemon HTTP port |
| `SIGNET_HOST` | `127.0.0.1` | Daemon host for local calls |
| `SIGNET_BIND` | network mode bind | Explicit bind address override (`0.0.0.0`, etc.); defaults to `127.0.0.1` in localhost mode and `0.0.0.0` in tailscale mode |
| `SIGNET_LOG_FILE` | — | Optional explicit daemon log file path |
| `SIGNET_LOG_DIR` | `$SIGNET_WORKSPACE/.daemon/logs` | Optional daemon log directory override |
| `SIGNET_SQLITE_PATH` | — | macOS explicit SQLite dylib override used before Bun opens the database |
| `SIGNET_DAEMON_RUNTIME` | `typescript` | Installed daemon runtime selector. Set to `rust` only for explicit daemon-rs parity testing; route parity alone is not a production cutover. |
| `SIGNET_SESSION_START_TIMEOUT` | `15000` | Session-start daemon wait budget in ms for Signet-managed clients. Generated Claude Code hook config writes this value directly. Generated Codex hook config rounds up to seconds and adds 5 seconds of harness grace |
| `SIGNET_FETCH_TIMEOUT` | `15000` | Legacy fallback for session-start timeout in ms when `SIGNET_SESSION_START_TIMEOUT` is unset |
| `SIGNET_PROMPT_SUBMIT_TIMEOUT` | `5000` | Prompt-submit daemon wait budget in ms; OpenCode uses this value directly, generated Claude Code hook config writes this value + 2000 ms grace, and generated Codex hook config rounds up to seconds and adds 2 seconds of harness grace |
| `SIGNET_TRUSTED_PROVIDER_ENDPOINT_HOSTS` | — | Comma-separated host allowlist for Anthropic endpoint overrides used during credentialed startup preflight (supports entries like `proxy.example.com` and `*.example.com`) |
| `OPENAI_API_KEY` | — | OpenAI key when embedding provider is `openai` |

`SIGNET_PATH` changes where Signet reads and writes all agent data for
that process, including the config file itself. Use this for temporary
overrides in CI or isolated local testing.

On macOS, `SIGNET_SQLITE_PATH` can point at a `libsqlite3.dylib` build
that supports `loadExtension()`. If it is set, Signet treats it as an
authoritative override and refuses fallback if the file is missing. If
it is unset, Signet checks `$SIGNET_WORKSPACE/libsqlite3.dylib`, where
`$SIGNET_WORKSPACE` resolves from `SIGNET_PATH`, then
`~/.config/signet/workspace.json`, then the default `~/.agents`, before
trying standard Homebrew SQLite locations and finally falling back to
Apple's system SQLite.

`SIGNET_DAEMON_RUNTIME=rust` is an explicit test opt-in for installed bundles
that include `runtime/daemon-rs/signet-daemon`. Leave it unset for normal
operation; the TypeScript/Bun daemon remains the default until daemon-rs has
stateful subsystem and rollback proof, not just endpoint-shape parity.

For non-loopback Anthropic endpoint overrides, daemon-rs
only sends provider credentials during startup preflight when the host
is trusted. Official provider hosts are trusted by default. Add trusted
proxy/gateway hosts through `SIGNET_TRUSTED_PROVIDER_ENDPOINT_HOSTS`.


AGENTS.md
---------

The main agent identity file. Synced to all configured harnesses on
change (2-second debounce). Write it in plain markdown — there is no
required structure, but a typical layout looks like this:

```markdown
# Agent Name

Short introduction paragraph.

## Personality

Communication style, tone, and approach.

## Instructions

Specific behaviors, preferences, and task guidance.

## Rules

Hard rules the agent must follow.

## Context

Background about the user and their work.
```

When `AGENTS.md` changes, the daemon writes updated copies to:

- `~/.claude/CLAUDE.md` (if `~/.claude/` exists)
- `~/.config/opencode/AGENTS.md` (if `~/.config/opencode/` exists)

Each copy is prefixed with a generated header identifying the source file
and timestamp, and includes a warning not to edit the copy directly.


SOUL.md
-------

Optional personality file for deeper character definition. Loaded by
harnesses that support separate personality and instruction files.

```markdown
# Soul

## Voice
How the agent speaks and writes.

## Values
What the agent prioritizes.

## Quirks
Unique personality characteristics.
```


MEMORY.md
---------

Auto-generated working memory summary. Updated by the synthesis system.
Do not edit by hand — changes will be overwritten on the next synthesis
run. Loaded at session start when `hooks.sessionStart.includeRecentContext`
is `true`.


Database Schema
---------------

The SQLite database at `memory/memories.db` contains three main tables.

### memories

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Primary key (UUID) |
| `content` | TEXT | Memory content |
| `type` | TEXT | `fact`, `preference`, `decision`, `daily-log`, `episodic`, `procedural`, `semantic`, `system` |
| `source` | TEXT | Source system or harness |
| `importance` | REAL | 0-1 score, decays over time |
| `tags` | TEXT | Comma-separated tags |
| `who` | TEXT | Source harness name |
| `pinned` | INTEGER | 1 if critical/pinned (never decays) |
| `is_deleted` | INTEGER | 1 if soft-deleted (tombstone) |
| `deleted_at` | TEXT | ISO timestamp of soft-delete |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |
| `last_accessed` | TEXT | Last access timestamp |
| `access_count` | INTEGER | Number of times recalled |
| `confidence` | REAL | Extraction confidence (0-1) |
| `version` | INTEGER | Optimistic concurrency version |
| `manual_override` | INTEGER | 1 if user has manually edited |

### embeddings

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Primary key (UUID) |
| `content_hash` | TEXT | SHA-256 hash of embedded text |
| `vector` | BLOB | Float32 array (raw bytes) |
| `dimensions` | INTEGER | Vector size (e.g. 768) |
| `source_type` | TEXT | `memory`, `conversation`, etc. |
| `source_id` | TEXT | Reference to parent memory UUID |
| `chunk_text` | TEXT | The text that was embedded |
| `created_at` | TEXT | ISO timestamp |

### memories_fts

FTS5 virtual table for keyword search over `content`, backed by the
`memories` table and created with the `unicode61` tokenizer. Triggers
keep the index in sync when rows are inserted, deleted, or updated.


Harness-Specific Configuration
-------------------------------

### Claude Code

Location: `~/.claude/`

`settings.json` installs hooks that fire at session lifecycle events:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "python3 $SIGNET_WORKSPACE/memory/scripts/memory.py load --mode session-start",
        "timeout": 3000
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "python3 $SIGNET_WORKSPACE/memory/scripts/memory.py load --mode prompt",
        "timeout": 2000
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "python3 $SIGNET_WORKSPACE/memory/scripts/memory.py save --mode auto",
        "timeout": 10000
      }]
    }]
  }
}
```

### OpenCode

Location: `~/.config/opencode/plugins/`

`signet.mjs` is a bundled OpenCode plugin installed by
`@signet/connector-opencode` that exposes `/remember` and `/recall`
as native tools within the harness.

> **Note:** Legacy `memory.mjs` installations are automatically migrated
> to `~/.config/opencode/plugins/signet.mjs` on reconnect.

### OpenClaw

Location: `$SIGNET_WORKSPACE/hooks/agent-memory/` (hook directory)

Also configures the OpenClaw workspace in `~/.openclaw/openclaw.json`
(and compatible `clawdbot` / `moltbot` config locations):

```json
{
  "agents": {
    "defaults": {
      "workspace": "$SIGNET_WORKSPACE"
    }
  }
}
```

See [HARNESSES.md](./HARNESSES.md) for the full OpenClaw adapter docs.


Git Integration
---------------

If your Signet workspace is a git repository, the daemon auto-commits file changes
with a 5-second debounce after the last detected change. Commit messages
use the format `YYYY-MM-DDTHH-MM-SS_auto_<filename>`. The setup wizard
offers to initialize git on first run and creates a backup commit before
making any changes.

Recommended `.gitignore` for your workspace:

```gitignore
.daemon/
.secrets/
__pycache__/
*.pyc
*.log
```

### Watcher ignore file

Create `$SIGNET_WORKSPACE/.sigignore` to keep local runtime files in the
Signet workspace without triggering daemon watcher work or git auto-commits.
Patterns are matched relative to the workspace root and support common
gitignore-style globs such as `*`, `?`, `**`, directory prefixes, comments
with `#`, and later `!` negation inside the same file.

When no `.sigignore` exists, the daemon creates one with sensible defaults
covering known runtime artifacts (for example Fly harness homes). Example:

```gitignore
# Harness runtimes and sockets
agents/*/.fly-*-home/
*.sock

# Keep a specific socket visible to the watcher
!agents/<agent-name>/keep.sock
```

The `.sigignore` file itself is still watched, and new ignore patterns take
effect without a daemon restart. If you remove a pattern that previously hid a
whole existing directory, restart the daemon to guarantee that subtree is added
back to the watcher. Signet also always ignores its managed source checkout,
memory database files, generated memory artifacts, and per-agent generated
`workspace/AGENTS.md`.
