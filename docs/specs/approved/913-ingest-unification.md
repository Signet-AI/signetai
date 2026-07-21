---
title: "#913: Unified Ingest — One Dreaming Activity, Pluggable Executor"
description: "Unify pipeline dreaming and agentic dreaming into one ingest operation with interchangeable inference executors; retire the legacy daemon dreaming worker."
order: 2
section: "Memory Architecture"
informed_by:
  - "https://github.com/Signet-AI/signetai/issues/913"
  - "docs/specs/approved/dreaming-memory-consolidation.md"
success_criteria:
  - "Daemon dreaming and agentic dreaming produce identical memory + graph output classes through the same queue, the same deterministic lease/context and validate/apply phases, and the same IngestPlan contract; only the inference source differs"
  - "One consolidated reasoning call per ~128k-token batch of inbox reasons holistically over the whole batch and matches or beats the retired 5-stage chain on fact recall, entity precision, aspect-naming consistency, and dependency-edge F1"
  - "The legacy daemon dreaming worker, dream-promotion.ts, the 5-stage scaffolds, the /api/dream/* routes, signet dream CLI, and the dreaming_state/dreaming_passes tables are deleted in the cutover with no shim or fallback reader"
  - "Agent-scoped fenced leasing prevents double-apply across the daemon and an external harness serving the same agent"
  - "IngestPlan graph ops reach the full 19-op ontology vocabulary (entities, aspects, attributes, links, merges, supersedes) with version chains, source provenance, and uniform reversibility"
  - "daemon-rs parity lands in the same PR"
scope_boundary: "This spec covers the unified ingest operation, the IngestPlan contract, the agent-scoped queue/lease, the consolidated planner, the edge normalizers, the legacy-dreaming cutover, and daemon-rs parity. It does NOT touch the summary worker or the session_summaries DAG (left intact). It does NOT route graph writes through the proposal review queue (direct apply only). It does NOT build the cloud runner (types/interfaces only)."
---

# #913: Unified Ingest — One Dreaming Activity, Pluggable Executor

*Dreaming is the activity. The daemon, a cron-driven harness, and a future
cloud runner are three ways to fill the same reasoning slot — not three
memory systems.*

## North star

Dreaming (memory maintenance) becomes **one activity with interchangeable
inference executors.** All executors share:

- one durable queue (`memory_jobs`),
- one deterministic **lease/context** phase and one deterministic
  **validate/apply** phase,
- one strict handoff object: **`IngestPlan`**,
- one runbook prompt: **`DREAMING.md`** (via the existing identity resolver).

Only the **plan** phase differs — where the inference comes from. The daemon
invokes the configured provider in-process; an external harness reasons in its
own turn over a leased context bundle; a future cloud runner fills the same
slot remotely.

The legacy daemon dreaming worker (`dreaming-worker.ts` + `dreaming.ts`) is a
broken third path and is deleted in the cutover.

## Locked decisions (Nicholai-signed, 2026-07-12)

1. **Handoff object: `IngestPlan`.** Emitted by plan, consumed by apply. The
   dreaming name stays on the runbook and the skill, not the data structure.

2. **Batch-unit planner.** One `IngestPlan` per call, packed to the effective
   token budget — the model's context window minus reserved overhead, with
   **128k as the canonical unit and the undetectable-window fallback.**
   Maximize tokens-per-call without overflowing. Items are packed whole
   (never bisected mid-content); a single item larger than one budget splits
   at safe boundaries (turn / message / paragraph), never silently truncated.

3. **Graph writes — unified through `applyOntologyOperationBatch` (direct
   apply, `propose:false`), no split.** `IngestPlan` emits ops from the full
   19-op ontology vocabulary — `create_entity`, `rename_entity`,
   `archive_entity`, `merge_entities`, `create_aspect`, `rename_aspect`,
   `archive_aspect`, `add_claim_value`, `set_claim_value`,
   `supersede_claim_value`, `archive_claim_value`, `restore_claim_version`,
   `create_link`, `update_link`, `archive_link`, `create_policy`,
   `create_action_type`, `create_interface`, `attach_interface`. This is
   literally the dreaming skill's capability surface. Every op carries a
   version chain + source provenance + apply-audit row, so reversibility is
   uniform and free. `txPersistEntities` is retired from ingest once the
   extraction worker it served is replaced (verify other callers first); the
   memory↔entity recall index (`memory_entity_mentions`) is **not** an
   ontology op and rides with memory creation.

   *Divergence from the issue's "Option A / `txPersistEntities`" decision —
   superseded because full ontology capability is only reachable via the
   ontology apply path, and the "overbearing control plane" the issue
   rejected was the **proposal review queue**, not the **direct-apply path**
   (which has no queue, no pending state). The apply-audit row is the
   reversibility mechanism the issue's own guardrails demand.*

