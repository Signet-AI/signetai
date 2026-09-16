---
title: "Hooks"
description: "HTTP lifecycle contracts for Signet harness integrations."
---

Signet is a local-first memory and context layer for AI agents. Hooks are daemon-owned HTTP callbacks that run at harness lifecycle boundaries; they are not agent-invoked MCP tools.

## Route index

| Method | Route | Contract |
|---|---|---|
| `POST` | `/api/hooks/session-start` | Claim a session and return stable and dynamic startup context. |
| `POST` | `/api/hooks/user-prompt-submit` | Return entity-scoped context for one prompt. |
| `POST` | `/api/hooks/notifications` | Deliver unread coordination messages without recall side effects. |
| `POST` | `/api/hooks/session-end` | Persist transcript lineage and queue end-of-session work. |
| `GET` | `/api/hooks/transcript-capture/:jobId` | Poll an asynchronous transcript-capture job. |
| `POST` | `/api/hooks/skill-invocation` | Record a harness skill invocation. |
| `POST` | `/api/hooks/session-checkpoint-extract` | Process an explicit session checkpoint. |
| `POST` | `/api/hooks/remember` | Compatibility hook for an explicit memory write. |
| `POST` | `/api/hooks/recall` | Compatibility hook for explicit recall. |
| `POST` | `/api/hooks/pre-compaction` | Return compaction guidance. |
| `POST` | `/api/hooks/compaction-complete` | Persist a first-class compaction artifact. |
| `GET` | `/api/hooks/synthesis/config` | Read legacy synthesis configuration. |
| `POST` | `/api/hooks/synthesis` | Compatibility request for synthesis input. |
| `POST` | `/api/hooks/synthesis/complete` | Retired; returns HTTP 410. |
| `POST` | `/api/synthesis/trigger` | Request daemon-owned Dreaming synthesis. |
| `GET` | `/api/synthesis/status` | Read synthesis worker status. |

Cross-agent coordination has separate routes: `GET /api/cross-agent/presence`, `POST /api/cross-agent/presence`, `DELETE /api/cross-agent/presence/:sessionKey`, `GET /api/cross-agent/messages`, `POST /api/cross-agent/messages`, `POST /api/cross-agent/messages/:messageId/ack`, `POST /api/cross-agent/messages/:messageId/retry`, and `GET /api/cross-agent/stream`.

All hook requests carry `harness`; session-aware requests should also carry `agentId` and `sessionKey`. The daemon resolves identity and scope before reading or writing evidence. Unsupported lifecycle input fails explicitly.

## Session start

`POST /api/hooks/session-start` accepts `harness`, optional `agentId`, `sessionKey`, `context`, `harnessAgentId`, and `parentSessionKey`. A daemon restart can be handled with `claimOnly: true` and an explicit `plugin` or `legacy` runtime path; this renews the claim without rebuilding startup context.

The response separates cache-stable and state-dependent fields:

| Field | Meaning |
|---|---|
| `stableSystemPrompt` | Deterministic Signet capability declaration. |
| `dynamicContext` | Bounded session continuity and current context for a hidden/provider-bound channel. |
| `inject` | Versioned aggregate for compatibility clients. |
| `contextHash` | Hash of the exact serialized `inject` bytes. |
| `contextVersion` | Aggregate contract version. |
| `identity` | Managed identity context when enabled. |
| `recentContext` | Dreaming-owned working-memory projection. |
| `memories` | Bounded identifiable previews, not a claim that omitted rows were delivered. |
| `notifications` | Optional bounded coordination-message block. |

Adapters should prefer `stableSystemPrompt` and `dynamicContext`. Legacy clients may consume `inject`; canonical transcript surfaces remove Signet context envelopes before storing or displaying conversation text.

## Prompt submit

`POST /api/hooks/user-prompt-submit` accepts the harness, prompt, session, project, and agent context. It does not run generic memory recall. It matches known ontology entities and aliases, then injects a compact `Relevant Entity Context` block only when an attribute clears the configured confidence threshold. Low-signal, ambiguous, and unmatched prompts return an empty `inject`; session bookkeeping still runs.

The response may include `clockContext`, which is dynamic prompt metadata. It is not a transcript turn, stored memory, `inject` content, or `contextHash` input.

## Notifications

`POST /api/hooks/notifications` is a lightweight polling boundary. Example request:

```json
{
  "harness": "opencode",
  "hook": "experimental.chat.system.transform",
  "agentId": "reviewer",
  "sessionKey": "session-identifier",
  "project": "/workspace/project"
}
```

