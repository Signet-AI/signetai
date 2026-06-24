# TypeScript Daemon Test Corpus Manifest

Generated parity catalog for `platform/daemon/src/**/*.test.ts` against Rust daemon coverage in `platform/daemon-rs/crates/**` and contract replay tests. This is a manifest only; no tests were run.

## Summary

- Total TypeScript daemon test files: **167**
- `has-rust-equivalent`: **42**
- `needs-port`: **114**
- `not-applicable-to-rust`: **11**

## Needs-port grouping by behavioral core

| Behavioral core | needs-port count |
|---|---:|
| recall/ranking | 18 |
| pipeline stages | 19 |
| memory/lineage | 11 |
| retention | 1 |
| ontology | 4 |
| hooks | 2 |
| scoping | 6 |
| auth/secrets | 7 |
| marketplace | 1 |
| skills | 7 |
| sources | 11 |
| mcp | 2 |
| dashboard | 2 |
| misc routes | 23 |

## Rust coverage sources inspected

- `platform/daemon-rs/crates/signet-core/tests/embedding_upsert.rs`
- `platform/daemon-rs/crates/signet-core/tests/migrations.rs`
- `platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs`
- `platform/daemon-rs/crates/signet-pipeline/tests/memory_lineage.rs`
- Inline `#[test]` / `#[tokio::test]` coverage in `platform/daemon-rs/crates/signet-core/src/**`, `signet-daemon/src/**`, `signet-pipeline/src/**`, `signet-services/src/**`, and `signet-shadow/src/**`.

## Full manifest

