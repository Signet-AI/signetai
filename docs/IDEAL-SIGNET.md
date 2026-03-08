---
title: "Ideal Signet"
description: "End-to-end engineering specification for the ideal Signet system."
order: 51
section: "Project"
---

# Signet (Ideal): Monolithic Engineering Spec

This document is a single, end-to-end specification for the *ideal* Signet
system: an agent identity + memory + operations substrate that can be
reimplemented cleanly (e.g., in Rust) without referring to the existing
TypeScript/Bun codebase.

It is written as an implementation contract: nouns are data structures,
verbs are flows, and every subsystem is described in terms of boundaries,
invariants, and APIs.

Non-goal: describing what the current repo happens to do today line-by-line.
The current implementation is a reference; this is the target architecture.

---

## 0) One-Sentence Definition

Signet is the local-first system that makes an AI agent a persistent
individual: it owns identity, durable memory, skills, secrets, and
operational tooling; it integrates with multiple harnesses; it learns what
context to inject; and it stays auditable and reversible.

---

## 1) Core Ideas (The Mental Model)

### 1.1 Agent vs Model vs Harness

- Model: a stateless reasoning engine.
- Agent: a persistent identity (rules + personality + preferences + memory +
  skills), independent of the model.
- Harness: an execution environment that hosts a session with a model (Claude
  Code, OpenCode, OpenClaw, IDE integrations, a Signet-owned runtime).

Signet moves persistence out of the model/harness into an owned substrate.

### 1.2 The Substrate

The substrate consists of:

- Filesystem identity (human-auditable markdown/YAML).
- SQLite database (the source of truth for memory, graph, telemetry).
- A local daemon (HTTP + workers) that owns all writes.
- Adapters/SDKs that translate harness events into daemon API calls.

### 1.3 The Invariants

1) Local-first defaults: all state is local; remote calls are opt-in.
2) Raw-first durability: persist input before any LLM processing.
3) Reversibility: every mutation is audited; deletes are soft with recovery.
4) No LLM calls inside write locks (SQLite write lock is exclusive).
5) One session = one runtime path (prevents duplicated hook/tool execution).
6) Multi-agent is first-class: every user-facing row is scoped by `agent_id`.
7) Constraints always surface: certain knowledge must be injected regardless
   of rank.

---

## 2) System Components (Ideal Decomposition)

### 2.1 Daemon (The Data Plane)

Responsibilities:

- Own all writes to on-disk state.
- Expose a stable HTTP API for all subsystems.
- Run background workers: extraction/decision pipeline, document ingest,
  retention, maintenance/repair, checkpointing/continuity, scheduling.
- Serve MCP (tool surface) as a standardized agent tool protocol.
- Watch the identity directory and sync to harnesses; optionally git
  auto-commit/sync.

Constraints:

- Single process, localhost by default.
- Bounded concurrency for worker loops.
- Explicit transaction boundaries and lease-based job queue.

### 2.2 Runtime (The Execution Plane)

Responsibilities:

- Provide a canonical definition of a Signet agent session loop:
  context assembly -> model call -> tool dispatch -> record signals.

Key design: runtime is daemon-API-first; it is orchestration, not state.

Runtime may be:

- A Signet-owned runtime server (ideal), or
- External harnesses implementing the same adapter contract.

### 2.3 Harness Adapters (The Integration Plane)

Responsibilities:

- Map harness lifecycle events (session start/end, per-prompt, compaction)
  into daemon hook endpoints.
- Provide on-demand memory tools via MCP (or equivalent native tool system).
- Never implement business logic; they call daemon endpoints.

### 2.4 SDKs (Typed Clients)

Responsibilities:

- Provide typed access to daemon endpoints in multiple languages.
- Provide tool definition helpers (OpenAI tools, Vercel AI SDK tools, MCP
  bridges) that ultimately call the daemon.

### 2.5 UI (Dashboard / Tray)

Optional. The UI should not own logic; it calls the daemon API.

---

## 3) On-Disk Layout (Source of Truth)

### 3.1 Base Directory

Default base directory (overridable):

- `SIGNET_PATH` (default `~/.agents`)

### 3.2 Single-Agent Layout

```
~/.agents/
  agent.yaml
  AGENTS.md
  SOUL.md
  IDENTITY.md
  USER.md
  MEMORY.md               (generated summary)
  memory/
    memories.db
    predictor/            (predictor weights, logs)
  skills/
    <skill>/SKILL.md
  .secrets/
    secrets.enc
  .daemon/
    pid
    auth-secret
    logs/
```

### 3.3 Multi-Agent Layout (Ideal)

Multi-agent is one daemon + one DB, many logical agents.

```
~/.agents/
  agent.yaml
  agents/
    <agent_name>/
      SOUL.md             (optional override)
      IDENTITY.md         (optional override)
      USER.md             (optional override)
      workspace/          (generated harness-specific workspace, optional)
  skills/                 (shared filesystem pool)
  memory/memories.db      (shared DB, scoped by agent_id)
```

Inheritance rule for identity files:

1) `~/.agents/agents/<agent_name>/<file>` if present
2) else `~/.agents/<file>`

Rationale: one canonical identity; per-agent overrides when needed.

---

## 4) Database: SQLite as the Durable Kernel

SQLite runs in WAL mode. The DB is the source of truth.

### 4.1 Columns and Scoping

Every table that stores user-facing, agent-owned state includes:

