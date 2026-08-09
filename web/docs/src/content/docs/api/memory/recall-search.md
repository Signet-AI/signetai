---
title: "Recall and search"
description: "Recall, search, and find similar memories through the HTTP API."
---

### POST /api/memory/recall
Hybrid recall combining FTS5, prospective hints, vector similarity,
structured path evidence, graph traversal, and optional reranking. The daemon
authorizes candidate IDs before any content-bearing rerank, summary,
dampening, expansion, or access-tracking stage runs. Requires `recall`
permission. For the full execution model, see [Hybrid Recall](/memory/#hybrid-recall).

**Request body**

```json
{
  "query": "user preferences for editor",
  "limit": 10,
  "type": "preference",
  "tags": "editor,ui",
  "who": "claude-code",
  "pinned": false,
  "importance_min": 0.5,
  "since": "2026-01-01T00:00:00Z",
  "time": {
    "start": "2026-05-13T00:00:00.000Z",
    "end": "2026-05-14T00:00:00.000Z",
    "facets": ["session", "occurred", "source", "captured"],
    "mode": "auto"
  },
  "aggregate": false,
  "aggregateBudget": "small",
  "saveAggregate": true,
  "agentId": "alice",
  "sessionKey": "session-uuid",
  "includeRecalled": false,
  "scope": "world:alpha"
}
```

Only `query` is required. Canonical clients serialize an omitted `limit` as
`10` and bound request values to `1..100`. The search backend currently applies
a separate execution cap of 50. `scope` is an exact daemon memory-scope string,
not a selector for agent or session isolation. Use `agentId` and `sessionKey`
for those behaviors. Domain clients may use namespaced values such as
`world:alpha`.

Canonical clients also accept snake-case aliases for compatibility but emit the
camel-case wire fields shown above. False opt-in flags are omitted, except an
explicit `saveAggregate: false`, which is significant for recall-only callers.

Exact date phrases in `query`, such as `2026/05/13`, `2026-05-13`, or
`May 13 2026`, activate temporal recall automatically. A date-only query
returns a timeline assembled from existing session, source, captured-memory,
and explicit temporal-edge metadata. A date plus topic uses the date as a
filter and the remaining words as the content query. Callers can also pass a
`time` object directly. Supported temporal facets are `session`, `source`,
`captured`, `observed`, `occurred`, and `valid`; `mode` may be `auto`,
`timeline`, or `filter`.

When `sessionKey` is present, recall uses a daemon-owned context ledger keyed by
`(sessionKey, agentId, contextEpoch)`. Rows returned once in the current epoch
are suppressed by default across direct recall, hook recall, and automatic
injection paths. Sessionless recall is unchanged. Set `includeRecalled: true`
to return repeats; repeated rows are annotated with
`already_recalled: true`, and newly returned rows are still recorded.

**Response**

```json
{
  "results": [
    {
      "id": "uuid",
      "content": "User prefers vim keybindings",
      "score": 0.92,
      "source": "hybrid",
      "type": "preference",
      "tags": "preference,editor",
      "pinned": false,
      "importance": 0.9,
      "who": "claude-code",
      "project": null,
      "created_at": "2026-02-21T10:00:00.000Z",
      "temporal_facet": "occurred",
      "temporal_start_at": "2026-02-20T15:00:00.000Z",
      "temporal_end_at": "2026-02-20T15:00:00.000Z",
      "subject_type": "memory",
      "subject_id": "uuid",
      "supplementary": false,
      "already_recalled": false
    }
  ],
  "query": "user preferences for editor",
  "method": "hybrid",
  "meta": {
    "totalReturned": 1,
    "hasSupplementary": false,
    "noHits": false,
    "timings": {
      "totalMs": 14.25,
      "stages": [
        { "name": "memory_fts", "durationMs": 1.12 },
        { "name": "query_embedding_wait", "durationMs": 8.4 },
        { "name": "final_rank", "durationMs": 0.08 }
      ]
    },
    "dedupe": {
      "enabled": true,
      "contextEpoch": 0,
      "suppressed": 0,
      "repeatedReturned": 0
    },
    "temporal": {
      "mode": "filter",
      "source": "query",
      "originalQuery": "2026/05/13 editor",
      "contentQuery": "editor",
      "start": "2026-05-13T06:00:00.000Z",
      "end": "2026-05-14T06:00:00.000Z",
      "facets": ["session", "source", "occurred", "observed", "valid", "captured"]
    }
  }
}
```

Common `source` values include `hybrid`, `vector`, `keyword`, `hint`, `sec`,
`structured`, `traversal`, `ka_traversal`, `source_obsidian`,
`native_memory`, `constructed`, `graph`, and `llm_summary`.
`method` on the response reflects whether vector search was available for
this call.

`meta.totalReturned` reflects the number of returned rows. `meta.hasSupplementary`
is `true` when the response includes supporting context such as an LLM summary
card or linked rationale context. `meta.noHits` is `true` when recall completed
normally but found no matching results.
`meta.timings`, when present, reports daemon-side stage timings in
milliseconds. Aggregate recall fills the same field with aggregate-specific
stages such as `aggregate_planning`, `aggregate_followup_recalls`, and
`aggregate_synthesis`.
`meta.temporal`, when present, describes the resolved temporal window, facets,
and content query used by automatic date parsing or an explicit `time` request.
When session dedupe is enabled, `meta.dedupe.suppressed` counts rows omitted
because they were already recalled in the current epoch, and
`meta.dedupe.repeatedReturned` counts repeated rows returned only because the
caller set `includeRecalled: true`.

Set `aggregate: true` to opt into bounded aggregate recall. The daemon first
runs normal hybrid recall, optionally asks the inference router for follow-up
recall queries, synthesizes one concise answer from unique evidence rows, and
returns only that aggregate row. Normal recall ranking is unchanged when
`aggregate` is omitted or `false`.

Aggregate budgets cap total recall queries: `small` = 3, `medium` = 5,
`large` = 8. `saveAggregate` defaults to `true`; saved aggregate answers are
normal memories with `source_type: "aggregate-recall"` and tags
`aggregate,recall`. Saving requires `remember` permission; recall-only callers
can still use aggregate mode by sending `saveAggregate: false`. Repeating the
same agent/query/project/budget/source-memory set returns the same saved memory
through the aggregate idempotency key.

When no evidence exists, aggregate recall returns a no-hit shape with
`results: []` and `aggregate.stoppedReason: "no_evidence"`. When planning or
synthesis is unavailable after evidence was retrieved, recall returns that
evidence with `aggregate.partial: true`, a diagnostic message, and
`aggregate.stoppedReason` set to `router_unavailable` or `synthesis_failed`.

When the routed inference provider reports token or billing metadata,
`aggregate.usage` includes planning/synthesis totals plus per-stage target,
attempt, fallback, token, duration, and cost fields. Missing provider usage is
reported as `null` rather than estimated.

Successful aggregate responses include aggregate metadata:

```json
{
  "aggregate": {
    "savedMemoryId": "uuid",
    "saved": true,
    "deduped": false,
    "budget": "small",
    "queries": ["user preferences for editor"],
    "sourceMemoryIds": ["source-memory-id"],
    "stoppedReason": "complete",
    "usage": {
      "inputTokens": 534,
      "outputTokens": 84,
      "cacheReadTokens": 128,
      "cacheCreationTokens": null,
      "totalCost": 0.00018,
      "totalDurationMs": 812,
      "stages": [
        {
          "name": "planning",
          "targetRef": "recall-openrouter-mercury/default",
          "attemptCount": 1,
          "fallbackCount": 0,
          "inputTokens": 142,
          "outputTokens": 28,
          "cacheReadTokens": 64,
          "cacheCreationTokens": null,
          "totalCost": 0.00005,
          "totalDurationMs": 310
        }
      ]
    }
  }
}
```

When `memory.pipelineV2.reranker.useExtractionModel` is enabled, an
additional synthesized summary card may be prepended to results. This card
has `source: "llm_summary"`, `supplementary: true`, and an id of the form
`summary:<sha1-12>`. It is only injected when `limit >= 2` so callers
always receive at least one real memory to verify the summary against. The
card is not stored in the database and does not affect access-time tracking.

**Operational note**: `useExtractionModel` moves recall onto a live LLM
call path. When auth mode is not `local`, the daemon enforces a dedicated
rate-limit bucket — `auth.rateLimits.recallLlm` (default: 60 req/min per
token). Configure it in `agent.yaml` alongside the other operation limits:

```yaml
auth:
  mode: team
  rateLimits:
    recallLlm:
      windowMs: 60000
      max: 30
```

No additional permission level is required beyond `recall`.

#### Client request compatibility

| Client | Canonical default/bounds | Scope surface | Score threshold | Intentional override |
|---|---|---|---|---|
| Core, SDK | `10`, `1..100` | Any daemon scope string | SDK `minScore` is local | None |
| OpenClaw | `10`, `1..100` | Not exposed by its tool schema | `min_score` is local | Product schema exposes a focused subset |
| OpenCode | `10`, `1..100` | Exact daemon scope string | `min_score` is local | None |
| Hermes Agent | `10`, `1..100` | Agent opt-in through `agent_scoped` | `score_min` is local | Product schema exposes a focused subset |
| Unreal | NPC default `6`, `1..20` | World/player namespace | Not exposed | Always sets `includeRecalled: true` |

The versioned cross-runtime request vectors live in
`platform/core/contracts/recall-request-v1.json`.

### GET /api/memory/search

GET-compatible alias for `POST /api/memory/recall`. Forwards query parameters
to the recall endpoint. Requires `recall` permission.

**Query parameters**

| Parameter      | Description                   |
|----------------|-------------------------------|
| `q`            | Search query (required)       |
| `limit`        | Max results (default: 10)     |
| `type`         | Filter by memory type         |
| `tags`         | Filter by tag (comma-sep)     |
| `who`          | Filter by author              |
| `pinned`       | `1` or `true` to filter       |
| `importance_min` | Minimum importance float    |
| `since`        | ISO timestamp lower bound     |
| `until`        | ISO timestamp upper bound     |
| `sessionKey` / `session_key` | Session key for context dedupe |
| `includeRecalled` / `include_recalled` | `1` or `true` to return repeats |

**Response** — same shape as `POST /api/memory/recall`.

### GET /memory/search

Legacy keyword search endpoint. Also supports filter-only queries without a
search term. Requires `recall` permission.

**Query parameters**

| Parameter       | Description                                  |
|-----------------|----------------------------------------------|
| `q`             | FTS5 query string (optional)                 |
| `distinct`      | `who` — returns distinct authors instead     |
| `limit`         | Max results (default: 20 with query, 50 without) |
| `type`          | Filter by type                               |
| `tags`          | Comma-separated tag filter                   |
| `who`           | Filter by author                             |
| `pinned`        | `1` or `true`                                |
| `importance_min`| Float minimum                                |
| `since`         | ISO timestamp                                |

When `distinct=who` is passed, all other parameters are ignored and the
response is `{ "values": ["alice", "bob"] }`.

Otherwise: `{ "results": [...] }` where each result includes `id`, `content`,
`created_at`, `who`, `importance`, `tags`, `type`, `pinned`, and optionally
`score` (BM25 or recency-weighted).

### GET /memory/similar

Vector similarity search anchored to an existing memory's embedding. Returns
memories most similar to the given record. Requires `recall` permission.

**Query parameters**

| Parameter | Description                              |
|-----------|------------------------------------------|
| `id`      | Memory ID to use as the anchor (required)|
| `k`       | Number of results (default: 10)          |
| `type`    | Optional type filter                     |

**Response**

```json
{
  "results": [
    {
      "id": "uuid",
      "content": "...",
      "type": "preference",
      "tags": [],
      "score": 0.87,
      "confidence": null,
      "created_at": "2026-02-21T10:00:00.000Z"
    }
  ]
}
```

Returns `404` if the anchor memory has no stored embedding.