4. **§7 out of scope — summary worker and `session_summaries` DAG left
   intact.** Migration 088 does not touch `summary_jobs`; `boundary_reason`
   stays on `summary_jobs`. `ingest` takes over the extraction worker's
   transcript→memory role alongside the surviving summary worker. Token
   duplication is accepted as a stated trade-off in exchange for not
   redesigning the DAG. This drops the #903, temporal-recall-re-home,
   boundary_reason-on-queue, and condensation entanglements from the cutover.

5. **One consolidated reasoning call per batch.** The 5-stage chain
   (extraction, decision, escalation-L2, structural-classify,
   structural-dependency) folds into the single batch-window call.
   escalation-L3 (deterministic hash+keyword filter) stays as a post-plan
   guard. **`dependency-synthesis` stays a separate periodic `maintain`
   lane** — it joins an entity's full history across batches/time, which a
   single batch cannot see.

6. **Three-phase `ingest`.** `lease/context` (deterministic, shared) →
   `plan` (runner-owned, one consolidated call) → `validate/apply`
   (deterministic, shared).

7. **Context budget.** ~80% of `RoutingModelConfig.contextWindow`; one
   **128k fallback constant** for both daemon and agentic paths when the
   window is undetectable (e.g. Claude Code). Items exceeding the effective
   budget fail explicitly with a structured dead-letter reason — never
   silent truncation.

8. **Queue: `memory_jobs`, agent-scoped fenced lease.** Three distinct
   fields: `agent_id` (data ownership), `lease_owner` (executor holding the
   attempt), `lease_token` (fencing proof, CAS target on apply). Priority
   lanes — live > recent/import > backfill > maintenance — leased
   highest-first with ≥1 slot reserved for live, plus per-agent fairness via
   an **admission/selection layer above the #918 semaphore** (the semaphore
   stays daemon-global and agent-agnostic).