| TS test file | behavior/feature covered | classification | nearest Rust test/behavior |
|---|---|---|---|
| `platform/daemon/src/__tests__/extraction-thread.test.ts` | TypeScript extraction worker message protocol and worker lifecycle messages | not-applicable-to-rust | NONE - TypeScript Worker/Bun thread protocol only |
| `platform/daemon/src/agent-id.test.ts` | Agent id normalization, daemon agent resolution, and agent registry policy | needs-port | NONE (partial scope parsing only in platform/daemon-rs/crates/signet-daemon/src/routes/hooks.rs and platform/daemon-rs/crates/signet-daemon/src/mcp/tools.rs) |
| `platform/daemon/src/aggregate-recall.test.ts` | Aggregate recall planning, synthesis, evidence linking, and save policy | needs-port | NONE |
| `platform/daemon/src/analytics.test.ts` | In-memory analytics counters, latency/error ring buffers, and summaries | needs-port | NONE (route replay only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs analytics_collector_routes_record_request_counters_and_latency) |
| `platform/daemon/src/async-yield.test.ts` | JavaScript event-loop yielding helper | not-applicable-to-rust | NONE - JS async event-loop helper |
| `platform/daemon/src/auth/api-keys.test.ts` | Connector API key creation, metadata-only storage, revocation, and permission semantics | needs-port | NONE (token primitives only: platform/daemon-rs/crates/signet-daemon/src/auth/tokens.rs) |
| `platform/daemon/src/auth/auth.test.ts` | Auth tokens, permission policy, scopes, middleware, and rate limiting | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/auth/tokens.rs; platform/daemon-rs/crates/signet-daemon/src/auth/policy.rs; platform/daemon-rs/crates/signet-daemon/src/auth/rate_limiter.rs |
| `platform/daemon/src/bind-with-retry.test.ts` | HTTP bind retry/backoff/abort behavior | needs-port | NONE |
| `platform/daemon/src/bitwarden.test.ts` | Bitwarden secret references, CLI writes, migration, and dry-run safety | needs-port | NONE (route shapes only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs secrets_list) |
| `platform/daemon/src/bun-socket-polyfill.test.ts` | Bun socket destroySoon polyfill behavior | not-applicable-to-rust | NONE - Bun/Node socket polyfill only |
| `platform/daemon/src/connectors/filesystem.test.ts` | Filesystem connector glob matching and dotfile discovery rules | needs-port | NONE (filesystem sync replay only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs filesystem_connector_sync_replays_ts_document_ingest_side_effects) |
| `platform/daemon/src/content-normalization.test.ts` | Storage normalization and semantic hash stability for markdown content | has-rust-equivalent | platform/daemon-rs/crates/signet-services/src/normalize.rs |
| `platform/daemon/src/context-budget.test.ts` | Recall/context row selection and truncation by character/token budgets | needs-port | NONE |
| `platform/daemon/src/continuity-state.test.ts` | Per-session continuity counters, prompt/remember accumulation, and checkpoint triggers | has-rust-equivalent | platform/daemon-rs/crates/signet-services/src/session.rs |
| `platform/daemon/src/cross-agent.test.ts` | Cross-agent presence, direct/broadcast messages, events, and durable receipts | needs-port | NONE (route replay only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs cross_agent_endpoints) |
| `platform/daemon/src/daemon-auth-guard-colocation.test.ts` | Route guard placement and auth/permission failures across daemon APIs | needs-port | NONE (auth policy primitives only: platform/daemon-rs/crates/signet-daemon/src/auth/policy.rs) |
| `platform/daemon/src/daemon-cors.test.ts` | CORS origin allow/deny rules for daemon, Tailscale, desktop, and localhost | needs-port | NONE |
| `platform/daemon/src/daemon-refactor.test.ts` | Daemon import side-effect guard and auth reload idempotency | needs-port | NONE |
| `platform/daemon/src/daemon-status.test.ts` | Status route provider resolution, worker load shedding, and connector heartbeat telemetry | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/main.rs status_includes_worker_runtime_fields_with_configured_bounds; platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs status_returns_db_info |
| `platform/daemon/src/db-accessor.test.ts` | DB accessor lifecycle, transactions, backup pruning, and custom SQLite path resolution | needs-port | NONE (low-level open/compat only: platform/daemon-rs/crates/signet-core/src/db.rs) |
| `platform/daemon/src/diagnostics.test.ts` | Queue/storage/index/worker diagnostics health scoring | needs-port | NONE (route replay only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs diagnostics_endpoints) |
| `platform/daemon/src/discord-source-fetch.test.ts` | Discord REST fetch pagination, threads, members, errors, snowflakes, and timeouts | needs-port | NONE |
| `platform/daemon/src/discord-source-provider.test.ts` | Discord source indexing, gateway/cache import, partial failures, and stale purge | needs-port | NONE |
| `platform/daemon/src/dream-promotion.test.ts` | Dream evidence promotion from memory artifacts into ontology operations | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs dream_promote_replays_native_preference_preview_and_apply |
| `platform/daemon/src/dreaming-skill.test.ts` | Built-in dreaming skill metadata and graph-first maintenance framing | needs-port | NONE |
| `platform/daemon/src/embedding-coverage.test.ts` | Embedding coverage detection for duplicate hashes and stale source-linked embeddings | needs-port | NONE (upsert only: platform/daemon-rs/crates/signet-core/tests/embedding_upsert.rs) |
| `platform/daemon/src/embedding-fetch.test.ts` | Embedding provider fetch routing, API-key rules, timeouts, and native fallbacks | needs-port | NONE |
| `platform/daemon/src/embedding-health.test.ts` | Embedding health diagnostics and sqlite-vec error classification | needs-port | NONE |
| `platform/daemon/src/embedding-tracker.test.ts` | Embedding retry backoff, suppression, content-hash invalidation, and success clearing | needs-port | NONE |
| `platform/daemon/src/entity-quality.test.ts` | Entity quality gate for concrete, short, generic, and scaffolding names | has-rust-equivalent | platform/daemon-rs/crates/signet-pipeline/src/entity_quality.rs |
| `platform/daemon/src/event-loop-responsiveness.test.ts` | JavaScript file processing responsiveness under large async batches | not-applicable-to-rust | NONE - JS event-loop responsiveness check |
| `platform/daemon/src/file-sync.test.ts` | Write-if-changed file helper behavior | needs-port | NONE |
| `platform/daemon/src/github-source-fetch.test.ts` | GitHub API fetch globbing, issue/PR/discussion pagination, labels, and errors | needs-port | NONE |
| `platform/daemon/src/github-source-provider.test.ts` | GitHub source indexing, caps, comments, stale purge, and failure artifacts | needs-port | NONE |
| `platform/daemon/src/graphiq.test.ts` | GraphIQ CLI subprocess timeout and force-kill behavior | needs-port | NONE (route status replay only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs graphiq_routes_replay_validation_and_status_shapes) |
| `platform/daemon/src/hooks-config.test.ts` | Hook config loading, harness profiles, identity paths, and prompt thresholds | needs-port | NONE |
| `platform/daemon/src/hooks-recall.test.ts` | /api/hooks/recall validation, bypass/runtime conflicts, and lifecycle no-op contracts | needs-port | NONE (broad hook replay only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs hook_recall_and_compaction_endpoints) |
| `platform/daemon/src/hooks.prompt-submit.test.ts` | Prompt-submit ontology entity context injection and alias/aspect relevance | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/routes/hooks.rs prompt_submit_* tests |
| `platform/daemon/src/hooks.test.ts` | Hook lifecycle, remember/session/compaction handling, transcript and memory injection | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/routes/hooks.rs; platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs hook_session_lifecycle |
| `platform/daemon/src/http-server.test.ts` | Native Request/Response global preservation in TS HTTP server creation | not-applicable-to-rust | NONE - JavaScript global object preservation only |
| `platform/daemon/src/identity-context.test.ts` | Identity markdown/agent.yaml loading, profile sections, budgets, and symlink guards | needs-port | NONE |
| `platform/daemon/src/identity-sync.test.ts` | Agent workspace AGENTS.md composition and batched identity sync yielding | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/watcher.rs sync_agent_workspaces_writes_overrides_and_shared_identity; platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs watcher_syncs_identity_workspaces_and_architecture_doc |
| `platform/daemon/src/inference-api.test.ts` | Inference gateway/status/execution routes, auth, scoping, rate limits, and audits | needs-port | NONE (native route replay subset: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs inference_native_endpoints_cover_ts_hardening_contract) |
| `platform/daemon/src/inference-router.test.ts` | Legacy inference router API credentials, local/remote routing, and fallback targets | needs-port | NONE |
| `platform/daemon/src/inline-entity-linker.test.ts` | Inline linking of existing entities without cross-agent leakage | needs-port | NONE |
| `platform/daemon/src/knowledge-expand-api.test.ts` | Knowledge/session expansion by entity, summary text, and project matching | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs knowledge_expand_native_graph_data; knowledge_expand_enforces_authenticated_agent_scope |
| `platform/daemon/src/knowledge-feedback.test.ts` | Knowledge path feedback, pinning, entity health, aspect weight updates, and decay | needs-port | NONE |
| `platform/daemon/src/knowledge-graph-hygiene.test.ts` | Knowledge graph hygiene report for suspicious entities and safe mention candidates | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs knowledge_health_hygiene_and_communities_replay_ts_shape |
| `platform/daemon/src/knowledge-graph-list.test.ts` | Knowledge entity list/detail ordering, counts, archive filtering, and constellation graph | needs-port | NONE (shape replay only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs knowledge_legacy_entity_routes_replay_ts_shape) |
| `platform/daemon/src/knowledge-navigation.test.ts` | Knowledge navigation tree entity to aspect to group to claim to attributes | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs knowledge_navigation_routes_replay_ts_shape |
| `platform/daemon/src/logger.test.ts` | Daemon logger path resolution from SIGNET_PATH and overrides | needs-port | NONE |
| `platform/daemon/src/mcp/route.test.ts` | MCP HTTP route body parsing and malformed JSON parse-error shape | needs-port | NONE (stdio parse shape only: platform/daemon-rs/crates/signet-mcp-stdio/src/main.rs parse_error_response_shape) |
| `platform/daemon/src/mcp/tools.test.ts` | MCP server tools, auth forwarding, GraphIQ gating, schemas, and tool handlers | needs-port | NONE (tool schema/name subset only: platform/daemon-rs/crates/signet-daemon/src/mcp/tools.rs) |
| `platform/daemon/src/memory-config.test.ts` | Memory config loading from agent/config YAML, provider defaults, bounds, and warnings | needs-port | NONE (manifest config subset only: platform/daemon-rs/crates/signet-core/src/config.rs) |
| `platform/daemon/src/memory-feedback-api.test.ts` | Memory feedback API mixed-id accepted/total response | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/feedback.rs; platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs feedback_endpoint |
| `platform/daemon/src/memory-head.test.ts` | MEMORY.md projection writing, agent scope, unsafe id rejection, and token truncation | needs-port | NONE (projection truncation only: platform/daemon-rs/crates/signet-pipeline/src/memory_lineage.rs) |
| `platform/daemon/src/memory-ingest-filter.test.ts` | Generated memory artifact filename exclusion patterns | needs-port | NONE |
| `platform/daemon/src/memory-lineage.test.ts` | Memory artifact lineage projection, purge, reindexing, idempotency, and noise cleanup | has-rust-equivalent | platform/daemon-rs/crates/signet-pipeline/src/memory_lineage.rs; platform/daemon-rs/crates/signet-pipeline/tests/memory_lineage.rs |
| `platform/daemon/src/memory-search-telemetry.test.ts` | Recall telemetry storage, filters, timings, snapshots, and no-hit filtering | needs-port | NONE (telemetry list/export replay only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs telemetry_memory_search_native_list_and_export) |
| `platform/daemon/src/memory-search.test.ts` | Hybrid recall across memories, sources, sessions, temporal expansion, scoping, and ranking | needs-port | NONE (basic search/recall only: platform/daemon-rs/crates/signet-core/src/search.rs and contract_replay.rs search_endpoints) |
| `platform/daemon/src/memory-timeline.test.ts` | Memory timeline buckets, invalid timestamps, and deleted-row filtering | needs-port | NONE (route shape only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs timeline_endpoint) |
| `platform/daemon/src/middleware.test.ts` | Global middleware shadow body capture for mutating requests | needs-port | NONE |
| `platform/daemon/src/mutation-api.test.ts` | Memory mutation API remember/modify/forget/recover, idempotency, chunks, and provenance | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/routes/write.rs; platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs memory_remember_*; platform/daemon-rs/crates/signet-services/src/transactions.rs |
| `platform/daemon/src/native-embedding.test.ts` | TypeScript native embedding provider lifecycle and 768-dim transformer output | not-applicable-to-rust | NONE - TS native/transformers provider implementation only |
| `platform/daemon/src/native-memory-sources.test.ts` | Native Codex/Claude memory source discovery, symlink rejection, dedupe, and purge | needs-port | NONE |
| `platform/daemon/src/native-runtime-assets.test.ts` | Compiled JS runtime embedded dashboard/setup/worker/wasm asset materialization | not-applicable-to-rust | NONE - TS compiled-runtime asset materialization only |
| `platform/daemon/src/obsidian-source-embeddings.test.ts` | Obsidian markdown chunking, source chunk embeddings, purge, sqlite-vec mirror, and recall | needs-port | NONE (generic document chunking only: platform/daemon-rs/crates/signet-pipeline/src/document.rs) |
| `platform/daemon/src/obsidian-source-graph.test.ts` | Obsidian folders/files/wikilinks/headings/claims graph projection and purge | needs-port | NONE |
| `platform/daemon/src/onepassword.test.ts` | 1Password imported secret naming, field extraction, and conflict suffixing | needs-port | NONE |
| `platform/daemon/src/ontology-assertions.test.ts` | Ontology assertion create/link/archive/supersede validation and evidence preservation | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs ontology_assertion_routes_create_link_supersede_and_archive; ontology_assertions_aliases_operations_replay_missing_cluster |
| `platform/daemon/src/ontology-proposals.test.ts` | Ontology proposal batches, extraction, consolidation, conflicts, apply/reject, and evidence | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs ontology_native_proposal_lifecycle; ontology_extract_reads_sources_and_writes_candidates_transactionally; ontology_proposal_conflicts_group_pending_claim_slot_values |
| `platform/daemon/src/package-bundle.test.ts` | npm package dashboard bundle contents | not-applicable-to-rust | NONE - npm/package artifact test |
| `platform/daemon/src/path-feedback.test.ts` | Path feedback stats, aspect/dependency propagation, session/agent filtering, and edge promotion | needs-port | NONE |
| `platform/daemon/src/pipeline/continuity-scoring.test.ts` | Continuity scoring schema, injected memory loading, source weighting, and candidate scores | needs-port | NONE |
| `platform/daemon/src/pipeline/contradiction.test.ts` | Semantic contradiction JSON extraction from prose/fences/trailing commas | needs-port | NONE (antonym primitives only: platform/daemon-rs/crates/signet-pipeline/src/antonyms.rs) |
| `platform/daemon/src/pipeline/decision.test.ts` | Shadow decision parsing, candidate validation, vector fallback, timeout, and confidence clamps | has-rust-equivalent | platform/daemon-rs/crates/signet-pipeline/src/decision.rs |
| `platform/daemon/src/pipeline/dependency-synthesis.test.ts` | Dependency synthesis stall gating, durable progress, agent scoping, prompt contract, and edges | has-rust-equivalent | platform/daemon-rs/crates/signet-pipeline/src/dep_synthesis.rs |
| `platform/daemon/src/pipeline/dreaming-worker.test.ts` | Dreaming worker agent discovery and manual async trigger scoping | needs-port | NONE |
| `platform/daemon/src/pipeline/dreaming.test.ts` | Dreaming state, thresholds, backoff, prompt parsing, mutations, and persistence | has-rust-equivalent | platform/daemon-rs/crates/signet-pipeline/src/dreaming.rs |
| `platform/daemon/src/pipeline/extraction-fallback.test.ts` | Blocked extraction fallback dead-lettering pending jobs and memory status | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/routes/write.rs dead_letter_blocked_extraction_*; platform/daemon-rs/crates/signet-daemon/src/main.rs startup_dead_letter_* |
| `platform/daemon/src/pipeline/extraction.test.ts` | Fact/entity extraction JSON parsing, fences/prose, limits, confidence, and validation | has-rust-equivalent | platform/daemon-rs/crates/signet-pipeline/src/extraction.rs |
| `platform/daemon/src/pipeline/graph-search.test.ts` | Graph search linked and one-hop neighbor memory expansion with timeout/deleted filtering | needs-port | NONE (traversal primitive only: platform/daemon-rs/crates/signet-services/src/graph.rs traversal_collects_memories) |
| `platform/daemon/src/pipeline/graph-transactions.test.ts` | Graph entity/relation persistence, mention counts, audit history, decrement, and quality gate | needs-port | NONE (claim-key/supersession helpers only: platform/daemon-rs/crates/signet-pipeline/src/graph_transactions.rs) |
| `platform/daemon/src/pipeline/graph-traversal-compare.test.ts` | Graph traversal comparison fixtures for project-specific graph output | needs-port | NONE |
| `platform/daemon/src/pipeline/maintenance-worker.test.ts` | Maintenance worker health reports, repair recommendations, execute/observe modes, and intervals | has-rust-equivalent | platform/daemon-rs/crates/signet-pipeline/src/maintenance.rs |
| `platform/daemon/src/pipeline/model-registry.test.ts` | Static model registry catalog, provider grouping, and refresh compatibility | needs-port | NONE (route subset only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs pipeline_endpoints) |
| `platform/daemon/src/pipeline/prospective-index.test.ts` | Prospective hint generation, filtering, job enqueueing, and provider errors | needs-port | NONE |
| `platform/daemon/src/pipeline/provider-executable-availability.test.ts` | Provider executable availability checks for explicit relative paths/commands | needs-port | NONE |
| `platform/daemon/src/pipeline/provider.test.ts` | Provider process execution, ACPX/ACP events, cleanup, env/cwd safety, and timeouts | needs-port | NONE (startup provider resolution subset: platform/daemon-rs/crates/signet-daemon/src/main.rs) |
| `platform/daemon/src/pipeline/rate-limit.test.ts` | Token-bucket provider rate limiting and generate/generateWithUsage passthrough | needs-port | NONE (auth limiter only: platform/daemon-rs/crates/signet-daemon/src/auth/rate_limiter.rs) |
| `platform/daemon/src/pipeline/reflection-worker.test.ts` | Reflection worker scheduling, source collection, insight persistence, dedupe, and agent scope | needs-port | NONE |
| `platform/daemon/src/pipeline/reranker-llm.live.test.ts` | Live LLM reranker summary smoke against Ollama model | needs-port | NONE |
| `platform/daemon/src/pipeline/reranker-llm.test.ts` | LLM reranker candidate scoring JSON parsing/fallback and cleaned summaries | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/reranker.rs |
| `platform/daemon/src/pipeline/retention-worker.test.ts` | Retention sweep for tombstoned memories, history, jobs, graph links, and orphans | needs-port | NONE |
| `platform/daemon/src/pipeline/significance-gate.test.ts` | Session significance gates for turns, entity overlap, novelty, and custom thresholds | has-rust-equivalent | platform/daemon-rs/crates/signet-pipeline/src/significance_gate.rs |
| `platform/daemon/src/pipeline/skill-enrichment.test.ts` | Skill enrichment JSON extraction from prose/fences/trailing commas | needs-port | NONE |
| `platform/daemon/src/pipeline/skill-graph.test.ts` | Skill graph node install, skill_meta upsert, and scoped embedding hashes | needs-port | NONE (route replay only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs skills_endpoints) |
| `platform/daemon/src/pipeline/skill-reconciler.test.ts` | Skill reconciler idempotence and metadata updates after disk/frontmatter changes | needs-port | NONE |
| `platform/daemon/src/pipeline/stale-leases.test.ts` | Stale extraction job lease recovery and dead-letter after exhausted retries | has-rust-equivalent | platform/daemon-rs/crates/signet-core/src/queries/job.rs; platform/daemon-rs/crates/signet-pipeline/src/maintenance.rs |
| `platform/daemon/src/pipeline/structural-dependency.test.ts` | Structural dependency type registry, prompt rules, and model output validation | has-rust-equivalent | platform/daemon-rs/crates/signet-pipeline/src/structural.rs |
| `platform/daemon/src/pipeline/structured-evidence.test.ts` | Structured path/semantic ranking boosts, anchoring, hint rescue, and facet coverage | needs-port | NONE |
| `platform/daemon/src/pipeline/structured-path-evidence.test.ts` | Structured path evidence boosts for advice-shaped queries | needs-port | NONE |
| `platform/daemon/src/pipeline/summary-condensation.test.ts` | Summary/compaction root condensation with agent isolation | needs-port | NONE |
| `platform/daemon/src/pipeline/summary-worker.test.ts` | Summary fact insertion, dedupe, extraction jobs, recovery, noise skipping, and compaction | needs-port | NONE (summary noise/recovery subset: platform/daemon-rs/crates/signet-pipeline/src/summary.rs) |
| `platform/daemon/src/pipeline/supersession.test.ts` | Attribute contradiction/supersession detection, shadow proposals, and constraints | needs-port | NONE (low-level marker helpers only: platform/daemon-rs/crates/signet-pipeline/src/graph_transactions.rs; antonyms.rs) |
| `platform/daemon/src/pipeline/synthesis-worker.test.ts` | Synthesis worker write lock, cooldown, forced queueing, retries, and agent scope | needs-port | NONE |
| `platform/daemon/src/pipeline/worker-graph-gate.test.ts` | Extraction graph write gate defaults and explicit opt-out behavior | has-rust-equivalent | platform/daemon-rs/crates/signet-pipeline/src/worker.rs process_extract_persists_graph_entities_when_enabled |
| `platform/daemon/src/pipeline/worker.integration.test.ts` | End-to-end extraction decision write graph structural hints search pipeline behavior | needs-port | NONE |
| `platform/daemon/src/pipeline/worker.test.ts` | Extraction worker queueing, leasing, retries, history, shadow mode, graph/hints, and stats | needs-port | NONE (runtime stats/graph gate subset: platform/daemon-rs/crates/signet-pipeline/src/worker.rs; job primitives in signet-core/src/queries/job.rs) |
| `platform/daemon/src/plugins/host.test.ts` | TypeScript plugin host discovery, grants, surfaces, prompt contributions, and TS runtime blocking | not-applicable-to-rust | NONE - JS plugin loader/host implementation |
| `platform/daemon/src/plugins/manifest.test.ts` | TypeScript plugin manifest validation for bundled/verified plugins and TS runtime constraints | not-applicable-to-rust | NONE - JS plugin manifest/runtime validation |
| `platform/daemon/src/prompt-text.test.ts` | Prompt cleaning, recall query shape, and missing-anchor detection | needs-port | NONE |
| `platform/daemon/src/provider-safety.test.ts` | Provider safety remote/local classification, config validation, audit, rollback, and repair | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/main.rs trusted_secret_probe_hosts_*; platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs provider_safety_routes_replay_empty_audit_and_validation |
| `platform/daemon/src/repair-actions.test.ts` | Autonomous repair rate limits, gates, pruning, embedding repair, FTS, vec, and source actions | needs-port | NONE (embedding repair subset: platform/daemon-rs/crates/signet-daemon/src/routes/repair.rs) |
| `platform/daemon/src/request-scope.test.ts` | Request scope helper enforcement for agent/project in local/hybrid/team modes | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/auth/policy.rs scope_enforcement |
| `platform/daemon/src/resource-monitor.test.ts` | Resource snapshot, FD/event-loop monitors, and timer lifecycle | needs-port | NONE |
| `platform/daemon/src/routes/database-diagnostics.test.ts` | Database diagnostics route schema metadata, samples, validation, and pagination clamps | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs database_diagnostics_schema_and_samples_replay_ts_shape |
| `platform/daemon/src/routes/git-sync.test.ts` | Git config patching/status degradation/auto-commit scheduling and git route behavior | needs-port | NONE (default config only: platform/daemon-rs/crates/signet-daemon/src/routes/git.rs) |
| `platform/daemon/src/routes/graphiq-routes.test.ts` | GraphIQ install script path/package inclusion and production resolver | needs-port | NONE (status shape only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs graphiq_routes_replay_validation_and_status_shapes) |
| `platform/daemon/src/routes/marketplace-reviews.test.ts` | Marketplace review create/list and sync config routes | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs marketplace_reviews_native_roundtrip; marketplace_reviews_preserve_concurrent_file_writes |
| `platform/daemon/src/routes/marketplace.test.ts` | Marketplace MCP markdown/config parsing and MCP route dispatch | needs-port | NONE (route shape only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs marketplace_endpoints) |
| `platform/daemon/src/routes/mcp-analytics.test.ts` | MCP invocation analytics aggregation, agent scoping, since filter, and source column | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs mcp_analytics_routes_replay_ts_shapes |
| `platform/daemon/src/routes/memory-routes-scope.test.ts` | Memory route structured payload validation and agent/scope enforcement | needs-port | NONE (remember route subset: platform/daemon-rs/crates/signet-daemon/src/routes/write.rs) |
| `platform/daemon/src/routes/memory-routes.test.ts` | Codex native note write collision handling | needs-port | NONE |
| `platform/daemon/src/routes/misc-routes-provider-safety.test.ts` | Provider safety config-save guard, rollback role validation, audit persistence, and routes | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs provider_safety_routes_replay_empty_audit_and_validation |
| `platform/daemon/src/routes/misc-routes.test.ts` | Dashboard identity route fallback from agent.yaml/IDENTITY.md | needs-port | NONE |
| `platform/daemon/src/routes/pipeline-routes-agent.test.ts` | Pipeline dream route agent resolution precedence and snake_case query compatibility | needs-port | NONE |
| `platform/daemon/src/routes/pipeline-routes-models.test.ts` | Pipeline model routes for static ACPX catalog and by-provider grouping | needs-port | NONE (route presence only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs pipeline_endpoints) |
| `platform/daemon/src/routes/plugins-routes.test.ts` | Plugin route list/diagnostics/prompt-contribution/audit behavior | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs plugins_native_registry_prompt_and_audit; plugin_audit_requires_analytics_permission |
| `platform/daemon/src/routes/reflection-routes.test.ts` | Reflection routes manual generation, today/list limits, answer persistence, and duplicate claim | needs-port | NONE (empty/validation shape only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs reflection_routes_replay_empty_and_validation_shapes) |
| `platform/daemon/src/routes/secrets-routes.test.ts` | Secrets route plugin capability enforcement and Bitwarden/1Password route behavior | needs-port | NONE (local route shape only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs secrets_list) |
| `platform/daemon/src/routes/skill-analytics.test.ts` | Skill analytics top skills, agent scoping, and since filter | needs-port | NONE |
| `platform/daemon/src/routes/skills.test.ts` | Skill frontmatter parsing, listing, install/update/uninstall, analytics, and repo/package rules | needs-port | NONE (install path helpers only: platform/daemon-rs/crates/signet-daemon/src/routes/skills.rs; route replay: contract_replay.rs skills_endpoints) |
| `platform/daemon/src/routes/sources-routes.test.ts` | Source connect/disconnect/reconnect/index/purge routes for Obsidian/Discord/GitHub and token rejection | needs-port | NONE (route shape only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs sources_endpoints) |
| `platform/daemon/src/scheduler/spawn.test.ts` | Scheduler task spawn model selection for Codex and Claude Code harnesses | needs-port | NONE |
| `platform/daemon/src/scheduler/worker-execute.test.ts` | Scheduler task execution failure handling and skill usage recording | needs-port | NONE |
| `platform/daemon/src/scheduler/worker.test.ts` | Scheduler due-task selection, running-run exclusion, ordering, and model cache | needs-port | NONE (static constants only: platform/daemon-rs/crates/signet-daemon/src/routes/scheduler.rs) |
| `platform/daemon/src/secrets.test.ts` | Local encrypted secrets store, exec redaction/timeouts/jobs/concurrency/health/corruption | needs-port | NONE (name/default store helpers only: platform/daemon-rs/crates/signet-daemon/src/routes/secrets.rs) |
| `platform/daemon/src/session-api.test.ts` | Session API live presence listing and prefixed bypass toggles | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs session_endpoints; session_bypass_replays_ts_validation_and_toggle_contract |
| `platform/daemon/src/session-checkpoints.test.ts` | Session checkpoint write/query/prune/redaction and queue merge behavior | needs-port | NONE (checkpoint trigger primitive only: platform/daemon-rs/crates/signet-services/src/session.rs) |
| `platform/daemon/src/session-memories.test.ts` | Session candidate memory recording, FTS/vector hit tracking, scores, idempotency, and queries | needs-port | NONE |
| `platform/daemon/src/session-noise.test.ts` | Projection-noise classification for temp projects and synthetic session ids | has-rust-equivalent | platform/daemon-rs/crates/signet-pipeline/src/memory_lineage.rs; platform/daemon-rs/crates/signet-pipeline/src/summary.rs |
| `platform/daemon/src/session-recall-dedupe.test.ts` | Session recall de-duplication epochs, includeRecalled, and agent isolation | needs-port | NONE (dedup window primitive only: platform/daemon-rs/crates/signet-services/src/session.rs) |
| `platform/daemon/src/session-start-format.test.ts` | Session start prompt formatting, peer tool detection, path serialization, and timestamps | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/routes/hooks.rs build_signet_system_prompt_mentions_transcript_artifacts |
| `platform/daemon/src/session-tracker.test.ts` | Session tracker claim/release, bypass TTLs, rotation, cleanup, and scope parsing | needs-port | NONE (claim/bypass primitive only: platform/daemon-rs/crates/signet-services/src/session.rs) |
| `platform/daemon/src/single-flight-runner.test.ts` | Single-flight runner queued rerun and transient failure replay behavior | needs-port | NONE |
| `platform/daemon/src/skill-invocations.test.ts` | Skill invocation recording under agent scope and skill metadata updates | needs-port | NONE |
| `platform/daemon/src/source-artifact-graph.test.ts` | Provider artifact graph projection, refresh, path purge, and whole-source removal | needs-port | NONE |
| `platform/daemon/src/source-index-progress.test.ts` | Duplicate delayed source-index runner completed-job guard | needs-port | NONE |
| `platform/daemon/src/structural-features.test.ts` | Structural candidate feature vectors, slot density, and negative gap clamps | needs-port | NONE |
| `platform/daemon/src/subagent-context.test.ts` | Transcript search fallback LIKE parameter order for session/project filters | needs-port | NONE |
| `platform/daemon/src/synthesis-worker.test.ts` | TypeScript synthesis render worker DB accessor and message protocol | not-applicable-to-rust | NONE - Node/Bun worker-thread render protocol |
| `platform/daemon/src/task-scope.test.ts` | Task scope helper lookup and visibility under scope enforcement | needs-port | NONE |
| `platform/daemon/src/temporal-expand.test.ts` | Temporal node expansion lineage, linked memories, transcript context, and project filtering | needs-port | NONE |
| `platform/daemon/src/temporal-summary-api.test.ts` | Temporal summary API routing/auth/query aliases/expansion/tags/project fallback | needs-port | NONE |
| `platform/daemon/src/thread-heads.test.ts` | Thread-head scope/label/upsert/summarization behavior | needs-port | NONE |
| `platform/daemon/src/transactions.test.ts` | Transactional memory modify/forget/recover/apply-decision with history, conflicts, and pinning | has-rust-equivalent | platform/daemon-rs/crates/signet-services/src/transactions.rs; platform/daemon-rs/crates/signet-core/src/queries/memory.rs |
| `platform/daemon/src/transcript-capture.test.ts` | Live prompt transcript formatting and duplicate-suffix append prevention | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/routes/hooks.rs prompt_submit_writes_transcript_audit_and_live_snapshot |
| `platform/daemon/src/transcript-jsonl.test.ts` | Canonical transcript JSONL locks/backfill/dedup/OOM guard/markers/live turns | needs-port | NONE (normalization subset: platform/daemon-rs/crates/signet-daemon/src/routes/hooks.rs normalize_session_transcript_* tests) |
| `platform/daemon/src/transcript-normalization.test.ts` | Transcript normalization for Codex events, raw text, generic JSONL, and no-turn warnings | has-rust-equivalent | platform/daemon-rs/crates/signet-daemon/src/routes/hooks.rs normalize_session_transcript_* tests |
| `platform/daemon/src/umap-projection.test.ts` | UMAP projection pagination and LIKE escaping for queries/tags | needs-port | NONE |
| `platform/daemon/src/update-route.test.ts` | Update route targetVersion body handling, channel config, CLI timeouts, and desktop reasons | needs-port | NONE (update status replay only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs update_status) |
| `platform/daemon/src/update-system.test.ts` | Update install verification, source sync, desktop update integration, rollback, and channels | needs-port | NONE |
| `platform/daemon/src/vector-integration.test.ts` | Vector blob roundtrip, cosine similarity, blended rerank ordering, and KNN edges | has-rust-equivalent | platform/daemon-rs/crates/signet-pipeline/src/write_gate.rs; platform/daemon-rs/crates/signet-core/src/search.rs; platform/daemon-rs/crates/signet-core/tests/embedding_upsert.rs |
| `platform/daemon/src/version.test.ts` | Version comparison helpers for semver, v-prefixes, prereleases, and newer checks | needs-port | NONE (version endpoint only: platform/daemon-rs/crates/signet-daemon/tests/contract_replay.rs version_endpoint) |
| `platform/daemon/src/watcher-ignore.test.ts` | Watcher ignore matcher for DB/journals/generated workspace files/.sigignore/globs/artifacts | needs-port | NONE |
| `platform/daemon/src/which.test.ts` | Executable lookup for relative paths and PATH search | needs-port | NONE |

