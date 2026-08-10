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
  - "Codex, Claude Code, and Hermes Agent native memory artifacts are indexed with harness/source provenance"
  - "Removed native artifact files are soft-deleted and excluded from active recall without losing provenance"
  - "Codex MCP registration avoids exposing duplicate Signet memory tools by default"
scope_boundary: "Indexes harness-native memory artifacts and bridges them into recall; does not replace native memory systems, write their internal databases, or add a second extraction pipeline"
---

# Native Harness Memory Bridge

Signet provides one portable memory interface across harnesses. When a harness
already has its own memory system, Signet indexes that harness's native memory
artifacts as external provenance-bearing artifacts rather than re-extracting,
rewriting, or claiming ownership of those memories.

V1 implements the generic source abstraction for harness-owned memory
artifacts. Codex memory files under `~/.codex/memories/` and automation-local
memory files under `~/.codex/automations/*/memory.md` are indexed into
Signet's artifact search layer and surfaced through recall as
`native_memory` results. Claude Code's native memdir files under
`~/.claude/projects/*/memory/`, `~/.claude/session-memory/`, and
`~/.claude/agent-memory/` use the same bridge path instead of the previous
Claude-only watcher that rechunked `MEMORY.md` into Signet-authored rows.
Hermes Agent's configured profile memory files under
`<HERMES_HOME>/memories/MEMORY.md` and `<HERMES_HOME>/memories/USER.md` use
the same read-only artifact path. Signet records the profile identity, source
path, content hash, and source timestamp, and keeps the rows scoped to the
requesting Signet agent. Exact live `hermes-memory-write` mirrors are
deduplicated at recall without replacing either source of evidence.
When native memory files disappear, Signet marks their artifact rows deleted and
excludes them from active recall rather than hard-deleting provenance.
Normal Signet hooks remain the write path for Signet memories created from
Hermes, OpenClaw, OpenCode, Claude Code, and Codex sessions.

Codex's MCP registration keeps hooks and non-duplicative Signet capabilities,
but filters Signet memory tools by default so native memory plus hook-driven
recall do not create two competing memory UXs.
