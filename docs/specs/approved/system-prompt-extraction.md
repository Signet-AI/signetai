---
title: "System Prompt Extraction from Identity Files"
description: "Move the Signet system prompt out of AGENTS.md and into the session-start hook as an independent injection, preserving user identity files and simplifying the tool surface for models."
order: 2
section: "Memory Architecture"
informed_by:
  - "docs/specs/planning/dreaming-memory-consolidation.md"
  - "docs/specs/planning/LCM-PATTERNS.md"
success_criteria:
  - "Signet system prompt is injected via session-start hook output, not embedded in AGENTS.md"
  - "Users with pre-existing AGENTS.md files receive the system prompt without regenerating their file"
  - "AGENTS.md contains only user-authored agent instructions and identity; no Signet plumbing"
  - "The system prompt is a single, maintainable source of truth across all connectors"
  - "Models use LCM expand / memory search as the primary retrieval interface without additional prompting in identity files"
scope_boundary: "This spec covers the system prompt content, its injection mechanism, and the migration path for existing users. It does not cover changes to MEMORY.md rendering, session-end hooks, or the extraction pipeline."
---

System Prompt Extraction from Identity Files
=============================================

*The Signet system prompt should be infrastructure, not content.*


## Problem

Today the Signet system prompt lives inside a `<!-- SIGNET:START -->` /
`<!-- SIGNET:END -->` block that gets injected into `AGENTS.md` (and
its harness-specific copies like `CLAUDE.md`). This has three problems:

### 1. The prompt is invisible to users who already have an AGENTS.md

The Signet block is injected when `AGENTS.md` is generated from
scratch during setup. If a user already has an `AGENTS.md` — either
hand-written or from a previous version of Signet — the system prompt
is never re-inserted. The user's agent runs without Signet's tool
instructions, memory context, or identity stewardship guidelines.

The connector's `install()` method calls `buildSignetBlock()` and
writes it into the generated file, but it won't overwrite an existing
file. And even if it did, users would rightly object to their
hand-crafted instructions being clobbered by auto-generated plumbing.

### 2. The prompt pollutes the identity layer

`AGENTS.md` is supposed to be the agent's operating instructions —
*how* it works, *what* it should do. The Signet system prompt is
infrastructure: tool availability, memory commands, file locations,
architecture explanations. Mixing the two makes both harder to
maintain and harder for models to parse. The user's intent gets buried
under Signet's self-description.

### 3. The prompt is duplicated and scattered

The system prompt content is defined in `@signet/core`'s
`buildSignetBlock()`, but each connector has its own copy/paste
installation path. Updates to the prompt require rebuilding and
reinstalling connectors. The `SIGNET-ARCHITECTURE.md` file is a
separate artifact that duplicates some of the same information.
There's no single source of truth that all connectors read at runtime.


## Design

### Move the system prompt to session-start hook output

The session-start hook already returns an `inject` string that gets
prepended to the model's context. This is the natural place for the
Signet system prompt. The hook runs on every session, regardless of
what's in `AGENTS.md`, and it's controlled by the daemon — so updates
take effect immediately without reinstalling connectors.

```
Current flow:
  AGENTS.md (contains Signet block) → symlinked to CLAUDE.md → model reads it
  Session-start hook → returns memories + date/time → prepended to context

Proposed flow:
  AGENTS.md (user content only) → symlinked to CLAUDE.md → model reads it
  Session-start hook → returns system prompt + memories + date/time → prepended to context
```

### What the system prompt should contain

The prompt should be short, tool-focused, and avoid duplicating what
models already know. It's not an architecture document — it's a
briefing.

Proposed structure:

```
[signet active]

You have persistent memory managed by Signet. Your primary tool for
retrieving memory is:

  mcp__signet__memory_search — hybrid vector + keyword search across
  all stored memories. Returns scored results with content, type, tags,
  and entity graph context.

For deeper exploration:

  mcp__signet__lcm_expand — drill into a session summary node.
  Returns parent/child lineage, linked memories, and optionally the
  cleaned transcript. Use this when memory_search returns a session
  reference you want to expand.

  mcp__signet__knowledge_expand — drill into an entity's aspects,
  attributes, constraints, and dependencies.

  mcp__signet__knowledge_expand_session — find session summaries
  linked to a specific entity.

Cross-session history is also available through linked summary and
transcript artifacts in the Signet workspace. Inspect those artifacts
directly when MEMORY.md or recall snippets are not enough.

To store a memory explicitly:

  mcp__signet__memory_store — write a memory with content, type,
  and optional tags.

Your identity files are in your Signet workspace:
  AGENTS.md — how you operate (you maintain this)
  SOUL.md — your personality and values (you maintain this)
  IDENTITY.md — who you are (you maintain this)
  USER.md — who the user is (you maintain this)
  MEMORY.md — auto-generated working memory summary (system-managed)

Secrets are available via mcp__signet__secret_list and
mcp__signet__secret_exec. Secrets are injected as environment
variables into subprocesses, never exposed as raw values.
```

