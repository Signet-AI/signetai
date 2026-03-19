---
title: "Retroactive Memory Supersession"
id: retroactive-supersession
status: planning
informed_by:
  - "docs/research/technical/MSAM-COMPARISON.md"
section: "Knowledge Architecture"
depends_on:
  - "knowledge-architecture-schema"
success_criteria:
  - "When a new fact contradicts an existing attribute on the same entity/aspect, the old attribute is marked superseded within one structural_classify poll cycle"
  - "Constraints (kind='constraint') are never auto-superseded"
  - "All supersession events produce memory_history audit records"
  - "Shadow mode records proposals without mutating attribute status"
  - "Sweep catches pre-existing contradictions across sessions"
scope_boundary: "Detects and marks contradictory attributes as superseded — does not define the entity/aspect schema or the structural classification pipeline"
---

# Retroactive Memory Supersession

Spec metadata:
- ID: `retroactive-supersession`
- Status: `planning`
- Hard depends on: `knowledge-architecture-schema`
- Registry: `docs/specs/INDEX.md`

Related docs:
- `docs/KNOWLEDGE-GRAPH.md` (entity/aspect/attribute model)
- `docs/PIPELINE.md` (structural classification, contradiction detection)
- `docs/specs/complete/knowledge-architecture-schema.md` (schema contract)
- `docs/research/technical/MSAM-COMPARISON.md` (MSAM temporal world model)

---

## 1) Problem

