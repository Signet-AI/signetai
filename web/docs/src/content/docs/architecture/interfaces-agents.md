---
title: "Interfaces and agents"
description: "HTTP interfaces, key implementation files, and multi-agent support."
---

## HTTP API Reference

All endpoints are served by the Hono server on port 3850.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | none | Uptime, pid, version |
| `/api/status` | GET | none | Full daemon status |
| `/api/features` | GET | none | Feature flags |
| `/api/config` | GET | local | List config files |
| `/api/config` | POST | local | Save a config file |
| `/api/identity` | GET | local | Agent identity |
| `/api/auth/whoami` | GET | none | Current auth identity |
| `/api/auth/token` | POST | admin | Issue auth token |
| `/api/memories` | GET | recall | List with pagination |
| `/api/memory/remember` | POST | remember | Save a memory, enqueue extraction |
| `/api/memory/recall` | POST | recall | Hybrid search |
| `/api/memory/forget` | POST | forget | Batch forget memories |
| `/api/memory/modify` | POST | modify | Modify a memory |
| `/api/memory/search` | GET | recall | Search memories |
| `/api/memory/:id` | GET | recall | Get a memory |
| `/api/memory/:id` | PATCH | modify | Update a memory |
| `/api/memory/:id` | DELETE | forget | Delete a memory |
| `/api/memory/:id/history` | GET | recall | Memory version history |
| `/api/memory/:id/recover` | POST | recover | Recover a deleted memory |
| `/memory/search` | GET | recall | Legacy keyword search |
| `/memory/similar` | GET | recall | Vector similarity search |
| `/api/embeddings` | GET | recall | Export embeddings |
| `/api/embeddings/status` | GET | recall | Embedding provider status |
| `/api/embeddings/health` | GET | recall | Embedding health metrics |
| `/api/embeddings/projection` | GET | recall | UMAP 2D/3D projection |
| `/api/hooks/session-start` | POST | remember | Inject context into session |
| `/api/hooks/user-prompt-submit` | POST | recall | Per-prompt entity context load |
| `/api/hooks/session-end` | POST | remember | Capture immutable session evidence |
| `/api/hooks/remember` | POST | remember | Save a memory via hook |
| `/api/hooks/recall` | POST | recall | Search via hook |
| `/api/hooks/pre-compaction` | POST | remember | Pre-compaction instructions |
| `/api/hooks/compaction-complete` | POST | remember | Save compaction summary |
| `/api/hooks/synthesis/*` | GET/POST | local | MEMORY.md synthesis |
| `/api/harnesses` | GET | local | List configured harnesses |
| `/api/harnesses/regenerate` | POST | local | Regenerate harness configs |
| `/api/skills` | GET | local | List installed skills |
| `/api/secrets` | GET | admin | List secret names |
| `/api/secrets/exec` | POST | admin | Queue with multiple secrets |
| `/api/secrets/exec/:jobId` | GET | admin | Inspect queued secret exec job |
| `/api/secrets/:name/exec` | POST | admin | Queue with single secret (legacy) |
| `/api/documents` | GET/POST | documents | List or enqueue documents |
| `/api/documents/:id` | GET/DELETE | documents | Get or delete a document |
| `/api/documents/:id/chunks` | GET | documents | Get document chunks |
| `/api/connectors` | GET/POST | connectors | List or register connectors |
| `/api/connectors/:id` | GET/DELETE | connectors | Get or delete a connector |
| `/api/connectors/:id/sync` | POST | connectors | Trigger incremental sync |
| `/api/connectors/:id/sync/full` | POST | connectors | Trigger full re-sync |
| `/api/connectors/:id/health` | GET | connectors | Connector health |
| `/api/diagnostics` | GET | diagnostics | Full health report |
| `/api/diagnostics/:domain` | GET | diagnostics | Per-domain health score |
| `/api/pipeline/status` | GET | diagnostics | Pipeline status snapshot |
| `/api/repair/requeue-dead` | POST | operator | Requeue dead-letter jobs |
| `/api/repair/release-leases` | POST | operator | Release stale job leases |
| `/api/repair/check-fts` | POST | operator | Check/repair FTS consistency and tokenizer drift |
| `/api/repair/retention-sweep` | POST | operator | Trigger retention sweep |
| `/api/repair/embedding-gaps` | GET | operator | Count unembedded memories |
| `/api/repair/re-embed` | POST | operator | Batch re-embed missing vectors |
| `/api/repair/clean-orphans` | POST | operator | Remove orphaned embeddings |
| `/api/repair/dedup-stats` | GET | operator | Deduplication statistics |
| `/api/repair/deduplicate` | POST | operator | Deduplicate memories |
| `/api/checkpoints` | GET | recall | Session checkpoints by project |
| `/api/checkpoints/:sessionKey` | GET | recall | Session checkpoints by session |
| `/api/analytics/usage` | GET | analytics | Usage counters |
| `/api/analytics/errors` | GET | analytics | Recent error events |
| `/api/analytics/latency` | GET | analytics | Latency histograms |
| `/api/analytics/logs` | GET | analytics | Structured log entries |
| `/api/analytics/memory-safety` | GET | analytics | Mutation diagnostics |
| `/api/analytics/continuity` | GET | analytics | Continuity scores over time |
| `/api/analytics/continuity/latest` | GET | analytics | Latest score per project |
| `/api/telemetry/events` | GET | analytics | Query telemetry events |
| `/api/telemetry/stats` | GET | analytics | Aggregated telemetry stats |
| `/api/telemetry/export` | GET | analytics | Export telemetry as NDJSON |
| `/api/telemetry/memory-search` | GET | analytics | Query local recall QA telemetry |
| `/api/telemetry/memory-search/export` | GET | analytics | Export recall QA telemetry as NDJSON |
| `/api/git/status` | GET | local | Git sync status |
| `/api/git/pull` | POST | local | Pull from remote |
| `/api/git/push` | POST | local | Push to remote |
| `/api/git/sync` | POST | local | Pull then push |
| `/api/git/config` | GET/POST | local | Git sync configuration |
| `/api/update/check` | GET | local | Check for updates |
| `/api/update/config` | GET/POST | local | Update configuration |
| `/api/update/run` | POST | local | Apply pending update |
| `/api/tasks` | GET/POST | local | List/create scheduled tasks |
| `/api/tasks/:id` | GET/PATCH/DELETE | local | Get/update/delete task |
| `/api/tasks/:id/run` | POST | local | Trigger immediate run |
| `/api/tasks/:id/runs` | GET | local | Paginated run history |
| `/api/tasks/:id/stream` | GET | local | SSE stream of task output |
| `/api/logs` | GET | local | Daemon log access |
| `/api/logs/stream` | GET | local | SSE log streaming |
| `/mcp` | ALL | none | MCP server (Streamable HTTP) |
| `/*` | GET | none | Dashboard static files |

