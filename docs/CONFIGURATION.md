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

All files live in `~/.agents/` (or your custom `SIGNET_PATH`).

| File | Purpose |
|------|---------|
| `agent.yaml` | Main configuration and manifest |
| `AGENTS.md` | Agent identity and instructions (synced to harnesses) |
| `SOUL.md` | Personality and tone |
| `MEMORY.md` | Working memory summary (auto-generated) |
| `IDENTITY.md` | Optional identity metadata (name, creature, vibe) |
| `USER.md` | Optional user preferences and profile |

The loader checks `agent.yaml`, `AGENT.yaml`, and `config.yaml` in that
order, using the first file it finds. All sections are optional; omitting
a section falls back to the documented defaults.


agent.yaml
----------

The primary configuration file. Created by `signet setup` and editable
via `signet config` or the dashboard's config editor.

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
      provider: claude-code
      model: haiku
    graph:
      enabled: true
    autonomous:
      enabled: true
      maintenanceMode: execute

hooks:
  sessionStart:
    recallLimit: 10
    includeIdentity: true
    includeRecentContext: true
    recencyBias: 0.7
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

Optional owner identification. Reserved for future ERC-8128 verification.

| Field | Type | Description |
|-------|------|-------------|
| `address` | string | Ethereum wallet address |
| `localId` | string | Local user identifier |
| `ens` | string | ENS domain name |
| `name` | string | Human-readable name |


### harnesses

List of AI platforms to integrate with. Valid values: `claude-code`,
`opencode`, `openclaw`. Support for `cursor`, `windsurf`, `chatgpt`, and
`gemini` is planned.


### embedding

Vector embedding configuration for semantic memory search.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | `"ollama"` | `"ollama"` or `"openai"` |
| `model` | string | `"nomic-embed-text"` | Embedding model name |
| `dimensions` | number | `768` | Output vector dimensions |
| `base_url` | string | `"http://localhost:11434"` | Ollama API base URL |
| `api_key` | string | — | API key or `$secret:NAME` reference |

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
| `database` | string | `"memory/memories.db"` | SQLite path (relative to `~/.agents/`) |
| `session_budget` | number | `2000` | Character limit for session context injection |
| `decay_rate` | number | `0.95` | Daily importance decay factor for non-pinned memories |

Non-pinned memories lose importance over time using the formula:

```
importance(t) = base_importance × decay_rate^days_since_access
```

Accessing a memory resets the decay timer.


### memory.synthesis

Configuration for periodic `MEMORY.md` regeneration. The synthesis
process reads all memories and asks a model to write a coherent summary.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `harness` | string | `"openclaw"` | Which harness runs synthesis |
| `model` | string | `"sonnet"` | Model identifier |
| `schedule` | string | `"daily"` | `"daily"`, `"weekly"`, or `"on-demand"` |
| `max_tokens` | number | `4000` | Max output tokens |


Pipeline V2 Config
------------------

The V2 [[pipeline|memory pipeline]] lives at `packages/daemon/src/pipeline/`. It runs
LLM-based fact extraction against incoming conversation text, then decides
whether to write new memories, update existing ones, or skip. Config lives
under `memory.pipelineV2` in `agent.yaml`.

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
      provider: ollama
      model: qwen3:4b
