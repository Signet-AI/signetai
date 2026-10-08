---
title: "Dreaming, extraction, and semantic decisions"
description: "How Signet preserves evidence, selects it for Dreaming, and applies audited semantic operations."
---

## Overview

Signet separates source evidence from the semantic knowledge derived from it.
A memory, transcript, document, or other source artifact is stored as
agent-scoped episodic evidence first. That evidence remains available for
recall, provenance, repair, and later processing.

Dreaming is the current semantic processing path. It selects evidence from the
agent-scoped episodic surface, reasons over that evidence with bounded daemon
capabilities, and submits audited ontology operations. It may derive entities,
aspects, claims, and links, but it does not rewrite the evidence it used.

A `POST /api/memory/remember` call does not create a per-memory extraction job.
The memory row is immediately available for keyword search, and embedding work
may continue asynchronously. Pipeline V2 runs the workers that are currently
active for the installation: document ingest, retention, maintenance,
synthesis, prospective indexing, and Dreaming.

This is the important architectural boundary:

- Episodic evidence records what was received.
- Dreaming derives semantic state from selected evidence.
- The daemon owns validation, scope, mutation, and audit behavior.
- No LLM call runs inside a write-locked transaction.

For the storage lifecycle and search path, see [Memory System](/memory/). For
worker startup and retired workers, see [Workers and maintenance](/pipeline/workers-maintenance/).

## The old extraction and decision worker is retired

The former Pipeline V2 design ran a background extraction worker for each raw
memory. That worker produced fact and relationship candidates, retrieved
similar memories, asked an LLM to choose `ADD`, `UPDATE`, `DELETE`, or `NONE`,
and applied the permitted results through a controlled-write path.

That runtime no longer exists. The daemon does not create or lease new
`extract` jobs, and startup terminalizes unfinished historical extraction jobs
with their existing provenance intact. The old per-fact decision loop,
`runShadowDecisions`, and `applyPhaseCWrites` are not current runtime surfaces.

The `memory_extraction` name may still appear in inference-router status. It is
the workload binding Dreaming uses for inference calls; it does not mean that
the retired extraction worker is enabled.

Likewise, the old structural classification, structural dependency, and
cross-entity dependency-synthesis workers are retired. Dreaming's audited
operation path is the automatic semantic graph writer.

## Dreaming passes

A Dreaming pass operates over one or more agent scopes. The pass avoids spending
inference work when there is no pending attention or episodic backlog. When
there is work, it follows this general sequence.

### 1. Select evidence

Dreaming searches the agent-scoped episodic aggregation surface. This can
include explicit memories, source artifacts, completed transcripts, and
temporal summaries. The search path preserves source references and returns
bounded excerpts rather than handing the model an unbounded database view.

A completed transcript and its related lineage remain one source of evidence,
not several independent facts to merge blindly. When a captured session has
both a transcript artifact and a transcript record, the transcript record is
the one Dreaming input; the artifact is offered only when no record exists. Credentials in delivered evidence
are redacted on the way to Dreaming; the original source row is not rewritten.

The evidence search capability is `search_evidence`. Other read capabilities
allow Dreaming to inspect entities, aspects, claims, links, contradictions,
and attention state within the relevant agent scope.

### 2. Reason with bounded capabilities

Dreaming is an agentic pass, not a fixed per-fact classifier. Its capability
registry defines the operations available to the agent, including:

- `search_evidence` for immutable episodic memories, artifacts, and transcripts;
  without a query it pages through the delivery queue and reports `hasMore`
  until the queue is empty. A page holds one excerpt per source, and a partly
  reviewed source continues on a later page by itself. Within a pass a source
  resumes where the pass last read it; a source reviewed partway in an earlier
  pass resumes 200 characters before its reviewed end, snapped back to a
  sentence or paragraph start, and the excerpt's `reviewedChars` counts the
  leading characters that were already reviewed. The agent files each page and
  acknowledges it before asking for the next, so a pass that runs out of time
  loses at most one page. Once a pass has used half its
  timeout, the queue stops handing out new sources (`deliveryClosed`) so the
  pass can file what it read and record its progress; the rest goes to the
  next pass. With a query it searches full history, splitting it on whitespace
  into words that match independently
  (ASCII case-insensitive) and ranking fuller matches first; unspaced text such
  as CJK matches as one phrase
