---
title: "Semantic Prospective Hints"
id: semantic-prospective-hints
status: planning
informed_by:
  - "docs/research/technical/RESEARCH-OBSIDIAN-VAULT-RECALL-EVAL.md"
  - "docs/research/market/memory-benchmark-comparison.md"
section: "Runtime"
depends_on:
  - "memory-pipeline-v2"
  - "desire-paths-epic"
success_criteria:
  - "Prospective hints are embedded at write time and become queryable through the same embedding provider path used for document recall"
  - "Hybrid recall fuses content FTS, content vectors, hint FTS, and hint vectors without regressing no-hint behavior"
  - "Backfill and degraded-mode behavior are explicit: existing installs can populate missing hint embeddings incrementally and recall continues to function when hint vectors are unavailable"
  - "Evaluation shows semantic hint retrieval is a measurable improvement over hint FTS alone on Signet's retrieval-quality suite"
scope_boundary: "TypeScript runtime and schema work for semantic retrieval over prospective hints. Covers write-time hint embedding, storage, retrieval fusion, and backfill/degraded-mode behavior. Excludes Rust parity, curated-memory substrate redesign, and unrelated recall-surface formatting work."
draft_quality: "research-backed planning draft"
---

# Semantic Prospective Hints

## Problem

Signet already generates prospective hints at write time. Those hints are
stored as text and searched through FTS5 during recall. That is useful,
but it leaves one of the main benefits of prospective indexing only
half-finished.

Prospective hints exist to bridge cue-trigger mismatch:

- the stored memory may be phrased one way,
- the future user query may be phrased another way,
- the hint tries to predict the future phrasing.

Today, that bridge is lexical-only. If the future query is semantically
close to a hint but not lexically close enough, the system still misses
the connection.

The current implementation lives across:

- `packages/daemon/src/pipeline/prospective-index.ts`
- `packages/daemon/src/memory-search.ts`
- `packages/core/src/migrations/038-memory-hints.ts`

and the current contract is:

- generate hints,
- store hint text,
- index hints in `memory_hints_fts`,
- blend hint FTS into the lexical side of `hybridRecall()`.

The recent Obsidian-vault recall eval now gives us stronger evidence that
this is worth extending. On a 385-note real-world corpus:

- lexical-first retrieval underperformed Signet's current hybrid stack,
- a plain chunked hybrid RAG baseline still underperformed the current
  note-level hybrid baseline,
- hint FTS improved retrieval further,
- semantic retrieval over hints improved further again.

That is enough signal to justify planning real semantic hint support
instead of treating it as a speculative idea.

## Goals

1. Extend prospective indexing so hints are retrievable semantically as
   well as lexically.
2. Keep hint FTS, because lexical hint matches are still cheap and useful.
3. Preserve the current retrieval shape when hint vectors are absent or
   temporarily unavailable.
4. Make hint-vector support operationally survivable:
   - incremental backfill,
   - explicit degraded mode,
   - no hard cutover requirement.
5. Ground the work in evals instead of intuition alone.

## Non-goals

- No curated-memory substrate redesign in this spec.
- No prompt-submit formatting changes.
- No Rust parity work yet.
- No replacement of content-vector retrieval with hint-vector retrieval.
- No new benchmark framework; use the existing eval surfaces and targeted
  research harnesses.

## Why now

There are three reasons to do this now instead of later.

### 1. The current retrieval stack has already beaten the simpler baselines

The Obsidian-vault eval showed:

- lexical-first < note-level hybrid
- plain chunked hybrid RAG < note-level hybrid
- note-level hybrid + hint FTS < note-level hybrid + hint FTS + hint vectors

That means the argument is no longer "maybe semantic hints are elegant."
The argument is "semantic hints appear to improve retrieval on a real
corpus that looks more like lived memory than a toy benchmark."

### 2. This extends an existing successful mechanism instead of inventing a new one

DP-6.1 already shipped prospective indexing. The missing piece is not a
whole new memory concept. It is a deeper retrieval path for an existing
surface that is already producing value.

### 3. The next retrieval ceiling looks like substrate quality, not chunking

The chunked control lane failing to beat the current note-level hybrid
baseline is important. It suggests the next gains are more likely to come
from:

- better retrieval over predicted cues,
- better memory substrate quality,

not from falling back to a more generic chunked-RAG recipe.

## Current state

### Write time

Prospective hints are generated through `prospective-index.ts` and stored
in:

- `memory_hints`
- `memory_hints_fts`

There is no hint embedding storage today.

### Recall time

`hybridRecall()` currently uses:

- content FTS
- content vector search
- graph/traversal expansion and reranking
- hint FTS blended into the lexical branch

There is no hint vector retrieval path today.

### Operational posture

The current hint path is cheap, incremental, and fairly forgiving:

- if hint generation exists, recall can use it,
- if it does not, recall still works normally,
- there is no backfill burden beyond hint text.

Any semantic-hint design should preserve that survivability.

## Proposed design

## 1) Store embeddings for prospective hints

Each generated hint should be embedded at write time using the same
embedding-provider abstraction already used elsewhere in the memory
pipeline.

The storage shape should preserve one-to-many semantics:

- one memory
- multiple prospective hints
- one vector per hint

Two viable storage directions:

### Option A, extend `memory_hints`

Add embedding storage directly to `memory_hints` or a tightly related
table keyed by the existing hint row.

Pros:

- close to the current hint lifecycle
- easier provenance
- easier to backfill from existing hint rows

