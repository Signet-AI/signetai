---
title: "Analytics"
description: "Usage analytics, timeline, and metrics."
---

The Signet [Daemon](/daemon/) exposes real-time operational visibility through three
subsystems: an in-memory analytics accumulator, an incident timeline
builder, and a health [Diagnostics](/diagnostics/) scorer. Together they let operators
understand what the daemon is doing right now, reconstruct what happened
to a specific memory or request, and get a structured assessment of
overall system health.


## Overview

Analytics counters are entirely ephemeral. They reset when the daemon
restarts. This is intentional — durable history already exists in the
`memory_history` table and structured logs, so the analytics layer
doesn't need to duplicate that. Its job is to give you fast, in-process
counts and latency distributions for the current daemon lifetime without
any write overhead.

If you need to track trends across restarts, read from `memory_history`
and the log files directly. The analytics endpoints are a real-time
operational view, not a database replacement. For the complete endpoint
reference, see [Api](/api/).


## Usage Counters

`GET /api/analytics/usage` returns a `UsageCounters` object with four
maps, each keyed by a string identifier.

**Endpoint stats** are keyed by `"METHOD /path"` (e.g.,
`"POST /api/memory/remember"`). Each entry tracks the total request
count, the number of responses with status >= 400, and the cumulative
latency in milliseconds. Divide `totalLatencyMs` by `count` for a
rough average latency per endpoint.

**Actor stats** are keyed by actor identity — either the `x-signet-actor`
request header or the `sub` field from a bearer token, whichever is
present. Each actor entry counts total `requests`, plus broken-out
counts for `remembers`, `recalls`, and `mutations`. The classification
is path-based: paths containing `/remember` or `/save` count as
remembers; `/recall`, `/search`, or `/similar` count as recalls;
`/modify`, `/forget`, or `/recover` count as mutations; everything else
increments `requests`.

**Provider stats** track LLM/embedding provider calls by provider name
(e.g., `"ollama"`). Each entry has `calls`, `failures`, and
`totalLatencyMs`. The `failures` count increments when `recordProvider`
is called with `success: false`.

**Connector stats** are keyed by connector ID and track `syncs`,
`errors`, and `documentsProcessed` — coarse throughput metrics for each
registered harness connector.


## Error Taxonomy

Errors are captured in a ring buffer (default capacity: 500 entries)
and organized by pipeline stage. The taxonomy is fixed:

- **extraction**: `EXTRACTION_TIMEOUT`, `EXTRACTION_PARSE_FAIL`
- **decision**: `DECISION_TIMEOUT`, `DECISION_INVALID`
- **embedding**: `EMBEDDING_PROVIDER_DOWN`, `EMBEDDING_TIMEOUT`
- **mutation**: `MUTATION_CONFLICT`, `MUTATION_SCOPE_DENIED`
- **connector**: `CONNECTOR_SYNC_FAIL`, `CONNECTOR_AUTH_FAIL`

Each error entry includes a timestamp, stage, code, message, and
optional `requestId`, `memoryId`, and `actor` fields for correlation.
When the buffer is full, the oldest entry is evicted to make room.

`GET /api/analytics/errors` returns recent errors. You can filter by
`stage` (query param) and `since` (ISO timestamp), and limit the
number of results returned.


## Latency Histograms

Four operations are tracked: `remember`, `recall`, `mutate`, and `jobs`.
Each maintains a rolling window of the last 1,000 samples. When the
window is full, the oldest sample is dropped.

`GET /api/analytics/latency` returns a snapshot for each operation with
`p50`, `p95`, `p99`, `count`, and `mean` in milliseconds. If a histogram
has no samples yet, all values are zero. The percentile calculation sorts
the sample window on demand, so there's a small sort cost on the first
read after new samples are recorded.


## Timeline

The timeline builder answers the question "what happened to this thing?"
Given any entity ID — a memory ID, a job ID, a request ID, or a session
ID — it assembles a chronological list of everything the system recorded
about that entity.

