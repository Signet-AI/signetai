---
title: "Dreaming: Surprisal-Guided Attention Evaluation"
description: "Evaluate a bounded, opt-in embedding-geometry signal that gives Dreaming content passes exploration hints without changing evidence watermarks or audited write paths."
order: 2
section: "Memory Architecture"
informed_by:
  - "docs/specs/approved/dreaming-memory-consolidation.md"
  - "docs/specs/approved/knowledge-architecture-navigation.md"
  - "docs/specs/approved/model-provider-router.md"
success_criteria:
  - "The selector is disabled by default and cannot create ontology state or bypass an audited Dreaming operation."
  - "A bounded, agent-scoped sample of existing episodic memory embeddings can produce deterministic, deduplicated attention hints without provider embedding requests."
  - "Structural attention and surprisal attention remain complementary: both signals can be measured in the same bounded pass and content work is not starved by hygiene work."
  - "Selector failure, insufficient data, invalid vectors, and embedding-store failure fail open to ordinary Dreaming behavior with observable bounded-sweep statistics."
  - "The evaluation reports useful-review yield, false-positive review of valid unusual evidence, structural/surprisal overlap, graph-quality delta, latency, and embedding request/token/cost impact."
scope_boundary: "This spec covers the evaluation lane and the optional attention hint contract. It does not approve automatic claims from embedding geometry, a new ontology writer, replacement of the evidence cursor, or production rollout without measured gates."
---

# Dreaming: Surprisal-Guided Attention Evaluation

## Decision

Dreaming keeps its existing structural attention selectors (`review_due`,
`hygiene`, `contested_claim`, and `evidence_requeue`) as the default. This
spec adds an **evaluation-only, opt-in** exploration signal named
`surprisal`. The signal is a bounded hint about an unusual embedding region;
it is not a claim, evidence record, confidence score, or authorization to
write the graph.

The design is motivated by Honcho's use of embedding-tree path surprisal for
sampling unusual observations, but it is not a drop-in implementation of that
algorithm. Signet's selector is deterministic so repeated scheduled checks do
not churn attention records: local nearest-neighbour density is the primary
signal and a bounded median projection tree supplies a secondary sparse-region
signal. The selector reuses vectors already persisted by the normal embedding
pipeline and never calls an embedding provider.

