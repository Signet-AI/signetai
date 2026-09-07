# Plan: Continue integrity sweeps past expected FTS5 tables (issue #1779)

> Closes <https://github.com/Signet-AI/signetai/issues/1779>.
> Branch: `fix/1779-integrity-sweep-fts`, based on `origin/main` at
> `77ae26b1a` (`v0.219.2`).

## Problem and evidence

`platform/daemon/src/incremental-database-integrity.ts` currently treats the
first `USING fts5(...)` schema object as a database-wide terminal condition.
It persists `degraded:fts-unverifiable`, stops advancing the cursor, and
reports `remainingObjects: 0`. FTS5 is an expected part of Signet's production
schema, so this both degrades healthy installations and hides ordinary schema
objects that were never visited.

The affected status path is:

```text
DB-owner incremental sweep
  -> durable db_integrity_checkpoints cursor/counts
  -> updateDatabaseIntegrityStatus
  -> GET /health and GET /health/ready
```

The existing FTS startup recovery and bounded owner protocol remain separate
maintenance paths. This repair does not execute an unbounded FTS operation in
the request-serving process.

## Phased implementation

### Phase 1 — Establish the contract

- Define the selected schema inventory as the `sqlite_schema` rows eligible
  for the bounded sweep.
- Preserve `checkedObjects` as objects for which the checker ran a verification
  operation; keep `failedObjects` as the failed subset.
- Add `skippedObjects` for expected, intentionally unverifiable FTS5 virtual
  tables and expose `inventoryObjects` so the invariant is directly auditable:
  `checkedObjects + skippedObjects + remainingObjects = inventoryObjects`.
- Add explicit FTS coverage metadata to integrity status/progress. Expected FTS
  skips must not populate `degradationReason` or turn database health degraded.

### Phase 2 — Repair the durable sweep and upgrade path

- Replace the FTS terminal branch with a bounded skip checkpoint that advances
  the cursor and continues to later tables, indexes, views, and triggers.
- Persist the skipped count in `db_integrity_checkpoints`.
- Upgrade older checkpoint tables idempotently with the new count column.
- Convert existing `degraded:fts-unverifiable` rows to a resumable `running`
  checkpoint, count the parked FTS object as skipped, and resume after it.
- Keep actual check failures, owner failures, and deadline failures on their
  existing actionable health paths.

### Phase 3 — Focused regression coverage

- Update the incremental integrity tests to cover a production-shaped FTS
  object followed by ordinary objects, truthful count arithmetic, repeated
  FTS objects, and migration of an already-parked checkpoint.
- Update integrity status tests to prove expected FTS skips remain healthy while
  observed corruption/unavailability retains actionable guidance.
- Keep the test additions limited to the changed behavior; do not add tests for
  retired behavior beyond replacing the regression that encoded it.

### Phase 4 — Real acceptance surfaces

- Extend the acceptance database builder/harness to assert that a full
  production schema reaches completion, reports the expected FTS coverage, and
  checks objects after the first FTS table rather than only asserting HTTP
  reachability.
- Extend compiled first-use acceptance to inspect `/health` and verify its
  integrity state/progress semantics after startup.
- Preserve bounded owner execution and health responsiveness while the sweep
  runs; retain the existing smoke/full and nightly soak gates.

### Phase 5 — Documentation, verification, and delivery

- Document the new integrity coverage fields and the distinction between
  expected FTS unverifiability and database degradation in the owning
  diagnostics documentation.
- Run focused daemon tests, production-shape acceptance, compiled first-use
  acceptance where the local toolchain permits, then the repository's full
  build, typecheck, lint, format check, and test suite.
- Manually review the final diff against every issue acceptance criterion,
  commit with a conventional title, push the issue branch, create a PR whose
  body checks the repository readiness items, links `#1779` with `Closes`, and
  comment on the issue with the completed fix and validation evidence.

## Acceptance mapping

| Issue criterion | Planned proof |
| --- | --- |
| Fresh production schema completes without FTS-only degradation | Production-shaped acceptance fixture and incremental integration test |
| One unsupported virtual table does not block later objects | Ordered FTS-followed-by-table/index/view/trigger regression test |
| Coverage counts are internally consistent | `inventoryObjects` plus checked/skipped/remaining invariant assertions |
| FTS coverage is explicit and not corruption | Status/progress FTS metadata assertions; healthy database state and null degradation reason |
| Known corruption/unavailability remains actionable | Existing status tests retained and expanded around the new fields |
| Parked checkpoints migrate/resume | Legacy checkpoint fixture with `degraded:fts-unverifiable` and resume assertion |
| Compiled first-use and soak validate semantics | Native first-use `/health` assertions and production-shape smoke/full acceptance checks |