- `review_evidence` to acknowledge the excerpts a pass has reviewed. The agent
  copies `sourceRef` and `contentOffset` from an excerpt delivered in the same
  pass and scope, and either acknowledges the whole excerpt or names an exact
  `through` quote where its review stopped. The daemon converts that to a
  character offset and rejects the whole call with a specific code when the
  excerpt was not delivered in this pass, belongs to another scope, does not
  contain the quote, or has changed since delivery. A source's evidence cursor
  advances only by text acknowledged this way or cited by a successful
  `apply_ontology_ops` operation, extended contiguously from the stored cursor
  when the pass finalizes. Delivered text that is never acknowledged stays
  queued. A source revision delivered in three successful passes without
  progress gets a visible `evidence_requeue` attention record and stops
  leading the continuation queue. Cursors written before this rule are marked
  with `cursor_basis = 'delivery'`; new writes use `'review'`.
- `search_entities` and `get_entity` for scoped graph reads
- `list_aspect_claims` for claims with their evidence, and optionally the aspect's contradictions
- `attention_list` for queued review and maintenance attention beyond what the pass prompt lists
- `validate_proposal` for deterministic checks
- `runbook_write` for Dreaming's per-pass operational note, and `zoom_history` to open a
  line of the pass history back into the passes and records it was made from
- `apply_ontology_ops` for daemon-owned semantic mutations

The same scope-bound registry is used across the in-process agent path and the
MCP, HTTP, and CLI surfaces. Capability input is validated before execution,
and graph reads and writes remain bound to the requested agent scope.

