---
title: "Diagnostics"
description: "Health scoring and system diagnostics."
order: 18
section: "Infrastructure"
---

Diagnostics and Repair
===

The daemon continuously monitors the health of the memory pipeline through
a read-only diagnostics system and a set of policy-gated repair actions. An
optional maintenance worker ties them together, running repairs autonomously
on a schedule.

Source files:
- `packages/daemon/src/diagnostics.ts`
- `packages/daemon/src/repair-actions.ts`
- `packages/daemon/src/pipeline/maintenance-worker.ts`


Health Domains
---

Every diagnostic report scores six independent domains. Each domain returns
a score between 0 and 1, and a status derived from that score:

- `healthy` — score >= 0.8
- `degraded` — score >= 0.5
- `unhealthy` — score < 0.5

All domain functions are read-only. They accept a `ReadDb` handle or a
`ProviderTracker` and return plain data structs with no side effects.

### queue

Reflects the state of `memory_jobs` — the work queue for the extraction
pipeline.

Signals measured:

- `depth` — count of pending jobs. More than 50 pending jobs deducts 0.3.
- `deadRate` — ratio of dead-letter jobs to completed+dead in the last 24
  hours. Exceeding 1% deducts 0.3.
- `oldestAgeSec` — age in seconds of the oldest pending job. Over 5 minutes
  deducts 0.2.
- `leaseAnomalies` — count of jobs still in `leased` status but created more
  than 10 minutes ago. Any anomaly deducts 0.2.

A perfect queue scores 1.0. All deductions are cumulative and clamped to
the [0, 1] range.

### storage

Reflects the state of the `memories` table.

- `totalMemories` — total row count including tombstones.
- `deletedTombstones` — count of soft-deleted rows (`is_deleted = 1`).
- `dbSizeBytes` — reported as 0 on read connections (file stat unavailable).

If deleted tombstones exceed 30% of total rows, the score drops by 0.3.

### index

Reflects the quality of the FTS5 full-text index and embedding coverage.

- `memoriesRowCount` — count of active (non-deleted) memories.
- `ftsRowCount` — row count from `memories_fts`. Because FTS5 external
  content tables include tombstone rows, a mismatch is flagged only when
  the FTS count exceeds the active count by more than 10%.
- `ftsMismatch` — boolean. When true, the score drops by 0.5.
- `embeddingCoverage` — fraction of active memories that have an embedding
  model assigned. Below 80% coverage deducts 0.3.

### provider

Reflects recent LLM call reliability via `ProviderTracker`, an in-memory
ring buffer that holds the last 100 outcomes.

```typescript
type Outcome = "success" | "failure" | "timeout";
```

The ring buffer evicts the oldest entry when it reaches capacity, maintaining
an O(1) running tally. If the buffer is empty (no calls yet), the system
assumes healthy and returns 1.0.

- `availabilityRate` — `successes / total`. This is used directly as the
  score, so a 100% success rate is 1.0 and any failures or timeouts reduce
  it proportionally.
- `recentTotal`, `recentSuccesses`, `recentFailures`, `recentTimeouts` are
  also returned for inspection.

### mutation

Reflects write reliability over the last 7 days from `memory_history`.

- `recentRecovers` — count of `recovered` events. More than 5 recoveries
  suggests that deletes are regularly being undone, which deducts 0.3.
- `recentDeletes` — informational count of `deleted` events.

### connector

Reflects the sync state of installed harness connectors from the
`connectors` table.

- `connectorCount`, `syncingCount`, `errorCount` are counted directly.
- `oldestErrorAge` — milliseconds since the oldest unresolved connector
  error. Over 24 hours deducts an additional 0.2 on top of the 0.3 deducted
  for any error being present.

If the `connectors` table does not exist (older databases), this domain
returns a perfect score of 1.0 rather than failing.


Composite Scoring
---

The six domain scores are combined into a single weighted average:

| Domain    | Weight |
|-----------|--------|
| queue     | 0.28   |
| provider  | 0.24   |
| index     | 0.19   |
| storage   | 0.14   |
| mutation  | 0.10   |
| connector | 0.05   |