- `agent_id TEXT NOT NULL` (default `"default"`)

All reads and writes filter by `agent_id` unless explicitly requested.

Derived/index tables (FTS, embeddings, caches) may be global (no `agent_id`)
as long as they cannot be used to bypass agent scoping (i.e., they are always
joined back to an agent-scoped source-of-truth table).

### 4.2 Core Tables (Memory System)

#### `memories`

Concept: the canonical memory record. Rows are immutable-in-spirit but
mutable via explicit modify/forget (always audited).

Minimum fields:

- `id TEXT PRIMARY KEY` (UUID)
- `agent_id TEXT NOT NULL`
- `type TEXT NOT NULL` (fact, preference, decision, procedural, semantic,
  session_summary, document_chunk, etc.)
- `content TEXT NOT NULL` (storage form)
- `normalized_content TEXT NOT NULL`
- `content_hash TEXT` (sha256 of normalized content, for dedup)
- `tags_json TEXT` (JSON array)
- `who TEXT` (actor/harness)
- `project TEXT NULL` (optional)
- `confidence REAL NULL` (extraction confidence)
- `importance REAL NOT NULL` (cold-start importance only; once Knowledge
  Architecture is populated, importance is computed from structural density and
  access/behavioral signals)
- `pinned INTEGER NOT NULL DEFAULT 0`
- `manual_override INTEGER NOT NULL DEFAULT 0`
- `is_deleted INTEGER NOT NULL DEFAULT 0`
- `deleted_at TEXT NULL`
- `version INTEGER NOT NULL DEFAULT 1` (optimistic concurrency)
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`
- `last_accessed TEXT NULL`
- `access_count INTEGER NOT NULL DEFAULT 0`
- `embedding_model TEXT NULL`
- `extraction_model TEXT NULL`

Indexes:

- Unique partial index on `(agent_id, content_hash)` where `is_deleted = 0`.
- Indexes to support filters: `(agent_id, is_deleted)`, `(agent_id, type)`,
  `(agent_id, pinned)`, `(agent_id, created_at)`.

#### `embeddings`

Concept: vectors keyed by `content_hash` (dedup across identical text).

- `id TEXT PRIMARY KEY` (UUID)
- `content_hash TEXT NOT NULL`
- `dimensions INTEGER NOT NULL`
- `model TEXT NOT NULL`
- `vector BLOB NOT NULL` (float32)
- `created_at TEXT NOT NULL`

Uniqueness:

- Unique `(model, content_hash)`; embeddings are safely shareable across agents
  because they are derived. Agent scoping is enforced by joins to source tables.

Vector index:

- Use sqlite-vec (or equivalent) to provide ANN search over vectors.

#### `embedding_sources`

Concept: links an agent-scoped source row to an embedding (supports multiple
embeddings/models per source).

- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `source_type TEXT NOT NULL` (memory, skill, entity_attribute, document_chunk, ...)
- `source_id TEXT NOT NULL`
- `model TEXT NOT NULL`
- `embedding_id TEXT NOT NULL`
- `created_at TEXT NOT NULL`

Uniqueness:

- unique `(agent_id, source_type, source_id, model)`

#### `memories_fts` (FTS5)

Concept: keyword index for `memories.content` and optionally tags.

Important rule: FTS is not the source of truth; it is derived.

Scope strategy:

- Either store `agent_id` in FTS as a column (ideal, requires rebuild), or
- Filter post-join against `memories.agent_id` (backward compatible).

#### `memory_entity_mentions`

Concept: derived index mapping memories to entities mentioned or implied by
extraction. This powers fast graph boosts and continuity signals; it is not the
source of truth.

- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `memory_id TEXT NOT NULL`
- `entity_id TEXT NOT NULL`
- `confidence REAL NOT NULL`
- `created_at TEXT NOT NULL`

Indexes:

- unique `(agent_id, memory_id, entity_id)`
- index `(agent_id, entity_id)`

#### `memory_history`

Concept: immutable audit log for every mutation and pipeline proposal.

- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `memory_id TEXT NOT NULL`
- `event TEXT NOT NULL` (created, modified, deleted, recovered, none)
- `old_content TEXT NULL`
- `new_content TEXT NULL`
- `changed_by TEXT NOT NULL`
- `actor_type TEXT NOT NULL` (operator, agent, daemon, harness)
- `reason TEXT NULL` (required for user/operator mutations)
- `metadata_json TEXT NULL` (pipeline proposal details, flags)
- `session_key TEXT NULL`
- `request_id TEXT NULL`
- `created_at TEXT NOT NULL`

Invariants:

- Every successful mutation (modify/forget/recover) must write a history row
  in the same transaction.
- Pipeline shadow mode records proposals as `event = 'none'`.

#### `memory_jobs` (Durable Queue)

Concept: job queue backed by SQLite so work survives restarts.

- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `job_type TEXT NOT NULL` (extract, document_ingest, reembed, etc.)
- `status TEXT NOT NULL` (pending, leased, completed, failed, dead)
- `payload_json TEXT NOT NULL`
- `result_json TEXT NULL`
- `attempts INTEGER NOT NULL`
- `max_attempts INTEGER NOT NULL`
- `leased_at TEXT NULL`
- `completed_at TEXT NULL`
- `failed_at TEXT NULL`
- `error TEXT NULL`

Lease semantics:

- Leasing must be atomic: select + update in a single write transaction.
- A reaper resets stale leases (`leased_at` too old) back to `pending`.

### 4.3 Documents (Ingest External Content)

#### `documents`

- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `source_type TEXT NOT NULL` (text, url, file)
- `source_url TEXT NULL` (url or file path)
- `title TEXT NULL`
- `raw_content TEXT NULL`
- `content_hash TEXT NULL`
- `status TEXT NOT NULL` (queued, extracting, chunking, embedding,
  indexing, done, failed, deleted)
- `error TEXT NULL`
- `metadata_json TEXT NULL`
- `connector_id TEXT NULL`
- `created_at TEXT NOT NULL`
- `completed_at TEXT NULL`

#### `document_memories`

- `(document_id, memory_id)` composite primary key
- `chunk_index INTEGER NOT NULL`

### 4.4 Connectors (Daemon-Side Sync Framework)

#### `connectors`

- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `provider TEXT NOT NULL` (filesystem, github-docs, gdrive, ...)
- `display_name TEXT NOT NULL`
- `config_json TEXT NOT NULL`
- `cursor_json TEXT NULL`
- `status TEXT NOT NULL` (idle, syncing, error)
- `last_sync_at TEXT NULL`
- `last_error TEXT NULL`

### 4.5 Continuity and Session Telemetry

#### `session_checkpoints`

- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `session_key TEXT NOT NULL`
- `harness TEXT NOT NULL`
- `project TEXT NULL`
- `project_normalized TEXT NULL`
- `trigger TEXT NOT NULL` (periodic, pre_compaction, agent, explicit)
- `digest TEXT NOT NULL` (redacted)
- `prompt_count INTEGER NOT NULL`
- `memory_queries_json TEXT NULL`
- `recent_remembers_json TEXT NULL`
- `created_at TEXT NOT NULL`

#### `session_memories`

Tracks which candidates were considered, injected, and later judged.

- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `session_key TEXT NOT NULL`
- `memory_id TEXT NOT NULL`
- `source TEXT NOT NULL` (effective, predictor, both, exploration, fts_only)
- `effective_score REAL NULL`
- `predictor_score REAL NULL`
- `final_score REAL NOT NULL`
- `rank INTEGER NOT NULL`
- `was_injected INTEGER NOT NULL`
- `relevance_score REAL NULL` (filled at session end)
- `fts_hit_count INTEGER NOT NULL DEFAULT 0`
- `created_at TEXT NOT NULL`
- unique `(agent_id, session_key, memory_id)`

#### `session_scores`

Stores continuity evaluation at session end.

- `agent_id TEXT NOT NULL`
- `session_key TEXT NOT NULL`
- `score REAL NOT NULL` (0..1)
- `confidence REAL NOT NULL` (0..1)
- `memories_used INTEGER NOT NULL`
- `novel_context_count INTEGER NOT NULL`
- `reasoning TEXT NULL` (auditable)
- `created_at TEXT NOT NULL`

Primary key:

- `(agent_id, session_key)`

### 4.6 Knowledge Architecture (Traversal-First Structure)

The knowledge architecture upgrades the graph from "entity mentions" to a
structured model: entity -> aspect -> attribute/constraint, plus explicit
dependency edges.

Structural importance note:

- Do not treat `importance` as a hand-tuned float long-term.
- Once KA tables exist, compute importance from structural density
  (constraints/aspects/edges) and observed access/behavioral signals.

Canonical `entity_type` values:

- person, project, system, tool, concept, skill, task, unknown

#### `entities`

- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `name TEXT NOT NULL`
- `canonical_name TEXT NOT NULL`
- `entity_type TEXT NOT NULL`
- `description TEXT NULL`
- `mentions INTEGER NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

