---
title: "Cache-Stable Memory Injection"
id: cache-stable-memory-injection
status: approved
informed_by:
  - docs/specs/approved/lossless-working-memory-closure.md
  - docs/specs/approved/jsonl-transcript-source-of-truth.md
section: "Connectors"
depends_on:
  - "prompt-context-contract"
  - "lossless-working-memory-closure"
  - "signet-runtime"
success_criteria:
  - "Session-start responses expose a deterministic stableSystemPrompt separately from state-dependent dynamicContext"
  - "Identical harness state produces byte-identical provider-bound dynamic context while canonical user and assistant transcripts remain free of injected memory blocks"
  - "Supported prompt-submit integrations deliver dynamic context through an API-only, hidden, or harness-native context channel rather than appending it to canonical user content"
  - "Internal signet-memory and memory-context delimiters are escaped at injection boundaries and removed from visible streaming output when the harness exposes a stream boundary"
  - "Compression, resume, branch, rewind, and session-end boundaries do not replay stale dynamic context"
  - "Contract evaluation reports deterministic replay, transcript separation, and measured latency results"
scope_boundary: "Defines the transport contract and adapter behavior; it does not replace harness-owned transcript stores, add a database migration, or promise provider-output scrubbing where the harness exposes no stream boundary"
---

# Cache-Stable Memory Injection

## Contract

The daemon exposes two prompt-context fields on the hook responses:

- `stableSystemPrompt` is the deterministic Signet instruction prefix. It may
  depend on the resolved identity mode and enabled Signet capabilities, but it
  must not contain clocks, peer presence, memory rows, session summaries, or
  other per-turn state. A harness may cache this value for the lifetime of a
  compatible session.
- `dynamicContext` is state-dependent context for the current session or turn.
  It is delivered through the harness' provider-bound context mechanism and is
  never the canonical user message. The existing `inject` field remains a
  compatibility aggregate for legacy clients. It is serialized as the
  versioned `<signet-memory-context>` envelope, and `contextHash` hashes those
  exact returned bytes; `contextVersion` identifies the envelope contract.
  New adapters must prefer the split fields.

When a harness supports an API-only message copy, the adapter uses the clean
user message as the persisted value and composes a separate provider-bound
copy with a `<signet-memory source="api-context">` block. The exact composed
bytes are the replay contract: the adapter must persist or otherwise retain
the composed value when the harness supports sidecar replay, rather than
recomputing context from a later clock or recall result.

## Transcript and delimiter invariants

Canonical user/assistant transcript surfaces contain only user and assistant
content. The normalizer removes complete, orphaned, and unterminated internal
`<signet-memory>`, `<memory-context>`, and `<signet-memory-context>` blocks
before transcript retention or recall-query extraction. Raw harness audit
artifacts may retain the original transport payload for provenance, but they
are not canonical conversation content or recall input.

Dynamic context is escaped before being placed inside an internal fence.
Provider output must pass through the streaming scrubber when the harness
exposes a stream boundary; the scrubber holds delimiter prefixes across
chunks, drops complete and unterminated internal blocks, and never displays a
memory fence or its contents. Harnesses without a stream boundary are marked
degraded rather than pretending that Signet can control provider rendering.

## Lifecycle rules

- A new session delivers the stable prefix once and may deliver the initial
  session dynamic context once.
- Each prompt-submit result is scoped to that turn. A failed or empty recall
  never resurrects an older turn's dynamic context.
- Compression/compaction clears pending turn context and may re-deliver the
  stable prefix; it must not reuse the pre-compaction dynamic context.
- Resume, branch, rewind, and session switch use the new harness session
  identity or reset pending context before the next provider request.
- Session end clears in-memory pending context. A daemon restart may restore a
  session claim, but must not inject the previous session-start aggregate into
  an already-running provider conversation.

## Harness fidelity matrix

| Harness | Stable prefix | Dynamic context | Transcript/stream guarantee |
|---|---|---|---|
| Claude Code | SessionStart hook `additionalContext` | UserPromptSubmit hook `additionalContext` | Hook payload is separate from Signet canonical transcript; provider stream scrubbing is harness-owned/degraded |
| Codex | SessionStart hook `additionalContext` | UserPromptSubmit hook `additionalContext` | Hook payload is separate from Signet canonical transcript; provider stream scrubbing is harness-owned/degraded |
| OpenCode | `experimental.chat.system.transform` | `experimental.chat.messages.transform` on the provider-bound user-message copy | Persisted message is clean; API transform is replay-stable for the active turn |
| OpenClaw | First prompt-build session context | `before_prompt_build`/legacy `before_agent_start` wrapped context | Prompt extraction and compaction/session capture strip internal blocks; provider stream scrubbing is harness-owned/degraded |
| Pi / Oh My Pi | Hidden, excluded session-context message | Hidden pending recall message | Custom Signet messages are excluded from canonical transcript snapshots; stream scrubbing is harness-owned/degraded |
| Hermes Agent | `system_prompt_block()` stable prefix | `prefetch()` dynamic context, consumed by Hermes' API-only context path | Plugin transcript buffer strips internal blocks; Hermes owns sidecar persistence and provider stream scrubbing |
| Gemini / Forge | No full prompt-submit integration | Explicit/manual memory surface only | Not a full contract participant until a provider-bound prompt-submit hook exists |

The matrix is intentionally explicit about degraded modes. A connector must
not claim byte-stable provider replay or visible-output scrubbing unless its
harness actually supplies the corresponding lifecycle or stream boundary.

## Measurement

The deterministic contract evaluation is runnable without a live provider:

```bash
bun scripts/evals/cache-stable-memory-injection.ts
```

It checks replay byte equality, canonical transcript delimiter absence,
split-chunk stream scrubbing, and reports p50/p95 composition latency and
provider-bound character counts. Provider/network latency remains an adapter
benchmark concern and must be measured separately from the pure composition
invariant.
