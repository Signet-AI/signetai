---
title: "Telemetry and logs API"
description: "Analytics, telemetry, log, MCP, and scheduled task endpoints."
order: 20
section: "Reference"
---

# Telemetry and logs API

Analytics, telemetry, log, MCP, and scheduled task endpoints.

[Back to HTTP API overview](../API.md).

## Analytics

Requires `analytics` permission.

### GET /api/analytics/usage

Aggregate request counts, memory operation totals, and per-endpoint hit
counts collected since daemon start.

**Response** — collector-defined usage summary object.

### GET /api/analytics/errors

Recent error events from the analytics collector.

**Query parameters**

| Parameter | Description                                   |
|-----------|-----------------------------------------------|
| `stage`   | Filter by pipeline stage (e.g., `mutation`)   |
| `since`   | ISO timestamp — only errors after this time   |
| `limit`   | Max errors to return                          |

**Response**

```json
{
  "errors": [ { "stage": "mutation", "message": "...", "at": "..." } ],
  "summary": { "total": 5, "byStage": { "mutation": 5 } }
}
```

### GET /api/analytics/latency

Latency histograms for key operation groups: `remember`, `recall`, `mutate`.

**Response** — collector-defined latency object with p50/p95/p99 per group.

### GET /api/analytics/logs

Recent structured log entries. Same data as `GET /api/logs` but namespaced
under analytics.

**Query parameters**

| Parameter  | Description                                           |
|------------|-------------------------------------------------------|
| `limit`    | Max log entries (default: 100)                        |
| `level`    | `debug`, `info`, `warn`, or `error`                   |
| `category` | Filter by log category (e.g., `memory`, `pipeline`)   |
| `since`    | ISO timestamp lower bound                             |

**Response**

```json
{ "logs": [...], "count": 47 }
```

### GET /api/analytics/memory-safety

Combined view of mutation diagnostics and recent mutation errors. Useful for
auditing data integrity.

**Response**

```json
{
  "mutation": { ... },
  "recentErrors": [ ... ],
  "errorSummary": { ... }
}
```

### GET /api/analytics/continuity

Session continuity scores over time. Tracks how well memory injection
maintains context across sessions.

**Query parameters**

| Parameter | Type    | Description                                    |
|-----------|---------|------------------------------------------------|
| `project` | string | Filter by project path (optional)              |
| `limit`   | integer | Max scores to return (default: 50)             |

**Response**

```json
{
  "scores": [
    {
      "id": "uuid",
      "session_key": "abc-123",
      "project": "/path/to/project",
      "harness": "claude-code",
      "score": 0.85,
      "memories_recalled": 12,
      "memories_used": 8,
      "novel_context_count": 3,
      "reasoning": "...",
      "created_at": "2026-02-21T10:00:00.000Z"
    }
  ],
  "summary": {
    "count": 50,
    "average": 0.78,
    "trend": 0.05,
    "latest": 0.85
  }
}
```

### GET /api/analytics/continuity/latest

Latest continuity score per project. Returns one row per project, ordered
by most recent.

**Response**

```json
{
  "scores": [
    { "project": "/path/to/project", "score": 0.85, "created_at": "2026-02-21T10:00:00.000Z" }
  ]
}
```


## Telemetry

Telemetry endpoints expose local event data collected by the daemon. The
standard event stream excludes prompt text, memory content, credentials, and
session references. Recall QA telemetry is a separate local-only ledger that
intentionally stores query text and result snapshots for manual review, so it
requires `analytics` permission and is never forwarded to external telemetry
sinks.

### GET /api/telemetry/events

Query raw telemetry events.

**Query parameters**

| Parameter | Type    | Description                                    |
|-----------|---------|------------------------------------------------|
| `event`   | string  | Filter by event type (e.g., `llm.generate`)    |
| `since`   | string  | ISO timestamp lower bound                      |
| `until`   | string  | ISO timestamp upper bound                      |
| `limit`   | integer | Max events (default: 100)                      |

**Response**

```json
{
  "events": [
    {
      "event": "llm.generate",
      "properties": { "inputTokens": 500, "outputTokens": 200, "durationMs": 1200 },
      "timestamp": "2026-02-21T10:00:00.000Z"
    }
  ],
  "enabled": true
}
```

Inference emits additional local-first telemetry events:

- `inference.route`
- `inference.execute`
- `inference.stream`
- `inference.fallback`

These events intentionally exclude raw prompts, response text, secrets,
credentials, and session references.

### GET /api/telemetry/stats

Aggregated telemetry statistics since daemon start or since a given timestamp.

**Query parameters**

| Parameter | Type   | Description                           |
|-----------|--------|---------------------------------------|
| `since`   | string | ISO timestamp lower bound (optional)  |

**Response**

```json
{
  "enabled": true,
  "totalEvents": 500,
  "llm": {
    "calls": 120,
    "errors": 2,
    "totalInputTokens": 60000,
    "totalOutputTokens": 24000,
    "totalCost": 0.45,
    "p50": 800,
    "p95": 2400
  },
  "inference": {
    "routes": 40,
    "executes": 18,
    "streams": 4,
    "errors": 3,
    "cancelled": 1,
    "fallbacks": 5,
    "p50": 120,
    "p95": 900
  },
  "pipelineErrors": 3
}
```

### GET /api/telemetry/export

Export raw telemetry events as newline-delimited JSON (NDJSON).

**Query parameters**

| Parameter | Type    | Description                           |
|-----------|---------|---------------------------------------|
| `since`   | string  | ISO timestamp lower bound (optional)  |
| `limit`   | integer | Max events (default: 10000)           |