Entity detection works by probing the database in order: first
`memory_history` by `memory_id`, then `memories` by `id`, then
`memory_jobs` by job `id` (which resolves to the associated `memory_id`).
If the ID doesn't match anything in the database, the entity type is
marked `"unknown"` — which can happen for request IDs and session IDs
that exist only in logs and the error buffer.

Once the entity type is resolved, the builder collects four kinds of
events:

**History events** come from `memory_history`. Each row produces one
event with the history event name (e.g., `"created"`, `"updated"`,
`"deleted"`, `"recovered"`), the actor that made the change, and flags
indicating whether old and new content were present.

**Job lifecycle events** come from `memory_jobs`. Each job row can
produce up to four events: `job:<type>:created`, `job:<type>:leased`,
`job:<type>:completed`, and `job:<type>:failed`, depending on which
timestamp columns are non-null.

**Log events** are drawn from the in-memory log ring buffer (up to 500
recent entries). A log entry matches if the entity ID appears anywhere
in `entry.message` or in any string value of `entry.data`.

**Error events** are drawn from the analytics error buffer (up to 500
recent entries). An error matches if `entry.memoryId`, `entry.requestId`,
or `entry.message` contains the entity ID.

All events from all sources are merged and sorted by timestamp before
being returned.

`GET /api/timeline/:id` — build a timeline for any entity ID.

`GET /api/timeline/:id/export` — same data in an export-friendly format.


## Diagnostics

The diagnostics subsystem produces a structured health report across six
domains. Each domain returns a score from 0 to 1 and a status string
(`"healthy"`, `"degraded"`, or `"unhealthy"`). Status thresholds are:
healthy >= 0.8, degraded >= 0.5, unhealthy < 0.5.

**Queue** (weight 0.28) examines `memory_jobs` for the pending job depth,
the age of the oldest pending job, the dead-job rate over the last 24
hours, and the count of jobs stuck in `"leased"` status for more than
10 minutes. Penalties: depth > 50 (-0.3), dead rate > 1% (-0.3), oldest
job age > 300 seconds (-0.2), lease anomalies present (-0.2).

**Storage** (weight 0.14) looks at total memory rows and the tombstone
ratio (soft-deleted rows / total rows). A tombstone ratio above 30%
deducts 0.3. The `dbSizeBytes` field is always 0 from a read connection
— it's present in the type for future use.

**Index** (weight 0.19) compares the FTS5 content table row count against
active (non-deleted) memory rows, and measures embedding coverage —
the fraction of active memories that have an `embedding_model` set (see
[Memory](/memory/) for how memories are stored). FTS mismatch (FTS row count
more than 10% above active count, indicating tombstones are surfacing
in full-text search) deducts 0.5. Embedding
coverage below 80% deducts 0.3.

**Provider** (weight 0.24) uses a separate in-memory ring buffer
(`ProviderTracker`) that records the last 100 provider call outcomes
(`success`, `failure`, `timeout`). The score equals the availability
rate (successes / total). With no data yet, the rate defaults to 1.0.

**Mutation** (weight 0.10) queries `memory_history` for `recovered` and
`deleted` events in the last 7 days. More than 5 recoveries in that
window suggests repeated wrong-target deletes and deducts 0.3.

**Connector** (weight 0.05) reads the [Connectors](/connectors/) table for total
connector count, how many are currently syncing, how many have a
non-null `last_error`, and the age of the oldest unresolved error.
Any errors deduct 0.3; an error older than 24 hours deducts an
additional 0.2. If the `connectors` table doesn't exist (older
database), the domain scores a perfect 1.0.

The composite score is a weighted average of all six domain scores,
clamped to [0, 1].


## Diagnostics API

`GET /api/diagnostics` — full report with composite score and all six
domain health objects.

`GET /api/diagnostics/:domain` — single domain detail. Valid domain
names: `queue`, `storage`, `index`, `provider`, `mutation`, `connector`.

`GET /api/analytics/memory-safety` — mutation health metrics (alias
into the mutation domain for memory integrity monitoring).