Reference reading: [Honcho's surprisal sampler](https://github.com/plastic-labs/honcho/blob/main/src/dreamer/surprisal.py).

## Problem and hypothesis

Structural flags identify known maintenance debt. They do not necessarily
identify a valid, semantically important observation that is unusual relative
to the agent's recent memory. The hypothesis is that a small number of
high-surprisal observations can improve the useful-review rate of a bounded
content pass without materially increasing latency, provider spend, or false
positive attention.

The hypothesis is not accepted merely because the selector ranks a synthetic
outlier. It must be tested against a fixed coherent memory set with a semantic
outlier and, separately, real agent-scoped samples. A semantically unusual
observation can be valid evidence and must be counted as a false positive if
it causes unnecessary review, not discarded as noise by definition.

## Attention contract

### Candidate source and scope

1. Read only primary memories owned by the requested `agent_id`.
2. Include only episodic, non-deleted, non-archived, unpinned memories with
   the default empty scope. Do not read another agent's evidence.
3. Join the latest agent-compatible stored memory embedding. If no usable
   finite, non-zero vector exists, skip that observation.
4. Order by captured time and id, then inspect at most `sampleSize` rows.
   The selector must never scan an unbounded embedding table.
5. The optional `since` argument is a read filter for callers that need one;
   the scheduled exploratory sweep intentionally does not use the Dreaming
   evidence cursor as a frontier. A hint sweep must never mark evidence
   processed or advance `dreaming_state.evidence_cursor`.

### Scoring and bounds

For each valid vector, calculate:

- the mean cosine distance to up to `neighborCount` nearest other vectors;
- a deterministic projection-tree path surprisal, with a maximum leaf size of
  `treeLeafSize`; and
- a normalized bounded score, weighted 75% local density and 25% tree path.

The implementation clamps scores to `[0, 1]`, emits at most `maxCandidates`
hints, requires `minObservations` valid vectors, and records a stable selector
version in each hint. Ties are deterministic. Defaults are conservative and
the whole nested configuration is disabled unless `memory.dreaming.surprisal.enabled`
is explicitly true:

```yaml
memory:
  dreaming:
    surprisal:
      enabled: false
      sampleSize: 128
      maxCandidates: 5
      minObservations: 20
      neighborCount: 5
      treeLeafSize: 10
      minScore: 0.75
```

Configuration parsing clamps the sample and candidate bounds before the
selector runs. The selector reports sampled rows, valid vectors, candidate
count, elapsed time, and embedding requests/tokens/cost. The latter three
values are expected to remain zero for this stored-vector implementation.

### Queue lifecycle

The daemon stores a candidate as an agent-scoped `dreaming_attention` row with
`kind=surprisal`, `subject_ref=memory:<id>`, score/rank/sample metadata, and a
bounded priority. The existing unique attention key prevents duplicate rows.
The worker evaluates the opt-in selector during its scheduled check, then the
existing workload resolver decides whether a pass should run. Structural
attention remains independently schedulable; when both structural and content
work are pending, focused checks alternate so hygiene cannot permanently starve
content.

The content runbook must:

1. list `kind=surprisal` hints and inspect each referenced memory through the
   normal, agent-scoped evidence tool;
2. treat the score only as review priority;
3. use a normal audited content operation with an exact quote only when the
   evidence establishes a useful settled fact; or use `decline_attention` after
   inspection when it is valid but not useful/noisy; and
4. never cite `attention:<id>` as content provenance, create an entity or claim
   from geometry alone, or bypass the existing evidence cursor/resolver.

Hygiene passes leave `surprisal` rows pending for a content pass. No new
writer, direct semantic SQL, provider bypass, or evidence mutation is part of
this feature.

## Failure and safety behavior

- Disabled configuration is a no-op.
- Too few observations or no valid vectors produces no hints and does not
  fail a Dreaming check.
- A missing/incompatible embedding store produces no hints and leaves the
  ordinary structural/content path available.
- A malformed vector cannot poison ranking; invalid dimensions are excluded.
- All queries are agent-scoped and sample-limited.
- A resolved hint is not reopened just because a scheduled sweep sees the
  same stable sample again. A changed selector record can be reconsidered by
  the existing attention upsert rules, but it never changes evidence state.
- Every eventual graph mutation continues through the existing audited
  capability registry and provenance validation.

## Evaluation protocol

The evaluation must compare **rule-only** and **rule + surprisal** conditions
using the same seeded observations, agent scope, pass budget, model/provider,
and bounded wall-clock window. The rule-only condition runs the existing
structural selectors with surprisal disabled. The assisted condition enables
surprisal with fixed bounds. Neither condition may receive an extra evidence
cursor advance or a larger model budget.

### Synthetic calibration

Seed a coherent cluster, one semantically valid outlier, ordinary structural
debt, and unrelated noise. Repeat with the outlier in different capture-order
positions and with a second coherent cluster. Record:

- whether the valid outlier is selected;
- candidate rank, score, and deterministic repeatability;
- structural/surprisal overlap and candidate-set Jaccard;
- useful-review yield and false-positive attention rate;
- selector latency, rows scanned, valid-vector ratio, and tree/distance work;
- additional embedding requests, tokens, and cost (expected zero); and
- before/after graph quality: duplicate rate, supported-claim precision,
  unsupported or stale claim rate, and the number of unresolved attention rows.

### Real-sample shadow evaluation

Run the same two conditions over a bounded, agent-scoped sample of completed
episodic memories in a non-production or shadow database. A reviewer labels
each surfaced observation as useful review, valid-but-not-useful, noise, or
not-reviewable. Graph-quality measurements must be computed from the same
snapshot and the same pass budget; do not credit changes caused by unrelated
new evidence. Publish the sample size, provider/model, latency distribution,
embedding-store dimensions, and all exclusions so a zero-candidate run is not
mistaken for a successful precision result.

### Rollout gate

This PR establishes the bounded selector, queue contract, prompt guardrails,
and reproducible tests/evaluation protocol. It does not claim that the
hypothesis passed. Enable the feature only after the observed assisted
condition improves useful-review yield or graph-quality delta without an
unacceptable increase in false-positive attention or pass latency. If the
result is neutral or regresses, keep the feature disabled and retain the
measurements for a later selector change.

## Compatibility and observability

Migration 123 extends the existing `dreaming_attention.kind` check while
preserving existing rows and indexes. Existing installations and fresh
databases therefore share one queue contract. Configuration remains backward
compatible because the optional nested setting defaults off. Structured log
fields (`sampled`, `valid`, `candidates`, `durationMs`,
`embeddingRequests`, `embeddingTokens`, `embeddingCostUsd`, and
`skippedReason`) make the evaluation auditable without storing vectors or
duplicating evidence.
