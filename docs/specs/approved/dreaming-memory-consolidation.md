---
title: "Dreaming: Token-Budget Memory Consolidation"
description: "Replace granular pipeline workers with periodic smart-model reasoning passes that consolidate session summaries into a dense, accurate knowledge graph."
order: 1
section: "Memory Architecture"
informed_by:
  - "docs/specs/planning/LCM-PATTERNS.md"
  - "docs/specs/complete/memory-pipeline-plan.md"
  - "docs/specs/complete/knowledge-architecture-schema.md"
success_criteria:
  - "Entity graph density increases (fewer entities, more attributes per entity) after a dreaming pass"
  - "Duplicate and near-duplicate entities are merged automatically"
  - "Stale or junk attributes are pruned without manual intervention"
  - "Users without large-model access fall back to the existing extraction pipeline with no degradation"
  - "Token spend per dreaming pass is bounded and configurable"
scope_boundary: "This spec covers the consolidation agent, trigger mechanism, and backfill strategy. It does not cover changes to the session capture system (transcripts, summaries) which remains as-is, nor does it cover the system prompt extraction from AGENTS.md (separate spec)."
---

Dreaming: Token-Budget Memory Consolidation
============================================

*Let a smart model reason about your day instead of making dumb workers
guess at it piece by piece.*


## Problem

The current memory pipeline runs small, context-limited workers that
process individual transcript chunks in isolation. Each worker sees a
narrow slice — one chunk, one fact candidate — and cannot reason across
the full picture. The results:

- **Entity bloat.** The knowledge graph fills with duplicate and
  near-duplicate entities because no single worker sees enough context
  to recognize that "Nuke compositing" and "Foundry Nuke" refer to the
  same thing.
- **Junk attributes.** Short fragments, broken index entries, and
  decontextualized snippets survive as attributes because the quality
  gate (MIN_FACT_LENGTH=80, confidence threshold) is a blunt instrument
  that can't assess semantic value.
- **Weak graph traversal.** The knowledge graph's traversal scoring
  is dominated by hub entities (high-degree nodes like the user's own
  name) rather than topically relevant nodes, because the graph
  structure itself is noisy.
- **Compounding complexity.** Every attempt to fix these problems adds
  another stage to the pipeline (reranker, contradiction checker,
  dedup pass, significance gate), making the system harder to maintain
  without proportionally better results.

Meanwhile, session summaries produced by the summary-worker are
already good. The LCM lineage system captures coherent session-level
artifacts. The raw material is fine — it's the processing that's the
bottleneck.


## Core Idea

Replace the granular extract-decide-write-embed pipeline with periodic
**dreaming passes**: a single smart-model reasoning step that reads
accumulated session summaries and the current entity graph, then
produces a set of graph mutations (create, merge, update, delete,
supersede).

The metaphor is deliberate. Biological memory consolidation happens
during sleep — the brain replays the day's experiences and integrates
them into long-term memory. Dreaming does the same thing for Signet:
replay the sessions, reason about what matters, and write it into the
graph cleanly.


## Architecture

### What stays

- **Session capture.** Transcripts and summaries continue to be
  written by the existing summary-worker. The LCM artifact system
  (`writeImmutableArtifact`) is unchanged.
- **The knowledge graph schema.** Entities, aspects, attributes —
  the data model is good. The problem is the writer, not the schema.
- **The extraction pipeline (as fallback).** Users who don't want to
  spend tokens on a large model keep the existing pipeline. It becomes
  the "local/free" tier of memory maintenance. Dreaming is the
  "premium" tier.

### What changes

- **Dreaming agent.** A new background job that runs a reasoning pass
  over accumulated session summaries. It reads the current entity
  graph, identifies what changed, and produces structured mutations.
- **Token-budget trigger.** Dreaming is triggered by accumulated
  summary tokens, not by a fixed schedule. Once unprocessed summaries
  cross a configurable threshold (default: ~100k tokens), a dreaming
  job is queued.
- **Backfill / compaction mode.** A one-time (or on-demand) variant
  that reads the full entity graph and densifies it — merging
  duplicates, pruning junk, collapsing near-identical attributes.
  Same agent, different scope.


## Trigger Mechanism

The daemon tracks accumulated summary tokens since the last dreaming
pass. This is a simple counter: each time a session summary is written,
its token count is added to a running total persisted in the database.

