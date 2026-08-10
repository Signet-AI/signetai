---
title: "Pipeline configuration"
description: "Configure extraction, synthesis, graph, search, continuity, and pipeline workers."
---

## Pipeline V2 Config

The V2 [memory pipeline](/pipeline/) lives at `platform/daemon/src/pipeline/`. It runs
LLM-based fact extraction against incoming conversation text, then decides
whether to write new memories, update existing ones, or skip. Config lives
under `memory.pipelineV2` in `agent.yaml`.

Inference selection for extraction is configured through the top-level
`inference.workloads.memoryExtraction` binding. Session processing follows that
route and is not independently configurable. Legacy provider/model/endpoint
fields under `memory.pipelineV2` are retired and rejected by the strict loader.

The config uses a nested structure with grouped sub-objects. Operation tuning
such as timeouts, confidence thresholds, and rate limits remains under
`memory.pipelineV2`; provider selection belongs in `inference`.

Enable the pipeline:

```yaml
memory:
  pipelineV2:
    enabled: true
    shadowMode: true        # extract without writing — safe first step
```


### Control flags

These top-level boolean fields gate major pipeline behaviors.

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch. Pipeline does nothing when false. |
| `shadowMode` | `false` | Extract facts but skip writes. Useful for evaluation. |
| `mutationsFrozen` | `false` | Allow reads; block all writes. Overrides `shadowMode`. |
| `semanticContradictionEnabled` | `true` | Enable LLM-based semantic contradiction detection for UPDATE/DELETE proposals. |
| `telemetryEnabled` | `true` | Enable anonymous telemetry reporting (set `false` to opt out). |

The relationship between `shadowMode` and `mutationsFrozen` matters:
`shadowMode` suppresses writes from the normal extraction path only;
`mutationsFrozen` is a harder freeze that blocks all write paths
including repairs and graph updates.


### Extraction tuning

Provider and model selection are no longer configured under
`memory.pipelineV2.extraction`. Configure the canonical
`inference.workloads.memoryExtraction` binding instead:

```yaml
inference:
  targets:
    background:
      executor: ollama
      models:
        default:
          model: qwen3:4b
  policies:
    background:
      mode: automatic
      defaultTargets: [background/default]
      fallbackTargets: [background/default]
  defaultPolicy: background
  taskClasses:
    memory_extraction:
      reasoning: medium
      toolsRequired: true
      privacy: restricted_remote
  workloads:
    memoryExtraction:
      target: background/default
      taskClass: memory_extraction
```

The remaining `memory.pipelineV2.extraction` fields are operation tuning only:

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `timeout` | `90000` | 5000-300000 ms | Extraction call timeout |
| `minConfidence` | `0.7` | 0.0-1.0 | Confidence threshold; facts below this are dropped |
| `structuredOutput` | `true` | — | Send JSON schema in the `format` field of inference requests |
| `rateLimit.maxCallsPerHour` | `200` when configured | 0-10000 | Max extraction calls per hour; set `0` to disable rate limiting |
| `rateLimit.burstSize` | `20` when configured | 1-1000 | Max burst size before throttling begins |
| `rateLimit.waitTimeoutMs` | `5000` when configured | 0-60000 ms | How long to wait for a rate-limit token |

`provider`, `model`, `endpoint`, `baseUrl`, `fallbackProvider`, and `command`
are retired under this block. The daemon rejects them after migration rather
than silently choosing a fallback. See [upgrading](/upgrading/) for the
reconfiguration path.

`rateLimit` is opt-in and applies only to remote or paid inference targets.
Ollama and local OpenAI-compatible targets are exempt. Rate-limiter state is
in-memory and resets after a daemon restart.

Set `memory.pipelineV2.enabled: false` to disable extraction entirely. Remote
API extraction can accumulate extreme fees quickly because the pipeline runs
continuously in the background.

### MEMORY.md synthesis (`synthesis`)

Session synthesis provider/model/endpoint routing is retired. Session processing
follows the `memoryExtraction` inference workload, while the MEMORY.md worker
uses the daemon's canonical inference route. Do not add a `memory.pipelineV2.synthesis`
block or provider fields under it; those fields are rejected during config load.