Cons:

- pushes vector concerns into the hint table directly
- may become awkward if providers or dimensions evolve

### Option B, add `memory_hint_embeddings`

Create a dedicated table keyed to hint rows.

Pros:

- cleaner separation between hint text and embedding material
- easier migration/versioning/provider metadata

Cons:

- slightly more moving pieces
- more joins

Planning preference: **Option B**. It is a little more ceremony, but it
keeps the schema cleaner if we later need provider/version metadata,
dimension changes, or partial backfills.

## 2) Embed hints incrementally, not all at once

New hints should be embedded at write time. Existing hints should be
backfilled incrementally through a worker/job path.

That means:

- no blocking migration that tries to embed every historical hint at once
- no requirement that all installs finish backfill before benefiting

If a memory has hint text but no hint vectors yet, recall should fall back
to the current behavior:

- content FTS
- content vectors
- hint FTS

## 3) Add hint-vector retrieval as an additive branch

Recall should use four retrieval signals:

1. content FTS
2. content vectors
3. hint FTS
4. hint vectors

The important point is **additive**, not replacement.

We should not trade one bridge for another. The system should be able to
win from:

- direct lexical overlap with the memory,
- semantic overlap with the memory,
- lexical overlap with a predicted future cue,
- semantic overlap with a predicted future cue.

## 4) Propagate hint-vector matches back to the parent memory

Hints are not the unit we ultimately want to return. Memories are.

So retrieval should:

- rank hint vectors at the hint level,
- collapse them back to the parent memory,
- keep the strongest hint-vector signal per memory,
- fuse that signal with the memory's other scores.

This mirrors what we already do conceptually for hint FTS.

## 5) Fuse conservatively

The main risk here is score inflation. If a memory has:

- decent content-vector similarity,
- decent hint-vector similarity,
- decent lexical overlap everywhere,

we do not want to hand it an unfair pile-up bonus.

So the likely shape should be:

- blend content FTS + hint FTS on the lexical branch
- blend content vectors + hint vectors on the semantic branch
- then hybrid-fuse lexical vs semantic

This is safer than just summing four independent scores.

In rough terms:

```text
lexical_branch = blend(content_fts, hint_fts)
semantic_branch = blend(content_vec, hint_vec)
final_score = hybrid_fuse(lexical_branch, semantic_branch)
```

That keeps the retrieval model understandable and prevents hint signals
from behaving like a second full duplicate memory score.

## 6) Make degraded mode explicit

This feature should not quietly become a hidden dependency.

We need explicit states for:

- hint text present, hint embeddings absent
- hint embeddings partially backfilled
- hint embedding provider unavailable

Recall should still work in all three states. The system should expose
that hint-vector retrieval is degraded, but it should not fail closed.

## Evaluation plan

The Obsidian-vault eval already provides a strong directional signal. This
spec should require a second, more canonical check before completion.

Minimum eval requirements:

1. compare current hint FTS against hint FTS + hint vectors on the same
   question set
2. report Hit@1, Hit@3, Hit@5, and MRR
3. include a corpus slice where cue mismatch is common:
   - fleeting/journal notes
   - generic planning notes
   - weakly titled notes
4. verify that no-hint and partial-backfill installs do not regress

Completion should require a measurable improvement, not just a plausible
implementation.

## Implementation sketch

### Phase 1, schema and worker plumbing

- add schema for hint embeddings
- add provider/version metadata as needed
- enqueue/perform hint embedding on new hint creation
- add incremental backfill path for existing hint rows

### Phase 2, retrieval integration

- load hint-vector candidates during recall
- collapse hint matches to parent memories
- fuse hint-vector scores into the semantic branch
- preserve current no-hint behavior

### Phase 3, degraded-mode observability

- surface partial-backfill / unavailable-provider state
- make doctor/status surfaces able to explain when hint vectors are absent

### Phase 4, eval and tuning

- rerun targeted retrieval evals
- adjust blending weights if needed
- lock the final score-fusion contract

## Risks and tradeoffs

### More storage and write-time cost

Hint vectors are cheap compared to many model operations, but they are not
free. This spec deliberately accepts that cost because the eval suggests
the gain is real.

### More fusion complexity

Retrieval gets harder to reason about when there are too many scoring
paths. That is why this spec insists on a branch-based fusion shape
instead of a naive sum of all signals.

### Backfill debt

Historical installs will not gain the full benefit immediately unless we
provide a backfill path. That is why backfill/degraded-mode behavior is
part of the spec, not an afterthought.

### Potential overlap with future curated-memory work

Curated substrate work may eventually improve recall more than any one
retrieval tweak. That is not a reason to skip semantic hints. It is a
reason to treat this as one improvement in a broader retrieval strategy,
not the final answer to memory quality.

## Open questions

1. Should hint embeddings reuse the exact same embedding model as memory
   content by default, or should hints allow a distinct provider/model?
2. What metadata needs to live with hint embeddings for safe backfill and
   provider migration?
3. Should hint-vector matches be exposed in provenance/debug output, or
   remain an internal score contributor only?
4. At what point should curated-memory artifacts become a first-class
   retrieval branch beside raw memory and hint retrieval?

## Success criteria

This spec is complete when:

1. prospective hints can be searched semantically as well as lexically,
2. recall preserves current behavior when hint vectors are missing,
3. historical installs can backfill hint embeddings incrementally,
4. evals show a meaningful retrieval improvement over hint FTS alone.
