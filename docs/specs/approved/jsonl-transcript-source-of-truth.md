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
scope_boundary: "Defines canonical transcript persistence and backfill. It does not redesign derived transcript retrieval weighting, which remains covered by transcript-surface-separation."
draft_quality: "implementation contract"
---

# JSONL Transcript Source of Truth

Signet stores transcripts as JSONL under the workspace at `memory/{harness}/transcripts/transcript.jsonl`. The file is appendable during live sessions, easy to copy from harnesses that already persist JSONL, and stable enough to become the input for transcript-based summary, fallback, and lineage flows.

The daemon accepts three transcript sources. If a hook provides a transcript path or inline transcript, the daemon normalizes the conversation into canonical JSONL records and replaces the prior slice for that agent, harness, and session. If a harness only calls prompt-submit with the current user turn, the daemon appends live user and previous-assistant turns so active sessions still appear before session-end. If an existing install only has legacy markdown artifacts or database transcript rows, the daemon backfills those records into the same JSONL location before new writes.

The canonical record schema is `signet.transcript.v1`. Each line carries the agent id, harness id, session key/id, project, sequence number, role, content, capture timestamp, source format, optional source path, and source hash. This keeps one transcript substrate across Claude Code, Codex, OpenCode, OpenClaw, Hermes Agent, Gemini, Oh My Pi, and Pi without relying on any one harness's native log shape.

Markdown transcript artifacts remain readable as legacy inputs, and the `session_transcripts` table remains a compatibility/indexing surface while existing retrieval and FTS paths migrate. New transcript persistence must write JSONL first and treat markdown transcript artifacts as historical compatibility, not the forward source of truth.