The worker's remaining operational settings, when supported by the installed
release, are tuning-only. Completed transcripts are delivered directly to
Dreaming through the content pass.


### Claude Code background environment (`claudeCode`)

Applies whenever legacy pipeline extraction, synthesis, or an explicit
inference route uses the `claude-code` provider.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `allowApiKeyEnv` | `false` | — | When `false`, daemon-spawned `claude -p` calls strip ambient `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`. Set `true` only when background pipeline jobs should inherit those env credentials. Legacy unshipped `billingMode: api-key` is accepted as an alias for `true`; `billingMode: subscription` maps to `false`. |
| `maxBudgetUsd` | unset | 0.01-1000 | Optional per-invocation spend cap passed to Claude Code print mode as `--max-budget-usd`. Omitted by default because Claude Code documents no default limit for this flag and forcing one could change CLI behavior. |
| `cooldownMs` | `300000` | 1000-3600000 ms | Daemon-wide Claude Code circuit cooldown opened after Claude Code reports quota, usage-limit, credit, billing, or auth failures. Calls during cooldown fail before spawning `claude`. Interactive and background `claude-code` providers in the daemon share this circuit and config snapshot. |

```yaml
memory:
  pipelineV2:
    claudeCode:
      allowApiKeyEnv: false
      cooldownMs: 300000
```

Only opt into ambient API-key/token inheritance when you intentionally want
background pipeline jobs to use the Anthropic credentials already present in
the daemon environment:

```yaml
memory:
  pipelineV2:
    claudeCode:
      allowApiKeyEnv: true
      maxBudgetUsd: 0.25
```

Anthropic's Claude Code CLI reference lists `--max-budget-usd` as a
print-mode-only API-call budget flag:
<https://docs.anthropic.com/en/docs/claude-code/cli-reference>. Anthropic's
Claude Code cost docs describe Claude Code charges in terms of API token
consumption and subscription plan pricing separately:
<https://docs.anthropic.com/en/docs/claude-code/costs>. Anthropic support docs
also state that paid Claude subscriptions and Claude Console/API usage are
separate products:
<https://support.anthropic.com/en/articles/9876003-i-subscribe-to-claude-pro-why-do-i-have-to-pay-separately-for-api-usage-on-console>.
Signet does not verify the billing account selected by a persisted
`claude auth login --console` session; it only controls whether the daemon
subprocess inherits ambient Anthropic API key/token environment variables.

### Worker (`worker`)

The pipeline processes jobs through a queue with lease-based concurrency
control.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `maxRetries` | `3` | 1-10 | Max retry attempts before a job goes to dead-letter |
| `leaseTimeoutMs` | `300000` | 10000-600000 ms | Time before an uncompleted job lease expires |
| `maxLlmConcurrency` | `2` | 1-16 | Shared cap for live LLM calls across extraction, synthesis, reranking, inference streaming, and daemon route provider calls such as skills, ontology consolidation, and diagnostics greetings. `SIGNET_MAX_LLM_CONCURRENCY` overrides YAML when set, matching the TypeScript daemon behavior for wired provider paths. |