`runbook_write` accepts `reviewedExcludedEvidence` for source revisions that the
pass inspected completely and intentionally found to contain no durable fact.
A concrete deliverable the assistant produced for the user's own project, plan,
or situation, such as a budget, schedule, or draft, counts as durable: Dreaming
files its specifics on that project, worded as proposed rather than confirmed.
Generic information not tied to the user's circumstances does not. Advice is
not durable, but what the user discloses about themselves to get it (their
situation, constraints, habits, and preferences) is, so a source holding such a
disclosure is never excluded as empty. Those claims attach to a person entity
named after the user when the source states a name, and otherwise to one
entity named `User`; a bare `User` without the person type is still rejected
as transcript scaffolding. When a source shows several named speakers, such as
a group chat, each speaker's statements go on that speaker's own entity.
Separating unnamed users who share one agent scope is best effort (#2037). A pass defers a source only while its transcript is
still mid-stream or a tool error persists after the call is corrected; a
missing entity or aspect is created in the same pass. Each claim holds one fact
with every date, amount, count, and name the source gives for it, and work the
user asks for on behalf of their own job, business, trip, or event counts as
their own situation. The
`memory_head_read` and `memory_head_commit` tools are offered only to content
passes, which are the only passes that can publish the head.
Each entry includes the owning `agentId` and `sourceRef`, so multi-scope passes
cannot attribute a reviewed source to the primary scope. This terminal
disposition is revision-scoped. A newer source revision becomes eligible again,
while a temporary blocker must remain in `deferredEvidence`.

### 3. Propose and validate ontology operations

Dreaming expresses semantic changes as structured ontology operations rather
than direct SQL or free-form memory-row edits. The daemon validates the
operation contract and runs deterministic pre-write guards before applying it.

Validation can include entity-label quality, duplicate-entity checks, and
contradiction checks against active aspect values. Write caps and other graph
invariants are enforced by the daemon-owned apply path, not by trusting the
model to stay within bounds.

### 4. Apply audited operations

`apply_ontology_ops` is the only semantic-mutating Dreaming capability. The
separate runbook capability may update Dreaming's bounded operational notes,
but it does not author graph state. The daemon applies accepted ontology
operations through the audited mutation path, records operation effects and
failures, and preserves evidence and version history.

Dreaming can create or update semantic graph state, but it does not silently
rewrite the episodic source that justified the operation. Claims and links keep
their available evidence and provenance so later review can distinguish source
truth from the current semantic view.

Inference and embedding work happen before the short database mutation phase.
The write path must remain deterministic and bounded; a slow provider call must
not hold a SQLite write lock.

### 5. Record pass state

Dreaming records pass status, tool calls, applied/skipped/failed mutation
counts, evidence progress, and summary information. The evidence watermark
advances only when the pass actually consumes the relevant episodic backlog.
A failed ontology operation withholds progress only for the sources it cites,
unless a successful write in the same pass cited the same source with the same
quote;
a failure that cites no source, including one whose operations could not be
parsed, withholds progress for the sources in its agent scope that no
successful write in the pass cited, so filed sources and other scopes in the
same pass still record what was read. Hygiene operations (flags, declines,
and the archives and merges that cite attention records) carry no evidence, so
their failures withhold nothing. A failed write whose trace cannot be read
withholds every scope in the pass.
An `incremental-content` pass must stage exactly one `memory_head_commit`, and
fails if the agent ends without one. A pass with nothing to publish resubmits
the current entries, or an empty entry set while the head is still empty. The
DB owner applies the staged head in the same transaction as pass completion and
watermark updates. If validation or any finalization write fails, the transaction rolls
back the head, pass completion, and watermark together. The generated
`MEMORY.md` file is a projection: a publication failure leaves a durable
pending publication for a later read to recover and does not turn the
committed pass into a failure. A hygiene-only pass must not hide unprocessed
content from a later content pass.

Dreaming has focused modes for incremental work, compact runs, content work,
and hygiene work. These are pass modes, not the retired per-fact
`ADD`/`UPDATE`/`DELETE` decision modes.

## Operational controls

The daemon reports a Pipeline V2 mode derived from these controls:

| Control | Current meaning |
| --- | --- |
| `enabled` | Enables Pipeline V2 runtime processing. |
| `paused` | Prevents the normal pipeline runtime from starting; retention can still run as a standalone safeguard. |
| `mutationsFrozen` | Prevents mutation-producing pipeline workers, including Dreaming, from starting. |
| `shadowMode` | Causes the daemon to report `shadow` pipeline status and keeps checkpoint extraction available when the main pipeline switch is off. It does not restore the old extraction worker or its simulated decision pass. |
| `autonomous.enabled` | Enables the scheduled maintenance interval. |
| `autonomous.frozen` | Prevents the scheduled maintenance interval while leaving on-demand inspection available. |
| `autonomous.maintenanceMode` | Selects whether maintenance recommendations are observed or executed. |

Fresh installs enable background Dreaming by default and ask about it during provider/model onboarding. If no provider is connected, it remains enabled but waits: the scheduler reports `blocked` with `reason: "inference_unavailable"`, runs no passes, rechecks every 30 seconds, and resumes on its own once the Dreaming route resolves. An explicit `memory.pipelineV2.enabled: false` turns Dreaming off as well. Users can opt out in onboarding. This enables the Pipeline V2 runtime, knowledge graph, autonomous maintenance, update/delete operations, and executable maintenance mode. Rehearsal boosting and reranking also remain enabled by default. `signet setup --enable-dreaming` applies the Dreaming settings to an existing workspace while preserving unrelated configuration. Retired provider-routing and synthesis settings are not written to new configs; migrations remove retired fields from older configs when they can be migrated safely before strict loading.

`autonomous.allowUpdateDelete` is not the old extraction decision gate. The
retired extraction, write-gate, and legacy provider-routing configuration keys
are rejected as retired; inference provider selection belongs to the canonical
inference workload configuration.

The default pipeline workers are deliberately divided by responsibility:

- Document ingest turns source documents into indexed chunks.
- Retention removes expired rows while preserving referential safety.
- Maintenance diagnoses queue, index, storage, and graph health and can run bounded repair actions.
- Synthesis maintains session-derived projection artifacts.
- Prospective indexing generates search hints.
- Dreaming is the automatic semantic writer.

See [Workers and maintenance](/pipeline/workers-maintenance/) for the
non-semantic workers and their repair behavior.

## Explicit ontology extraction

The daemon also exposes an explicit operator-facing path at
`POST /api/ontology/extract`. This is separate from the scheduled Dreaming
worker.

The endpoint reads selected episodic material and can use an inference provider
to propose ontology candidates such as:

- entities
- claim values
- links
- actions and policies
- assertions
- questions

The default behavior is a dry run. `write_proposals` and `write_assertions`
explicitly opt into persisting those results. The provider is instructed not to
write memory or invent unsupported facts. This path produces ontology proposals
and assertions; it is not the retired per-memory fact extractor.

## Content normalization and deduplication

All memory content passes through `normalizeAndHashContent` before storage or
hashing. The result has three useful text values and a hash basis.

`storageContent` normalizes CRLF line endings and trims the outer whitespace.
It preserves internal whitespace and newlines. This is the content stored in the
memory row, with original casing preserved.

`normalizedContent` lowercases `storageContent`, collapses whitespace to single
spaces, removes trailing punctuation from `[.,!?;:]+`, and trims the result.
This is the normal form used for matching and hashing when it is non-empty.

`contentHash` is the SHA-256 digest of `normalizedContent`, or of lowercased
`storageContent` when the normalized value is empty. The resulting 64-character
hex digest is used for exact-content deduplication and embedding-key lookup.

## Inline entity linking

Before asynchronous workers run, the remember path performs a fast,
synchronous mention-linking pass. This is a mechanical helper, not a semantic
author.

The linker scans content for candidate proper nouns and attaches mentions only
to entities that already exist in the same `agent_id` scope. It can create
`memory_entity_mentions` rows so a new memory is discoverable from an existing
entity page, but it does not create entities, aspects, attributes, or
dependencies.

Structured graph writes come from an explicit `structured` remember payload,
user or agent actions, reviewed repair and normalization passes, or Dreaming's
audited ontology operations. The inline linker makes the default write path
cheap and predictable without allowing incidental capitalization to invent graph
structure.

Because the linker runs inside the memory write transaction, it must remain
fast and deterministic. It performs no network calls, LLM inference, or
blocking provider work.

## Source truth and semantic truth

The source record and the semantic graph serve different purposes:

- Source evidence is retained for provenance and recovery.
- Semantic claims and links are the current operational view derived from that evidence.
- Dreaming may revise semantic state as new evidence arrives.
- A semantic revision does not rewrite the evidence that led to an earlier state.
- Agent scope and visibility are enforced on both reads and writes.

This separation is what makes the graph repairable. When a source is removed or
new evidence contradicts a claim, the system can review derived state without
pretending that the original source never existed.

For the broader graph model, see [Knowledge architecture](/knowledge-architecture/)
and [Knowledge graph persistence](/knowledge-graph/). For recall's evidence
and authorization boundary, see [Knowledge and search](/pipeline/knowledge-search/).

## Retired concepts

The following names may still appear in historical migrations, logs, tests, or
old configuration examples, but they do not describe the current semantic write
path:

- per-memory `extract` jobs
- the extraction fact/entity JSON contract
- `runShadowDecisions`
- `ADD`, `UPDATE`, `DELETE`, and `NONE` fact decisions
- `applyPhaseCWrites`
- the old `memory_history` decision record for every extracted fact
- background structural classification and dependency writers
- `memory.pipelineV2.writeGate` and legacy extraction provider routing

When diagnosing current behavior, start with the Dreaming pass, its scoped
capabilities, the ontology operation contract, and the daemon's audit records.
