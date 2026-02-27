---
title: "Daemon Rust Rewrite"
description: "Planning spec for incremental Rust rewrite of the Signet daemon"
---

# Signet Daemon: Incremental Rust Rewrite

## Context

The Signet daemon (`packages/daemon/`) is ~23,000 lines of TypeScript
running on Bun. It's a 24/7 background service handling memory storage,
hybrid search, an LLM extraction pipeline, file watching, git sync, MCP
server, secrets, auth, scheduled tasks, and 100+ HTTP endpoints.

Motivations for rewriting in Rust: single-binary distribution (no bun
dependency for users), lower memory footprint (~5-10MB vs ~100MB idle),
better tail latency on search, and developer preference.

Strategy: **incremental migration** with a Rust proxy binary that starts
the TS daemon on a separate port and forwards unimplemented routes. Routes
migrate to Rust one domain at a time. Users never see a broken daemon.

`@signet/core` stays in TypeScript. The Rust daemon reimplements only what
it needs from core (search queries, YAML parsing, migrations via embedded SQL).


## Cargo Workspace

```
packages/daemon-rs/
  Cargo.toml              (workspace root)
  crates/
    signet-daemon/        (binary: axum server, proxy, startup)
    signet-db/            (rusqlite: connection pool, pragmas, vec ext, FTS)
    signet-search/        (hybrid recall: BM25 + cosine + score merging)
    signet-secrets/       (XSalsa20-Poly1305 compat with existing secrets.enc)
    signet-pipeline/      (extraction workers, LLM providers, decision logic)
    signet-mcp/           (MCP server via rmcp crate)
```


## Phase 1: Foundation (proxy binary)
**Timeline: 1-2 weeks | Risk: LOW | ~450 LOC**

Rust binary that:
- opens `~/.agents/memory/memories.db` read-only (smoke test)
- serves `GET /health` natively
- starts TS daemon on port 3851 as subprocess
- reverse-proxies all other requests to TS via reqwest streaming
- respects SIGNET_PORT / SIGNET_HOST env vars

Crates: axum, tokio, reqwest (streaming), rusqlite (bundled), serde, serde_json, clap, tracing

Validate:
- `/health` returns valid JSON with uptime
- all proxied routes return identical responses
- SSE streaming (`/api/logs/stream`) works through proxy
- proxy overhead < 1ms on localhost

Critical files:
- `packages/daemon/src/daemon.ts` (boot sequence, lines 1-150)


## Phase 2: Read-only endpoints (search hot path)
**Timeline: 4-6 weeks | Risk: MEDIUM | ~1,800 LOC**

Port the performance-sensitive read path:
- `GET /api/memories` (list, paginate, filter)
- `GET /api/memory/:id` + `/history`
- `POST /api/memory/recall` (hybrid search - the prize)
- `GET /api/memory/search`, `GET /memory/search`, `GET /memory/similar`
- `GET /api/embeddings`, `/status`, `/health`
- `GET /api/status`, `GET /api/diagnostics/*`, `GET /api/pipeline/status`

Reimplement from core:
- `vectorSearch` — the sqlite-vec cosine query
- `keywordSearch` — FTS5 BM25 query
- `cosineSimilarity` — dot product (trivial)
- `parseSimpleYaml` — replace with serde_yaml
- `findSqliteVecExtension` — path resolution logic

New crates: libloading (vec ext), serde_yaml, uuid, chrono

**Technical risk: sqlite-vec loading.** rusqlite's `loadable_extension`
feature requires `unsafe_load_extension()`. Test this on day 1 of Phase 2
against the actual sqlite-vec .so/.dylib. If it fails, fall back to
compiling sqlite-vec from C source via `build.rs` + `cc` crate.

Validate:
- for 10 known memories, recall via both TS and Rust — results match
- BM25 normalized scores are identical (same formula: `abs(raw) / maxRaw`)
- benchmark: `hey -n 1000 -c 10` on `/api/memory/recall` — Rust should win at p99

Critical files:
- `packages/daemon/src/memory-search.ts` (hybrid recall algorithm)
- `packages/daemon/src/db-accessor.ts` (connection pool pattern, WAL, vec loading)
- `packages/core/src/search.ts` (SQL query builders)


## Phase 3: Write endpoints
**Timeline: 6-8 weeks | Risk: MEDIUM-HIGH | ~1,850 LOC**

Port all mutations:
- `POST /api/memory/remember` (421-line handler: normalize, hash, embed, ingest tx)
- `POST /api/memory/forget`, `/modify`, `PATCH /:id`, `DELETE /:id`, `/:id/recover`
- `POST /api/documents`, `DELETE /api/documents/:id`
- `POST /api/config`, `POST /api/identity`
- Secrets: `POST/DELETE /api/secrets/:name`, `POST /:name/exec`
- Analytics accumulators (move to Rust since writes now happen here)

Reimplement from core:
- `txIngestEnvelope` transaction (content-hash dedup, is_deleted recovery, FTS/vec sync)

New crates: xsalsa20poly1305, blake2, sha2, base64, regex

**Secrets backward compat is critical.** The existing `secrets.enc` uses:
- Key: BLAKE2b-256 of `signet:secrets:{machine-id}` (no key, no salt — `crypto_generichash(32, input, null)`)
- Encrypt: `crypto_secretbox_easy` (XSalsa20-Poly1305), 24-byte nonce prepended
- Encoding: standard base64 with padding (`sodium.base64_variants.ORIGINAL`)