`GET /api/analytics/logs` — alias for structured log access.


## PostHog Telemetry

Separate from the in-memory analytics above, the daemon ships an
anonymous telemetry collector for understanding install and usage
patterns (see [Configuration](/configuration/)). It buffers events to SQLite and
flushes them in batches to a PostHog instance when both `posthogHost`
and `posthogApiKey` are configured (`telemetryEnabled` defaults to
true; set it to `false` to opt out).

The event catalog, privacy contract, the open JSONL audit log, and how to
query the project live in **[TELEMETRY.md](https://github.com/Signet-AI/signetai/blob/main/docs/TELEMETRY.md)** — the single
telemetry reference. Telemetry carries no memory content, user identity,
agent ids, or file paths; each install uses a random persisted anonymous id
and every event is mirrored to the auditable JSONL log. `pipeline.error` is
emitted for categorized extraction, decision, and embedding failures with
stage/code-only properties. The remaining `pipeline.extraction` and
`pipeline.decision` event types are declared for future use but not yet
emitted.

Privacy contract:

- Events carry no memory content, user identity, agent ids, or file paths.
- Each install gets a random anonymous id (persisted in the workspace
  database) used as the PostHog `distinct_id`, so installs are countable
  but not identifiable.
- Telemetry is on by default and can be disabled with
  `telemetryEnabled: false`.
- Every recorded event is mirrored to an open, inspectable JSONL log at
  `<agentsDir>/.daemon/telemetry/events.jsonl`, so users can audit
  exactly what was sent. CLI `command.invoked` events are also queued in the
  workspace database when remote delivery is configured and a telemetry SQLite
  database is available, then flushed to PostHog in bounded, best-effort
  batches without awaiting the command. Fresh workspaces without that database
  remain local-only; the CLI reads the same persisted install id as the daemon.

Events recorded: `daemon.heartbeat` (every 5 minutes), the `inference.*`
lifecycle (`route`, `execute`, `stream`, `fallback`), `llm.generate`
(provider, latency, token and cost counts when reported, success — never
prompt text), `session.start` / `session.end` (harness and prompt count),
the lifecycle events `daemon.started`, `command.invoked`,
`error.occurred` (sanitized crash report — truncated message with user
paths stripped, top stack frames with home directories removed, uptime;
plus rate-limited `EventLoopLag` reports with measured lag), and
`version.upgraded`, `install.activated` (first daemon run of a new
install — covers bun/desktop installs the npm postinstall ping never
sees), and `config.snapshot` (first-run feature flags, embedding provider
and model, local/remote inference mode, and configured harnesses). The
per-install harness mix is queryable from `session.start.harness` events
because they share the same anonymous `distinct_id`. `pipeline.embedding`
(tokens, provider, sourceKind — memory capture / artifact index / recall /
dreaming), and `dreaming.pass`
(provider-reported input/output/cache tokens and cost per agentic
pass, plus bounded outcomes and content-free artifact, durable-effect,
tool-call, and duration counters). `dreaming.pass` never includes artifact
names, memory text, prompts, tool arguments, source paths, or raw agent
identities; unavailable provider usage remains null rather than inferred zero
usage. The remaining `pipeline.*` event types are declared
for future use but not yet emitted.

## Release Download Stats

GitHub tracks download counts per release asset. Unlike npm download totals —
which include CI pipelines, `npx` one-offs, and version-update churn — each
release asset download is a real binary or connector-tarball fetch, so it is
the cleaner install signal (issue #1026 Phase 3).

```sh
bun scripts/release-download-stats.ts              # markdown table
bun scripts/release-download-stats.ts --json       # NDJSON for dashboards
bun scripts/release-download-stats.ts --releases 5 # last N releases
```

The script queries the public GitHub REST API for `Signet-AI/signetai`
releases (no auth required; unauthenticated rate limit of 60 req/hr is
plenty) and aggregates `download_count` per release and per asset, sorted
by downloads descending. Output includes the total across the window.