---

## Key Files

```
platform/core/src/
    types.ts                  TypeScript interfaces
    database.ts               SQLite wrapper (runtime-detecting)
    search.ts                 Hybrid search
    migrations/               Numbered migration scripts

platform/daemon/src/
    daemon.ts                 HTTP server + file watcher
    db-accessor.ts            withReadDb / withWriteTx wrappers
    transactions.ts           txIngestEnvelope and history helpers
    content-normalization.ts  SHA-256 dedup normalization
    analytics.ts              In-memory counters and histograms
    diagnostics.ts            Six-domain health scoring
    repair-actions.ts         Policy-gated repair functions
    session-tracker.ts        Plugin vs legacy runtime mutex
    memory-config.ts          PipelineV2Config type and defaults
    embedding-tracker.ts      Incremental embedding refresh tracker
    embedding-health.ts       Embedding health metrics
    inline-entity-linker.ts   Synchronous write-time entity linking
    memory-search.ts          Hybrid recall search orchestration
    session-checkpoints.ts    Session checkpoint persistence
    continuity-state.ts       Continuity state for compaction boundaries
    telemetry.ts              Local telemetry event collection
    feature-flags.ts          Runtime feature flags

    auth/
        types.ts              AuthMode, TokenRole, Permission
        tokens.ts             HMAC-SHA256 token sign/verify
        middleware.ts         Hono middleware: auth, scope, rate limit
        policy.ts             Permission matrix, scope enforcement

    connectors/
        registry.ts           CRUD for connectors table
        filesystem.ts         Filesystem connector

    pipeline/
        worker.ts             Extraction job worker
        extraction.ts         Shared JSON recovery/parsing helpers
        decision.ts           LLM shadow decision engine
        graph-transactions.ts entity decrement (retention purge)
        graph-search.ts       Query-time graph boost (entity resolution)
        document-worker.ts    Document ingest job worker
        retention-worker.ts   Purge worker (6-step ordered purge)
        maintenance-worker.ts Autonomous diagnostics + repair loop
        provider.ts           LlmProvider interface + Ollama impl
        reranker.ts           Optional result reranking
        prospective-index.ts  Hints worker (hypothetical query generation)
        graph-traversal.ts    Traversal-primary retrieval path
        community-detection.ts Entity community clustering (Louvain)
```

