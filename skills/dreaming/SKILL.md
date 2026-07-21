---
name: dreaming
description: "Maintain Signet's living ontology and memory substrate from transcripts, memory artifacts, source artifacts, notes, summaries, and imported records."
version: 2.0.0
builtin: true
---

# Dreaming

Use this skill when an agent should wake up, read accumulated source evidence,
and turn it into Signet ontology structure. The job is flexible bulk ingestion:
transcripts, memory artifacts, source artifacts, notes, summaries, and imported
records go in; the knowledge graph, scoped memories, and identity/behavior files
get better.

Dreaming is one activity with two interchangeable runners — the daemon's own
24/7 ingest worker, and this agentic runner (a harness turn on cron). Both drive
the same unified ingest pipeline: lease a context bundle from the daemon, reason
over it in your turn, and post an IngestPlan back. The daemon is the single
writer; this skill never touches the database directly. Memory and source
artifacts are the evidence your graphOps cite. The structured graph vocabulary
is entities, aspects, groups, claims, attributes, and links; the daemon's apply
is the audited path that writes them.

Apply first with provenance is the blanket rule for dreaming and ordinary graph
maintenance. The daemon applies a posted IngestPlan directly — it never creates
pending proposals. High-confidence, authorized maintenance is expressed as
graphOps that the daemon applies with evidence, source pointers, actor, and
version history. Use pending proposals only for massive graph refactors,
risky/destructive changes, or cases where the operator explicitly asks for
review before mutation.

Memory creation flows through ingest apply on the leased queue item, not by
calling the API `remember` endpoint; the daemon stamps provenance (source id,
agent id, content hash) on every row. Graph and memory writes flow through
ingest apply; never hand-edit DB rows. Do not edit SQLite directly. Do not
rewrite raw transcript/source artifacts — they are immutable provenance.

## The Agentic Workflow

The runner is a two-phase HTTP client against the daemon's ingest protocol.
The daemon hands you a leased batch item and its context; you produce the plan;
the daemon validates and applies it.

1. **Lease a context bundle.**

   ```bash
   signet ingest lease --agent "$AGENT_ID"
   ```

   The daemon returns `{ eligible, jobId, leaseToken, leaseExpiresAt, context }`.
   If `eligible` is `false`, the queue is drained for this agent — there is
   nothing to drain, so exit cleanly. The `leaseToken` authorizes exactly one
   apply. Declare your real harness window with `--context-budget` when the
   daemon cannot detect it; otherwise let the daemon size the bundle.

2. **Reason over the context and produce an IngestPlan.** Read
   `context.source` (the batch item text), `context.dreamingMd` (this runbook's
   resolved identity content), and `context.graphSlice` (a bounded view of the
   existing entities and active claims around the source's focal entities — the
   dedup context so you update rather than duplicate). Emit a single IngestPlan
   body with three output classes: `memories`, `graphOps`, `filePatches`.

3. **Post the plan back for apply.**

   ```bash
   signet ingest apply-plan --agent "$AGENT_ID" \
     --lease-token "$LEASE_TOKEN" --file plan.json
   ```

   The daemon re-verifies the lease token, validates the plan against the
   IngestPlan schema, applies each op (every op is independently idempotent),
   and completes the lease by CAS. The result is
   `{ completed, memories, graph, filePatches, planHash }`. If `completed` is
   `false`, the token was stale or a write failed — re-lease and retry.

Inspect the queue when you need to:

```bash
signet ingest status --agent "$AGENT_ID"
```

## The IngestPlan

The plan body is `{ memories, graphOps, filePatches }` (plus an optional
`notes`). The envelope fields the daemon owns — `schemaVersion`, `jobId`,
`agentId`, `sourceHash`, `createdAt`, and the derived `planHash` — are stamped
from the lease by the runner and verified against it. Author the body only; do
not author envelope or idempotency fields. For large sources, split work into
coherent queue items; prefer fewer high-confidence ops with direct evidence
quotes over broad speculative coverage.

### memories — source-backed recall rows

Emit a memory only when the evidence supports durable recall that is not already
represented in the graph. Each memory op carries provenance via `sourceSpan`
(which batch item and span it came from); the daemon fills id, content hash,
normalized content, timestamps, agent id, source attribution, and idempotency
key, and runs the dedup, durability, and write gates outside the model.

```json
{
  "content": "Signet's ontology rejects pronouns and section headings as entities.",
  "why": "Cited extraction rule confirmed across two transcript spans.",
  "importance": 0.8,
  "type": "fact",
  "sourceSpan": { "itemId": "<leased item id>", "start": 120, "end": 240 }
}
```

### graphOps — the full ontology op vocabulary

These are the same 19 operations the ontology control plane dispatches. Emit
them as graphOps; the daemon applies each one directly (no proposal queue) with
version chains and provenance. Payload is op-specific; carry `reason`,
`evidence`, `confidence`, and source pointers (`sourceKind`, `sourceId`,
`sourcePath`) on every op.

- `create_entity`, `rename_entity`, `archive_entity`, `merge_entities`
- `create_aspect`, `rename_aspect`, `archive_aspect`
- `add_claim_value`, `set_claim_value`, `supersede_claim_value`,
  `archive_claim_value`, `restore_claim_version`