## Needs-port files by core

### recall/ranking (18)

- `platform/daemon/src/aggregate-recall.test.ts` - Aggregate recall planning, synthesis, evidence linking, and save policy
- `platform/daemon/src/context-budget.test.ts` - Recall/context row selection and truncation by character/token budgets
- `platform/daemon/src/memory-search-telemetry.test.ts` - Recall telemetry storage, filters, timings, snapshots, and no-hit filtering
- `platform/daemon/src/memory-search.test.ts` - Hybrid recall across memories, sources, sessions, temporal expansion, scoping, and ranking
- `platform/daemon/src/memory-timeline.test.ts` - Memory timeline buckets, invalid timestamps, and deleted-row filtering
- `platform/daemon/src/path-feedback.test.ts` - Path feedback stats, aspect/dependency propagation, session/agent filtering, and edge promotion
- `platform/daemon/src/pipeline/graph-search.test.ts` - Graph search linked and one-hop neighbor memory expansion with timeout/deleted filtering
- `platform/daemon/src/pipeline/graph-traversal-compare.test.ts` - Graph traversal comparison fixtures for project-specific graph output
- `platform/daemon/src/pipeline/reranker-llm.live.test.ts` - Live LLM reranker summary smoke against Ollama model
- `platform/daemon/src/pipeline/structured-evidence.test.ts` - Structured path/semantic ranking boosts, anchoring, hint rescue, and facet coverage
- `platform/daemon/src/pipeline/structured-path-evidence.test.ts` - Structured path evidence boosts for advice-shaped queries
- `platform/daemon/src/prompt-text.test.ts` - Prompt cleaning, recall query shape, and missing-anchor detection
- `platform/daemon/src/session-recall-dedupe.test.ts` - Session recall de-duplication epochs, includeRecalled, and agent isolation
- `platform/daemon/src/structural-features.test.ts` - Structural candidate feature vectors, slot density, and negative gap clamps
- `platform/daemon/src/subagent-context.test.ts` - Transcript search fallback LIKE parameter order for session/project filters
- `platform/daemon/src/temporal-expand.test.ts` - Temporal node expansion lineage, linked memories, transcript context, and project filtering
- `platform/daemon/src/temporal-summary-api.test.ts` - Temporal summary API routing/auth/query aliases/expansion/tags/project fallback
- `platform/daemon/src/umap-projection.test.ts` - UMAP projection pagination and LIKE escaping for queries/tags