---

## Multi-Agent Support

Multiple agents can share a single Signet daemon and database. The database
uses `agent_id` columns on all key tables to keep agent data separate.

**Agent roster** is declared in `agent.yaml` under `agents.roster`. Each
entry defines a named agent and its read policy. On daemon startup the
roster is synced to the `agents` table in SQLite.

**Memory ownership** — every memory row carries:
- `agent_id TEXT DEFAULT 'default'` — which agent wrote this memory
- `visibility TEXT DEFAULT 'global'` — who can read it:
  - `global`: any agent whose read policy permits it
  - `private`: only the owning agent
  - `archived`: soft-deleted when the owning agent is removed

**Read policies** control what a given agent sees on recall:

| policy    | SQL filter |
|-----------|------------|
| `isolated` | `agent_id = self` |
| `shared`  | `visibility = 'global' OR agent_id = self` |
| `group`   | `(visibility = 'global' AND agent_id IN group) OR agent_id = self` |

The default agent uses `shared` policy for backward compatibility — existing
installs see all their memories unchanged.

**Identity inheritance** — each agent can have its own identity files under
`$SIGNET_WORKSPACE/agents/{name}/`. On session start, the daemon checks the
agent directory first for the standard identity files (`AGENTS.md`, `SOUL.md`,
`IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `MEMORY.md`,
`BOOTSTRAP.md`) and falls back to the workspace root when an agent-local file
does not exist. This lets named agents override prompt identity and working
memory without copying the whole workspace. If no agent-local `MEMORY.md`
exists, the shared root `MEMORY.md` remains the working-memory projection for
that agent. The daemon's file watcher monitors `$SIGNET_WORKSPACE/agents/`
and triggers a harness sync on change.

**OpenClaw session keys** — OpenClaw encodes the agent ID in session keys as
`agent:{id}:{rest}`. The daemon's `resolveAgentId()` helper auto-parses this
format, so memories are routed to the correct agent without any extra config.

**Per-agent workspace** — when syncing to OpenClaw, the daemon writes an
assembled `AGENTS.md` to `$SIGNET_WORKSPACE/agents/{name}/workspace/` for
each agent. OpenClaw is configured to use this directory as the agent's
workspace, giving each agent its own context on session start.

**Single-agent installs** — fully backward compatible. Omitting
`agents.roster` from `agent.yaml` keeps the single-agent behavior. All new
API parameters (`agentId`, `visibility`) are optional with sensible defaults.
