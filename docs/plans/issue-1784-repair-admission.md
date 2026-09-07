# Issue #1784 — Repair admission hardening

Issue: [Repair limiter is bypassed by default HTTP and autonomous daemon callers](https://github.com/Signet-AI/signetai/issues/1784)

## Goal

Make every mutating repair entry point obey the same authorization and runtime-admission contract. Operator permission may bypass only the `autonomous.enabled` feature toggle. It must not bypass cooldowns, hourly budgets, leases, bounded work, or owner-pressure checks.

## Phased implementation plan

### Phase 1 — Baseline and contract

- [x] Reproduce the reported path on current `main`: HTTP repair context defaults to `operator`, autonomous maintenance uses `daemon`, and `checkRepairGate` bypasses both roles.
- [x] Inventory repair routes, maintenance callers, existing limiter calls, scope resolution, and durable embedding repair state.
- [x] Define the contract: no implicit force override; deny duplicate work before it starts; use an action-plus-scope key; keep dry runs read-only; return structured `429` admission errors.

### Phase 2 — Durable admission owner

- [x] Add an idempotent SQLite migration for a generic per-action/per-scope admission table.
- [x] Implement transactional lease acquisition and completion in the daemon's canonical database write path. Persist the hourly window, admitted work, lease owner, expiry, recent completion, and error state.
- [x] Make expired leases recoverable but keep active leases and cooldowns durable across daemon restarts.
- [x] Keep the existing embedding-specific retry/backoff state for per-memory provider retries; use the generic table for the repair action boundary.

### Phase 3 — Repair execution paths

- [x] Remove the operator/daemon limiter bypass while preserving operator access when autonomous maintenance is disabled.
- [x] Apply durable admission to HTTP and maintenance calls for FTS, queue, retention, embeddings, vector reconciliation, deduplication, and cleanup actions.
- [x] Apply the same boundary to legacy mutating repair routes that previously had no limiter.
- [x] Use resolved agent scope for agent-owned operations and a global scope only for genuinely global repairs.
- [x] Ensure failures release leases with an observable outcome and successful work records completion; do not add an implicit force path.

### Phase 4 — API, configuration, and observability contract

- [x] Return `429` only for structured admission/policy denials, including cooldown, budget, active-lease, frozen, and disabled-agent cases.
- [x] Preserve request identity in durable admission owner fields and reason/request identity in the existing repair audit event.
- [x] Update source comments, API documentation, maintenance documentation, and pipeline configuration documentation to describe the enforced durable contract.

### Phase 5 — Focused proof and release

- [x] Add the minimum focused integration coverage for operator, daemon, and agent calls; action/scope isolation; duplicate concurrent requests; and restart persistence.
- [x] Exercise migration idempotence and an upgrade path.
- [ ] Run focused daemon/core tests, then the full build, typecheck, lint, and repository test suite. Focused tests, build, typecheck, lint, and the migration/audit checks pass; the repository-wide hermetic run remains red on unrelated pre-existing environment and timeout failures documented in the PR.
- [ ] Self-review the diff against every acceptance criterion, commit with a conventional title, push the branch, open a PR that closes #1784, and update the issue with the verified solution and test evidence.

## Acceptance mapping

| Issue criterion | Planned proof |
| --- | --- |
| Default HTTP operators can receive `429` | Route integration test with a durable limiter and a repeated request |
| Daemon obeys cooldown/budget/concurrency | Maintenance/action integration tests against the same SQLite admission row |
| Operator bypasses only feature toggle | Gate test with `autonomous.enabled: false` plus a runtime-admission denial |
| Duplicate same action/scope is rejected | Concurrent action test and persisted active lease assertion |
| Action plus agent/project scope | Scoped embedding/cleanup tests and admission-key assertions |
| Restart cannot replay active work | New limiter instance against the same database remains denied |
| Force override is safe | No force override is exposed; arbitrary callers remain subject to admission |
| Docs and `429` behavior match | Updated API/configuration/architecture docs and structured status assertions |
| Integration coverage is not map-only | Tests cross the action boundary with operator, daemon, agent, concurrency, and restart cases |