### pipeline stages (19)

- `platform/daemon/src/embedding-fetch.test.ts` - Embedding provider fetch routing, API-key rules, timeouts, and native fallbacks
- `platform/daemon/src/inference-router.test.ts` - Legacy inference router API credentials, local/remote routing, and fallback targets
- `platform/daemon/src/pipeline/continuity-scoring.test.ts` - Continuity scoring schema, injected memory loading, source weighting, and candidate scores
- `platform/daemon/src/pipeline/contradiction.test.ts` - Semantic contradiction JSON extraction from prose/fences/trailing commas
- `platform/daemon/src/pipeline/dreaming-worker.test.ts` - Dreaming worker agent discovery and manual async trigger scoping
- `platform/daemon/src/pipeline/model-registry.test.ts` - Static model registry catalog, provider grouping, and refresh compatibility
- `platform/daemon/src/pipeline/prospective-index.test.ts` - Prospective hint generation, filtering, job enqueueing, and provider errors
- `platform/daemon/src/pipeline/provider-executable-availability.test.ts` - Provider executable availability checks for explicit relative paths/commands
- `platform/daemon/src/pipeline/provider.test.ts` - Provider process execution, ACPX/ACP events, cleanup, env/cwd safety, and timeouts
- `platform/daemon/src/pipeline/rate-limit.test.ts` - Token-bucket provider rate limiting and generate/generateWithUsage passthrough
- `platform/daemon/src/pipeline/reflection-worker.test.ts` - Reflection worker scheduling, source collection, insight persistence, dedupe, and agent scope
- `platform/daemon/src/pipeline/summary-condensation.test.ts` - Summary/compaction root condensation with agent isolation
- `platform/daemon/src/pipeline/summary-worker.test.ts` - Summary fact insertion, dedupe, extraction jobs, recovery, noise skipping, and compaction
- `platform/daemon/src/pipeline/synthesis-worker.test.ts` - Synthesis worker write lock, cooldown, forced queueing, retries, and agent scope
- `platform/daemon/src/pipeline/worker.integration.test.ts` - End-to-end extraction decision write graph structural hints search pipeline behavior
- `platform/daemon/src/pipeline/worker.test.ts` - Extraction worker queueing, leasing, retries, history, shadow mode, graph/hints, and stats
- `platform/daemon/src/routes/pipeline-routes-agent.test.ts` - Pipeline dream route agent resolution precedence and snake_case query compatibility
- `platform/daemon/src/routes/pipeline-routes-models.test.ts` - Pipeline model routes for static ACPX catalog and by-provider grouping
- `platform/daemon/src/routes/reflection-routes.test.ts` - Reflection routes manual generation, today/list limits, answer persistence, and duplicate claim

