---
title: "Native Harness Memory Bridge Research"
question: "How should Signet make harness-native memories portable without duplicating each harness's memory pipeline?"
date: 2026-04-22
---

# Native Harness Memory Bridge Research

Codex now ships a native memory system that writes consolidated memory
artifacts under `~/.codex/memories/` and supports extension inputs under
`~/.codex/memories_extensions/<extension>/`. The relevant stable surface for
Signet is the filesystem artifact layer, not Codex's internal SQLite state.

The integration posture should be adapter-based: harnesses that already have
memory remain the source of truth for their native memories, while Signet
indexes those artifacts with provenance so they can be recalled from other
harnesses. Signet-authored memories continue to flow through existing Signet
hooks and recall injection.

For Codex v1, read `memory_summary.md`, `MEMORY.md`, `raw_memories.md`,
`rollout_summaries/*.md`, and automation-local `automations/*/memory.md`
files. Do not write Codex state DB rows. Use Codex memory extensions only as a
future native export surface if prompt injection is not sufficient for a
specific workflow.


Claude Code uses a broader memdir system than the older Signet integration
assumed. Source inspection in `references/claude-code/src/memdir/paths.ts`,
`memdir.ts`, `memoryScan.ts`, `memoryTypes.ts`, and
`utils/memoryFileDetection.ts` shows that Claude Code stores an entrypoint
`MEMORY.md`, separate frontmatter-bearing `.md` memory files, session memory,
and agent-scoped memory under `~/.claude/agent-memory/<agentType>/`. The
bridge should index those filesystem artifacts as external native memory
provenance instead of maintaining a separate Claude-only chunking and
`/api/memory/remember` path.

For Claude Code v1, read `projects/*/memory/MEMORY.md`,
`projects/*/memory/**/*.md` excluding the entrypoint duplicate,
`session-memory/**/*.md`, `agent-memory/*/*.md`, and
`agent-memory-local/*/*.md`. Project-local `.claude/agent-memory/` roots can
be added later once project root discovery is shared with the connector layer.