```
dreaming_state:
  tokens_since_last_pass: 0
  last_pass_at: null
  last_pass_id: null
```

When `tokens_since_last_pass` exceeds the configured threshold, the
daemon queues a dreaming job. The threshold is configurable in
`agent.yaml`:

```yaml
memory:
  dreaming:
    enabled: true
    tokenThreshold: 100000    # trigger after ~100k tokens of summaries
    maxInputTokens: 128000    # context budget per pass
    backfillOnFirstRun: true  # run compaction on first dreaming pass
```

This means:
- Heavy user (many sessions/day): dreams nightly or more often
- Light user (few sessions/week): dreams weekly or less
- Scales naturally with actual usage, not wall-clock time


## Dreaming Agent Contract

### Identity

The dreaming agent is not an anonymous data processor. It is the same
agent taking time to reflect on its own experiences. It receives the
startup identity/context selected by the active identity preset, then
receives `DREAMING.md` as the dreaming task prompt. For example:

- Minimal startup: `AGENTS.md`
- Hermes startup: `SOUL.md`, then `AGENTS.md` / Hermes project context
- OpenClaw startup: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`,
  and `MEMORY.md`
- Special dreaming prompt: `DREAMING.md` appended only for dreaming sessions

This matters because memory consolidation requires judgment about
*what matters to this agent and this user*. An isolated worker can't
make that call. The agent reasoning about its own day — knowing who
it is, who the user is, what it cares about — can.

### Dreaming is a normal session

This is the critical design insight: **a dreaming pass is just a
regular Signet session.** It goes through the same session-start
hook, the same transcript capture, the same summarization at session
end. The agent receives MEMORY.md as part of its context, just like
any other session. The dreaming session's transcript and summary are
saved like any other session's.

This means:

- **The agent remembers dreaming.** The next dreaming pass can review
  what the previous one did — what it merged, what it pruned, what
  decisions it made — and course-correct. "Last time I was too
  aggressive pruning entities related to VFX projects. I should be
  more conservative there."
- **MEMORY.md provides continuity.** The dreamer doesn't approach the
  graph cold. It has its working memory of recent activity, priorities,
  and the state of things from the last time it reflected.
- **Self-improvement is emergent.** Because the agent can observe its
  own prior dreaming sessions, it can evaluate its own performance.
  "I merged these entities last time but the search results got worse.
  I should have kept them separate." The feedback loop tightens
  naturally.
- **No special infrastructure.** The daemon doesn't need a separate
  session type, a separate transcript store, or a separate summary
  pipeline for dreaming. It's the same code path. The only difference
  is what triggers the session and what the initial prompt says.

The dreaming prompt is simple:

> You're taking some time to reflect on your recent sessions. Here
> are the session summaries since your last reflection. Here is your
> current knowledge graph. Please review what happened, what you
> learned, and update your memory accordingly.

That's it. The agent's identity, working memory, and judgment handle
the rest.

### Input

The dreaming agent receives (via normal session-start hook):

1. **Active startup identity context** — the ordered files selected by
   `identity.startup.load` in `agent.yaml`. Minimal agents may load only
   `AGENTS.md`; richer presets can load `SOUL.md`, `IDENTITY.md`,
   `USER.md`, and `MEMORY.md` according to their configured order.
2. **Unprocessed session summaries** — all summaries written since the
   last dreaming pass, ordered chronologically. These are the session
   DAG nodes at depth 0 with `kind = "session"`.
3. **Current entity graph snapshot** — all entities with their aspects
   and attributes, plus relationship edges. This is the agent's view
   of existing long-term memory.
4. **`DREAMING.md` task prompt** — the special-session prompt telling
   the agent to reflect on the sessions and update the graph. It is not
   loaded in normal startup context; it is appended only for dreaming
   sessions.

### Self-Improvement Loop

Because dreaming sessions are normal sessions that get summarized and
stored, a natural self-improvement cycle emerges:

1. **Dream pass N** — agent reviews sessions, updates graph, makes
   judgment calls about what to merge/prune/keep.
2. **Dream pass N is summarized** — the dreaming session's transcript
   and decisions become part of the agent's history.
3. **Dream pass N+1** — agent sees the summary of dream pass N in its
   session history. It can evaluate: did those merges make retrieval
   better? Did pruning go too far? Were the right things prioritized?
4. **Adjustments compound** — the agent refines its approach to memory
   management over time, based on observing its own results.

This replaces the current model where pipeline workers repeat the
same mistakes indefinitely because they have no memory of prior
passes and no ability to self-evaluate.

### Output

A structured JSON response containing graph mutations:

```typescript
interface DreamingResult {
  mutations: Array<
    | { op: "create_entity"; name: string; type: string; aspects: Aspect[] }
    | { op: "merge_entities"; source: string[]; target: string; reason: string }
    | { op: "delete_entity"; name: string; reason: string }
    | { op: "update_aspect"; entity: string; aspect: string; attributes: Attribute[] }
    | { op: "delete_aspect"; entity: string; aspect: string; reason: string }
    | { op: "supersede_attribute"; entity: string; aspect: string; old: string; new: string }
    | { op: "create_attribute"; entity: string; aspect: string; content: string }
    | { op: "delete_attribute"; entity: string; aspect: string; content: string; reason: string }
  >;
  summary: string;       // human-readable summary of what changed
  tokensBudget: number;  // tokens consumed by this pass
}
```

The daemon validates and applies mutations transactionally. Failed
or invalid mutations are logged but don't block the rest.

### Incremental deltas

Dreaming passes operate on deltas, not full graph snapshots. The
daemon tracks what changed since the last pass:

- New session summaries (already tracked via token counter)
- Entities/attributes created or modified since last pass (via
  `updated_at` timestamp or a monotonic version column)

The dreaming model receives:

1. Identity context (AGENTS.md, SOUL.md, etc.)
2. New session summaries since last pass
3. Only entities/attributes in the delta (created or modified)
4. A graph query tool to pull adjacent entities on demand (e.g.
   if the model suspects a merge candidate exists outside the delta)

The default payload is small and bounded by actual change volume,
not total graph size. The model reaches into the full graph only
when it needs to — not as a baseline assumption.

Backfill/compaction mode (below) is the exception: it deliberately
walks the full graph for cleanup. Regular dreaming passes are
incremental.


## Backfill / Initial Compaction

On first run (or on-demand via API/CLI), dreaming runs in compaction
mode:

1. Load the full entity graph (entities + aspects + attributes)
2. Load a sample of recent session summaries for context
3. Reason about the graph: find duplicates, merge them, prune junk
   attributes, collapse redundant aspects
4. Output the same mutation format

This is how we clean up existing bloated databases. It's the same
agent with a different input emphasis: graph-heavy instead of
summary-heavy.

A CLI command triggers it explicitly:

```bash
signet dream --compact    # run compaction now
signet dream --status     # show dreaming state
signet dream --trigger    # force a dreaming pass now
```


## Interaction with Existing Pipeline

Dreaming (Pipeline V3) and the extraction pipeline (Pipeline V2) are
**mutually exclusive**. When dreaming is enabled, Pipeline V2 is off.
One writer for the knowledge graph at a time.

| Config                    | Behavior                                              |
|---------------------------|-------------------------------------------------------|
| `dreaming.enabled: false` | Pipeline V2 (current behavior, default)               |
| `dreaming.enabled: true`  | Pipeline V2 off. Summaries accumulate, dreaming       |
|                           | consolidates the knowledge graph on token threshold   |

This is an architectural simplification, not an additive layer. The
existing database schema (entities, aspects, attributes) is preserved
— dreaming replaces the *writer*, not the *data model*. The graph
structure has real value for traversal, deduplication, and density.
The problem was never the schema; it was building 10 narrow-context
workers to populate it poorly. A single capable reasoning model with
full identity context and the complete picture does all of that better.

Pipeline V2 remains as a fallback for users without access to a
capable reasoning model (small/local-only setups).


## System Prompt Extraction (Related)

This is a separate concern but was identified in the same
conversation: the Signet system prompt currently lives inside
`AGENTS.md`, which means it's never re-injected if the user already
has a custom `AGENTS.md`. The fix:

- **Remove the Signet system prompt from AGENTS.md generation.**
- **Inject it as a prefix in the session-start hook.** This keeps it
  independent of the user's identity files.
- **The system prompt should explain the LCM expand tool** (possibly
  renamed to something more intuitive like "memory search" or
  "session recall") and encourage models to use it as the primary
  memory interface.

This is tracked separately but is part of the same simplification
effort.


## Evidence: Manual Graph Audit (2026-04-01)

A manual knowledge graph audit on the live database confirmed every
problem this spec aims to solve. Key findings:

### Entity Duplication

A single person (Avery Felts) exists as **6 separate entities**:
`Avery`, `Avery Felts`, `Avery's`, `Avery Felts\"**`,
`Avery/AlexMondello`, `LMAO AVERY`. The possessive forms, markdown
artifacts, and Discord message fragments were all extracted as
distinct entities by pipeline workers that couldn't recognize them
as the same person.

