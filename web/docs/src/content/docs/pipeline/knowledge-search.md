---
title: "Knowledge and search"
description: "How graph augmentation, reranking, contradiction checks, and dampening shape recall."
---

## Knowledge Graph

When `graph.enabled` is true, graph reads, traversal, and recall boosting are
available. Dreaming is the only automatic graph author: it reasons over
episodic evidence and submits audited operations through the daemon-owned apply
path. Graph configuration controls reads and traversal, not a second semantic
writer.

Entities are stored in the `entities` table with `name` (original casing),
`canonical_name` (lowercase, whitespace-normalized), `entity_type`, and
`mentions` (an integer count). New entities are inserted; existing entities
(matched by `canonical_name`) have their `mentions` counter incremented.
UNIQUE constraint collisions on the `name` column are handled gracefully by
falling back to the existing row and incrementing mentions there.

Relations are stored in the `relations` table linking two entity rows by
`source_entity_id`, `target_entity_id`, and `relation_type`. The `strength`
field is fixed at 1.0 for all pipeline-extracted relations. When a relation
already exists (same source, target, and type), `mentions` is incremented
and `confidence` is updated via a running average:
`(old_avg × n + new_confidence) / (n + 1)`.

Every source and target entity is linked back to the originating memory row
via `memory_entity_mentions`. The link stores `mention_text` (the raw
string before canonicalization) and `confidence`. Inserts use
`INSERT OR IGNORE` so re-processing the same memory is idempotent.

## Aspect Feedback

After recall, `aspect-feedback.ts` feeds behavioral signals back to the
knowledge graph by measuring FTS overlap between retrieved content and
entity aspects. The function `applyFtsOverlapFeedback` is called at
session end with the session key and agent ID.

The feedback loop operates as follows. Memories that received at least one
FTS hit during the session (tracked in `session_memories.fts_hit_count`) are
looked up. For each confirmed memory, the `entity_attributes` table is
queried to find its parent `aspect_id`. Confirmation counts are summed per
aspect, and each aspect's `weight` column is incremented by
`delta × confirmations`, clamped to `[minWeight, maxWeight]`. This updates
which aspects were structurally "correct" for the session — aspects whose
memories were actively searched for gain weight, aspects whose memories were
ignored do not.

A separate `decayAspectWeights` function handles time-based decay. Aspects
that have not been updated in more than `staleDays` days have their weight
reduced by `decayRate`, floored at `minWeight`. Session decay is governed
by a counter so it runs every N sessions rather than on every call.

Telemetry is accumulated in an in-process snapshot (`getFeedbackTelemetry`)
and exposed on the pipeline status endpoint: `feedbackAspectsUpdated`,
`feedbackFtsConfirmations`, `feedbackDecayedAspects`, and
`feedbackPropagatedAttributes`.

## Graph-Augmented Search

At query time, when `graph.enabled` is true and the caller requests a graph
boost, `getGraphBoostIds` is called synchronously against the read database.
The function returns a set of memory IDs that should receive a score boost
in the final recall ranking.

The lookup proceeds in three steps. First, query tokens (2+ character
alphanumeric runs, lowercased) are matched against `canonical_name LIKE ?`
for each token, with results ordered by `mentions` descending and capped at
20 entity hits. Second, the matched entity IDs are expanded one hop through
the `relations` table in both directions (source and target), collecting up
to 50 additional neighbor entity IDs. Third, the expanded entity ID set is
joined through `memory_entity_mentions` to collect up to 200 distinct
non-deleted memory IDs.

The entire function is deadline-bounded. A `Date.now()` cutoff is checked
after each step; if the deadline is exceeded, the function returns whatever
it has accumulated so far with `timedOut: true`. On any exception, it
returns an empty result. There is no degradation in recall correctness —
graph boosting is always additive.

The boost weight (default 0.15) is applied by the search layer on top of
the hybrid BM25 + vector score. IDs in the graph-linked set receive a score
increment of `graphBoostWeight`.

## Optional Reranking

After baseline hybrid search returns a scored candidate list, a reranking pass
can reorder the top-N entries. Reranking is enabled by default, but the default
provider is the pass-through `noopReranker` unless a concrete reranker path is
selected.

The `rerank` function accepts a query string, a mutable candidate list, a
`RerankProvider` callback, and a `RerankConfig`. It slices the list at
`topN` (default 20), passes the head to the provider, and appends the
untouched tail to the result. If the provider call exceeds `timeoutMs`
(default 2,000 ms) or throws, the original ordering is returned unchanged
via a `Promise.race` against a timeout promise. There is no secondary
attempt.

The `noopReranker` pass-through is provided for testing. Custom providers
implement the `RerankProvider` signature
`(query, candidates, cfg) => Promise<RerankCandidate[]>` and can call any
scoring backend.