The result is clamped to [0, 1] and assigned the same status thresholds as
individual domains. Queue and provider carry the most weight because
extraction failures cascade — a stuck queue or an unavailable LLM will stall
memory ingestion entirely.


API Endpoints
---

Both endpoints require the `diagnostics` permission. In local auth mode
this is always granted. With token auth, the token must include the
`diagnostics` scope.

### GET /api/diagnostics

Returns a full `DiagnosticsReport` with all six domains and the composite.

```json
{
  "timestamp": "2026-02-21T12:00:00.000Z",
  "composite": { "score": 0.91, "status": "healthy" },
  "queue": {
    "score": 1.0,
    "status": "healthy",
    "depth": 2,
    "oldestAgeSec": 4,
    "deadRate": 0,
    "leaseAnomalies": 0
  },
  "storage": { ... },
  "index": { ... },
  "provider": { ... },
  "mutation": { ... },
  "connector": { ... }
}
```

### GET /api/diagnostics/:domain

Returns the health object for a single domain. Valid values for `:domain`
are: `queue`, `storage`, `index`, `provider`, `mutation`, `connector`.
Returns 400 if the domain name is unrecognized.

```bash
curl http://localhost:3850/api/diagnostics/queue
curl http://localhost:3850/api/diagnostics/provider
```


Repair Actions
---

Repair endpoints require the `admin` permission. All actions pass through two
gates before executing: the policy gate and the rate limiter.

### Policy gate

The policy gate checks two config flags in order:

1. `autonomousFrozen` — if true, all repairs are blocked regardless of actor.
2. `autonomousEnabled` — if false, repairs requested by `agent` actors are
   blocked. Operators and the daemon itself bypass this check.

The actor type is read from the `x-signet-actor-type` request header. Valid
values are `operator`, `agent`, and `daemon`. Defaults to `operator`.

### Rate limiter

Each action tracks its last run timestamp and an hourly invocation count.
Two thresholds control it: a cooldown (minimum gap between runs) and a
hourly budget (maximum runs per rolling hour window). If either threshold is
violated, the endpoint returns 429 with a reason string.

### Repair context headers

All repair endpoints read optional headers to populate the audit log:

| Header                  | Default              | Description                  |
|-------------------------|----------------------|------------------------------|
| `x-signet-reason`       | `"manual repair"`    | Why the repair was triggered |
| `x-signet-actor`        | `"operator"`         | Who triggered it             |
| `x-signet-actor-type`   | `"operator"`         | Actor type for policy check  |
| `x-signet-request-id`   | random UUID          | For tracing across logs      |

Every successful repair writes an audit entry to `memory_history` with
`event = "none"` and a `metadata` field containing the action name,
affected count, and message.

### POST /api/repair/requeue-dead

Resets up to 50 dead-letter jobs back to `pending` with `attempts = 0`,
allowing the extraction worker to retry them.

- Cooldown: `repairRequeueCooldownMs` (default: 1 minute)
- Hourly budget: `repairRequeueHourlyBudget` (default: 50)

```bash
curl -X POST http://localhost:3850/api/repair/requeue-dead \
  -H "x-signet-reason: dead rate spiked after model timeout"
```

### POST /api/repair/release-leases

Releases jobs stuck in `leased` status past the lease timeout back to
`pending`. The cutoff is `now - leaseTimeoutMs` (default: 5 minutes).

- Cooldown: `repairRequeueCooldownMs` (default: 1 minute)
- Hourly budget: `repairRequeueHourlyBudget` (default: 50)

```bash
curl -X POST http://localhost:3850/api/repair/release-leases
```

### POST /api/repair/check-fts

Verifies that the FTS5 index is consistent with the active memory count.
Pass `{ "repair": true }` in the JSON body to trigger a full FTS rebuild
if a mismatch is detected. Without that flag, the endpoint checks and
reports only.

FTS rebuilds are expensive. This action uses a separate, stricter rate limit:

- Cooldown: `repairReembedCooldownMs` (default: 5 minutes)
- Hourly budget: 5 (hardcoded)

