---
title: "Transcript Surface Separation"
id: transcript-surface-separation
status: planning
informed_by:
  - "docs/research/technical/RESEARCH-OBSIDIAN-VAULT-RECALL-EVAL.md"
  - "docs/research/technical/RESEARCH-LCM-ACP.md"
section: "Runtime"
depends_on:
  - "session-continuity-protocol"
  - "lossless-working-memory-runtime"
  - "lossless-working-memory-closure"
  - "explicit-recall-surface-alignment"
success_criteria:
  - "Raw session transcripts remain lossless, canonical, and drill-downable, but prompt-submit and explicit recall no longer surface raw harness metadata as first-class memory results"
  - "Transcript fallback queries a derived retrieval layer that strips or classifies harness-side noise without destroying the underlying source-of-truth transcript"
  - "Recall weighting and rendering treat raw transcript material as a lower-priority fallback surface than structured memories, summaries, and curated artifacts"
  - "Balanced evals show soft-human queries keep curated-quality behavior in mixed corpora and reflective queries reduce dirty-transcript contamination without regressing factual recall"
scope_boundary: "Planning for transcript-layer separation, transcript-derived retrieval surfaces, and recall weighting changes around raw versus derived transcript material. Excludes deleting raw transcripts, replacing the temporal DAG, or redesigning the entire memory substrate in one step."
draft_quality: "research-backed planning draft"
---

# Transcript Surface Separation

## Problem

Signet's current runtime contract is correct in one important respect:
raw transcripts are preserved as source-of-truth history. That is the
right archival posture. The problem is that this canonical layer is still
bleeding upward into retrieval surfaces where it should not be treated as
first-class prompt material.

The recent balanced recall eval and live dogfood checks both exposed the
same architectural issue from different angles:

- curated notes produce the strongest and most human-shaped recall
  results,
- dirty transcript-heavy memory degrades every retrieval lane,
- mixed corpora stay mostly healthy on soft-human queries but reflective
  prompts are still vulnerable to transcript contamination,
- live transcript fallback can surface raw harness artifacts such as IDE
  file-open wrappers and interruption boilerplate.

This is not an argument against keeping raw transcripts. It is an argument
for separating concerns more clearly:

1. raw transcript as immutable truth,
2. derived transcript retrieval surfaces for search and fallback,
3. curated and structured memory products as the preferred prompt-time
   surfaces.

Right now those boundaries are too porous.

## Goals

1. Preserve raw transcripts as canonical, lossless history.
2. Stop raw harness metadata from surfacing directly in prompt-submit and
   explicit recall unless the user drills into deep history on purpose.
3. Introduce a transcript-derived retrieval layer that is optimized for
   search and fallback, not archival fidelity.
4. Make transcript material compete appropriately against structured
   memory, summaries, and curated artifacts.
5. Improve mixed-corpus behavior without overfitting retrieval to junk.

## Non-goals

- No deletion or destructive sanitization of raw transcript artifacts.
- No replacement of temporal DAG artifacts, session summaries, or
  `MEMORY.md` as the runtime head.
- No all-at-once curated-memory redesign in this spec.
- No Rust parity work in this phase.
- No attempt to solve all reflective recall weaknesses purely through
  transcript shaping.

## Why this needs a spec

This is not a local formatting tweak. It touches:

- transcript persistence and normalization semantics,
- recall ordering and weighting across memory classes,
- fallback behavior for prompt-submit and explicit recall,
- the contract between archival truth and retrieval-friendly derived
  representations.

Without a spec, it is too easy to accidentally "fix" junky transcript
recall by damaging the source-of-truth layer or by adding ad hoc display
filters that drift across surfaces.

## Current state

## 1) The raw layer is doing its job

The approved working-memory specs already require:

- lossless transcript persistence,
- transcript queryability before full structural distillation catches up,
- transcript fallback as a secondary retrieval surface,
- temporal drill-down into deeper lineage.

That part is conceptually sound. Raw transcript must stay intact.

## 2) The fallback layer is too close to the archive layer

Today, transcript fallback can still surface content that is appropriate
for deep audit but poor for hot-path recall, including:

- harness wrappers,
- IDE file-open metadata,
- interruption boilerplate,
- procedural transcript debris.

The problem is not that this content exists. The problem is that the same
layer is still acting as both archive and retrieval substrate.

## 3) Mixed-corpus evaluation now makes the tradeoff visible

The balanced recall eval adds a useful architectural signal:

- curated corpus is the right primary tuning surface,
- dirty transcript-heavy memory is a robustness lane, not the north star,
- the strongest retrieval stack still wins in curated, dirty, and mixed
  corpora,
- reflective queries are the first place where dirty transcript material
  leaks back into mixed retrieval.

That means transcript separation should be designed to preserve curated
behavior first and use dirty robustness as a regression guard.

## Design principles

## 1) Archive and retrieval are different products

The raw transcript is the tape.
The retrieval layer is the editorial cut.
The prompt-submit injection is the trailer.

All three can come from the same session, but they are not the same
artifact and should not be optimized for the same job.

## 2) Raw transcript must remain reversible truth

Any retrieval-oriented shaping must preserve a path back to the raw,
canonical transcript. Operators and agents must be able to drill down
from derived recall surfaces into the underlying archival lineage.

## 3) Default recall should prefer cleaner surfaces

Default retrieval order should remain aligned with the working-memory
closure contract:

1. structured distillation and curated memory surfaces,
2. thread heads and temporal summaries,
3. transcript-derived fallback,
4. raw transcript drill-down only when explicitly requested.

## 4) Dirty-memory robustness should not become the main tuning target

