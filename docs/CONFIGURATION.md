Configuration Reference
=======================

Complete reference for all Signet configuration options.


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
    enabled: false
    shadowMode: false
    extractionModel: qwen3:4b

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

The V2 memory pipeline lives at `packages/daemon/src/pipeline/`. It runs
LLM-based fact extraction against incoming conversation text, then decides
whether to write new memories, update existing ones, or skip. Config lives
under `memory.pipelineV2` in `agent.yaml`.

Pipeline V2 is disabled by default. Enable it explicitly:

```yaml
memory:
  pipelineV2:
    enabled: true
    shadowMode: true        # extract without writing — safe first step
    extractionModel: qwen3:4b
```


### Control flags

These boolean fields gate major pipeline behaviors. All default to
`false` unless noted.

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch. Pipeline does nothing when false. |
| `shadowMode` | `false` | Extract facts but skip writes. Useful for evaluation. |
| `mutationsFrozen` | `false` | Allow reads; block all writes. Overrides `shadowMode`. |
| `allowUpdateDelete` | `false` | Permit the pipeline to update or delete existing memories. |
| `graphEnabled` | `false` | Build and query the knowledge graph during extraction. |
| `autonomousEnabled` | `false` | Allow autonomous pipeline operations (maintenance, repair). |
| `autonomousFrozen` | `false` | Block autonomous writes; autonomous reads still allowed. |

The relationship between `shadowMode` and `mutationsFrozen` matters:
`shadowMode` suppresses writes from the normal extraction path only;
`mutationsFrozen` is a harder freeze that blocks all write paths
including repairs and graph updates.


### Extraction

These fields control the Ollama-based extraction stage.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `extractionModel` | `"qwen3:4b"` | — | Ollama model for fact extraction |
| `extractionTimeout` | `45000` | 5000-300000 ms | Extraction call timeout |
| `minFactConfidenceForWrite` | `0.7` | 0.0-1.0 | Confidence threshold; facts below this are dropped |

The extraction model must be available locally via Ollama. Lower
`minFactConfidenceForWrite` to capture more facts at the cost of noise;
raise it to write only high-confidence facts.


### Worker

The pipeline processes jobs through a queue with lease-based concurrency
control.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `workerPollMs` | `2000` | 100-60000 ms | How often the worker polls for pending jobs |
| `workerMaxRetries` | `3` | 1-10 | Max retry attempts before a job goes to dead-letter |
| `leaseTimeoutMs` | `300000` | 10000-600000 ms | Time before an uncompleted job lease expires |

A job that exceeds `workerMaxRetries` moves to dead-letter status and is
eventually purged by the retention worker.


### Knowledge Graph

When `graphEnabled: true`, the pipeline builds entity-relationship links
from extracted facts and uses them to boost search relevance.

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `graphBoostWeight` | `0.15` | 0.0-1.0 | Weight applied to graph-neighbor score boost |
| `graphBoostTimeoutMs` | `500` | 50-5000 ms | Timeout for graph lookup during search |


### Reranker

An optional cross-encoder reranking pass that runs after initial
retrieval. Disabled by default.

| Field | Default | Description |
|-------|---------|-------------|
| `rerankerEnabled` | `false` | Enable the reranking pass |
| `rerankerModel` | `""` | Model name for the reranker |
| `rerankerTopN` | `20` | Number of candidates to pass to the reranker |
| `rerankerTimeoutMs` | `2000` | Timeout for the reranking call (100-30000 ms) |


### Maintenance

The maintenance worker periodically inspects the database for anomalies
and can trigger corrective actions.

| Field | Default | Description |
|-------|---------|-------------|
| `maintenanceIntervalMs` | `1800000` | How often maintenance runs (30 min). Range: 60s-24h. |
| `maintenanceMode` | `"observe"` | `"observe"` logs issues; `"execute"` attempts repairs. |

In `"observe"` mode the worker emits structured log events but makes no
changes. Switch to `"execute"` only when `autonomousEnabled: true`.


### Repair budgets

Repair sub-workers limit how aggressively they re-embed or re-queue items
to avoid overloading Ollama.

| Field | Default | Description |
|-------|---------|-------------|
| `repairReembedCooldownMs` | `300000` | Min time between re-embed batches (10s-1h) |
| `repairReembedHourlyBudget` | `10` | Max re-embed operations per hour (1-1000) |
| `repairRequeueCooldownMs` | `60000` | Min time between re-queue batches (5s-1h) |
| `repairRequeueHourlyBudget` | `50` | Max re-queue operations per hour (1-1000) |


### Document ingest worker

Controls chunking for ingesting large documents into the memory store.

| Field | Default | Description |
|-------|---------|-------------|
| `documentWorkerIntervalMs` | `10000` | Poll interval for pending document jobs (1s-300s) |
| `documentChunkSize` | `2000` | Target chunk size in characters (200-50000) |
| `documentChunkOverlap` | `200` | Overlap between adjacent chunks (0-10000 chars) |
| `documentMaxContentBytes` | `10485760` | Max document size accepted (1 KB - 100 MB) |

Chunk overlap ensures context is not lost at chunk boundaries. A value of
10-15% of `documentChunkSize` is a reasonable starting point.


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

Controls what Signet injects during harness lifecycle events. See
[HOOKS.md](./HOOKS.md) for full details.

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

Location: `~/.config/opencode/`

`memory.mjs` is an OpenCode plugin that exposes `/remember` and `/recall`
as native tools within the harness.

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