9. **`planning` lifecycle.** A distinct `planning` status is reclaimed
   leniently back to `pending` (no double-apply). Per-row ceilings on
   `planning_attempts`, cumulative wall-clock (from `planning_started_at`),
   and per-item cooldown (from `last_planning_at`); whichever fires first
   dead-letters, with a distinguished reason. **No checkpoint column** —
   resumability comes from per-operation idempotency (key = item id +
   `plan_hash`) plus `INSERT OR IGNORE`/upsert semantics (per #900/#926).

10. **`DREAMING.md` + the `"dreaming"` identity session kind survive** as the
    runbook prompt, served to both runners via the existing
    `resolveSpecialIdentityFiles(agentsDir, "dreaming")` resolver. Only the
    legacy worker's read of it dies.

11. **Skill survives, re-pointed.** `skills/dreaming/SKILL.md` (canonical,
    `builtin:true`) rewires from `signet ontology stream apply` to
    `signet ingest lease` → reason in harness → `signet ingest apply-plan`.
    The apply-first / no-proposal-queue / no-SQLite-edits /
    no-`remember`-endpoint guarantees are preserved in ingest-first wording.
    Both parity tests (`dreaming-skill.test.ts`, `skills_parity.rs`) rewrite
    in lockstep.

12. **Deterministic guards stay outside the model.** Truly deterministic:
    `IngestPlan` schema validation, `normalized_content` dedup/hash,
    agent-scoped lease filtering, idempotency key, `assessDurability` (#917),
    `assessSignificance` (deterministic; rehomed as the ingest entry
    pre-filter), `detectContradictionRisk` (syntactic), `shouldPersistEntity`
    (#914/#904 — **extended to the `create_entity` apply path** so label
    quality does not regress when entity creation moves off `txPersistEntities`),
    and the forgotten-memory invariant (#910/#895 — **cancel filter broadened
    to the new ingest `job_type` + planning/applying states**). Model-/
    embedding-bounded (where drift hides): `detectSemanticContradiction` and
    `assessWriteGate`.

13. **`#908` is not closed by this refactor** — only the queue-lifecycle
    (running-vs-pending) slice. The full configured/resolved/effective
    provider-state surface stays open. `memories.extraction_status`: stop the
    redundant inline writes, derive on read, keep the column one release.

14. **`scoreContinuity` stays a separate session-end evaluation**, **not**
    folded into `IngestPlan`. It reads only runtime-injected memories
    (`was_injected=1`), preserving feedback non-circularity.

15. **Command-extraction re-homes as `provider='command'`** — one
    runner-owned executor type. Its subprocess lifecycle + `AbortSignal`
    plumbing + crash-recovery are the seed for the future harness/cloud
    executor shape.

16. **Cutover: one atomic PR.** Build and prove the replacement (Phase 6
    parity gate), then delete the legacy worker, `dream-promotion.ts`, the
    5-stage scaffolds, the `/api/dream/*` routes, the `signet dream` CLI, and
    the `dreaming_state`/`dreaming_passes` tables in the **same PR**, with
    daemon-rs parity in lockstep. No shim, no fallback reader, no parallel
    path.

## Walls resolved (first-principles, no patches)

These are places the issue's literal wording broke against code reality. Each
was rederived rather than patched.

- **"5 stages → 1" granularity.** Structural-classify/dependency batch
  *across memories*; dependency-synthesis joins an entity's *full history*.
  Resolved by the batch-unit planner (within-batch structural work folds in)
  plus keeping dependency-synthesis as a periodic `maintain` lane. Not "one
  call replaces all five unconditionally" — one call per batch for the
  per-item + within-batch stages; cross-time consolidation is maintenance.
- **Graph-write surface undercount.** The issue named only `txPersistEntities`,
  which cannot write aspects/attributes. Resolved by routing all graph ops
  through `applyOntologyOperationBatch` (full vocabulary). Dissolves the
  would-be split into the forbidden second channel.
- **`session_summaries` content source.** Dropping the LLM pass would have
  orphaned the DAG's content column and its many readers. Resolved by §7
  descoping — leave it intact this refactor.
- **"Apply checkpoints the posted plan."** #900/#926 just rejected a
  checkpoint column. Resolved by per-op idempotency; no checkpoint column.
- **Entity-label gate gap.** `shouldPersistEntity` ran only inside
  `txPersistEntities`. Resolved by extending it to the `create_entity` apply
  path (now mandatory, not defensive).
- **Forgotten-memory filter scope.** Cancel was hardcoded to
  `job_type='extract'`. Resolved by broadening to the new job_type + states.
- **`contextWindow` optional / no default.** Resolved by one 128k fallback
  constant shared by both paths.
- **#908 overclaim.** Resolved by stating the slice this refactor covers and
  leaving the provider-state surface open.
- **Agentic runner never received `DREAMING.md`.** Resolved by the shared
  lease/context builder including it in the bundle for both runners.

## Phased plan (build → prove → cutover)

- **Phase 0 — decisions (this document).** Signed.
- **Phase 1 — migration 088 (schema only).** `memory_jobs` gains
  `agent_id`, `lease_owner`, `lease_token`, `lease_expires_at`, `priority`,
  `planning_attempts`, `planning_started_at`, `last_planning_at`,
  `plan_hash`; backfill `agent_id`; lease/stale/boundary indexes; drop
  `dreaming_state` + `dreaming_passes`. daemon-rs schema in lockstep.
- **Phase 2 — unified ingest primitives (additive, unwired).** Fenced lease,
  lease/context builder, `IngestPlan` schema, apply dispatcher,
  stale-lease extension, per-file patch locking; guard generalizations
  (entity-label gate, forgotten-memory filter).
- **Phase 3 — consolidated planner + edge envelope normalizers (additive).**
  The batch-window reasoning call over the #918 broker; source-preserving
  envelope; MD/HTML/JSON/plain normalizers (zero-dep); re-home
  `dream-promotion`'s source readers + provenance.
- **Phase 4 — re-point skill + CLI + routes to `/api/ingest`.**
- **Phase 5 — parity proof (the gate).** Old chain vs new planner on shared
  transcripts + LoCoMo. No cutover until ≥ today's quality.
- **Phase 6 — CUTOVER (one PR).** Delete legacy worker, `dream-promotion.ts`,
  5-stage scaffolds, routes/CLI/tables; daemon-rs parity; migration 088
  lands. No shim.
- **Phase 7 — follow-ups filed separately.** #901 (queue observability),
  #902 (TTL→queue), #903 (temporal, if pursued), #908 (provider-state
  surface), supersession daemon-rs parity, `extraction_status` cleanup,
  `txPersistEntities` retirement audit.

## Migration 088 (sketch)

```sql
ALTER TABLE memory_jobs ADD COLUMN agent_id TEXT;
ALTER TABLE memory_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE memory_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE memory_jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE memory_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_jobs ADD COLUMN planning_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_jobs ADD COLUMN planning_started_at TEXT;
ALTER TABLE memory_jobs ADD COLUMN last_planning_at TEXT;
ALTER TABLE memory_jobs ADD COLUMN plan_hash TEXT;

-- backfill agent_id (data ownership)
UPDATE memory_jobs
   SET agent_id = COALESCE(
     (SELECT agent_id FROM documents WHERE id = memory_jobs.document_id),
     (SELECT agent_id FROM memories  WHERE id = memory_jobs.memory_id),
     'default');

CREATE INDEX IF NOT EXISTS idx_memory_jobs_lease
  ON memory_jobs(agent_id, status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_stale
  ON memory_jobs(status, lease_expires_at)
  WHERE status IN ('leased','planning','applying');

DROP INDEX IF EXISTS idx_dreaming_passes_agent;
DROP TABLE IF EXISTS dreaming_state;
DROP TABLE IF EXISTS dreaming_passes;
```

`summary_jobs` is **not** touched (§7 out of scope). Production drops require
a backup-first CLI step (never delete production data without backup).

## Out of scope

- The audited **proposal review queue** for graph writes (direct apply only).
- The cloud runner (types/interfaces only; cross-device queue continuity is a
  cloud-runner concern).
- The pause subsystem (separate propagated bug fix; #918 did the broker).
- §7 summary-worker / `session_summaries` work (left intact).
- `supersession` daemon-rs parity (filed as parity debt unless ported in
  cutover).