### memory/lineage (11)

- `platform/daemon/src/db-accessor.test.ts` - DB accessor lifecycle, transactions, backup pruning, and custom SQLite path resolution
- `platform/daemon/src/embedding-coverage.test.ts` - Embedding coverage detection for duplicate hashes and stale source-linked embeddings
- `platform/daemon/src/embedding-tracker.test.ts` - Embedding retry backoff, suppression, content-hash invalidation, and success clearing
- `platform/daemon/src/memory-config.test.ts` - Memory config loading from agent/config YAML, provider defaults, bounds, and warnings
- `platform/daemon/src/memory-head.test.ts` - MEMORY.md projection writing, agent scope, unsafe id rejection, and token truncation
- `platform/daemon/src/memory-ingest-filter.test.ts` - Generated memory artifact filename exclusion patterns
- `platform/daemon/src/routes/memory-routes.test.ts` - Codex native note write collision handling
- `platform/daemon/src/session-checkpoints.test.ts` - Session checkpoint write/query/prune/redaction and queue merge behavior
- `platform/daemon/src/session-memories.test.ts` - Session candidate memory recording, FTS/vector hit tracking, scores, idempotency, and queries
- `platform/daemon/src/thread-heads.test.ts` - Thread-head scope/label/upsert/summarization behavior
- `platform/daemon/src/transcript-jsonl.test.ts` - Canonical transcript JSONL locks/backfill/dedup/OOM guard/markers/live turns