- `create_link`, `update_link`, `archive_link`
- `create_policy`, `create_action_type`, `create_interface`, `attach_interface`

graphOp line shape:

```json
{
  "operation": "set_claim_value",
  "payload": {
    "entity": "Signet",
    "aspect": "architecture",
    "group_key": "ontology",
    "claim_key": "mutation_policy",
    "value": "Dreaming and normal graph maintenance apply first through audited operations with provenance."
  },
  "reason": "Consolidated from cited transcript evidence.",
  "confidence": 0.9,
  "evidence": [{ "source_kind": "transcript", "source_id": "session-key", "quote": "..." }],
  "sourceKind": "memory",
  "sourceId": "<leased item id>"
}
```

Use the `merge_entities` op for clear duplicate cleanup; it is an audited direct
apply, not a proposal. Preserve `group_key` and `claim_key` as stable slots on
claim ops so version history stays inspectable. Use `archive_*` or
`restore_claim_version` only when evidence is strong and the operator asked for
maintenance, not just ingestion.

### filePatches — authored edits to identity/behavior files

When the pass learns a behavioral lesson or a stable operating rule, propose it
as a file patch against `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
`MEMORY.md`, `HEARTBEAT.md`, `DREAMING.md`, or a skill/literature path. The
daemon takes a per-file lock, captures before-state for one-call revert, writes
the block under a patch marker, and records the patch id so a re-apply is a
no-op. `id` is required on every file patch — it is the dedup handle when two
plans append to the same file.

```json
{
  "id": "agents-no-pronoun-entities-2026-07",
  "file": "AGENTS.md",
  "section": "Extraction",
  "append": "- Reject pronouns and section headings as entities during extraction.",
  "reason": "Reinforces the ontology extraction rule observed this pass.",
  "confidence": 0.85
}
```

## Routing Rules

- Source-backed graph facts → `graphOps` (`create_entity`, `set_claim_value`,
  `create_link`, and friends), applied directly by the daemon.
- Clear duplicate entity cleanup → a `merge_entities` graphOp, never a proposal.
- Durable recall lessons not represented in the graph → source-backed `memories`
  via ingest apply, never the API `remember` endpoint.
- Behavioral lessons or operating rules → `filePatches` against AGENTS.md,
  SOUL.md, or identity/behavior files.
- Repeated procedures → `filePatches` against the relevant skill file.
- Massive graph refactors or risky/destructive campaigns → stop and request an
  explicit operator review queue; do not express them as graphOps without
  authorization.

Do not collapse every observation into a memory. If the source teaches stable
structure about the world, a project, a person, a system, a document, or a
relationship, route it to a graphOp. If the source says a named actor believed,
claimed, decided, denied, or questioned something, route a source-attributed
memory that preserves the attribution rather than flattening it into a
current-truth graph claim; only promote it to a `set_claim_value` graphOp when
the evidence supports treating it as current truth. If it teaches a behavioral
preference, route a filePatch.

## Inputs

The lease delivers everything you need to reason; you do not gather inputs
yourself. Work from `context.source` plus `context.dreamingMd` plus
`context.graphSlice`, bounded by `context.budget`. When `context.oversize` is
true the source alone exceeds the input budget — split at a safe boundary or
fail the item explicitly, never truncate the middle. For depth beyond the slice,
queue follow-up items through the daemon; do not read the database directly.

## Hard Constraints

- Apply first: post the plan and let the daemon apply it. The daemon applies
  graphOps directly.
- Do not create pending proposals for normal dreaming or graph maintenance;
  that is what the agentic lease/apply-plan path replaces.
- Do not edit SQLite directly. Graph and memory writes flow through ingest apply;
  never hand-edit DB rows.
- Do not call `/api/memory/remember`, `/memory/remember`, or equivalent remember
  endpoints from this skill. Memory creation flows through ingest apply on the
  leased queue item.
- Preserve evidence for every graphOp, memory, and filePatch.
- Produce an evidence-backed IngestPlan, not a vibe summary.
- Treat source memories, source artifacts, transcripts, and raw records as
  immutable provenance. Do not rewrite raw artifacts when ontology attributes
  change.
- Do not invent entities or attributes just to fill a schema. Weak evidence
  belongs in `notes.skipped` or open questions.
- Do not flatten "X said/believes/denies Y" into "Y is true"; route a
  source-attributed memory unless current-truth evidence is explicit.
- Do not author envelope fields (`jobId`, `agentId`, `sourceHash`, `planHash`).
  The daemon stamps them from the lease and verifies them against it.

## Review Standard

Reject a candidate (skip the op, log it in `notes.skipped`) instead of emitting
it when:

- evidence is missing or only paraphrased
- the selector is ambiguous and no stable id is available
- the mutation would archive or replace a protected entity, aspect, group, or
  constraint without explicit operator force
- the candidate creates a generic scaffolding entity instead of a concrete
  semantic object
- it duplicates an entity, claim, or memory already present in the graph slice

The final plan's `notes.skipped` and `notes.uncertain` should make rejected
candidates and open questions as visible as the applied ops.