```


### Control flags

These top-level boolean fields gate major pipeline behaviors.

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Master switch. Pipeline does nothing when false. |
| `shadowMode` | `false` | Extract facts but skip writes. Useful for evaluation. |
| `mutationsFrozen` | `false` | Allow reads; block all writes. Overrides `shadowMode`. |
| `semanticContradictionEnabled` | `false` | Enable LLM-based semantic contradiction detection for UPDATE/DELETE proposals. |
| `telemetryEnabled` | `false` | Enable anonymous telemetry reporting. |

The relationship between `shadowMode` and `mutationsFrozen` matters:
`shadowMode` suppresses writes from the normal extraction path only;
`mutationsFrozen` is a harder freeze that blocks all write paths
including repairs and graph updates.


### Extraction (`extraction`)

Controls the LLM-based extraction stage. Supports multiple providers.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `provider` | `"claude-code"` | — | `"ollama"`, `"openai"`, `"claude-code"`, `"opencode"`, `"codex"`, or `"native"` |
| `model` | `"haiku"` | — | Model name for the configured provider |
| `timeout` | `45000` | 5000-300000 ms | Extraction call timeout |
| `minConfidence` | `0.7` | 0.0-1.0 | Confidence threshold; facts below this are dropped |

When using `ollama`, the model must be available locally. When using
`claude-code`, the Claude Code CLI must be on PATH. `codex` uses the
Codex harness as the extraction provider. `native` uses the
`@signet/native` Rust/NAPI module for local vector operations. Lower
`minConfidence` to capture more facts at the cost of noise; raise it
to write only high-confidence facts.


### Worker (`worker`)

The pipeline processes jobs through a queue with lease-based concurrency
control.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `pollMs` | `2000` | 100-60000 ms | How often the worker polls for pending jobs |
| `maxRetries` | `3` | 1-10 | Max retry attempts before a job goes to dead-letter |
| `leaseTimeoutMs` | `300000` | 10000-600000 ms | Time before an uncompleted job lease expires |

A job that exceeds `maxRetries` moves to dead-letter status and is
eventually purged by the retention worker.


### Knowledge Graph (`graph`)

When `graph.enabled: true`, the pipeline builds entity-relationship links
from extracted facts and uses them to boost search relevance.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Enable knowledge graph building and querying |
| `boostWeight` | `0.15` | 0.0-1.0 | Weight applied to graph-neighbor score boost |
| `boostTimeoutMs` | `500` | 50-5000 ms | Timeout for graph lookup during search |


### Reranker (`reranker`)

An optional reranking pass that runs after initial retrieval. An
embedding-based reranker is built in (uses cached vectors, no extra
LLM calls). Custom cross-encoder providers can also be used.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Enable the reranking pass |
| `model` | `""` | — | Model name for the reranker (empty uses embedding-based) |
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
```

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `"local"` | Auth mode: `"local"`, `"team"`, or `"hybrid"` |
| `defaultTokenTtlSeconds` | `604800` | API token lifetime (7 days) |
| `sessionTokenTtlSeconds` | `86400` | Session token lifetime (24 hours) |

In `"local"` mode the token secret is generated automatically and stored
at `~/.agents/.daemon/auth-secret`. In `"team"` and `"hybrid"` modes,
wallet-based ERC-8128 signatures are used alongside or instead of local
tokens.


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
  preCompaction:
    includeRecentMemories: true
    memoryLimit: 5
    summaryGuidelines: "Focus on technical decisions."
```

`hooks.sessionStart` controls what is injected at the start of a new
harness session:

| Field | Default | Description |
|-------|---------|-------------|
| `recallLimit` | `10` | Number of memories to inject |
| `includeIdentity` | `true` | Include agent name and description |
| `includeRecentContext` | `true` | Include `MEMORY.md` content |
| `recencyBias` | `0.7` | Weight toward recent vs. important memories (0-1) |

`hooks.preCompaction` controls what is included when the harness triggers
a pre-compaction summary:

| Field | Default | Description |
|-------|---------|-------------|
| `includeRecentMemories` | `true` | Include recent memories in the prompt |
| `memoryLimit` | `5` | How many recent memories to include |
| `summaryGuidelines` | built-in | Custom instructions for session summary |


Environment Variables
---------------------

Environment variables take precedence over `agent.yaml` for runtime
overrides. They are useful in containerized or CI environments where
editing the config file is impractical.

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNET_PATH` | `~/.agents` | Base agents directory |
| `SIGNET_PORT` | `3850` | Daemon HTTP port |
| `SIGNET_HOST` | `localhost` | Daemon bind address |
| `OPENAI_API_KEY` | — | OpenAI key when embedding provider is `openai` |

`SIGNET_PATH` changes where Signet reads and writes all agent data,
including the config file itself. This is useful for testing with an
isolated environment or for running multiple agent identities.


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

FTS5 virtual table for keyword search. Indexes `content` and `tags`
from the `memories` table. An after-delete trigger keeps the FTS index
in sync when tombstones are hard-purged.


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
        "command": "python3 ~/.agents/memory/scripts/memory.py load --mode session-start",
        "timeout": 3000
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.agents/memory/scripts/memory.py load --mode prompt",
        "timeout": 2000
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.agents/memory/scripts/memory.py save --mode auto",
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

Location: `~/.agents/hooks/agent-memory/` (hook directory)

Also configures the OpenClaw workspace in `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.agents"
    }
  }
}
```

See [HARNESSES.md](./HARNESSES.md) for the full OpenClaw adapter docs.


Git Integration
---------------

If `~/.agents/` is a git repository, the daemon auto-commits file changes
with a 5-second debounce after the last detected change. Commit messages
use the format `YYYY-MM-DDTHH-MM-SS_auto_<filename>`. The setup wizard
offers to initialize git on first run and creates a backup commit before
making any changes.

Recommended `.gitignore` for `~/.agents/`:

```gitignore
.daemon/
.secrets/
__pycache__/
*.pyc
*.log
```