Session lifecycle concepts split across 5+ entities:
`session initialization`, `initialization commands`,
`Signet startup hook`, `signet hook session-start command`,
`Signet session-start hook`.

Entity names with markdown formatting artifacts: `Signet Development**`,
`Graph Bloat**`, `People's`.

### Attribute Fragmentation

The Nicholai entity's `general` aspect contains these attributes:
- `"lives with"` (truncated mid-sentence)
- `"**: Lead"` (markdown bold artifact)
- `"shared his top 3 pen list: Pilot G-2 0"` (truncated at chunk boundary)

The `properties` aspect is worse: `"Avery) consistently surface but
are very large/noisy"`, `"entity) over explicit entity names passed
as arguments"` — sentence fragments ripped from surrounding context.

### Memory Duplication from MEMORY.md Backups

The same "People" block existed in 4 copies (from successive
MEMORY.md backup snapshots ingested by the file watcher). The same
"Signet Development" block existed in 3 copies. The re-embedding
test results existed in 3 copies. All from the feedback loop bug
(PR #439), but demonstrating that even with the loop fixed, the
existing data needs a compaction pass.

### Traversal Scoring Dominance

Live testing showed graph traversal scores (93-109 range) outweigh
keyword relevance (under 1.0) by ~100x. A query for "Nuke" returned
pen preferences and Discord allowlists as top results because they
connect to hub entities (Nicholai, Biohazard) via graph edges.
Direct keyword hits for Nuke-related memories were buried.

### Manual Cleanup Results

In one session, 18 junk/duplicate memories were identified and
deleted via `memory_forget`. This required reading full memory
content, cross-referencing for duplicates, and making judgment calls
about supersession — exactly the kind of reasoning a dreaming agent
would do automatically.

### Implications for Backfill

The audit confirms that `--compact` mode is not optional for
existing users. The current graph state actively degrades search
quality. First dreaming pass must run compaction. Estimated scope:
13,000+ memories, potentially thousands of duplicate/junk entities
requiring merge/delete.


## Implementation Status (PR #442)

### Delivered (Phase 1)

The mechanical consolidation engine is complete:

- **Dreaming agent core.** All 8 mutation operations: `create_entity`,
  `merge_entities`, `delete_entity`, `update_aspect`, `delete_aspect`,
  `supersede_attribute`, `create_attribute`, `delete_attribute`. Atomic
  application in a single write transaction. Pinned entities and
  constraint attributes protected (reported as `skipped`).
- **Token-budget trigger.** Summary worker accumulates transcript
  token counts into `dreaming_state`. Background worker polls every
  5 minutes and fires when threshold is crossed.
- **Compact and incremental modes.** First pass auto-runs in compact
  mode when `backfillOnFirstRun: true`. Manual trigger via API/CLI.
- **Config surface.** `agent.yaml` > `memory.dreaming` with threshold,
  budget, backfill, and timeout settings. Provider and model are
  inherited from the synthesis provider (no separate dreaming-specific
  provider config -- avoids duplication and supports all synthesis
  backends including `claude-code`, `codex`, `opencode`, etc.).
- **API.** `GET /api/dream/status`, `POST /api/dream/trigger`.
- **CLI.** `signet dream status`, `signet dream trigger [--compact]`.
- **DB migration 055.** `dreaming_state` (per-agent PK) and
  `dreaming_passes` (audit log with applied/skipped/failed counts).
- **Graph safety.** LIMIT caps on entity graph queries (2000 entities,
  10k aspects, 50k attributes, 10k dependencies). Character budget
  for graph text in prompts (~30% of token budget).
- **Tests.** 26 tests covering state management, threshold logic,
  all mutation types, constraint protection, and pass lifecycle.

### Deferred (Phase 2 — required for spec completion)

These items are described in the spec but not yet implemented. They
are critical for the spec's full vision and must be built before
the spec can move to `complete`.

1. **Dreaming as a session.** The spec's central design insight
   (section "Dreaming is a normal session") is that a dreaming pass
   should go through the full session lifecycle — session-start hook,
   transcript capture, session-end summarization. Currently, dreaming
   is a standalone LLM call that bypasses the session system. This
   means:
   - The agent does not remember its own dreaming passes
   - The self-improvement loop (section "Self-Improvement Loop")
     is not active — dream pass N+1 cannot review dream pass N's
     decisions and course-correct
   - No session transcript is saved for the dreaming pass itself

2. **Incremental delta filtering.** The spec (section "Incremental
   deltas") describes sending only entities modified since the last
   pass, with a graph query tool for on-demand expansion. Currently,
   the full entity graph snapshot is sent (bounded by LIMIT caps).
   This works for moderate-sized graphs but is wasteful for large
   graphs where most entities haven't changed.

3. **Graph query tool.** The spec describes giving the model a tool
   to pull adjacent entities on demand when it suspects merge
   candidates exist outside the delta. Currently the model receives
   a static snapshot with no interactive tool access.

4. **Pipeline V2 mutual exclusion.** The spec (section "Interaction
   with Existing Pipeline") states that Pipeline V2 extraction should
   be OFF when dreaming is enabled — one writer at a time. Currently
   both can run simultaneously. SQLite write serialization prevents
   data corruption, but concurrent extraction can create new entities
   that the dreaming pass doesn't see, leading to inconsistency.
   Needs: gate `startPipeline` when `dreaming.enabled: true`, or
   stop extraction workers during a dreaming pass.

5. **Chunked compaction.** For very large graphs (13k+ entities per
   the evidence section), the full entity graph won't fit in a single
   context window even with LIMIT caps. The spec's open question #4
   describes entity-cluster batching (e.g. all entities related to
   "Signet", then "Biohazard VFX") with a cross-cluster merge pass.
   Not implemented — current LIMIT caps truncate silently.

6. **Dashboard observability.** The spec's open question #2 describes
   a diff view of the entity graph before/after a dreaming pass. No
   dashboard UI exists for dreaming status, history, or graph diffs.
   The API surface (`GET /api/dream/status`) provides the data but
   there's no frontend consumer.

7. **~~Identity context injection.~~** (RESOLVED) The prompt now loads
   and injects all five identity files (AGENTS.md, SOUL.md, IDENTITY.md,
   USER.md into `<identity>`, MEMORY.md into `<working_memory>`).
   This was implemented in Phase 1 — the deferred item was documented
   in error.


## Open Questions

1. **Model selection for dreaming.** Should this default to the same
   provider as extraction, or always target a larger model? The whole
   point is that a smarter model does better work, but cost varies.
   *Resolved in Phase 1:* Dreaming has its own provider/model config
   independent of extraction. Default is `anthropic`/`claude-sonnet-4-6`.
2. **Observability.** Users should be able to see what dreaming
   changed — a diff view of the entity graph before/after. Dashboard
   integration? *Deferred to Phase 2.*
3. **Retention policy interaction.** Dreaming's delete operations need
   to respect pinned memories and retention policies. How does this
   compose with the existing retention decay system? *Partially
   resolved:* pinned entities and constraint attributes are protected.
   Full retention policy integration (decay rates, archived memories)
   is not yet wired.
4. **Chunked compaction.** With 13k+ memories, the full graph won't
   fit in a single context window. Compaction may need to work in
   entity-cluster batches (e.g. all entities related to "Signet",
   then "Biohazard VFX", etc.) with a final merge-candidates pass
   across clusters. *Deferred to Phase 2.*
5. **Entity deduplication heuristics.** The dreaming agent needs
   guidance on recognizing possessive forms, markdown artifacts,
   and name variants as the same entity. Should this be in the
   dreaming prompt, or should there be a pre-processing normalization
   step before the agent sees the graph? *Currently in the prompt
   only — no pre-processing normalization.*
