# Context delivery

## Memory context is ephemeral

Signet memory context is a delivery artifact, not a user turn. Adapters must not write it into the canonical user and assistant transcript.

Why: transcripts are evidence. Injected context in a transcript would be re-ingested as something the user said.

## The clock stays out of the memory hash

`user-prompt-submit` returns `clockContext` separately. It is computed once per request, delivered through the hidden per-turn path, and never added to `inject`, the `<signet-memory-context>` envelope, or `contextHash`.

Why: a clock-only change must not change the memory-context hash, or every turn would look like new context and break provider prompt caching.

Owner: `platform/daemon/src/hooks.ts`.

## Composed bytes are the replay contract

When a harness supports an API-only copy of the user message, the adapter persists the clean message and sends a separate provider-bound copy with a `<signet-memory source="api-context">` block. If the harness supports sidecar replay, the adapter keeps the exact composed bytes. It never recomputes context from a later clock or recall result.

Why: recomputed context changes the prompt prefix, which breaks provider caching and makes replays disagree with what the model actually saw.

Owner: `platform/core/src/memory-context.ts`, the harness plugins under `integrations/`.

## Explicit requests bypass the low-signal gate

Automatic prompt recall skips greetings and acknowledgements and records a `skipped_low_signal` outcome. The gate is conservative so that short identifiers, project names, and terse corrections still get recall. It never applies to explicit recall or remember tools.

Owner: `platform/daemon/src/hooks.ts`.

## The stable prompt describes capability, not tools

The session-start capability prompt does not list tool names, slash commands, identity files, or secret names, and it does not prescribe a recall ritual.

Why: the harness already exposes current tool names and schemas. A second inventory in Signet would drift from the real one.

Owner: `platform/daemon/src/session-start-format.ts`.

## Startup only delivers a current head

Session start delivers generated memory text only from a current, scoped database head. A stale or unavailable head is withheld, and ordinary recall still supplies current evidence. Nothing can retract text already loaded into an active chat, so withholding is the only safe choice.

Owner: `platform/daemon/src/memory-head-owner.ts`.

## Delivery is not processing

Injecting a cross-agent message into a model's context does not prove the recipient acted on it, so delivery never acknowledges or deletes a message. A wake is a delivery attempt and never acknowledges either. Unacknowledged messages keep appearing at compatible hooks until the recipient acknowledges them.

Owner: `platform/daemon/src/cross-agent.ts`, `platform/daemon/src/cross-agent-wake.ts`.

## Harness sub-agent IDs are lineage, not identity

A harness's sub-agent identifier, such as Claude Code's hook `agent_id`, is lineage metadata only. It must never become Signet's persistence `agent_id`.

Why: using it would silently fork user memory into a new scope for every sub-agent.

Owner: `platform/daemon/src/subagent-context.ts`, `surfaces/cli/src/commands/hook.ts`.

## Recovery matches on real paths

Session recovery compares project paths after `realpath()`, so symlinks and aliases neither create false matches nor miss real ones.

Owner: `platform/daemon/src/continuity-state.ts`.