### retention (1)

- `platform/daemon/src/pipeline/retention-worker.test.ts` - Retention sweep for tombstoned memories, history, jobs, graph links, and orphans

### ontology (4)

- `platform/daemon/src/knowledge-feedback.test.ts` - Knowledge path feedback, pinning, entity health, aspect weight updates, and decay
- `platform/daemon/src/knowledge-graph-list.test.ts` - Knowledge entity list/detail ordering, counts, archive filtering, and constellation graph
- `platform/daemon/src/pipeline/graph-transactions.test.ts` - Graph entity/relation persistence, mention counts, audit history, decrement, and quality gate
- `platform/daemon/src/pipeline/supersession.test.ts` - Attribute contradiction/supersession detection, shadow proposals, and constraints

### hooks (2)

- `platform/daemon/src/hooks-config.test.ts` - Hook config loading, harness profiles, identity paths, and prompt thresholds
- `platform/daemon/src/hooks-recall.test.ts` - /api/hooks/recall validation, bypass/runtime conflicts, and lifecycle no-op contracts

### scoping (6)

- `platform/daemon/src/agent-id.test.ts` - Agent id normalization, daemon agent resolution, and agent registry policy
- `platform/daemon/src/cross-agent.test.ts` - Cross-agent presence, direct/broadcast messages, events, and durable receipts
- `platform/daemon/src/inline-entity-linker.test.ts` - Inline linking of existing entities without cross-agent leakage
- `platform/daemon/src/routes/memory-routes-scope.test.ts` - Memory route structured payload validation and agent/scope enforcement
- `platform/daemon/src/session-tracker.test.ts` - Session tracker claim/release, bypass TTLs, rotation, cleanup, and scope parsing
- `platform/daemon/src/task-scope.test.ts` - Task scope helper lookup and visibility under scope enforcement