The response is `{ "inject": "" }` when there are no unread messages. Otherwise it contains bounded `notifications.items`, stable message IDs, sender metadata, `unreadCount`, and `hasMore`. Peer content is untrusted coordination data, not system or developer instruction. Acknowledge delivered messages with `POST /api/cross-agent/messages/:messageId/ack` or MCP `agent_message_ack`; delivery may repeat until acknowledgement succeeds.

Compatible delivery points are declared by the adapter, not inferred by the daemon. Current examples include Claude Code and Codex `SessionStart`, `UserPromptSubmit`, and `PreToolUse`; Kimi Code `SessionStart`, `UserPromptSubmit`, and `SessionEnd`; OpenCode `chat.message`, `tool.execute.before`, `experimental.chat.system.transform`, and `experimental.chat.messages.transform`; OpenClaw `message_received`, `before_tool_call`, `before_prompt_build`, and `before_agent_start`; pi `context`; Oh My Pi `before_agent_start`; and Hermes Agent `on_turn_start`, `prefetch`, `sync_turn`, and `on_delegation`.

## Session end

`POST /api/hooks/session-end` persists transcript lineage and queues normal end-of-session processing. An optional `reason` identifies a real boundary:

| Reason | Boundary |
|---|---|
| `clear` | Caller discarded the current context. |
| `session.deleted` | OpenCode deleted the session. |
| `session_branch` | Oh My Pi forked the session. |
| `session_fork` | pi forked the session. |
| `session_shutdown` | pi shut down the session. |
| `session_switch` | pi switched sessions. |
| `stale-session-sweep` | Daemon finalized an abandoned retained session. |

Repeated end requests are deduplicated. Unrecognized or ordinary idle calls remain ordinary turn telemetry and still persist the transcript.

## Compaction

`POST /api/hooks/pre-compaction` accepts `harness`, optional `sessionKey` and `sessionContext`, and `messageCount`. It returns `summaryPrompt` and `guidelines` for the harness's compaction model.

`POST /api/hooks/compaction-complete` accepts `harness`, `summary`, `sessionKey`, and optional `project`. It stores the summary as a `session_summary` memory row and a temporal DAG artifact. If transcript lineage is unavailable, `project` is the fallback lineage key. The artifact remains agent-scoped.

## Explicit hook compatibility

`POST /api/hooks/remember` and `POST /api/hooks/recall` are compatibility adapters for clients that cannot use MCP or the canonical memory routes. They translate into the same daemon-owned evidence and recall operations; they do not create a second memory implementation.

`POST /api/hooks/skill-invocation` records a skill invocation. `POST /api/hooks/session-checkpoint-extract` handles an explicit checkpoint; it is not a generic transcript-extraction pipeline. `GET /api/hooks/transcript-capture/:jobId` reports the status of an asynchronous capture job submitted by session lifecycle processing.

## Bypass

Bypass is per session. Set `SIGNET_BYPASS=1` before launching a CLI hook process to exit cleanly without contacting the daemon. Alternatively, call MCP `session_bypass` or the daemon's session bypass control from an authorized client. When enabled, lifecycle hooks return an empty no-op response with `bypassed: true`; other sessions are unaffected and MCP tools remain available.

The bypass boundary applies to automatic startup, prompt, end, compaction, remember, and recall processing. It does not make MCP writes disappear: an explicit MCP operation is still an explicit operation.

## Dreaming and retired synthesis

Dreaming owns manifest-gated publication of the curated `MEMORY.md` head. `POST /api/hooks/synthesis/complete` is retired and returns HTTP 410 with a structured replacement pointing to `POST /api/synthesis/trigger`; it must not receive generated content. `GET /api/hooks/synthesis/config` and `POST /api/hooks/synthesis` remain compatibility boundaries for older clients, not an independent writer.

## Implementing an adapter

1. Check the daemon health endpoint.
2. Send `harness`, `agentId`, and stable `sessionKey` values on every session-aware request.
3. Deliver `stableSystemPrompt` once and dynamic context through the harness's hidden/provider-bound channel when available.
4. Strip Signet context envelopes from visible transcript content.
5. Treat empty `inject` as an intentional no-op, not proof that no evidence exists.
6. Acknowledge notifications after processing them.
7. Send a recognized session-end reason when a real boundary occurs.

Hooks expose only the daemon lifecycle and coordination routes listed above.