#### `entity_aspects`

- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `entity_id TEXT NOT NULL`
- `name TEXT NOT NULL`
- `canonical_name TEXT NOT NULL`
- `weight REAL NOT NULL DEFAULT 0.5`
- unique `(agent_id, entity_id, canonical_name)`

#### `entity_attributes`

- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `aspect_id TEXT NOT NULL`
- `memory_id TEXT NULL` (link back to the atomic fact memory)
- `kind TEXT NOT NULL` (attribute, constraint)
- `content TEXT NOT NULL`
- `normalized_content TEXT NOT NULL`
- `confidence REAL NOT NULL`
- `importance REAL NOT NULL`
- `status TEXT NOT NULL` (active, superseded, deleted)
- `superseded_by TEXT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Constraints are first-class (`kind='constraint'`) and must always surface.

#### `entity_dependencies`

- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `source_entity_id TEXT NOT NULL`
- `target_entity_id TEXT NOT NULL`
- `aspect_id TEXT NULL`
- `dependency_type TEXT NOT NULL` (uses, requires, owned_by, blocks, informs)
- `strength REAL NOT NULL DEFAULT 0.5`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

#### Task lifecycle

Tasks are entities with `entity_type='task'` and separate lifecycle metadata.

- `task_meta(entity_id PRIMARY KEY, status, expires_at, retention_until, ...)`

### 4.7 Procedural Memory (Skills as Graph Nodes)

Skills exist on disk, but are indexed into the DB as procedural memory.

#### `skill_meta`

- `entity_id TEXT PRIMARY KEY` (points at entities row with type=skill)
- `agent_id TEXT NOT NULL`
- `source TEXT NOT NULL` (skills.sh, manual, harness)
- `fs_path TEXT NOT NULL`
- `role TEXT NOT NULL` (orchestrator, processor, utility, hook-candidate)
- `tags_json TEXT NULL`
- `triggers_json TEXT NULL`
- `installed_at TEXT NOT NULL`
- `uninstalled_at TEXT NULL`
- `use_count INTEGER NOT NULL`
- `last_used_at TEXT NULL`
- `decay_rate REAL NOT NULL DEFAULT 0.99`

### 4.8 Predictive Memory Scorer (Local Learned Ranking)

Predictor tables (minimum):

- `predictor_comparisons`: session-level audits comparing baseline vs
  predictor using NDCG@10 and updating success-rate EMA.
- `predictor_training_log`: training steps, loss, canary metrics.

The predictor itself can be:

- A sidecar process (ideal for Rust: an internal module; in TS era it was a
  separate Rust binary).

---

## 5) The Daemon HTTP API (Authoritative Contract)

All endpoints are served from a single daemon URL:

- `http://localhost:<port>` (default port 3850)

