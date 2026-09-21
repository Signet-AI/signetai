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

A daemon database and its workspace root are one ownership unit. Every process using the same database must use the same canonical workspace root; sharing a database across roots is unsupported because canonical artifacts and source-generation locks are rooted at that workspace.

The daemon accepts four transcript sources. Prompt-submit appends only the current user and previous-assistant turns to canonical JSONL; ordinary Stop/session.idle hooks never reread or enqueue the growing native source. Explicit lifecycle boundaries enqueue either an external transcript path or the already-retained session transcript. A path is authoritative: capture admission records only its resolved path and cheap stat metadata; the worker is the sole full-source reader, hashes and verifies the same byte generation, and SQLite stores only source identity, digest, metadata, import state, and a bounded audit reference. Inline boundary data is a fallback only when no source path exists and is cleared after successful processing. Existing markdown transcript artifacts and `session_transcripts` rows backfill canonical JSONL history without losing backward compatibility. Finally, a dedicated recovery worker scans settled native Claude Code and Codex JSONL session logs and enqueues snapshots that the lifecycle-hook path missed.

Recovery is best-effort and bounded. The worker waits for a quiet period before reading a file, limits discovery, reads, file size, and scan frequency, and records stat fingerprints to advance the bounded frontier without rechecking the same candidate twice in one cycle. The capture worker remains the only full-source reader and periodically revalidates unchanged-stat candidates, so preserved size/mtime cannot permanently hide a byte change. Capture admission coalesces one logical source identity, and the worker records the authoritative content digest after its single full read; a changed generation replaces the pending/completed capture instead of appending another full snapshot. Source locks serialize admission and processing for one agent/source pair. A completed source-backed canonical session is append-only: canonical JSONL is evaluated before its normalized/session row is updated, and a stale shorter or divergent source cannot replace retained canonical turns or its derived artifact/index. Startup cleanup clears recoverable legacy payloads without deleting unrecoverable evidence. The worker preserves the raw log as provenance and never modifies native harness files.

Claude Code recovery covers `~/.claude/projects/**/*.jsonl`. Codex recovery covers uncompressed `~/.codex/sessions/**/rollout-*.jsonl`; archived `.jsonl.zst` rollouts are outside the current contract. OpenCode recovery remains hook/SDK-based because current OpenCode stores sessions in its SQLite database rather than exposing a native transcript-log path. Other harnesses remain eligible when they define a stable, documented native transcript source.

The canonical record schema is `signet.transcript.v1`. Each line carries the agent id, harness id, session key/id, project, sequence number, role, content, capture timestamp, source format, optional source path, and source hash. This keeps one transcript substrate across Claude Code, Codex, OpenCode, OpenClaw, Hermes Agent, Gemini, Oh My Pi, and Pi without relying on any one harness's native log shape.

Markdown transcript artifacts remain readable as legacy inputs, and the `session_transcripts` table remains a compatibility/indexing surface while existing retrieval and FTS paths migrate. New transcript persistence must write JSONL first and treat markdown transcript artifacts as historical compatibility, not the forward source of truth.
