---
title: "Extraction and decisions"
description: "How the memory pipeline extracts, classifies, decides, and applies controlled writes."
---

## Overview and Philosophy

Pipeline v2 exists because the original [Memory](/memory/) system was purely reactive:
callers wrote whatever they wanted, the database accepted it, and recall
quality depended entirely on how well the caller chose what to store. That
model worked for bootstrapping but doesn't scale — memories accumulate
noise, contradict each other, and fragment across overlapping phrasings of
the same fact.

The pipeline introduces a background extraction layer. When a memory
arrives, it is persisted immediately (raw-first safety), and a job is
enqueued to analyze it asynchronously. The job runs extraction and
decision passes using a local LLM, then optionally writes derived facts
back into the memory store. This means the caller's raw content is never
lost — it is always durably committed before any LLM call runs — and
derived facts are layered on top rather than replacing the original.

This is substrate work. The pipeline's job is to turn raw interaction
data into cleaner, more structured material the rest of the system can
use for retrieval, repair, and eventually learned context selection.

The central constraint governing every design decision here is: **no LLM
calls inside write-locked transactions.** SQLite write locks are exclusive,
and a blocking HTTP call to Ollama inside one would stall the entire [Daemon](/daemon/).
The pipeline enforces a strict two-phase discipline: fetch and embed outside
the lock, then commit atomically inside `withWriteTx`. Any violation of this
rule introduces unbounded latency into every other writer.

## Pipeline Modes

Three operational modes are composed from five boolean flags.

**Shadow mode** is active when `enabled` is true but `shadowMode` is also
true, or when `mutationsFrozen` is true. In this mode the pipeline runs the
full extraction and decision sequence, records all proposals to
`memory_history` for audit, but makes no writes to the memories table.
Shadow mode is useful for validating extraction quality without affecting
production data.

**Controlled-write mode** is active when `enabled` is true, `shadowMode` is
false, and `mutationsFrozen` is false. In this mode, ADD and NONE decisions
are applied. ADD creates new memory rows and embeddings; NONE is recorded
for audit only. UPDATE and DELETE proposals are blocked unless
`autonomous.allowUpdateDelete` is true.

**Full mode** is controlled-write mode with `allowUpdateDelete` set to true.
In this mode UPDATE proposals modify the referenced memory through the mutation
API path, and DELETE proposals soft-delete the referenced memory through the
forget path. The previous target state is archived to the cold tier first, and
pinned memories are skipped rather than deleted.

The five config flags in detail:

- `enabled` — Master switch. When false, no extraction jobs are processed.
- `shadowMode` — Run extraction and decisions without writing any facts.
- `allowUpdateDelete` — Permit UPDATE/DELETE decisions to mutate existing
  memories through guarded modify/forget paths.
- `mutationsFrozen` — Emergency brake. Disables all writes even if
  `shadowMode` is false.
- `autonomous.frozen` — Disables the maintenance worker's scheduled interval
  even if `autonomous.enabled` is true.

## Extraction Stage

Extraction is the first LLM pass. Its job is to decompose a raw memory
string into a list of discrete, reusable facts and a list of entity
relationship triples.

The extraction prompt instructs the model to return a JSON object with two
arrays. Each fact carries a `content` string, a `type` discriminant
(`fact`, `preference`, `decision`, `procedural`, or `semantic`), and a
floating-point `confidence` in [0, 1]. Each entity triple carries `source`,
`relationship`, `target`, and `confidence`. The prompt includes worked
examples and explicitly tells the model to skip ephemeral details and return
only the JSON object — no surrounding text.

The model's output is post-processed before validation. `<think>` blocks
emitted by chain-of-thought models like qwen3 are stripped first. Then
Markdown code fences are removed if present. The resulting string is
parsed as JSON.

Validation is strict and partial-failure safe. Facts are capped at 20 per
input. Any fact shorter than 10 characters is rejected. Any fact longer
than 2000 characters is truncated. An unknown type string is coerced to
`fact` with a warning recorded. Entities are capped at 50 per input; each
must have non-empty `source` and `target` strings and a non-empty
`relationship`. Input longer than 12,000 characters is truncated before the
prompt is built.

Validation failures produce warnings that are accumulated in the
`ExtractionResult` and surfaced in the job's result payload. They never
throw — partial results are always returned.

## Decision Stage

The decision stage evaluates each extracted fact independently against the
existing memory store. For each fact, the engine retrieves the top-5
candidate memories via hybrid search, then asks the LLM which of four
actions to take: ADD, UPDATE, DELETE, or NONE.

This stage is intentionally conservative. It is better understood as a
proposal and curation layer than as autonomous semantic rewriting. Its
output improves memory quality and auditability; it does not eliminate
the need for downstream relevance learning.

Candidate retrieval uses the same BM25 + vector hybrid search that powers
recall. The BM25 leg queries `memories_fts` with the fact's content as the
full-text query; scores are normalized to [0, 1] via `1 / (1 + |score|)`.
The vector leg embeds the fact content and calls `vectorSearch` against the
embeddings table. Results from both legs are merged by ID, then combined
with a weighted sum: `alpha × vector + (1 - alpha) × bm25` when both legs
returned a score, or the single available score otherwise. Candidates below
`min_score` are dropped. The top 5 are fetched from the memories table.