### auth/secrets (7)

- `platform/daemon/src/auth/api-keys.test.ts` - Connector API key creation, metadata-only storage, revocation, and permission semantics
- `platform/daemon/src/bitwarden.test.ts` - Bitwarden secret references, CLI writes, migration, and dry-run safety
- `platform/daemon/src/daemon-auth-guard-colocation.test.ts` - Route guard placement and auth/permission failures across daemon APIs
- `platform/daemon/src/daemon-cors.test.ts` - CORS origin allow/deny rules for daemon, Tailscale, desktop, and localhost
- `platform/daemon/src/onepassword.test.ts` - 1Password imported secret naming, field extraction, and conflict suffixing
- `platform/daemon/src/routes/secrets-routes.test.ts` - Secrets route plugin capability enforcement and Bitwarden/1Password route behavior
- `platform/daemon/src/secrets.test.ts` - Local encrypted secrets store, exec redaction/timeouts/jobs/concurrency/health/corruption

### marketplace (1)

- `platform/daemon/src/routes/marketplace.test.ts` - Marketplace MCP markdown/config parsing and MCP route dispatch

### skills (7)

- `platform/daemon/src/dreaming-skill.test.ts` - Built-in dreaming skill metadata and graph-first maintenance framing
- `platform/daemon/src/pipeline/skill-enrichment.test.ts` - Skill enrichment JSON extraction from prose/fences/trailing commas
- `platform/daemon/src/pipeline/skill-graph.test.ts` - Skill graph node install, skill_meta upsert, and scoped embedding hashes
- `platform/daemon/src/pipeline/skill-reconciler.test.ts` - Skill reconciler idempotence and metadata updates after disk/frontmatter changes
- `platform/daemon/src/routes/skill-analytics.test.ts` - Skill analytics top skills, agent scoping, and since filter
- `platform/daemon/src/routes/skills.test.ts` - Skill frontmatter parsing, listing, install/update/uninstall, analytics, and repo/package rules
- `platform/daemon/src/skill-invocations.test.ts` - Skill invocation recording under agent scope and skill metadata updates