```bash
# Check only
curl -X POST http://localhost:3850/api/repair/check-fts

# Check and rebuild if mismatched
curl -X POST http://localhost:3850/api/repair/check-fts \
  -H "Content-Type: application/json" \
  -d '{"repair": true}'
```

### POST /api/repair/retention-sweep

Triggers an immediate retention purge instead of waiting for the next
scheduled sweep. This is useful when tombstone accumulation is causing
storage health to degrade.

- Cooldown: `repairRequeueCooldownMs` (default: 1 minute)
- Hourly budget: `repairRequeueHourlyBudget` (default: 50)

Note: this endpoint returns 501 if the pipeline has not been started and
the retention worker handle is unavailable.

```bash
curl -X POST http://localhost:3850/api/repair/retention-sweep
```

### Response shape

All repair endpoints return the same structure:

```json
{
  "action": "requeueDeadJobs",
  "success": true,
  "affected": 12,
  "message": "requeued 12 dead job(s) to pending"
}
```

A failed gate check returns the same shape with `success: false` and a
`message` explaining which gate blocked it, with HTTP 429.


Maintenance Worker
---

The maintenance worker runs on a timer and combines diagnostics with repair
to close the loop autonomously. It starts only when `autonomousEnabled` is
true and `autonomousFrozen` is false.

### Modes

The worker operates in one of two modes, controlled by `maintenanceMode`:

**observe** (default) — the worker runs diagnostics and logs recommendations
but does not execute any repairs. This lets you see what would happen before
committing to autonomous execution.

**execute** — the worker runs diagnostics, builds recommendations, and calls
the appropriate repair actions automatically. The actor type is `"daemon"`,
which bypasses the `autonomousEnabled` agent check.

### Recommendation engine

After each diagnostic run, the worker maps degraded signals to specific
repair actions:

| Condition | Action |
|-----------|--------|
| `queue.deadRate > 1%` | `requeueDeadJobs` |
| `queue.leaseAnomalies > 0` | `releaseStaleLeases` |
| `index.ftsMismatch` | `checkFtsConsistency` (with rebuild) |
| tombstone ratio > 30% | `triggerRetentionSweep` |

### Halt tracker

Each repair action has an independent consecutive-failure counter. When an
action is executed `MAX_INEFFECTIVE_RUNS` (3) times in a row without
improving the composite score, it is halted. The halt clears if any
subsequent diagnostic cycle finds no recommendations, at which point the
counters reset entirely.

This prevents the worker from hammering a repair that isn't helping — for
example, repeatedly requeuing dead jobs when the root cause is an
unavailable LLM provider.

### Configuration

These settings live under the `pipelineV2` block in `~/.agents/agent.yaml`:

| Key | Default | Description |
|-----|---------|-------------|
| `autonomousEnabled` | `false` | Enables autonomous mode and repair agent access |
| `autonomousFrozen` | `false` | Hard freeze — blocks all repairs regardless of actor |
| `maintenanceMode` | `"observe"` | `"observe"` or `"execute"` |
| `maintenanceIntervalMs` | `1800000` (30 min) | How often the worker runs. Min 60s, max 24h |
| `repairRequeueCooldownMs` | `60000` (1 min) | Cooldown for requeue/lease/sweep actions |
| `repairRequeueHourlyBudget` | `50` | Max invocations per hour for those actions |
| `repairReembedCooldownMs` | `300000` (5 min) | Cooldown for FTS consistency check |
| `repairReembedHourlyBudget` | `10` | Max FTS checks per hour |
| `leaseTimeoutMs` | `300000` (5 min) | Age at which a leased job is considered stale |

Example configuration to enable execute mode with a 15-minute cycle:

```yaml
pipelineV2:
  autonomousEnabled: true
  maintenanceMode: execute
  maintenanceIntervalMs: 900000
```

Changes to these values take effect on the next pipeline restart. The
maintenance worker captures config at startup and does not hot-reload, which
ensures the rate limiter's cooldown windows remain consistent across a cycle.