Set `reranker.useExtractionModel: true` to run reranking through the
active extraction provider/model instead of the embedding reranker.
When enabled, recall also prepends a short synthesized summary card
grounded in the top recalled memories.

### Embedding-Based Reranker

An embedding-based reranker implementation is provided in
`reranker-embedding.ts`. It re-scores candidates using full-content cosine
similarity against the query embedding vector. Cached embeddings from the
database are used when available, avoiding extra provider calls in most
cases.

The factory function `createEmbeddingReranker` takes a `DbAccessor` and
a pre-computed `queryVector` (Float32Array) and returns a `RerankProvider`.
For each candidate with a cached embedding, the score is blended:
`0.7 × original_score + 0.3 × cosine_similarity`. Candidates without a
cached embedding keep their original score. Results are sorted by blended
score descending. This reranker is fast (no LLM call), deterministic, and
catches cases where BM25 candidates were not vector-compared at all.

## Semantic Contradiction Detection

The pipeline includes two layers of contradiction detection for UPDATE and
DELETE proposals.

**Syntactic detection** (in `worker.ts`) is the fast path. It tokenizes
both the fact content and the target memory's content, checks for lexical
overlap of at least two tokens, then looks for either a negation-polarity
difference (one has a negation token, the other doesn't) or an antonym
pair conflict (enabled/disabled, allow/deny, etc.).

**Semantic detection** (in `contradiction.ts`) is the slow path. It uses
an LLM to catch semantic contradictions like "uses PostgreSQL" vs
"migrated to MongoDB". It is only called for update proposals with lexical
overlap >= 3 tokens where syntactic detection returned false. The LLM is
prompted to return a JSON object with `contradicts` (boolean), `confidence`
(0–1), and `reasoning` (string).

Semantic contradiction detection is gated by `semanticContradictionEnabled`
(default `true`). When enabled, the LLM call uses a configurable timeout
controlled by `semanticContradictionTimeoutMs` (default 120 seconds, range
5s-300s). On timeout or parse failure, the result defaults to "no
contradiction" — the check is advisory and never blocks a proposal.

Under the Dreaming cutover (#946) the periodic retroactive supersession
sweep and its `supersession.ts` module were retired; the contradiction
primitives above are no longer consumed by a retroactive supersession path.
Supersession now happens only at write time: the structured remember path
supersedes conflicting sibling attributes in the same
`aspect_id + group_key + claim_key` slot, and an explicit, audited
`supersede_claim_value` ontology operation handles supersession through the
mutation API. See [KNOWLEDGE-GRAPH.md](/knowledge-graph/#supersession) for
details.

```yaml
memory:
  pipelineV2:
    semanticContradictionEnabled: true
    semanticContradictionTimeoutMs: 120000  # ms, range 5000-300000
```

## URL Fetcher

The document ingest pipeline fetches web content through `url-fetcher.ts`.
The fetcher provides timeout and size guards, and strips HTML to plain text
for downstream chunking and embedding.

`fetchUrlContent(url, opts?)` accepts a URL and optional `FetchOptions`
(`timeoutMs` default 30,000 ms, `maxBytes` default 10 MB). It performs
a pre-flight size check from the `Content-Length` header, then stream-reads
the response body with a running byte counter. If total bytes exceed
`maxBytes` during streaming, the fetch is aborted.

Supported content types: `text/html`, `text/*`, `application/json`,
`application/xml`. Binary and unsupported types are rejected with an
error. For HTML responses, `<script>` and `<style>` blocks are stripped
entirely, remaining tags are removed, common HTML entities are decoded,
and the page title is extracted from the first `<title>` tag. The result
includes `content`, `contentType`, optional `title`, and `byteLength`.

## Continuity Scoring

At session end, the daemon retains the completed transcript and the
session-memory injection metadata. The retired summary worker is not part of
this path. Continuity feedback remains available through the session-memory
rows and their existing feedback APIs; Dreaming consumes the completed
transcript through its sanitized read-time projection.

3. **Per-memory relevance** — each entry in `per_memory` uses an 8-char
   prefix of the memory ID. The prefix is resolved to the full UUID via
   a map built from the injected memories. The `relevance_score` column
   on `session_memories` is updated for each matched memory.

4. **Score persistence** — the overall score, confidence, memory counts,
   reasoning, and continuity reasoning are written to `session_scores`.
   The `memories_recalled` field uses the actual injected count (not zero).

The scoring handles edge cases gracefully: markdown fences and `<think>`
blocks are stripped from LLM output, missing optional fields default to
zero/empty, out-of-range scores are clamped to [0, 1], and sessions
without `session_memories` data still get a valid score row.

## Prospective Indexing (Hints)

After a memory is written, a `prospective_index` job is enqueued in
`memory_jobs`. The hints worker
(`platform/daemon/src/pipeline/prospective-index.ts`) processes these
jobs as a background polling loop, generating hypothetical future
queries — "hints" — that the memory might answer.

The approach is inspired by Kumiho (arXiv:2603.17244) prospective
indexing. Rather than relying solely on the memory's literal content
for retrieval, the pipeline asks the extraction LLM to imagine what
questions a user might ask that this memory would help answer. The LLM
returns up to `hints.max` (default 5) hint strings per memory.

Hints are stored in the `memory_hints` table, each linking back to the
source `memory_id`. A companion `memory_hints_fts` FTS5 index makes
hints searchable with BM25 scoring.

At search time, the hints FTS5 table is queried alongside the content
FTS5 table. When a hint matches, its BM25 score is merged with the
memory's content score using `Math.max` — a hint match elevates its
parent memory but does not stack additively with the content score.
This prevents a memory with both a content match and a hint match from
being double-boosted; instead, the stronger of the two signals wins.

Configuration lives under `hints` in the pipeline config:

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `false` | — | Master switch |
| `max` | `5` | 1–20 | Max hints generated per memory |
| `timeout` | `45000` | 5000–300000 ms | LLM generation timeout |
| `poll` | `5000` | 1000–60000 ms | Worker polling interval |

```yaml
memory:
  pipelineV2:
    hints:
      enabled: true
      max: 5
```

## Post-Fusion Dampening

After hybrid recall combines traversal, FTS, vector results, and
prospective hints into a candidate pool, structured evidence shaping
(`platform/daemon/src/pipeline/structured-evidence.ts`) scores candidates
across separate lexical, semantic, hint, and traversal channels. This is
the recall-side SEC layer: traversal can contribute structure, but
traversal-only memories are capped below directly anchored evidence;
prospective hints stay strong enough to recover class-to-instance
matches, such as "music streaming service" finding a memory that only
says "Spotify." A light facet-coverage pass then prefers top candidates
that cover different parts of multi-part queries instead of returning
near-duplicates for one facet.

After structured evidence shaping produces a fused score list, the
dampening pipeline
(`platform/daemon/src/pipeline/dampening.ts`) applies three corrections
before the final sort. The goal is to break score bunching where relevant
and irrelevant results land at similar fusion scores.

The existing rehearsal stage also recognizes explicit freshness terms
(`current`, `latest`, `recent`, `today`, `this week`, and `this month`). For
those queries only, it applies a bounded `created_at` recency boost alongside
its normal access-based decay. Date-range interpretation remains exclusively
on the structural temporal-recall path, and bare `now` does not trigger
freshness shaping. Timeless queries and callers with `since`/`until` bounds are
unchanged. This conservative behavior is deliberately enabled by default as a
fix for stale near-ties; operators can disable it with
`search.temporal_prior_enabled: false`.

Structured currentness then applies a final correction before hydration.
Active attributes remain eligible as current evidence, while memories whose
structured attributes have been superseded are downweighted and annotated
with a `[Signet currentness]` note that points to the replacement
attribute when available. Structured supersession is grouped-claim-scoped: a newer
attribute can replace an older one only when it shares the same entity,
aspect, `group_key`, and `claim_key`. Sibling events under the same aspect stay active
unless the caller explicitly gives them the same group and claim key. This keeps stale
facts visible for historical questions without letting them win ordinary
"what is current?" recall.

**Stage 1: Gravity dampening** penalizes results that arrived via a
semantic path (vector, hybrid, or traversal) but share zero query-term
overlap with the actual content. These are "semantic hallucinations" —
the embedding model thinks they are related but the surface words have
nothing in common. Results with a score above 0.3 from a semantic source
are tokenized (lowercase, stop-word stripped) and checked against the
query tokens. Zero overlap halves the score (default `gravityPenalty:
0.5`).

**Stage 2: Hub dampening** penalizes results whose linked entities are
all high-degree hubs. Entity mention counts from
`memory_entity_mentions` are sorted to compute a P90 threshold (default
`hubPercentile: 0.9`). If every entity linked to a memory sits above
that threshold, the memory's score is multiplied by `hubPenalty` (default
0.7). This prevents popular entities like "Signet" or "Nicholai" from
dominating recall when the query targets something specific.

**Stage 3: Resolution boost** rewards actionable, specific memories.
Memories with type `constraint` or `decision` receive a 1.2x multiplier
(default `resolutionBoost: 1.2`). Other memories with temporal anchors
(ISO dates or month names) receive a lighter boost: `1 + (boost - 1) *
0.5`, which is 1.1x at default settings. Short or vague content (under
50 characters) receives no boost.

All three stages are independently togglable. After dampening, results
are re-sorted by adjusted score descending.