### 5.1 Common Response Shape

Errors are always:

```json
{ "error": "human readable message" }
```

All JSON in this API uses `camelCase`.

Unless noted, `agentId` is optional and defaults to `"default"`.

### 5.2 Common Request Attribution

Every request SHOULD carry attribution headers:

- `x-signet-runtime-path: plugin|legacy` (required for hooks)
- `x-signet-actor: <string>` (e.g., "claude-code", "opencode", "mcp")
- `x-signet-actor-type: operator|agent|harness|daemon`
- `x-signet-request-id: <uuid>` (optional; if absent, daemon generates)

The daemon persists `requestId` and attribution into audit tables.

### 5.3 Domains

The API is grouped by responsibility. The exact path names are less
important than the behavior and invariants.

#### Health and Status

- `GET /health` (no auth; liveness)
- `GET /api/status` (full daemon state + health score)

#### Config and Identity

- `GET /api/config` (list identity/config files)
- `POST /api/config` (write a file; whitelist `.md`/`.yaml` and basename only)
- `GET /api/identity` (parse `IDENTITY.md` into structured fields)

#### Memory

- `GET /api/memories` (list, paginated)
- `POST /api/memory/remember` (raw-first write + dedup; enqueue pipeline)
- `POST /api/memory/recall` (hybrid search + optional graph boost + reranker)
- `GET /api/memory/:id` (read)
- `PATCH /api/memory/:id` (modify with `reason` + `ifVersion`)
- `DELETE /api/memory/:id` (forget with `reason` + optional force)
- `POST /api/memory/:id/recover` (recover tombstone within retention)
- `GET /api/memory/:id/history` (audit)
- `POST /api/memory/modify` (batch modify)
- `POST /api/memory/forget` (batch preview/execute)

#### Hooks (Lifecycle)

- `POST /api/hooks/session-start`
- `POST /api/hooks/user-prompt-submit`
- `POST /api/hooks/session-end`
- `POST /api/hooks/pre-compaction`
- `POST /api/hooks/compaction-complete`
- `GET /api/hooks/synthesis/config`
- `POST /api/hooks/synthesis`
- `POST /api/hooks/synthesis/complete`

Hook invariant: a session is claimed by exactly one `runtime_path`:

- request header: `x-signet-runtime-path: plugin|legacy`
- daemon rejects mixed runtime paths for the same session (`409`).

### 5.4 Normative JSON Schemas (Hooks + Core Memory)

These schemas are the contract. Implementations may add fields, but MUST NOT
change meanings or requiredness.

#### 5.4.1 `POST /api/memory/remember`

Request:

```json
{
  "agentId": "default",
  "type": "fact",
  "content": "User prefers vim keybindings",
  "tags": ["preference", "editor"],
  "importance": 0.6,
  "project": "signetai",
  "who": "operator",
  "metadata": {
    "source": "mcp",
    "url": null
  },
  "idempotencyKey": "optional-stable-key"
}
```

Response:

```json
{
  "memoryId": "uuid",
  "agentId": "default",
  "deduped": false,
  "contentHash": "sha256hex",
  "createdAt": "2026-03-03T21:05:00Z",
  "pipeline": {
    "enqueued": true,
    "jobId": "uuid"
  }
}
```

Invariants:

- `content` is persisted even if embeddings/LLM extraction fail.
- Dedup is by `(agentId, contentHash)` for active (non-deleted) memories.

#### 5.4.2 `POST /api/memory/recall`

Request:

```json
{
  "agentId": "default",
  "query": "vim preference",
  "k": 20,
  "includeDeleted": false,
  "filters": {
    "types": ["fact", "preference", "decision"],
    "tags": ["editor"],
    "project": "signetai",
    "pinnedOnly": false
  },
  "options": {
    "hybrid": {
      "alpha": 0.65
    },
    "graphBoost": {
      "enabled": true,
      "deadlineMs": 40
    },
    "constraints": {
      "alwaysInclude": true
    }
  }
}
```

Response:

```json
{
  "agentId": "default",
  "query": "vim preference",
  "results": [
    {
      "memory": {
        "id": "uuid",
        "type": "preference",
        "content": "User prefers vim keybindings",
        "tags": ["preference", "editor"],
        "project": "signetai",
        "pinned": false,
        "isDeleted": false,
        "createdAt": "2026-03-03T21:05:00Z",
        "updatedAt": "2026-03-03T21:05:00Z"
      },
      "scores": {
        "final": 0.842,
        "keyword": 0.41,
        "vector": 0.91,
        "graphBoost": 0.02,
        "isConstraint": false
      },
      "explanations": ["vector", "tag:editor"],
      "highlights": {
        "content": ["vim"],
        "tags": ["editor"]
      }
    }
  ],
  "timingMs": {
    "total": 18,
    "fts": 3,
    "vector": 8,
    "rerank": 4,
    "graph": 2
  }
}
```

