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
  - "Models can use the harness-provided memory tools as the primary retrieval interface without duplicating tool names in the Signet prompt"
scope_boundary: "This spec covers the system prompt content, its injection mechanism, and the migration path for existing users. It does not cover changes to MEMORY.md rendering, session-end hooks, or the extraction pipeline."
---

> **Deprecated context:** The daemon-rs Rust daemon rewrite has been removed. References below to daemon-rs parity or mirroring are historical.


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
Signet provides persistent cross-session memory. Signet memory tools are available through this harness.
```

The stable prompt is intentionally about capability, not implementation. The
harness already exposes the current tool names and schemas, so Signet must not
maintain a second inventory that can drift. The prompt also does not prescribe
a recall ritual, list slash commands, enumerate identity files, or inject secret
names. Those details belong to the harness and the user's actual workspace.

Session-start output separately includes bounded Session Continuity previews.
Each preview keeps a full memory ID, type, date, and available source metadata;
long content is marked as an excerpt and can be retrieved through the current
harness memory retrieval surface. The historical-reference disclaimer appears
immediately above these records so recalled content is not mistaken for
instructions. This layer remains distinct from the Dreaming-owned `MEMORY.md`
summary of durable facts and preferences.

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

1. **Character budget:** accepted for MVP. The stable capability prompt is
   intentionally tiny and the rendered Session Continuity section has separate
   entry, section, and overall injection bounds.
2. **Per-harness variation:** deferred. This phase uses one shared stable
   capability prompt across harnesses.
3. **User override flag:** deferred. No suppression toggle in this phase.
4. **Tool availability detection:** deferred. The prompt does not enumerate
   tools; the active harness remains the source of tool names and schemas.
5. **Preview recovery:** every rendered memory keeps its full ID and truncated
   previews point to the existing exact-record retrieval surface.