The balanced eval strongly suggests that we should optimize for curated
quality first and use dirty transcript-heavy corpora only to prevent
catastrophic regression.

## Proposed architecture

## 1) Keep the raw transcript layer unchanged

The canonical transcript artifact and `session_transcripts` storage remain
lossless and immutable in meaning.

They continue to support:

- temporal lineage,
- drill-down,
- debugging and operator audit,
- deep-history retrieval when explicitly requested.

This spec does not weaken that contract.

## 2) Add a derived transcript retrieval layer

Introduce a retrieval-oriented representation of transcript history that
is generated from the raw transcript but optimized for search and
fallback.

This layer should:

- preserve speaker/content semantics,
- classify or strip harness-side metadata that is not useful for human
  recall,
- support excerpt generation that favors conversational meaning over raw
  wrapper text,
- remain traceable back to the raw transcript artifact.

Possible realization options:

### Option A: derived text alongside raw transcript rows

Persist one or more extra retrieval fields beside the canonical raw
transcript record, such as:

- cleaned conversation text,
- metadata-stripped text,
- turn-classified excerpt text.

Pros:
- easiest to query and weight,
- simplest migration path,
- no separate store to coordinate.

Cons:
- blurs archive and retrieval concerns in one table.

### Option B: dedicated transcript-derived table or materialized surface

Create a separate retrieval-oriented transcript surface keyed to the raw
session transcript.

Pros:
- cleaner separation of concerns,
- easier to evolve retrieval shaping independently,
- clearer archival-versus-derived semantics.

Cons:
- more schema and synchronization work.

Planning preference: **Option B**. This keeps the archive layer and the
fallback/retrieval layer conceptually distinct.

## 3) Make transcript fallback query the derived layer first

Prompt-submit and explicit transcript fallback should query the derived
transcript retrieval surface, not the raw archival text directly.

The raw transcript remains available for:

- explicit deep-history tools,
- temporal expansion,
- operator inspection,
- debugging when the shaped layer is insufficient.

## 4) Add memory-class-aware weighting

Transcript-derived results should be lower-priority than:

- structured memories,
- curated notes,
- thread heads,
- session summaries,
- other distilled artifacts.

This spec does not require one universal weighting formula yet, but it
does require retrieval to distinguish between:

- curated/distilled memory,
- fallback transcript material,
- raw archival transcript.

A transcript-derived hit should be able to win when it is truly the only
relevant source, but it should not casually outrank a better structured
memory on the same query.

## 5) Preserve deep drill-down to raw truth

Every transcript-derived hit should be traceable back to:

- session key,
- transcript artifact or lineage node,
- raw source span where practical.

That keeps the lossless working-memory contract intact.

## Query-shape implications

## Soft human queries

The balanced eval suggests soft-human queries are already mostly healthy
on curated and mixed corpora. Transcript separation here is mainly about
preventing obvious harness junk from leaking into fallback surfaces.

## Reflective queries

Reflective prompts remain weaker even on curated corpora and are the
first place where dirty transcript contamination reappears in mixed
corpora.

This spec does not claim transcript separation alone will solve
reflective recall, but it should reduce one obvious failure mode:
reflective prompts being dragged sideways by dirty transcript fragments
that are neither curated nor meaningfully thematic.

## Open questions

1. Should transcript-derived shaping happen at write time, query time, or
   both?
2. Which classes of harness metadata should be preserved as searchable
   signal versus demoted to audit-only content?
3. Should prompt-submit and explicit recall share the same transcript-
   derived retrieval surface, or should prompt-submit get a stricter
   subset?
4. How should transcript-derived hits interact with future curated-memory
   weighting work for reflective recall?
5. Which retrieval metrics should serve as merge gates: mixed-corpus
   factual metrics, exploratory bucket inspection, or both?

## Validation plan

## 1) Balanced retrieval eval remains the main quality check

Use the balanced corpus harness introduced in
`RESEARCH-OBSIDIAN-VAULT-RECALL-EVAL.md`:

- curated corpus as the primary target,
- dirty transcript-heavy corpus as robustness lane,
- mixed corpus as the real product approximation.

## 2) Exploratory bucket inspection is required

Track at least:

- `soft_human`
- `reflective`

Expected direction:

- no obvious regression on curated soft-human queries,
- fewer dirty transcript intrusions in mixed reflective top-k,
- no increase in obviously raw harness metadata surfacing in fallback
  responses.

## 3) Architectural invariants must remain true

- raw transcript persists losslessly,
- derived transcript retrieval remains traceable back to raw lineage,
- temporal drill-down still reaches the original source,
- prompt-submit still keeps structured memory primary.

## Recommended implementation order

### Phase 1: transcript-layer boundary

- define raw versus derived transcript contracts,
- add retrieval-oriented transcript representation,
- switch transcript fallback to the derived layer.

### Phase 2: weighting integration

- introduce transcript-derived weighting relative to structured memories,
- verify prompt-submit and explicit recall both honor the separation.

### Phase 3: reflective recall follow-up

- evaluate whether reflective prompts still need curated/thematic
  artifacts beyond transcript separation,
- feed that work into a later curated-memory weighting spec if needed.

## Recommendation

Signet should keep raw transcripts exactly because they are the source of
truth. The fix is not to throw them away. The fix is to stop asking the
raw archival layer to do the job of a retrieval-friendly memory surface.

The next architecture step should therefore be explicit transcript
surface separation:

- raw transcript stays canonical,
- derived transcript retrieval becomes the fallback search surface,
- structured and curated memories remain primary,
- deep drill-down still reaches the raw truth when needed.

That is the cleanest way to preserve lossless history without letting raw
harness junk dominate recall. 
