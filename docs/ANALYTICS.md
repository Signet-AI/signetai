Analytics, Timeline, and Diagnostics
===

The Signet daemon exposes real-time operational visibility through three
subsystems: an in-memory analytics accumulator, an incident timeline
builder, and a health diagnostics scorer. Together they let operators
understand what the daemon is doing right now, reconstruct what happened
to a specific memory or request, and get a structured assessment of
overall system health.


Overview
---

Analytics counters are entirely ephemeral. They reset when the daemon
restarts. This is intentional — durable history already exists in the
`memory_history` table and structured logs, so the analytics layer
doesn't need to duplicate that. Its job is to give you fast, in-process
counts and latency distributions for the current daemon lifetime without
any write overhead.

If you need to track trends across restarts, read from `memory_history`
and the log files directly. The analytics endpoints are a real-time
operational view, not a database replacement.


Usage Counters
---

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


Error Taxonomy
---

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


Latency Histograms
---

Four operations are tracked: `remember`, `recall`, `mutate`, and `jobs`.
Each maintains a rolling window of the last 1,000 samples. When the
window is full, the oldest sample is dropped.

`GET /api/analytics/latency` returns a snapshot for each operation with
`p50`, `p95`, `p99`, `count`, and `mean` in milliseconds. If a histogram
has no samples yet, all values are zero. The percentile calculation sorts
the sample window on demand, so there's a small sort cost on the first
read after new samples are recorded.


Timeline
---

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


Diagnostics
---

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
the fraction of active memories that have an `embedding_model` set. FTS
mismatch (FTS row count more than 10% above active count, indicating
tombstones are surfacing in full-text search) deducts 0.5. Embedding
coverage below 80% deducts 0.3.

**Provider** (weight 0.24) uses a separate in-memory ring buffer
(`ProviderTracker`) that records the last 100 provider call outcomes
(`success`, `failure`, `timeout`). The score equals the availability
rate (successes / total). With no data yet, the rate defaults to 1.0.

**Mutation** (weight 0.10) queries `memory_history` for `recovered` and
`deleted` events in the last 7 days. More than 5 recoveries in that
window suggests repeated wrong-target deletes and deducts 0.3.

**Connector** (weight 0.05) reads the `connectors` table for total
connector count, how many are currently syncing, how many have a
non-null `last_error`, and the age of the oldest unresolved error.
Any errors deduct 0.3; an error older than 24 hours deducts an
additional 0.2. If the `connectors` table doesn't exist (older
database), the domain scores a perfect 1.0.

The composite score is a weighted average of all six domain scores,
clamped to [0, 1].


Diagnostics API
---

`GET /api/diagnostics` — full report with composite score and all six
domain health objects.

`GET /api/diagnostics/:domain` — single domain detail. Valid domain
names: `queue`, `storage`, `index`, `provider`, `mutation`, `connector`.

`GET /api/analytics/memory-safety` — mutation health metrics (alias
into the mutation domain for memory integrity monitoring).

`GET /api/analytics/logs` — alias for structured log access.
