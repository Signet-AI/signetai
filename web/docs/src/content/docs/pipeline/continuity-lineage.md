---
title: "Continuity and lineage"
description: "How checkpoints, transcripts, and Markdown lineage preserve session evidence."
---

## Session Checkpoints

Session checkpoints (`platform/daemon/src/session-checkpoints.ts`) capture
periodic snapshots of session state for continuity recovery. They store
a digest of the session's current focus, prompt count, memory queries,
and recent remembers.

Checkpoints are triggered by five event types:

- `periodic` — fired on a timer or prompt-count interval
- `pre_compaction` — fired when the harness signals context compaction
- `session_end` — fired when a session closes
- `agent` — fired by agent-initiated events
- `explicit` — fired by manual API calls

Each checkpoint row stores `session_key`, `harness`, `project`,
`project_normalized`, `trigger`, `digest`, `prompt_count`,
`memory_queries` (JSON array), and `recent_remembers` (JSON array).
Secrets are redacted before storage using pattern-based scrubbing
(Bearer tokens, API keys, base64 credential blobs, env variable values).

A buffered flush queue (`queueCheckpointWrite`) debounces writes at
2,500 ms intervals. If two triggers fire within the flush window for
the same session, queries and remembers are merged (union with caps:
20 queries, 10 remembers) and prompt counts are summed.

Per-session caps are enforced: when checkpoint count exceeds
`maxCheckpointsPerSession`, the oldest rows are deleted.

Digest formatters produce structured markdown for each trigger type:

- `formatPeriodicDigest` — project, prompt count, duration, recent
  prompts, memory activity
- `formatPreCompactionDigest` — same plus optional session context
- `formatSessionEndDigest` — same with total prompt count

Pruning is strict: `pruneCheckpoints(db, retentionDays)` hard-deletes
all checkpoints older than the retention window.

Configuration lives under `continuity` in the pipeline config:

| Field | Default | Range | Description |
|-------|---------|-------|-------------|
| `enabled` | `true` | — | Master switch |
| `promptInterval` | `10` | 1–1000 | Prompts between periodic checkpoints |
| `timeIntervalMs` | `900000` | 60s–1h | Time between periodic checkpoints (15 min) |
| `maxCheckpointsPerSession` | `50` | 1–500 | Per-session cap |
| `retentionDays` | `7` | 1–90 | Days before old checkpoints are pruned |
| `recoveryBudgetChars` | `2000` | 200–10000 | Max characters for recovery digest |

## Lossless Session Transcripts

As hooks run, Signet stores the canonical retained conversation transcript as
JSONL at `$SIGNET_WORKSPACE/memory/{harness}/transcripts/transcript.jsonl` and
keeps the session row lossless for later projection. The `session_transcripts`
table (migration 040) is the canonical transcript index. Dreaming sanitizes a
read-time projection: tool calls become markers, tool outputs are omitted, and
the retained row is not rewritten. Raw auditable traces may still be written
to daemon logs outside the memory lineage.

The table schema includes `session_key`, `content`, `harness`, `project`,
`agent_id`, `created_at`, `completed_at`, and `content_hash`, with indexes for
agent/completion and agent/hash lookups. The session-end, recovery, and TTL
paths mark the row complete directly; no summary worker writes it.

The `/api/memory/remember` endpoint accepts an optional `transcript`
field. When present and a `sourceId` (session key) is available, the
transcript is written to `session_transcripts` in a separate write
transaction. This allows connectors to push cleaned conversation text
alongside memories without waiting for session-end summary processing.

At recall time, the `/api/memory/recall` endpoint supports `expand:
true`. When set, session keys from the result set are batch-looked up
in `session_transcripts` and the transcript content is joined into the
response. This lets callers retrieve the full conversation context
behind a recalled memory without a separate API call.

## Canonical Markdown Lineage and MEMORY.md Projection

Rolling history now has an explicit authority split.

Canonical historical content lives as immutable markdown artifacts in
`$SIGNET_WORKSPACE/memory/`:

- `--transcript.md`
- `--summary.md`
- `--compaction.md`

Each session also has one mutable `--manifest.md` file. The manifest is the
only artifact that may gain new links after session end, such as a later
`compaction_path`.

`MEMORY.md` is no longer canonical history. It is a rebuildable projection over:

- durable memory rows for the Tier 1 head
- persisted thread heads plus temporal DAG state for Tier 2
- canonical artifact frontmatter for the strict 30-day session ledger

The renderer is programmatic. LLM output in this lane is limited to the single
`memory_sentence` stored in summary and compaction frontmatter, with a
deterministic fallback when the quality gate fails. The final `MEMORY.md`
projection always includes:

- `## Global Head (Tier 1)`
- `## Thread Heads (Tier 2)`
- `## Session Ledger (Last 30 Days)`
- `## Open Threads`
- `## Durable Notes & Constraints`
- `## Temporal Index`

Session-end capture writes the canonical transcript artifact, and the
completed transcript row is the single Dreaming input for the content pass.
Dreaming owns the temporal manifest/MEMORY/DAG projection for that input.
Historical summary and compaction artifacts remain readable for provenance;
`compaction-complete` may still write a canonical compaction artifact. The
mid-session `session-checkpoint-extract` endpoint retains continuity checkpoint
nodes but does not create a summary job or deliver an intermediate transcript
to Dreaming.
