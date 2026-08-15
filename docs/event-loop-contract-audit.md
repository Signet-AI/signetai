# Event-loop synchronous contract audit

This report is generated from the deterministic migration ledger in `scripts/event-loop-contract-baseline.json`. Phase A enforces the type boundary structurally: production code receives an async-only `DbAccessor`, while the synchronous compatibility module lives outside the daemon production `src/` tree and is rejected by the production TypeScript project's `rootDir`. The AST import and call checks remain belt-and-suspenders diagnostics, and new synchronous DB call sites fail closed through exact ledger matching.

## Current inventory

- Exact ledger inventory: 959 sites
- Synchronous `withWriteTx()` sites: 174
- Synchronous `withReadDb()` sites: 301
- Synchronous filesystem/process sites: 484
- Compile-visible legacy DB sites remaining: 475
  - `withWriteTx`: 174
  - `withReadDb`: 301

The 959-site inventory excludes test, benchmark, generated, and `__tests__` fixtures. The 174 synchronous writes and 301 synchronous reads remain transitional callers for the later migration phase. They are marked with `@ts-expect-error LEGACY_SYNC_DB_ACCESS`, so the compiler reports every remaining site without forcing this phase to migrate 475 database operations.

## A3 Slice 2 migration notes

The converted async sites are distributed as follows: document-worker (18), dreaming (28), retention (6), repair-actions (31), and source-lifecycle-telemetry (8), for 91 sites total.

## A3 Slice 2 migration notes

The converted async sites are distributed as follows: document-worker (18), dreaming (28), retention (6), repair-actions (31), and source-lifecycle-telemetry (8), for 91 sites total.

## Enforcement boundary

- Statically-resolved production imports of the compatibility module fail the daemon TypeScript project because the module is outside its source rootDir. The AST import scan remains a supplementary diagnostic for source-tree execution.
- DbAccessor exports only asynchronous transaction and read primitives.
- db-accessor-sync.ts is the explicit compatibility surface for test/bootstrap-only code. Its module documentation records the pre-readiness bootstrap, CLI, and isolated-worker rationale.
- The migration ledger is an allowlist for existing synchronous DB callers. It may shrink, but a new synchronous DB call is a violation even when its type error is suppressed.

## Risk and follow-up

The structural boundary makes statically-resolved imports from the production source tree impossible: TypeScript reports TS6059 before aliases or computed member calls can use the compatibility type. The production bundle also only starts from source entrypoints, so this compatibility module is not a shipped production artifact.

A runtime-computed require() or import() can still reach a source-tree file when a development process deliberately constructs the path. TypeScript cannot prove an unresolved runtime string, and the AST audit remains the supplementary guard for that source-execution residual. This Phase A boundary intentionally leaves the synchronous methods on the runtime accessor so the 475 transitional callers keep working. The deferred final cleanup is explicit: first land the six A3 caller-migration slices that convert all 174 write and 301 read markers to async, then remove the runtime synchronous methods and compatibility module in a follow-up.