Write a parity test against a real `secrets.enc` BEFORE shipping this phase.
If compat proves fragile, keep secrets proxied to TS through Phase 5.

Validate:
- remember N memories via Rust, recall via both Rust and TS — content matches
- encrypt/decrypt roundtrip matches TS implementation byte-for-byte
- transaction atomicity: kill daemon mid-write, verify no partial state

Critical files:
- `packages/daemon/src/transactions.ts` (ingest envelope, modify, forget)
- `packages/daemon/src/secrets.ts` (XSalsa20-Poly1305, BLAKE2b key derivation)
- `packages/daemon/src/db-helpers.ts` (Float32Array → blob for vec_embeddings)


## Phase 4: Pipeline workers
**Timeline: 8-12 weeks | Risk: HIGH | ~3,050 LOC**

Port the 5 background workers:
1. Extraction: poll `memory_jobs`, call LLM, parse facts, run decisions
2. Retention: importance decay with configurable curve
3. Maintenance: FTS consistency, orphan cleanup, re-embedding gaps
4. Document: chunk documents, generate embeddings, index
5. Summary: session-end summaries → dated .md files

LLM provider trait:
- Ollama: HTTP POST to `localhost:11434/api/generate`
- Claude Code: `tokio::process::Command` spawning `claude -p ... --output-format json`

Defer UMAP to Phase 5 (keep `/api/embeddings/projection` proxied). It's a
dashboard feature, not core functionality.

New crates: (none beyond previous — tokio process already included)

Validate:
- port `worker.test.ts` (1,354 lines) to Rust integration tests
- mock Ollama with canned responses, verify extraction output
- job lease mechanism: two workers don't process the same job
- stuck job recovery: verify lease timeout releases orphaned jobs

Critical files:
- `packages/daemon/src/pipeline/worker.ts` (main extraction loop)
- `packages/daemon/src/pipeline/decision.ts` (ADD/UPDATE/NONE/DELETE scoring)
- `packages/daemon/src/pipeline/provider.ts` (Ollama + Claude providers)
- `packages/daemon/src/pipeline/summary-worker.ts` (session summarizer)


## Phase 5: Everything else
**Timeline: 10-16 weeks | Risk: HIGH | ~4,000 LOC**

Remaining domains:
- **Auth**: JWT tokens (hand-rolled HMAC — read `tokens.ts`), rate limiting (governor crate), tower middleware
- **Git sync**: subprocess git calls, credential resolution (SSH → credential-helper → GITHUB_TOKEN → gh CLI), debounced auto-commit
- **File watcher**: notify crate on `~/.agents/`, 5s commit debounce + 2s harness sync debounce
- **MCP**: rmcp crate, stateless Streamable HTTP (one server per request). Budget extra time — rmcp is young
- **Scheduler**: cron crate, 15s poll, tokio::process::Command for harness spawning, Semaphore(3) concurrency
- **Connectors**: filesystem connector + registry CRUD
- **Skills, harnesses, update system**: mostly HTTP + file I/O
- **Telemetry, timeline**: in-memory accumulators + DB reads
- **UMAP**: linfa-reduction or keep deferred
- **Static dashboard**: tower-http ServeDir

New crates: notify, rmcp, governor, cron, tower-http (fs/cors)

Validate:
- MCP: test memory_search and memory_store from Claude Code
- file watcher: edit AGENTS.md → verify CLAUDE.md syncs within 2s
- git sync: configure test remote, verify push with each credential method
- scheduler: create cron task, verify harness subprocess spawns on schedule

Critical files:
- `packages/daemon/src/hooks.ts` (session lifecycle, 1,375 lines)
- `packages/daemon/src/mcp/tools.ts` (MCP tool definitions)
- `packages/daemon/src/auth/tokens.ts` (token format for backward compat)


## Phase 6: Cutover
**Timeline: 2-4 weeks | Risk: MEDIUM**

- Remove TS subprocess spawning and proxy fallback
- Rust daemon is sole process
- CLI `signet start` points at Rust binary
- service.ts (systemd/launchd) updated for Rust binary path
- CI builds Rust for linux-x64, macos-arm64, macos-x64
- Binaries bundled in npm package (optionalDependencies pattern like esbuild)
- Migrations: embed SQL in Rust binary via `include_str!`, run at startup

Compile sqlite-vec from C source via `build.rs` for true single-binary.

Validate: full smoke test on fresh Linux and macOS installs — init, start,
remember, recall, MCP tools, file watcher, git sync.


## Totals

- **Estimated Rust LOC**: ~13,000-15,000
- **Estimated calendar time**: ~12 months solo full-focus, 18-24 months part-time
- **Top risks (ordered)**:
  1. sqlite-vec extension loading compatibility with rusqlite
  2. Secrets backward compat (wrong key derivation = lost secrets)
  3. rmcp maturity for stateless Streamable HTTP
  4. Git credential resolver OS-specific edge cases
  5. Pipeline decision logic parity (subtle scoring behavior)

Each phase produces a working daemon. Ship early phases to get real-world
validation before tackling the harder pipeline and MCP work.


## Where to start

Phase 1, day 1:
1. `mkdir -p packages/daemon-rs/crates/signet-daemon`
2. `cargo init` the workspace
3. Add axum + tokio + rusqlite (bundled) + reqwest
4. Write `main.rs`: open DB, serve /health, proxy everything else
5. Test sqlite-vec loading with rusqlite (the Phase 2 risk — verify early)
