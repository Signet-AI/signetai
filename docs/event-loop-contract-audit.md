# Event-loop synchronous contract audit

This report is generated from the deterministic migration ledger in `scripts/event-loop-contract-baseline.json`. The ledger is a reporting surface, not a scanner-based gate. Phase A enforces the new type boundary: production code receives an async-only `DbAccessor`, and CI rejects production imports of the explicit sync compatibility module.

## Current inventory

- Exact ledger inventory: 1060 sites
- Synchronous `withWriteTx()` sites: 230
- Synchronous `withReadDb()` sites: 346
- Synchronous filesystem/process sites: 484
- Compile-visible legacy DB sites remaining: 576
  - `withWriteTx`: 230
  - `withReadDb`: 346

The 1,060-site inventory excludes test, benchmark, generated, and `__tests__` fixtures. The 230 synchronous writes and 346 synchronous reads remain transitional callers for the later migration phase. They are marked with `@ts-expect-error LEGACY_SYNC_DB_ACCESS`, so the compiler reports every remaining site without forcing this phase to migrate 576 database operations.

## Enforcement boundary

- Production imports of `db-accessor-sync.ts` are rejected by the CI import-boundary check.
- `DbAccessor` exports only asynchronous transaction and read primitives.
- `db-accessor-sync.ts` is the explicit compatibility surface for test/bootstrap-only code. Its module documentation records the pre-readiness bootstrap, CLI, and isolated-worker rationale.
- The ledger does not attempt alias tracking, call-site classification, or evasion detection. Those scanner rules were retired because the type boundary is the enforceable contract.

## Risk and follow-up

The remaining synchronous DB operations are still a known transitional risk. The next migration wave removes the 230 write and 346 read markers. Startup, recall, ingestion, and existing tests must continue to use the runtime implementation while their callers move to the async primitives.