#### 5.4.3 `GET /api/memories`

Request (query params):

- `agentId=default`
- `cursor=<opaque>` (optional)
- `limit=50` (optional)
- `includeDeleted=false` (optional)

Response:

```json
{
  "agentId": "default",
  "items": [
    {
      "id": "uuid",
      "type": "fact",
      "content": "...",
      "tags": [],
      "project": null,
      "pinned": false,
      "isDeleted": false,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "page": {
    "nextCursor": "opaque-or-null",
    "hasMore": true
  }
}
```

#### 5.4.4 `GET /api/memory/:id`

Response:

```json
{
  "agentId": "default",
  "memory": {
    "id": "uuid",
    "type": "fact",
    "content": "...",
    "normalizedContent": "...",
    "contentHash": "sha256hex",
    "tags": [],
    "project": null,
    "who": "operator",
    "confidence": null,
    "importance": 0.5,
    "pinned": false,
    "manualOverride": false,
    "isDeleted": false,
    "version": 1,
    "createdAt": "...",
    "updatedAt": "...",
    "lastAccessed": null,
    "accessCount": 0,
    "embedding": {
      "model": "...",
      "dimensions": 1536,
      "status": "present"
    }
  }
}
```

#### 5.4.5 `PATCH /api/memory/:id`

Request:

```json
{
  "agentId": "default",
  "ifVersion": 1,
  "reason": "clarify wording",
  "patch": {
    "content": "User strongly prefers vim keybindings",
    "tags": ["preference", "editor"],
    "pinned": false
  }
}
```

Response:

```json
{
  "agentId": "default",
  "memory": {
    "id": "uuid",
    "version": 2,
    "updatedAt": "..."
  }
}
```

Errors:

- `409` if `ifVersion` does not match current row version.

#### 5.4.6 `DELETE /api/memory/:id`

Request:

```json
{
  "agentId": "default",
  "reason": "no longer true",
  "force": false
}
```

Response:

```json
{
  "agentId": "default",
  "memoryId": "uuid",
  "deleted": true,
  "deletedAt": "..."
}
```

#### 5.4.7 `POST /api/memory/:id/recover`

Request:

```json
{
  "agentId": "default",
  "reason": "was deleted by mistake"
}
```

Response:

```json
{
  "agentId": "default",
  "memoryId": "uuid",
  "recovered": true
}
```

#### 5.4.8 `POST /api/hooks/session-start`

Request:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "harness": "opencode",
  "project": "signetai",
  "cwd": "/home/nicholai/signet/signetai",
  "startedAt": "2026-03-03T21:00:00Z",
  "client": {
    "app": "opencode",
    "version": "x.y.z",
    "os": "linux"
  },
  "capabilities": {
    "mcp": true,
    "toolCalling": true,
    "compactionHooks": true
  }
}
```

Response:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "context": {
    "blocks": [
      {
        "id": "constraints",
        "kind": "constraints",
        "priority": 100,
        "content": "..."
      },
      {
        "id": "memories",
        "kind": "memories",
        "priority": 50,
        "content": "..."
      },
      {
        "id": "skills",
        "kind": "skills",
        "priority": 40,
        "content": "..."
      }
    ],
    "budgets": {
      "tokensReserved": 2000
    }
  }
}
```

Invariants:

- Enforces session runtime-path claim (`409` on conflict).
- Must include constraints blocks for in-scope entities.

#### 5.4.9 `POST /api/hooks/user-prompt-submit`

Request:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "prompt": {
    "id": "uuid",
    "role": "user",
    "content": "How do I run the daemon locally?",
    "submittedAt": "2026-03-03T21:01:30Z"
  },
  "context": {
    "project": "signetai",
    "cwd": "/home/nicholai/signet/signetai"
  }
}
```

Response:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "context": {
    "blocks": [
      {
        "id": "incremental-memories",
        "kind": "memories",
        "priority": 50,
        "content": "..."
      }
    ]
  }
}
```

#### 5.4.10 `POST /api/hooks/session-end`

Request:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "endedAt": "2026-03-03T21:15:00Z",
  "stats": {
    "promptCount": 12,
    "toolCallCount": 4
  },
  "artifacts": {
    "recentMemoryIds": ["uuid"],
    "checkpointIds": ["uuid"]
  }
}
```

Response:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "accepted": true,
  "jobs": {
    "enqueued": true,
    "jobIds": ["uuid"]
  }
}
```

#### 5.4.11 `POST /api/hooks/pre-compaction`

Request:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "triggeredAt": "2026-03-03T21:10:00Z",
  "reason": "harness-compaction",
  "compaction": {
    "maxContextTokens": 200000,
    "contextToBeCompacted": "raw text from harness (may be large)",
    "redactionHints": ["secrets", "api keys"]
  }
}
```

Response:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "checkpoint": {
    "written": true,
    "checkpointId": "uuid"
  },
  "instructions": {
    "preferredSummaryStyle": "constraints-first",
    "mustPreserve": ["constraints", "active tasks", "recent decisions"]
  }
}
```

