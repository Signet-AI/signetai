---
title: "Native Harness Memory Bridge"
id: native-harness-memory-bridge
status: approved
informed_by:
  - docs/research/technical/RESEARCH-NATIVE-HARNESS-MEMORY-BRIDGE.md
section: "Connectors"
depends_on:
  - "memory-md-rolling-window-lineage"
  - "signet-runtime"
success_criteria:
  - "Memories written by a native-memory harness are recallable through Signet from other harnesses without becoming Signet-authored memory rows"
  - "Codex native memory artifacts are indexed with harness/source provenance"
  - "Codex MCP registration avoids exposing duplicate Signet memory tools by default"
scope_boundary: "Indexes harness-native memory artifacts and bridges them into recall; does not replace native memory systems, write their internal databases, or add a second extraction pipeline"
---

# Native Harness Memory Bridge

Signet provides one portable memory interface across harnesses. When a harness
already has its own memory system, Signet indexes that harness's native memory
artifacts as external provenance-bearing artifacts rather than re-extracting,
rewriting, or claiming ownership of those memories.

V1 implements the generic source abstraction with Codex as the first adapter.
Codex memory files under `~/.codex/memories/` are indexed into Signet's
artifact search layer and surfaced through recall as `native_memory` results.
Normal Signet hooks remain the write path for Signet memories created from
Hermes, OpenClaw, OpenCode, Claude Code, and Codex sessions.

Codex's MCP registration keeps hooks and non-duplicative Signet capabilities,
but filters Signet memory tools by default so native memory plus hook-driven
recall do not create two competing memory UXs.