When no candidates are found, the engine immediately proposes ADD without an
LLM call, using the fact's own confidence as the proposal confidence and a
fixed reason string.

When candidates exist, the decision prompt presents the fact and a numbered
list of candidates with their IDs, types, and content. The model is asked
to return a JSON object with `action`, `targetId` (required for UPDATE and
DELETE), `confidence`, and `reason`. The response is parsed with the same
`<think>`-strip and fence-removal logic as extraction.

Validation on the decision output ensures that UPDATE and DELETE decisions
reference an ID that actually appears in the candidate set. Proposals with
missing or hallucinated IDs are dropped with a warning. An empty `reason`
string is also rejected.

The function is named `runShadowDecisions` regardless of mode — "shadow"
here means the function itself makes no writes. Whether the proposals are
applied or merely recorded is a concern of the worker that calls this
function.

## Controlled Writes

When controlled-write mode is active, the worker applies ADD decisions
inside a single `withWriteTx` call after all LLM and embedding work has
completed. The write path is implemented in `applyPhaseCWrites`.

Before entering the transaction, the worker pre-fetches embeddings for all
ADD proposals in parallel. Each fact content is passed through
`normalizeAndHashContent` to compute a `contentHash`, and the storage
content (original casing) and hash are used as the key for caching the
vector. The embedding fetch is intentionally outside the transaction lock.

Inside the transaction, each ADD proposal passes through a sequence of
safety gates. First, the fact's confidence is compared to
`minFactConfidenceForWrite` (default 0.7); facts below this threshold are
skipped with reason `low_fact_confidence`. Second, the normalized content
is checked for zero length; empty facts are skipped with reason
`empty_fact_content`. Third, the `content_hash` is checked against the
memories table to detect exact duplicates — both at the pre-insert check
and defensively on UNIQUE constraint collision. Duplicates are recorded with
the existing memory's ID and counted as `deduped`.

For facts that clear all gates, `txIngestEnvelope` creates the memory row
in a single insert, with `who` set to `pipeline-v2`, `why` to
`extracted-fact`, and the pipeline's extraction model name in
`extractionModel`. If a pre-fetched embedding vector is available for this
content hash, it is upserted into the embeddings table in the same
transaction.

Audit records are written for every proposal in every outcome: ADD
(created), ADD (deduped), ADD (skipped), NONE (recorded), and destructive
(blocked). Each record lands in `memory_history` with enough metadata to
reconstruct the decision context: proposal action, fact content, confidence,
the source memory ID, the extraction model, and fact and entity counts.

The contradiction detector runs on UPDATE and DELETE proposals before they
are blocked. It tokenizes both the fact content and the target memory's
content, checks for lexical overlap of at least two tokens, and then looks
for either a negation-polarity difference (one has a negation token, the
other doesn't) or an antonym pair conflict (enabled/disabled, allow/deny,
etc.). Proposals that trigger the detector are flagged `reviewNeeded: true`
in their audit record.

## Content Normalization

All content passes through `normalizeAndHashContent` before storage or
hashing. The function is deterministic and produces three derived values.

`storageContent` is the text after trimming and whitespace collapsing
(`/\s+/g → " "`). This is what gets written to the database. Original
casing is preserved.

`normalizedContent` takes `storageContent`, lowercases it, and strips
trailing punctuation (`[.,!?;:]+$`). This is used for FTS indexing and as
the hash basis when non-empty.

`contentHash` is a SHA-256 digest of the hash basis (normalized content if
non-empty, otherwise lowercased storage content). This 64-character hex
string is the deduplication key. Upserts on the embeddings table use it as
the unique key, and memory inserts check it to avoid exact-content
duplicates.

## Inline Entity Linker

Before any async pipeline job runs, the inline entity linker
(`platform/daemon/src/inline-entity-linker.ts`) performs a fast,
synchronous mention-linking pass at memory write time. This is a
mechanical helper, not a semantic author.

The linker runs without an LLM call. It scans the memory's content text
for candidate proper nouns and links only entities that already exist
for the same `agent_id`. It writes `memory_entity_mentions` rows so a
new memory can be discovered from known entity pages immediately, but it
does not create entities, aspects, attributes, or dependencies.

Structured graph writes come from `POST /api/memory/remember` with a
`structured` payload, explicit user/agent actions, or reviewed
normalization passes. This keeps the default background path cheap,
predictable, and hard to poison: incidental capitalization can attach a
memory to an existing known entity, but it cannot invent graph structure.

Because the linker runs inside the write transaction, it must stay fast
and deterministic. There are no network calls, no LLM inference, and no
blocking I/O, only candidate matching and SQLite writes against existing
graph rows.

## Structural Classification

The per-fact structural classify and structural dependency workers are retired.
Dreaming owns all automatic semantic writes, so no runtime creates or leases
`structural_classify`/`structural_dependency` jobs. The obsolete `structural`
configuration block is ignored.

The default pipeline does not use a background LLM to author graph structure;
Dreaming emits audited operations from episodic evidence.

For details on the knowledge graph persistence stage, see
[KNOWLEDGE-GRAPH.md](/knowledge-graph/).
