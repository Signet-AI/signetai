---
title: "Platform services"
description: "Authentication, analytics, connectors, diagnostics, and repair architecture."
---

## Auth Middleware

The daemon supports three deployment modes, controlled by `authMode`
in the config.

**local** (default): no authentication required. All requests are
accepted and `auth` is set to `{ authenticated: false, claims: null }`.
Rate limiting is also skipped in local mode.

**team**: a Bearer token is required on every request. Tokens are
HMAC-SHA256 signed using a 32-byte secret loaded from disk. The token
format is `base64url(payload).base64url(hmac)`. Payload is a JSON
object with `sub`, `scope`, `role`, `iat`, and `exp` fields. Expired
or malformed tokens return 401.

**hybrid**: localhost requests (identified by the `Host` header)
bypass the token requirement and get implicit full access. Remote
requests require a valid token. In hybrid mode, if a localhost caller
sends a token anyway, it is validated and its claims are used.

**Roles and permissions**: four roles exist — `admin`, `operator`,
`agent`, and `readonly`. Each role maps to a static permission set.

| Role | Permissions |
|------|-------------|
| admin | all |
| operator | all except `admin` |
| agent | remember, recall, modify, forget, recover, documents |
| readonly | recall only |

The `requirePermission` middleware enforces permission checks per
route. The `requireScope` middleware checks whether a token's scope
(project, agent, user fields) matches the request target. Unscoped
tokens and admin-role tokens bypass scope checks.

**Rate limiting** (`rate-limiter.ts`): a sliding-window rate limiter
keyed by `actor:operation`. In team and hybrid modes, the actor is
the token's `sub` claim or the `x-signet-actor` header. When the
limit is exceeded, the response is 429 with a `Retry-After` header.

---

## Analytics

`platform/daemon/src/analytics.ts` implements an in-memory [Analytics](/analytics/)
accumulator. All state is ephemeral — it resets on daemon restart.
Durable history lives in `memory_history` and structured logs.

**Usage counters**: four Maps track endpoints, actors, providers, and
connectors. Endpoint stats record call count, error count, and total
latency. Actor stats classify requests as remember/recall/mutate/other
by path pattern. Provider stats track LLM call count, failures, and
latency. Connector stats track syncs, errors, and documents processed.

**Error ring buffer**: a fixed-capacity array (default 500 entries)
of `ErrorEntry` records. When full, the oldest entry is evicted. Each
entry carries timestamp, stage, error code, message, and optional
memory ID and actor. Error codes form a taxonomy by stage:
`EXTRACTION_TIMEOUT`, `EXTRACTION_PARSE_FAIL`, `DECISION_TIMEOUT`,
`DECISION_INVALID`, `EMBEDDING_PROVIDER_DOWN`, `EMBEDDING_TIMEOUT`,
`MUTATION_CONFLICT`, `MUTATION_SCOPE_DENIED`, `CONNECTOR_SYNC_FAIL`,
`CONNECTOR_AUTH_FAIL`.

**Latency histograms**: four operations are tracked (`remember`,
`recall`, `mutate`, `jobs`) using a ring-buffer of 1,000 samples each.
Snapshots expose p50, p95, p99, count, and mean. The sort is deferred
until a snapshot is requested.

---

## Connector Framework

The connector framework manages external data source integrations that
push documents and memories into the [Pipeline](/pipeline/). It is distinct from the
[harness connector packages](/harnesses/) (claude-code, opencode, openclaw, oh-my-pi, pi) — those
handle platform hook installation; this framework handles ongoing sync.

**Registry** (`connectors/registry.ts`): CRUD operations on the
`connectors` table. `registerConnector` inserts a new row with
`status = 'idle'` and returns its UUID. `updateConnectorStatus`
transitions a connector between `idle`, `syncing`, and `error` states.
`updateCursor` persists the sync cursor after a successful run. The
cursor is a JSON object stored in `cursor_json`; it tracks the
high-water mark for incremental sync (typically a timestamp or offset).

**Filesystem connector** (`connectors/filesystem.ts`): watches a
directory path, ingests files as documents, and tracks the cursor
based on file modification times.

**Document count** is tracked by querying `documents.source_url` with
a prefix match against the connector's configured root path.

**Health**: connector health is one of the six diagnostic domains.
It measures the count of connectors with `last_error IS NOT NULL` and
the age of the oldest unresolved error.

---

## Diagnostics and Repair

`platform/daemon/src/diagnostics.ts` provides read-only health signals
across six domains. All functions accept a `ReadDb` or `ProviderTracker`
and return plain data — no mutations, no side effects.

**Composite score**: each domain score is multiplied by a fixed weight
and summed. Scores range from 0 to 1. Status thresholds are: `>= 0.8`
healthy, `>= 0.5` degraded, `< 0.5` unhealthy.

| Domain | Weight | Key signals |
|--------|--------|-------------|
| queue | 0.28 | depth > 50, dead rate > 1%, age > 5min, stale leases |
| storage | 0.14 | tombstone ratio > 30% |
| index | 0.19 | FTS/memory count mismatch > 10%, embedding coverage < 80% |
| provider | 0.24 | LLM availability rate from ring buffer |
| mutation | 0.10 | recovery events > 5 in last 7 days |
| connector | 0.05 | connectors with errors, age of oldest error |

**Provider tracker**: a ring buffer (default 100 entries) of
`success`/`failure`/`timeout` outcomes. Evicted entries have their
count decremented so the running totals stay accurate without a full
scan.

**Repair actions** (`repair-actions.ts`): four actions are defined.

- `requeueDeadJobs`: resets dead jobs to `pending` with `attempts = 0`
  (batch limit 50 per call).
- `releaseStaleLeases`: resets `leased` jobs whose `leased_at` predates
  the lease timeout back to `pending`.
- `checkFtsConsistency`: compares the physical FTS index document count to
  the canonical memory row count, including retained tombstones. A mismatch
  is reported without repair; with `repair = true`, rebuild admission is
  rate-limited, confirmed for autonomous callers, and sent through the async
  write queue before `INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`.
- `triggerRetentionSweep`: calls the retention worker's `sweep()` method
  immediately outside the normal schedule.

All repair actions pass through a policy gate (`checkRepairGate`). The
gate checks `autonomous.frozen` first (hard stop), then
`autonomous.enabled` for agent-role callers (operators and daemon bypass
this), then a rate limiter with per-action cooldown and hourly budget.
Each successful repair writes an audit event to `memory_history` with
`memory_id = 'system'`.

**Embedding refresh tracker** (`embedding-tracker.ts`): the existing
incremental tracker owns stale and missing-memory vector writes. It does not
create a second repair queue. Before a provider batch, it acquires a durable
SQLite lease and consumes one `repair.reembedHourlyBudget` slot. Per-memory
provider failures retain exponential retry deadlines across daemon restarts;
the lease, completed batch count, and last error are returned with
`GET /api/repair/embedding-gaps`.

**Maintenance worker** (`pipeline/maintenance-worker.ts`): runs on a
configurable interval. Each cycle calls `getDiagnostics`, builds repair
recommendations from the report, and either logs them (`observe` mode)
or executes them (`execute` mode). A halt tracker prevents the same
ineffective repair from running more than 3 consecutive cycles without
improving the composite score. The worker only starts its interval
timer when `autonomous.enabled && !autonomous.frozen`.

---
