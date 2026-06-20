# Phase 3 Shadow Divergence Resolution

Commit: recorded in final acceptance report.

## Summary

- Fixed Rust `/health` response shape to include TypeScript-parity structural fields from `platform/daemon/src/routes/health.ts`: uptime, pid, port, agentsDir, db, shutdown/update flags, pipeline summary, and resources summary.
- Fixed Rust `/api/status` response shape to include TypeScript-parity structural fields from `platform/daemon/src/routes/pipeline-routes.ts`: pid, uptime, startedAt, agentId, agentsDir, memoryDb, activeSessions, bypassedSessions, agentCreatedAt, logging, update, embedding, and pipelineV2 envelope fields.
- Expanded `platform/daemon-rs/contracts/parity-rules.json` for the 12 observed shadow endpoints, separating deterministic fields from non-deterministic/runtime-local fields.
- Documented architectural divergences in rules for `/api/plugins`, `/api/memory/search`, and `/api/changelog`.

## Fixed in Rust

- `/health`: added TS-parity envelope fields and live DB check.
- `/api/status`: added process/runtime status fields, workspace/database fields, session counts, update state, logging paths, and embedding shape.

## Configured in parity rules

- Ignored process/listener non-determinism: pid, uptime, port, host, startedAt, runtime resources, logging paths, update cache, worker runtime counters.
- Added/expanded endpoint-specific rules for `/health`, `/api/status`, `/api/plugins`, `/api/pipeline/status`, `/api/embeddings`, `/api/memory/search`, `/memory/search`, `/api/config`, `/api/ontology/proposals`, `/api/changelog`, `POST /api/memory/recall`, and `/api/memories`.

## Shadow re-run

A focused shadow replay through a rebuilt Rust daemon reduced critical divergences on the target endpoints to the two documented architectural gaps:

```text
Total entries:       8
Status mismatches:   1
Critical divergences: 2
Expected divergences: 29

Critical:
- GET /api/plugins: plugin count/model divergence (TS has 2, Rust has 1)
- GET /api/memory/search: route-path status divergence (TS 404, Rust 200; TS canonical path is /memory/search)
```

## Verification

```text
cd platform/daemon-rs && cargo build -p signet-daemon
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.25s

cd platform/daemon-rs && cargo test -p signet-daemon --test contract_replay -- --ignored
test result: ok. 122 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 21.65s
```