A job that exceeds `maxRetries` moves to dead-letter status and is
eventually purged by the retention worker.
The standalone extraction worker was retired under the Dreaming cutover
(#946); its former `pollMs`, `maxLoadPerCpu`, `overloadBackoffMs`, and
`threadedExtraction` knobs are no longer read from configuration (legacy
YAML values are ignored).


### Knowledge Graph (`graph`)

When `graph.enabled: true`, the pipeline builds entity-relationship links
from extracted facts and uses them to boost search relevance.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Enable knowledge graph building and querying |
| `boostWeight` | `0.15` | 0.0-1.0 | Weight applied to graph-neighbor score boost |
| `boostTimeoutMs` | `500` | 50-5000 ms | Timeout for graph lookup during search |


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
| `maxAspectsPerEntity` | `20` | 1-50 | Max aspects to collect per entity (read cap) |
| `maxAttributesPerAspect` | `50` | 1-100 | Max attributes per aspect (read cap) |
| `maxWriteAspectsPerEntity` | `20` | 1-50 | Max active aspects per entity before create_aspect is rejected |
| `maxWriteAttributesPerAspect` | `50` | 1-100 | Max active attributes per aspect before add_claim_value is rejected |
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
      maxAspectsPerEntity: 20
      maxAttributesPerAspect: 50
      maxWriteAspectsPerEntity: 20
      maxWriteAttributesPerAspect: 50
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

Anonymous usage telemetry. On by default; set `telemetryEnabled: false`
to opt out. Events are batched and flushed periodically. Sending requires
both `posthogHost` and `posthogApiKey`. Each install gets a random
anonymous id (persisted in the workspace database) used as the PostHog
`distinct_id`, so installs stay countable without being identifiable.

**See [TELEMETRY.md](https://github.com/Signet-AI/signetai/blob/main/docs/TELEMETRY.md)** — the single reference for the
event catalog, privacy contract, the open JSONL audit log, runtime opt-out
(`SIGNET_TELEMETRY_OPTOUT=1`), and how to query the data.

**Disclosure (issue #1026):** `signet setup` tells users telemetry is on
by default and asks whether to disable it, including sharing top-level CLI
command names with PostHog. Declining writes `telemetryEnabled: false`;
non-interactive/CI setups keep the default (enabled).

**Runtime opt-out:** setting `SIGNET_TELEMETRY_OPTOUT=1` in the daemon or CLI
process environment disables telemetry without touching config — the same knob
the install ping honors. CI runners, containers, and scripted environments
should set it in every process so automated daemon boots and CLI invocations do
not count as installs or usage.

**Open telemetry log:** every recorded event is appended as one JSON line
to `<agentsDir>/.daemon/telemetry/events.jsonl` — the single inspectable
audit surface for exactly what was recorded (daemon events and CLI
`command.invoked` lines). CLI command events are also queued in the workspace
database when remote delivery is configured and a telemetry SQLite database is
available, then flushed to PostHog in bounded, best-effort batches without
awaiting the command. Fresh workspaces without that database remain local-only.
The CLI and daemon use the same persisted install id.
No memory content, code, file paths, or personal
data are ever included.

Lifecycle events: `daemon.started` (version, platform,
uptime), `command.invoked` (command name only, never arguments),
`error.occurred` (sanitized crash report — truncated message with user paths
stripped, top stack frames with home directories removed, uptime, and
rate-limited `EventLoopLag` reports with measured lag), `version.upgraded`
(from, to), and `version.observed` (from, to for any observed daemon-start
transition).

**Development fleet marker:** setting `SIGNET_TELEMETRY_ENV=dev` keeps operator
development checkouts in the dataset while making them filterable. The daemon
adds `deployment: dev` to its local and PostHog events, while the CLI adds it
to its local and PostHog command events. The native install ping applies the marker
and `-dev` version suffix when the environment is present. The daemon and CLI
`bun run dev` scripts set this marker automatically. The marker does not
disable telemetry; use `SIGNET_TELEMETRY_OPTOUT=1` when development or
automated events should be silenced entirely.

Every daemon and CLI event carries `deploymentRole` and `installChannel`.
Both default to `unknown` and are populated only from the explicit config
keys below or `SIGNET_TELEMETRY_DEPLOYMENT_ROLE` and
`SIGNET_TELEMETRY_INSTALL_CHANNEL`. The `SIGNET_TELEMETRY_ENV=dev` marker
remains compatible and maps the role to `development`.
| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `posthogHost` | `https://us.i.posthog.com` | — | PostHog instance URL (empty disables) |
| `posthogApiKey` | `phc_mLsvJmbmp6e9UarrX9Cq5QtTjVNiiphM9mvi5Xnddd8Q` | — | PostHog project API key. Public ingest key by design; shared by daemon and CLI |
| `flushIntervalMs` | `60000` | 5s-10min | Time between event flushes |
| `flushBatchSize` | `50` | 1-500 | Max events per flush batch |
| `retentionDays` | `90` | 1-365 | Days before local telemetry data is purged |
| `deploymentRole` | `unknown` | `personal`, `service`, `automation`, `development`, `ci`, `unknown` | Explicit deployment role |
| `installChannel` | `unknown` | `desktop`, `package-manager`, `source`, `container`, `unknown` | Explicit installation provenance |
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