#### 5.4.12 `POST /api/hooks/compaction-complete`

Request:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "completedAt": "2026-03-03T21:10:10Z",
  "compaction": {
    "summaryProduced": "new compacted context",
    "tokenCount": 16000
  }
}
```

Response:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "accepted": true
}
```

#### 5.4.13 `GET /api/hooks/synthesis/config`

Response:

```json
{
  "agentId": "default",
  "enabled": true,
  "targets": ["MEMORY.md"],
  "budgets": {
    "maxTokens": 8000
  }
}
```

#### 5.4.14 `POST /api/hooks/synthesis`

Request:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "requestedAt": "2026-03-03T21:12:00Z",
  "inputs": {
    "recentMemories": 200,
    "includeConstraints": true,
    "includeSkills": true
  }
}
```

Response:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "instructions": {
    "format": "markdown",
    "sections": ["Current Context", "Preferences", "Active Projects", "Safety Constraints"]
  }
}
```

#### 5.4.15 `POST /api/hooks/synthesis/complete`

Request:

```json
{
  "agentId": "default",
  "sessionKey": "opaque-session-key",
  "completedAt": "2026-03-03T21:12:20Z",
  "output": {
    "path": "MEMORY.md",
    "content": "# MEMORY\n...",
    "contentHash": "sha256hex"
  }
}
```

Response:

```json
{
  "agentId": "default",
  "written": true
}
```

#### 5.4.16 `POST /api/memory/modify` (batch)

Request:

```json
{
  "agentId": "default",
  "reason": "bulk cleanup",
  "operations": [
    {
      "memoryId": "uuid",
      "ifVersion": 2,
      "patch": {
        "tags": ["preference"],
        "pinned": false
      }
    }
  ]
}
```

Response:

```json
{
  "agentId": "default",
  "updated": [
    {
      "memoryId": "uuid",
      "ok": true,
      "newVersion": 3
    }
  ],
  "failed": [
    {
      "memoryId": "uuid",
      "ok": false,
      "error": "409 version conflict"
    }
  ]
}
```

#### 5.4.17 `POST /api/memory/forget` (batch)

Request:

```json
{
  "agentId": "default",
  "reason": "remove outdated facts",
  "mode": "preview",
  "force": false,
  "memoryIds": ["uuid", "uuid"]
}
```

Response:

```json
{
  "agentId": "default",
  "mode": "preview",
  "items": [
    {
      "memoryId": "uuid",
      "willDelete": true,
      "blocked": false
    }
  ]
}
```

#### Documents

- `POST /api/documents` (enqueue ingest)
- `GET /api/documents` (list)
- `GET /api/documents/:id` (get)
- `GET /api/documents/:id/chunks` (chunk memories)
- `DELETE /api/documents/:id?reason=...` (delete doc + linked chunks)

#### Connectors (Daemon-Side Sync)

- `GET /api/connectors`
- `POST /api/connectors` (register)
- `GET /api/connectors/:id`
- `POST /api/connectors/:id/sync`
- `POST /api/connectors/:id/sync/full?confirm=true`
- `GET /api/connectors/:id/health`
- `DELETE /api/connectors/:id?cascade=true`

#### Skills

- `GET /api/skills` (installed skills, plus enriched graph metadata)
- `GET /api/skills/:name` (SKILL.md)
- `GET /api/skills/search?q=...` (registry search)
- `POST /api/skills/install` (install)
- `DELETE /api/skills/:name` (uninstall)

Procedural additions (ideal):

- `GET /api/skills/suggest?context=...` (vector search over skill embeddings)
- `POST /api/skills/used` (usage event; increments `use_count`, links context)

#### Secrets

- `GET /api/secrets` (names only)
- `POST /api/secrets/:name` (store)
- `DELETE /api/secrets/:name` (delete)
- `POST /api/secrets/exec` (run command with secret env injection; redact output)

Optional integration:

- 1Password connect/status/vaults/import endpoints.

#### Auth

- `GET /api/auth/whoami`
- `POST /api/auth/token` (issue token)

#### Analytics / Diagnostics / Repair

- `GET /api/analytics/usage|errors|latency|logs`
- `GET /api/diagnostics` (domain scores + composite)
- `GET /api/diagnostics/:domain`
- `POST /api/repair/requeue-dead|release-leases|check-fts|retention-sweep|...`

#### Git Sync

- `GET /api/git/status`
- `POST /api/git/pull|push|sync`
- `GET/POST /api/git/config`

#### Tasks (Scheduler)

- `GET/POST /api/tasks`
- `GET/PATCH/DELETE /api/tasks/:id`
- `POST /api/tasks/:id/run`
- `GET /api/tasks/:id/runs`
- `GET /api/tasks/:id/stream` (SSE)

---

## 6) MCP: Tool Surface for Agents

MCP provides on-demand tools to the harness/model.

Minimum tool set (direct daemon wrappers):

- `memory_search` -> `POST /api/memory/recall`
- `memory_store` -> `POST /api/memory/remember`
- `memory_get` -> `GET /api/memory/:id`
- `memory_list` -> `GET /api/memories`
- `memory_modify` -> `PATCH /api/memory/:id`
- `memory_forget` -> `DELETE /api/memory/:id`
- `secret_list` -> `GET /api/secrets`
- `secret_exec` -> `POST /api/secrets/exec`

MCP transport (ideal):

- Streamable HTTP at `/mcp` (stateless request handling).
- Optional stdio bridge binary for harnesses that want subprocess MCP.

