---
title: "JSONL Transcript Source of Truth"
id: jsonl-transcript-source-of-truth
status: approved
informed_by:
  - "docs/research/technical/RESEARCH-LCM-ACP.md"
  - "docs/specs/approved/lossless-working-memory-runtime.md"
section: "Runtime"
depends_on:
  - "session-continuity-protocol"
  - "lossless-working-memory-runtime"
success_criteria:
  - "Every supported harness writes or backfills into `$SIGNET_WORKSPACE/memory/{harness}/transcripts/transcript.jsonl`."
  - "Prompt-submit writes live JSONL turns when the harness does not provide a native transcript snapshot."
  - "Session-end and transcript snapshot hooks replace the session slice in canonical JSONL so final transcripts become the durable source of truth."
  - "Existing markdown transcript artifacts and `session_transcripts` rows backfill canonical JSONL history without losing backward compatibility."
  - "A bounded recovery worker backfills settled Claude Code and Codex JSONL session logs missed by lifecycle hooks without duplicating hook-sourced snapshots or rewriting native logs."
scope_boundary: "Defines canonical transcript persistence and backfill. It does not redesign derived transcript retrieval weighting, which remains covered by transcript-surface-separation."
draft_quality: "implementation contract"
---

# JSONL Transcript Source of Truth

Signet stores transcripts as JSONL under the workspace at `memory/{harness}/transcripts/transcript.jsonl`. The file is appendable during live sessions, easy to copy from harnesses that already persist JSONL, and stable enough to become the input for transcript-based summary, fallback, and lineage flows.

The daemon accepts four transcript sources. If a hook provides a transcript path or inline transcript, the daemon normalizes the conversation into canonical JSONL records and replaces the prior slice for that agent, harness, and session. If a harness only calls prompt-submit with the current user turn, the daemon appends live user and previous-assistant turns so active sessions still appear before session-end. If an existing install only has legacy markdown artifacts or database transcript rows, the daemon backfills those records into the same JSONL location before new writes. Finally, a dedicated recovery worker scans settled native Claude Code and Codex JSONL session logs and enqueues snapshots that the lifecycle-hook path missed.

Recovery is best-effort and bounded. The worker waits for a quiet period before reading a file, limits discovery, reads, file size, and scan frequency, and records file fingerprints in SQLite so unchanged logs are not repeatedly parsed. Recovery derives the same content-and-path session snapshot identity as session-end hooks; capture enqueue also deduplicates that stable identity and normalized content independently of delivery timestamps. The worker preserves the raw log as provenance and never modifies native harness files.

Claude Code recovery covers `~/.claude/projects/**/*.jsonl`. Codex recovery covers uncompressed `~/.codex/sessions/**/rollout-*.jsonl`; archived `.jsonl.zst` rollouts are outside the current contract. OpenCode recovery remains hook/SDK-based because current OpenCode stores sessions in its SQLite database rather than exposing a native transcript-log path. Other harnesses remain eligible when they define a stable, documented native transcript source.

The canonical record schema is `signet.transcript.v1`. Each line carries the agent id, harness id, session key/id, project, sequence number, role, content, capture timestamp, source format, optional source path, and source hash. This keeps one transcript substrate across Claude Code, Codex, OpenCode, OpenClaw, Hermes Agent, Gemini, Oh My Pi, and Pi without relying on any one harness's native log shape.

Markdown transcript artifacts remain readable as legacy inputs, and the `session_transcripts` table remains a compatibility/indexing surface while existing retrieval and FTS paths migrate. New transcript persistence must write JSONL first and treat markdown transcript artifacts as historical compatibility, not the forward source of truth.