When a new memory contradicts an older one about the same entity and aspect
(e.g., "broke up with Amari" should invalidate "apartment hunting with
Amari"), old attributes remain `status='active'`. The supersession primitives
already exist — `supersedeAttribute`, `propagateMemoryStatus`,
`entity_attributes.status`/`superseded_by` — but they only fire on explicit
UPDATE/DELETE proposals or orphaned memory cleanup. They never fire
retroactively when a newly classified attribute contradicts an existing
sibling on the same aspect.

The result is stale facts that persist indefinitely, surfacing during graph
traversal and polluting context injection with outdated information.


## 2) Solution — Two Paths

### Inline pass

After `structural_classify` populates `aspect_id` on newly classified
attributes, check those attributes against existing active siblings on the
same aspect. Runs in `processClassifyBatch()` as a post-transaction hook in
`structural-classify.ts`.

This is the primary path. It catches contradictions at the moment they enter
the graph, within the same poll cycle as classification.

### Periodic sweep

A maintenance worker scans all aspects that have multiple active attributes,
looking for contradictions that predate the inline pass (historical data,
attributes classified before this feature existed). Runs alongside
`propagateMemoryStatus()` in `maintenance-worker.ts`.

This is the catch-up path. It handles pre-existing contradictions and any
that the inline pass missed due to timing or partial failures.


## 3) Detection — Two Tiers

### Fast path (heuristic, no LLM)

Four heuristic signals, evaluated in order:

1. **Negation polarity** — XOR on negation tokens (`not`, `no`, `never`,
   `don't`, `doesn't`, `won't`, `can't`, `isn't`, `aren't`, `wasn't`,
   `weren't`, `haven't`, `hasn't`, `hadn't`, `couldn't`, `shouldn't`,
   `wouldn't`, `nor`, `neither`) combined with shared content words.
   If one attribute has a negation token and the other does not, and they
   share at least two non-stopword content tokens, it is a contradiction.

2. **Antonym pairs** — approximately 30 bidirectional pairs extracted into
   a shared `antonyms.ts` module (e.g., `enabled`/`disabled`,
   `allow`/`deny`, `active`/`inactive`, `open`/`closed`,
   `start`/`stop`, `include`/`exclude`). If the two attributes contain
   tokens from opposite sides of any pair, it is a contradiction.

3. **Value conflict** — same verb pattern, different value. Regex extracts
   `(verb, value)` tuples from both attributes (e.g., "lives in NYC" vs
   "lives in LA"). If the verb matches but the value differs, it is a
   contradiction.

4. **Temporal supersession** — if the creation timestamps are more than
   24 hours apart and the newer attribute contains temporal markers
   (`now`, `currently`, `recently`, `started`, `switched`, `moved`,
   `changed`), the older is superseded.

All four signals produce a confidence score. The maximum across fired
signals is the supersession confidence.

### Slow path (LLM, optional)

Reuses the existing `detectSemanticContradiction()` from
`contradiction.ts`. Fires when the heuristic returns false but
`normalized_content` overlap between the two attributes is >= 3 tokens.
This catches semantic contradictions like "uses PostgreSQL" vs "migrated
to MongoDB" that no keyword heuristic would catch.

Gated by two config flags:
- `semanticContradictionEnabled` (existing top-level flag)
- `supersessionSemanticFallback` (new, specific to this feature)

Both must be true for the LLM path to fire.


## 4) Design Constraints

- **Constraints are sacred.** Attributes with `kind='constraint'` are NEVER
  auto-superseded. Constraints represent non-negotiable rules that the user
  has explicitly defined. Only manual deletion can remove them.

- **No LLM inside write transactions.** The existing pipeline invariant
  applies here too. All LLM calls (semantic fallback) happen outside the
  transaction. The write transaction only applies the supersession result.

- **Shadow mode respected.** When `shadowMode` is true or
  `mutationsFrozen` is true, supersession proposals are recorded in
  `memory_history` with action `supersession_proposal` but no attribute
  status mutation occurs.

- **Agent-scoped.** All queries filter by `agent_id`. One agent's
  supersession logic never touches another agent's attributes.

- **Idempotent.** Calling `supersedeAttribute()` on an already-superseded
  row is a no-op. The sweep and inline pass can safely overlap without
  double-writes.

- **Lossless.** Superseded attributes keep their rows with
  `status='superseded'` and `superseded_by` pointing to the replacing
  attribute. Source memories are archived to the cold tier by the retention
  worker, not deleted.

- **No new migration needed.** The existing schema already has
  `entity_attributes.status`, `entity_attributes.superseded_by`, and
  `memory_history`. No DDL changes required.


## 5) Config Additions

New fields under `PipelineStructuralConfig` (nested under
`memory.pipelineV2.structural` in `agent.yaml`):

| Field | Type | Default | Description |
|---|---|---|---|
| `supersessionEnabled` | boolean | `true` | Master switch for retroactive supersession |
| `supersessionSweepEnabled` | boolean | `true` | Enable the periodic sweep in maintenance worker |
| `supersessionSemanticFallback` | boolean | `true` | Allow LLM fallback when heuristic is inconclusive |
| `supersessionMinConfidence` | number | `0.7` | Minimum confidence to apply supersession (range 0.0-1.0) |


## 6) Files Created/Modified

| File | Change |
|---|---|
| `packages/daemon/src/pipeline/supersession.ts` | Core supersession logic: heuristic detection, inline hook, sweep scan |
| `packages/daemon/src/pipeline/supersession.test.ts` | 13 tests, all passing |
| `packages/daemon/src/pipeline/antonyms.ts` | Shared antonym pairs, extracted from worker.ts |
| `packages/daemon/src/pipeline/structural-classify.ts` | Inline pass hook in `processClassifyBatch()` post-transaction |
| `packages/daemon/src/pipeline/maintenance-worker.ts` | Sweep integration alongside `propagateMemoryStatus()` |
| `packages/core/src/types.ts` | Config type additions for `PipelineStructuralConfig` |
| `packages/daemon/src/memory-config.ts` | Config defaults and parsing for new fields |
| `packages/daemon/src/pipeline/worker.ts` | Imports antonym pairs from shared `antonyms.ts` instead of inline |


## 7) External Research Informing This Design

This design draws from several production memory systems and theoretical
frameworks analyzed in `docs/research/technical/MSAM-COMPARISON.md`:

- **MSAM's Temporal World Model** — uses `valid_from`/`valid_until`
  timestamps with auto-close-on-conflict semantics. When a new fact
  arrives that contradicts an existing temporal fact, the old fact's
  `valid_until` is set automatically. Signet's `superseded_by` pointer
  serves the same role without requiring explicit temporal intervals.

- **Graphiti/Zep's bitemporal edge model** — scopes contradiction search
  to entity pairs, making it tractable even at scale. Signet scopes to
  entity + aspect, which is even tighter.

- **AGM belief revision theory** — the minimal change principle: when
  incorporating new information that contradicts existing beliefs, make
  the smallest possible change to the belief set. Supersession (marking
  old as superseded, not deleting) embodies this.

- **A-MAC's composite scoring** — uses type priors to weight different
  contradiction signals. The four-signal heuristic here is a simplified
  version of the same idea.

- **MSAM's four-signal heuristic contradiction detection** — negation,
  temporal, value, and antonym signals. Directly inspired the fast path
  design.

- **Key finding across all systems:** every production system uses
  prospective-only contradiction checking (check at write time, not
  retroactively). Signet's entity + aspect scoping makes retroactive
  scanning tractable because each aspect typically has only 2-10 active
  siblings — the search space is tiny.


## 8) Phased Rollout

### Phase 1: Shadow observation

Enable supersession detection with `supersessionEnabled: true` but rely
on shadow mode to prevent mutations. Record `supersession_proposal`
events in `memory_history`. Monitor false positive rate by reviewing
proposals against ground truth.

Target: validate that the heuristic correctly identifies contradictions
without false positives on real user data.

### Phase 2: Inline pass live

Disable shadow mode for supersession. The inline pass in
`structural-classify.ts` applies actual supersession after classify.
The sweep remains disabled to limit blast radius.

Target: confirm that real-time supersession works correctly in
production without degrading classify latency.

### Phase 3: Full rollout

Enable the sweep (`supersessionSweepEnabled: true`). Tune
`supersessionMinConfidence` based on observed false positive rates
from phases 1 and 2. Enable semantic fallback if heuristic coverage
is insufficient.

Target: all pre-existing contradictions are caught within one
maintenance cycle.
