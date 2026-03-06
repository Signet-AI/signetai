# Signet Insight Engine — PR Integration Guide

This document describes how to integrate the `signet-insight-engine` companion
service into the `signetai` daemon. The companion service runs standalone today,
but the long-term goal is to merge these features directly into the Signet daemon.

---

## What Was Built (Standalone Companion)

The companion service runs on port **3851** alongside the Signet daemon (3850).
It shares the same `memories.db` via SQLite WAL mode — safe for concurrent access
because the companion ONLY writes to new tables and a new column.

```
Port 3850: signet daemon (existing — untouched)
Port 3851: signet-insight-engine (new companion)
```

---

## DB Changes Required

Two migration files in `./migrations/`:

### Migration 001 — New tables
```sql
CREATE TABLE insights (
  id TEXT PRIMARY KEY,
  cluster_entity_id TEXT,
  cluster_label TEXT,
  source_memory_ids TEXT NOT NULL DEFAULT '[]',
  source_entity_ids TEXT DEFAULT '[]',
  insight TEXT NOT NULL,
  connections TEXT DEFAULT '[]',
  themes TEXT DEFAULT '[]',
  importance REAL DEFAULT 0.7,
  model_used TEXT,
  synthesis_version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  applied_to_synthesis INTEGER DEFAULT 0,
  is_deleted INTEGER DEFAULT 0
);

CREATE TABLE insight_sources (
  insight_id TEXT NOT NULL REFERENCES insights(id),
  memory_id  TEXT NOT NULL,
  PRIMARY KEY (insight_id, memory_id)
);
```

### Migration 002 — New column on memories
```sql
ALTER TABLE memories ADD COLUMN insight_processed_at TEXT;
```

Safe to run: `ALTER TABLE ADD COLUMN` in SQLite is non-destructive.
If column already exists, the migration script ignores the error.

---

## New Daemon Jobs to Integrate

### InsightSynthesizer (src/insight-synthesizer/)

Runs on a cron schedule (`0 */6 * * *` by default). Can also be triggered
via the `scheduled_tasks` table (which the daemon already reads).

The job:
1. Queries `entities` for top-N by `mentions`
2. Fetches related memories via `memory_entity_mentions` JOIN
3. Calls Claude Haiku with a cross-linking synthesis prompt
4. Stores results in `insights` + `insight_sources`
5. Marks processed memories with `insight_processed_at`

**Integration point**: Add as a new worker in the daemon's job scheduler.
Use the existing `scheduled_tasks` + `task_runs` infrastructure.

Config keys to add to `agent.yaml` schema:
```yaml
insights:
  enabled: true
  scheduleExpression: "0 */6 * * *"
  minMemoriesPerCluster: 3
  maxMemoriesPerBatch: 10
  maxClustersPerRun: 5
  model: haiku
  topEntityCount: 30
  reprocessAfterDays: 7
  applyToSynthesis: true
```

### InboxWatcher (src/inbox-watcher/)

File system watcher that auto-ingests files dropped in a configured directory.
Uses the existing `ingestion_jobs` + `connectors` tables (already in schema, never activated).

**Integration point**: Add as a new connector type (`filesystem`) in the connectors system.
The `connectors` table already exists — just needs a worker that reads `provider='filesystem'` rows.

Config keys:
```yaml
inbox:
  enabled: false
  watchPath: "~/inbox"
  pollIntervalMs: 5000
  audio:
    enabled: true
    transcriber: whisper
    model: base
  image:
    enabled: true
    model: haiku
  video:
    enabled: false
  maxFileSizeMb: 50
  processedBehavior: mark
```

---

## New API Endpoints

These endpoints exist in the companion at port 3851. 
For integration into the main daemon (3850), add these routes to the existing HTTP server.

### Insights API
```
GET  /api/insights                   — list (paginated)
GET  /api/insights/:id               — single + sources
POST /api/insights/run               — trigger synthesis
POST /api/insights/:id/pin           — toggle synthesis flag
DELETE /api/insights/:id             — soft delete
GET  /api/insights/entity/:entityId  — by entity
GET  /api/insights/memory/:memoryId  — by source memory
GET  /api/insights/stats             — stats
```

### Graph API (new — uses existing entities/relations tables)
```
GET  /api/graph/entities             — top entities for visualization
GET  /api/graph/entities/:id         — entity detail + relations
GET  /api/graph/relations            — relations with entity names
GET  /api/graph/overview             — entity/relation counts
```

### Inbox API
```
GET  /api/inbox/status               — watcher status
GET  /api/inbox/jobs                 — ingestion job history
POST /api/inbox/ingest               — manual file ingest
```

### Memory Citations (enhancement to existing search)
```
GET  /api/memory/search?q=...        — existing search + citation IDs in response
GET  /api/memory/:id/insights        — insights referencing this memory
```

---

## Source Citation Format

When search results are returned, add a `citation` field to each memory:
```json
{
  "id": "a3f29c12-...",
  "content": "User prefers dark mode",
  "citation": "M:a3f2"
}
```

`citation` = `"M:" + id.replace(/-/g, '').substring(0, 4)`

Also add `"citations": ["M:a3f2", "M:cc81"]` at the top level of search responses.

Update SKILL.md instructions to tell agents to cite memory IDs when stating facts.

---

## Dashboard

The companion serves a full dashboard at `http://localhost:3851` with three tabs:
- **Insights**: Generated insights with source memory drill-down
- **Graph**: D3 force-directed entity/relation visualization
- **Inbox**: Ingestion job history and file watcher status

For integration: this can be a new route in the existing Signet dashboard,
or kept as a standalone companion page.

---

## What Was NOT Changed

To be explicit about safety boundaries:

| Component | Changed? | Notes |
|---|---|---|
| `memories` table schema | NO — added 1 nullable column | `ALTER TABLE ADD COLUMN insight_processed_at TEXT` |
| Vector embeddings | NO | `vec_embeddings` table untouched |
| Hybrid search alpha (0.7) | NO | `agent.yaml` search.alpha untouched |
| Decay scoring (0.95^ageDays) | NO | Daemon decay logic untouched |
| Extraction pipeline | NO | pipelineV2 config untouched |
| Contradiction detection | NO | semanticContradictionEnabled untouched |
| Reranker | NO | rerankerEnabled untouched |
| Harness sync | NO | AGENTS.md/SOUL.md write-back untouched |
| MEMORY.md synthesis | NO | Only adds `applied_to_synthesis` flag for opt-in |
| Pinned memory behavior | NO | pinned column/logic untouched |
| Identity files | NO | Never touched by any new job |
| `entities` / `relations` tables | READ-ONLY | Only queried for clustering, never written |
| `memory_entity_mentions` | READ-ONLY | Only queried for clustering |
| `memory_jobs` | NOT USED | New jobs use `scheduled_tasks` pattern |