MCP headers for audit attribution:

- `x-signet-runtime-path: plugin`
- `x-signet-actor: mcp-server`
- `x-signet-actor-type: harness`

---

## 7) Memory Retrieval: Hybrid Search + Graph + Traversal

### 7.1 Baseline Hybrid Search

Two independent signals:

- Keyword: BM25 via FTS5.
- Semantic: cosine similarity via vector index.

Fuse:

`score = alpha * vector + (1 - alpha) * keyword`

If a leg is unavailable, degrade gracefully to the other.

### 7.2 Graph Boost (Entity Mentions)

At query time:

1) Resolve query tokens -> entities.
2) Expand 1 hop through relations (at minimum `entity_dependencies`; optionally
   skill-specific relation tables).
3) Collect linked memories via `memory_entity_mentions` (if the index is
   incomplete/unavailable, skip this boost path).
4) Apply small additive boost to those memory IDs.

Graph boost must be deadline-bounded; failure returns empty boost set.

### 7.3 Traversal-First Retrieval (Knowledge Architecture)

Traversal is the primary retrieval floor.

At session start (and optionally per-turn), compute a candidate pool by:

1) Resolve focal entities using session signals (project path, last
   checkpoint, prompt hints).
2) Pull all active constraints for focal entities and one-hop dependency
   neighbors.
3) Pull top aspects by weight.
4) Pull active attributes under those aspects.
5) Materialize candidate memory IDs via `entity_attributes.memory_id`.

Then (optionally) rank within this pool via the predictive scorer or hybrid
search.

Hard rule: constraints surface regardless of rank.

---

## 8) Memory Pipeline: From Raw Input to Structured Knowledge

The pipeline is asynchronous and job-driven.

### 8.1 Write Path: Raw-First

On `remember`:

1) Normalize + hash content.
2) Dedup by `content_hash` (and optional idempotency keys).
3) Insert into `memories` + `memories_fts` in one transaction.
4) Enqueue a `memory_jobs` row (`job_type = extract`).
5) Fetch/store embedding out-of-transaction; if embedding fails, memory
   remains keyword-searchable.

### 8.2 Extraction Stage

Given raw text, an LLM returns strict JSON:

- facts: [{ content, type, confidence }]
- entities: [{ source, relationship, target, confidence }]

Validation is strict but partial-failure tolerant:

- Cap counts.
- Enforce min/max length.
- Coerce invalid types to safe default.
- Strip reasoning wrappers (`<think>` blocks, code fences) before parsing.

### 8.3 Decision Stage

For each extracted fact:

1) Retrieve top-K candidate memories via hybrid search.
2) If no candidates: propose ADD without an LLM call.
3) Else, ask LLM to decide one of: add, update, delete, none.
4) Validate that update/delete references an actual candidate.

### 8.4 Controlled Writes

Pipeline writes are gated:

- `enabled` master flag
- `shadowMode` (proposals only)
- `mutationsFrozen` (killswitch for all writes)
- `allowUpdateDelete` (destructive mutations)

Write discipline:

- No LLM calls in write transaction.
- Prefetch embeddings for proposed ADD facts before entering transaction.
- Insert derived fact memories via the same normalization + dedup rules.
- Always write audit entries to `memory_history`.

### 8.5 Structural Assignment (Knowledge Architecture)

After an atomic fact is committed, run a structural assignment stage:

1) Resolve primary entity.
2) Resolve/create aspect.
3) Classify as attribute vs constraint.
4) Create/update dependency edges.
5) Link attribute row back to its memory (`entity_attributes.memory_id`).

Backfill: maintenance worker incrementally assigns legacy memories.

---

## 9) Continuity: Surviving Context Window Death

### 9.1 Checkpointing

Two channels:

- Passive (automatic): accumulate per-session prompt queries and remembers;
  write checkpoints every N prompts / M minutes via a debounced flush.
- Active (agent-initiated): an MCP tool (e.g. `session_digest`) writes a
  narrative checkpoint.

All checkpoint digests are redacted before storage.

### 9.2 Pre-Compaction Offload

On pre-compaction hook:

- Write an emergency checkpoint including the harness-provided context.

### 9.3 Recovery Injection

On session start:

- If a recent checkpoint exists for this project/session lineage,
  inject it into context under a reserved budget.

---

## 10) Predictive Memory Scorer: Learned Ranking That Earns Influence

Goal: learn which memories will matter *right now* for this user, locally.

### 10.1 Candidate Pool

Predictor never sees the full corpus. It receives a bounded pool:

- Traversal pool (KA)
  union
- top-N by baseline effective score
  union
- top-N by embedding similarity

### 10.2 Training Labels

Primary labels come from session-end continuity scoring:

- per-memory relevance scores
- overall session score and confidence
- novel context count

Behavioral reinforcement:

- FTS hit counts during the session
- explicit deletions/edits as negative signals
- superseded memories as negative labels

### 10.3 Fusion and Exploration

Predictor and baseline rankings are fused via Reciprocal Rank Fusion (RRF)
using a learned alpha that is earned by wins over time.

Use epsilon-greedy exploration: occasionally swap in a high-disagreement
candidate to prevent collapse.

Constraints remain non-suppressible.

### 10.4 Sidecar vs In-Process

Implementation options:

- Sidecar (JSON-RPC over stdio): isolates crashes and simplifies hot reload.
- In-process module: simpler deployment in a single Rust binary.