**Response** — `Content-Type: application/x-ndjson`. Each line is a
JSON-serialized telemetry event. Returns `404` if telemetry is not enabled.

### GET /api/telemetry/memory-search

Query local recall QA telemetry captured when
`telemetry.memorySearchQaEnabled: true`.

**Query parameters**

| Parameter     | Type    | Description                                      |
|---------------|---------|--------------------------------------------------|
| `agent_id`    | string  | Filter by agent id                               |
| `session_key` | string  | Filter by session key                            |
| `route`       | string  | Filter by recall route                           |
| `since`       | string  | ISO timestamp lower bound                        |
| `until`       | string  | ISO timestamp upper bound                        |
| `no_hits`     | boolean | Filter to no-hit or hit-producing searches       |
| `limit`       | integer | Max rows, clamped to 1-500, default 100          |
| `offset`      | integer | Pagination offset, default 0                     |

**Response**

```json
{
  "items": [
    {
      "id": "search-event-id",
      "created_at": "2026-05-06T21:22:00.000Z",
      "route": "POST /api/memory/recall",
      "agent_id": "ant",
      "session_key": "session-1",
      "query": "what did we decide about recall qa",
      "filters": { "limit": 10, "readPolicy": "isolated" },
      "result_count": 1,
      "top_score": 0.91,
      "no_hits": false,
      "duration_ms": 12.34,
      "results": [
        {
          "rank": 1,
          "id": "memory-id",
          "score": 0.91,
          "source": "memory",
          "content": "Captured recall result content..."
        }
      ]
    }
  ],
  "count": 1
}
```

### GET /api/telemetry/memory-search/export

Export local recall QA telemetry as newline-delimited JSON. Supports the
same filters as `GET /api/telemetry/memory-search`; `limit` is clamped to
1-10000.


## Logs

### GET /api/logs

Return recent structured log entries from the in-memory log buffer.

**Query parameters**

| Parameter  | Description                                           |
|------------|-------------------------------------------------------|
| `limit`    | Max entries (default: 100)                            |
| `level`    | Minimum level: `debug`, `info`, `warn`, `error`       |
| `category` | Filter by category string                             |
| `since`    | ISO timestamp — only logs after this time             |

**Response**

```json
{ "logs": [...], "count": 100 }
```

### GET /api/logs/stream

Server-Sent Events stream of live log output. Each event is a JSON-serialized
`LogEntry`. The connection sends an initial `{"type":"connected"}` event and
then emits entries in real time as the daemon generates them.

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Each SSE event:

```
data: {"level":"info","category":"memory","message":"Memory saved","at":"..."}
```

The stream stays open until the client disconnects.


## MCP Server

### ALL /mcp

Model Context Protocol endpoint using Streamable HTTP transport (stateless).
Supports POST (send messages), GET (SSE stream), and DELETE (session teardown).

Exposes memory/session tools: `memory_search`, `session_search`,
`memory_store`, `memory_get`, `memory_list`, `memory_modify`, `memory_forget`.
See `docs/MCP.md` for full tool documentation.

**POST /mcp** — Send MCP JSON-RPC messages. Returns JSON or SSE stream.

**GET /mcp** — Open an SSE stream for server-initiated notifications.

**DELETE /mcp** — Terminate MCP session (no-op in stateless mode).


## Scheduled Tasks

### GET /api/tasks

List all scheduled tasks with their last run status.

**Response**

```json
{
  "tasks": [{
    "id": "uuid",
    "name": "Review open PRs",
    "prompt": "Review all open pull requests",
    "cron_expression": "0 9 * * *",
    "harness": "claude-code",
    "working_directory": "/path/to/project",
    "enabled": 1,
    "last_run_at": "2026-02-23T09:00:00Z",
    "next_run_at": "2026-02-24T09:00:00Z",
    "last_run_status": "completed",
    "last_run_exit_code": 0
  }],
  "presets": [
    {"label": "Every 15 min", "expression": "*/15 * * * *"},
    {"label": "Hourly", "expression": "0 * * * *"},
    {"label": "Daily 9am", "expression": "0 9 * * *"},
    {"label": "Weekly Mon 9am", "expression": "0 9 * * 1"}
  ]
}
```

### POST /api/tasks

Create a new scheduled task.

**Request body**

```json
{
  "name": "Review open PRs",
  "prompt": "Review all open pull requests and summarize findings",
  "cronExpression": "0 9 * * *",
  "harness": "claude-code",
  "workingDirectory": "/path/to/project"
}
```

**Response** (201)

```json
{"id": "uuid", "nextRunAt": "2026-02-24T09:00:00Z"}
```

### GET /api/tasks/:id

Get a single task with its 20 most recent runs.

### PATCH /api/tasks/:id

Update a task's name, prompt, cron, harness, working directory, or enabled state.

### DELETE /api/tasks/:id

Delete a task and all its run history (cascade).

### POST /api/tasks/:id/run

Trigger an immediate manual run. Returns 202 with `runId`. Returns 409 if
the task already has a running execution. Skill usage analytics are
attributed using non-breaking task scope hints when available.

### GET /api/tasks/:id/runs

Paginated run history. Supports `limit` and `offset` query parameters.

### GET /api/tasks/:id/stream

Server-Sent Events stream of live task output. Replays buffered output on
connect, then streams new events in real time. Sends keepalive comments
every 15 seconds.

**Event types**

| Type           | Description                              |
|----------------|------------------------------------------|
| `connected`    | Initial connection confirmation           |
| `run-started`  | A run has begun (includes `runId`)        |
| `run-output`   | Stdout or stderr chunk (`stream` field)   |
| `run-completed`| Run finished (includes `exitCode`)        |

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```