### sources (11)

- `platform/daemon/src/connectors/filesystem.test.ts` - Filesystem connector glob matching and dotfile discovery rules
- `platform/daemon/src/discord-source-fetch.test.ts` - Discord REST fetch pagination, threads, members, errors, snowflakes, and timeouts
- `platform/daemon/src/discord-source-provider.test.ts` - Discord source indexing, gateway/cache import, partial failures, and stale purge
- `platform/daemon/src/github-source-fetch.test.ts` - GitHub API fetch globbing, issue/PR/discussion pagination, labels, and errors
- `platform/daemon/src/github-source-provider.test.ts` - GitHub source indexing, caps, comments, stale purge, and failure artifacts
- `platform/daemon/src/native-memory-sources.test.ts` - Native Codex/Claude memory source discovery, symlink rejection, dedupe, and purge
- `platform/daemon/src/obsidian-source-embeddings.test.ts` - Obsidian markdown chunking, source chunk embeddings, purge, sqlite-vec mirror, and recall
- `platform/daemon/src/obsidian-source-graph.test.ts` - Obsidian folders/files/wikilinks/headings/claims graph projection and purge
- `platform/daemon/src/routes/sources-routes.test.ts` - Source connect/disconnect/reconnect/index/purge routes for Obsidian/Discord/GitHub and token rejection
- `platform/daemon/src/source-artifact-graph.test.ts` - Provider artifact graph projection, refresh, path purge, and whole-source removal
- `platform/daemon/src/source-index-progress.test.ts` - Duplicate delayed source-index runner completed-job guard

### mcp (2)

- `platform/daemon/src/mcp/route.test.ts` - MCP HTTP route body parsing and malformed JSON parse-error shape
- `platform/daemon/src/mcp/tools.test.ts` - MCP server tools, auth forwarding, GraphIQ gating, schemas, and tool handlers

### dashboard (2)

- `platform/daemon/src/identity-context.test.ts` - Identity markdown/agent.yaml loading, profile sections, budgets, and symlink guards
- `platform/daemon/src/routes/misc-routes.test.ts` - Dashboard identity route fallback from agent.yaml/IDENTITY.md

### misc routes (23)

- `platform/daemon/src/analytics.test.ts` - In-memory analytics counters, latency/error ring buffers, and summaries
- `platform/daemon/src/bind-with-retry.test.ts` - HTTP bind retry/backoff/abort behavior
- `platform/daemon/src/daemon-refactor.test.ts` - Daemon import side-effect guard and auth reload idempotency
- `platform/daemon/src/diagnostics.test.ts` - Queue/storage/index/worker diagnostics health scoring
- `platform/daemon/src/embedding-health.test.ts` - Embedding health diagnostics and sqlite-vec error classification
- `platform/daemon/src/file-sync.test.ts` - Write-if-changed file helper behavior
- `platform/daemon/src/graphiq.test.ts` - GraphIQ CLI subprocess timeout and force-kill behavior
- `platform/daemon/src/inference-api.test.ts` - Inference gateway/status/execution routes, auth, scoping, rate limits, and audits
- `platform/daemon/src/logger.test.ts` - Daemon logger path resolution from SIGNET_PATH and overrides
- `platform/daemon/src/middleware.test.ts` - Global middleware shadow body capture for mutating requests
- `platform/daemon/src/repair-actions.test.ts` - Autonomous repair rate limits, gates, pruning, embedding repair, FTS, vec, and source actions
- `platform/daemon/src/resource-monitor.test.ts` - Resource snapshot, FD/event-loop monitors, and timer lifecycle
- `platform/daemon/src/routes/git-sync.test.ts` - Git config patching/status degradation/auto-commit scheduling and git route behavior
- `platform/daemon/src/routes/graphiq-routes.test.ts` - GraphIQ install script path/package inclusion and production resolver
- `platform/daemon/src/scheduler/spawn.test.ts` - Scheduler task spawn model selection for Codex and Claude Code harnesses
- `platform/daemon/src/scheduler/worker-execute.test.ts` - Scheduler task execution failure handling and skill usage recording
- `platform/daemon/src/scheduler/worker.test.ts` - Scheduler due-task selection, running-run exclusion, ordering, and model cache
- `platform/daemon/src/single-flight-runner.test.ts` - Single-flight runner queued rerun and transient failure replay behavior
- `platform/daemon/src/update-route.test.ts` - Update route targetVersion body handling, channel config, CLI timeouts, and desktop reasons
- `platform/daemon/src/update-system.test.ts` - Update install verification, source sync, desktop update integration, rollback, and channels
- `platform/daemon/src/version.test.ts` - Version comparison helpers for semver, v-prefixes, prereleases, and newer checks
- `platform/daemon/src/watcher-ignore.test.ts` - Watcher ignore matcher for DB/journals/generated workspace files/.sigignore/globs/artifacts
- `platform/daemon/src/which.test.ts` - Executable lookup for relative paths and PATH search