Whichever is chosen: inference must be latency-bounded with fallback.

---

## 11) Procedural Memory: Skills as First-Class Knowledge

### 11.1 Skill Indexing

Filesystem remains authoritative for skill runtime.

The daemon maintains DB representations:

- skill entity (`entities.entity_type='skill'`)
- `skill_meta`
- embedding over enriched frontmatter (name + description + triggers)

### 11.2 Frontmatter Enrichment

On install (or reconciliation), if metadata is thin:

- Run an LLM pass over SKILL.md to generate:
  - a concrete description (mechanism + when to use)
  - trigger phrases
  - tags
- Write back to SKILL.md using YAML-aware round-tripping (no regex hacks).

### 11.3 Usage Tracking

When a skill is invoked:

- `POST /api/skills/used` increments use count and links to relevant memories.

### 11.4 Suggestion

Given a context string:

- embed context
- vector search over skill embeddings
- rank by similarity * procedural decay/recency/importance floors

Inject top-K skills as "Relevant Skills" at session start (budgeted).

---

## 12) Secrets: Use Without Read

### 12.1 Storage

- File: `~/.agents/.secrets/secrets.enc` (0600)
- Each value encrypted independently.

### 12.2 Crypto

- Algorithm: XSalsa20-Poly1305 (libsodium secretbox)
- Key derivation: BLAKE2b over `signet:secrets:<machine-id>` to 32 bytes.
- Nonce: random 24 bytes, prepended to ciphertext.

### 12.3 Safety Contract

- No API endpoint ever returns a secret value.
- `secret_exec` injects into subprocess env; captured stdout/stderr is redacted
  by replacing any secret value occurrences with `[REDACTED]`.

---

## 13) Auth: Optional, Simple, Role/Scope-Based

### 13.1 Modes

- local: no auth, localhost binding.
- team: bearer token required.
- hybrid: localhost bypass; remote requires token.

### 13.2 Tokens

- Format: `base64url(payload).base64url(hmac_sha256(payload))`
- Secret: 32 random bytes at `~/.agents/.daemon/auth-secret` (0600)

Claims:

- sub, role, scope {project, agent, user}, iat, exp

### 13.3 Permissions

Roles: admin, operator, agent, readonly.

### 13.4 Rate Limiting

Sliding window per actor + operation for destructive endpoints.

---

## 14) Watchers, Git Sync, and Harness Sync

### 14.1 Identity Watcher

Watch identity/config files. On change:

- Debounced harness sync (e.g. 2s): regenerate harness-specific files.

### 14.2 Git Auto-Commit + Auto-Sync

If `~/.agents` is a git repo:

- Debounced `git add -A` + commit (e.g. 5s).
- Optional periodic pull/push sync.

Credential resolution order (ideal):

1) SSH
2) git credential helper
3) forge-specific token helpers (never inject GitHub tokens into non-GitHub)

---

## 15) Scheduler: Cron-Driven Agent Work

The daemon can spawn harness CLIs on a schedule:

- cron expression validation
- bounded concurrency
- stdout/stderr capture with size caps
- timeouts with SIGTERM then SIGKILL
- SSE streaming

Critical safety: avoid infinite loops (spawned processes must not trigger
Signet hooks back into the daemon).

---

## 16) A Clean Rust Implementation (One-Binary Target)

If implementing the ideal system in Rust, keep module boundaries aligned
with the above contracts.

Recommended crate breakdown:

- `signetd` (binary): axum server, startup, routing, worker supervision
- `db`: rusqlite/sqlx wrappers, migrations, transaction helpers
- `search`: BM25 + vec + fusion + rerankers
- `pipeline`: job leasing + extraction/decision + controlled writes
- `ka`: knowledge architecture (assignment + traversal retrieval)
- `skills`: skill indexing + enrichment + suggestions
- `secrets`: encryption/decryption + exec + redaction
- `auth`: tokens + RBAC + scope + rate limiter
- `mcp`: Streamable HTTP MCP tool server
- `watch`: notify-based watcher + debouncers
- `git`: subprocess wrapper + credential handling
- `scheduler`: cron + spawn + SSE streaming
- `predictor`: (optional) in-process learned ranker + training loop

Concurrency model:

- One write connection (serialized writes) + read pool.
- Workers are cooperative loops with explicit backoff.
- Every external I/O (LLM, embeddings, network fetch) happens outside write
  transactions.

Vector index:

- Prefer sqlite-vec for continuity with the data model; validate extension
  loading early.

---

## 17) Acceptance Tests (If You Ship This, These Must Pass)

Durability and safety:

1) remember persists even if LLM provider is down.
2) dedup holds under concurrency (two simultaneous identical remembers).
3) soft-delete + recover works within retention window.
4) pinned memory cannot be deleted without explicit force + operator policy.
5) no LLM calls inside write locks (enforced by structure, not hope).

Retrieval:

6) keyword-only works when embeddings are unavailable.
7) hybrid recall returns stable results with alpha fusion.
8) traversal retrieval always includes constraints for in-scope entities.

Continuity:

9) checkpoints are written periodically and on pre-compaction.
10) recovery injection occurs for same project within the window.

Procedural memory:

11) installed skills become skill entities with embeddings.
12) `/api/skills/suggest` returns relevant skills for a context.

Security:

13) secrets are never returned; exec output is redacted.
14) team mode rejects unauthenticated requests; RBAC enforced.

---

End.