This is ~1200 chars. It tells the model what tools exist, what they
do, and how to use them. No architecture lectures, no philosophy
about memory layers, no instructions about "durable substrate."
Models are smart enough to figure out usage patterns from the tool
descriptions themselves.

### What gets removed from AGENTS.md

The entire `<!-- SIGNET:START -->` / `<!-- SIGNET:END -->` block is
removed from `buildSignetBlock()` in `@signet/core/src/markdown.ts`.
The function either returns an empty string or is removed entirely.

`SIGNET-ARCHITECTURE.md` stays as an on-demand reference file — the
system prompt doesn't need to mention it. If a model or user wants to
understand the pipeline internals, they can read it directly.

### What changes in the session-start hook

`handleSessionStart()` in `platform/daemon/src/hooks.ts` already
builds an `inject` string from memories, date/time, and metadata.
The system prompt becomes the first section of that inject string,
before memories and other context.

The system prompt is built at runtime by the daemon (not baked into
connector configs), so it's always current. If tools are added or
renamed, the prompt updates on next session start.

### What changes in connectors

Connectors no longer inject `buildSignetBlock()` into generated
markdown files. The `install()` methods still create/symlink
`AGENTS.md` → `CLAUDE.md` etc., but only with the user's content.

For existing users who already have a Signet block in their
`AGENTS.md`, `signet install` strips it on upgrade (remove content
between `SIGNET:START` and `SIGNET:END` markers) as a marker-bounded,
idempotent migration.


## Migration Path

### New users

Setup wizard creates `AGENTS.md` with only user-authored content (or
a minimal template). No Signet block. System prompt comes from the
session-start hook.

### Existing users

Active migration is required in this phase:

1. `signet install` detects `SIGNET:START` / `SIGNET:END` markers and
   strips the legacy block from workspace `AGENTS.md`.
2. The cleanup is marker-bounded and idempotent, preserving all
   user-authored content outside the block.
3. Session-start inject supplies the runtime system prompt on every
   new session, so users do not need to regenerate identity files.


## Tool Naming

The current tool names (`mcp__signet__memory_search`,
`mcp__signet__lcm_expand`, etc.) are functional but not discoverable.
The system prompt extraction is an opportunity to establish clearer
names or at least clear descriptions.

Candidates for renaming (non-blocking, can be done separately):

| Current                              | Candidate                        |
|--------------------------------------|----------------------------------|
| `mcp__signet__lcm_expand`            | `mcp__signet__session_expand`    |
| `mcp__signet__knowledge_expand`      | `mcp__signet__entity_expand`     |
| `mcp__signet__knowledge_expand_session` | `mcp__signet__entity_sessions` |

These are MCP tool names so renaming has compatibility implications.
Could be done as aliases first, deprecating the old names.


## Files to Modify

| File | Change |
|------|--------|
| `platform/core/src/markdown.ts` | Remove or empty `buildSignetBlock()`. Keep `SIGNET_BLOCK_START`/`END` constants for migration detection. |
| `platform/daemon/src/hooks.ts` | Add system prompt to `handleSessionStart()` inject output |
| `integrations/claude-code/connector/src/index.ts` | Stop injecting Signet block into generated files. Optionally strip existing blocks on install. |
| `integrations/opencode/connector/src/index.ts` | Same as above |
| `integrations/openclaw/connector/src/index.ts` | Same as above |
| `integrations/codex/connector/src/index.ts` | Same as above |
| `integrations/oh-my-pi/connector/src/index.ts` | Apply the same legacy block cleanup during install |
| `platform/daemon-rs/crates/signet-daemon/src/routes/hooks.rs` | Mirror session-start system prompt injection to keep shadow parity |


## Implementation Decisions (This Phase)

1. **Character budget:** accepted for MVP. The injected system prompt is
   compact and fits inside existing session-start budgets.
2. **Per-harness variation:** deferred. This phase uses one shared
   prompt across harnesses.
3. **User override flag:** deferred. No suppression toggle in this phase.
4. **Tool availability detection:** deferred. Prompt currently lists the
   canonical Signet MCP tools unconditionally.
