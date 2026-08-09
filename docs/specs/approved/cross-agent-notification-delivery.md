---
title: "Cross-Agent Notification Delivery"
description: "Deliver durable, agent-scoped peer messages at the next compatible harness hook with explicit acknowledgement."
order: 11
section: "Runtime"
informed_by:
  - "docs/specs/approved/multi-agent-support.md"
success_criteria:
  - "Unread cross-agent messages survive daemon restarts and remain available until explicit recipient acknowledgement or expiry"
  - "Universal and harness-native lifecycle hooks deliver bounded peer notification context without treating peer content as trusted instructions"
  - "Acknowledgement is agent-scoped, idempotent, and available through HTTP, SDK, and MCP"
  - "Agent, session, and broadcast visibility cannot leak messages across recipient scopes"
  - "Notification selection remains below the 250 ms evaluation budget"
scope_boundary: "This spec covers durable local inbox delivery, acknowledgement, bounded hook projection, existing ACP relay status persistence, and supported connector integration. It does not add a native Gemini lifecycle hook, persist ephemeral presence, or imply remote processing before acknowledgement."
---

Cross-Agent Notification Delivery
=================================

## Problem

Signet agents can send cross-agent messages, but an inbox is not useful if the
recipient must remember to poll it. The previous queue was process-local, so a
daemon restart could also erase messages before the recipient saw them.

Delivery and processing are different events. Injecting a message into a model
context does not prove that the recipient acted on it, and must not destroy the
only copy.

## Contract

### Durable inbox

Cross-agent messages are stored in SQLite with:

- a stable message ID;
- sender and optional sender-session identity;
- one local recipient form: agent, active session, or broadcast;
- an immutable session-recipient agent snapshot;
- message type and content;
- local or ACP delivery status;
- creation and seven-day expiry timestamps.

Recipient acknowledgement is stored separately by `(message_id, agent_id)`.
Delivery remains non-destructive: an unread message may appear at multiple
compatible hooks until that recipient explicitly acknowledges it.

Direct sends to an active session capture the owning agent when the message is
created. A session-only target that is not currently active is rejected. Senders
use `toAgentId` for durable offline delivery.

Expired rows are pruned before writes. The live inbox is capped at 10,000 rows.
When full, writes return `429`; unread rows are never silently evicted.

### Visibility and acknowledgement

A recipient can see a message when one of these conditions holds:

1. `to_agent_id` matches its resolved agent scope;
2. the message's captured `to_session_agent_id` matches that scope;
3. the active session key and captured owner match;
4. the message is a broadcast not sent by that recipient, unless sent items are
   explicitly requested.

Acknowledgement repeats the same visibility test and fails closed with `404`
for invisible IDs. Broadcast acknowledgements are per recipient. Repeating the
same acknowledgement is idempotent.

### Hook delivery

`SessionStart` and `UserPromptSubmit` are universal delivery points. Connectors
may also call the notification endpoint at a real harness-native hook:

| Harness | Additional delivery point |
|---------|---------------------------|
| Claude Code | `PreToolUse` |
| Codex | `PreToolUse` |
| OpenCode | `tool.execute.before`, `experimental.chat.system.transform` |
| OpenClaw | `message_received`, `before_tool_call`, then the next prompt-building injection surface |
| Pi | `context` |
| Oh My Pi | `before_agent_start` |
| Hermes Agent | `prefetch`, `sync_turn`, `on_delegation` |
| Gemini CLI | MCP inbox polling fallback because the connector exposes no native lifecycle hook |

The daemon validates harness/hook compatibility. Notification blocks are
bounded by item count and total projected content. Each block preserves stable
message IDs, sender provenance, creation time, total unread count, and a
continuation signal. Peer content is quoted and labeled as untrusted
coordination data.

### Processing acknowledgement

The recipient acknowledges a processed message through one of:

- `POST /api/cross-agent/messages/:messageId/ack`;
- the SDK acknowledgement method;
- MCP tool `agent_message_ack`.

Hook text tells agents to acknowledge only after processing, not merely after
seeing the block.

### ACP relay

An ACP message is committed locally with `queued` status before the remote
request begins. Each ACP row also has a stable attempt identity, bounded retry
count, lease, persisted target, and an explicit `delivery_state`: `pending`,
`in_flight`, `indeterminate`, `delivered`, or `failed`. A relay claims the row
with a lease before making the remote request. Another daemon may reconcile only
an expired lease, so an active relay is not failed by startup recovery.

The stable attempt identity is sent as the HTTP `Idempotency-Key` header. A
successful response updates the row to `delivered`; a definitive non-2xx
response updates it to `failed`. A timeout, transport error, crash, or local
status-write failure leaves or moves the row to `indeterminate` because remote
truth is unknown. Reconciliation never resends automatically. Operators can
inspect the persisted attempt/error and use the bounded retry endpoint. There
are three total attempts: the initial relay and at most two retries. Once that
limit is reached, the row remains explicitly `indeterminate` and the retry
endpoint returns `409` for manual review rather than silently sending more
requests. Retries reuse the same idempotency key and therefore do not silently
create a duplicate when the remote ACP implementation honors that key. If the remote does not
provide idempotency or run lookup, the row remains an explicit indeterminate
outcome rather than pretending delivery is known. Rows created before this
reconciliation migration had no idempotency key on their original request;
those legacy rows require manual review before treating a retry as duplicate-safe.

If local capacity or persistence fails before the durable row is committed, the
remote relay is not attempted.

## Failure behavior

- Hook notification failures do not block the host harness's normal memory
  lifecycle.
- Unsupported harness/hook pairs return `400`.
- Cross-scope reads and acknowledgements return `403` or visibility-safe `404`.
- A daemon restart loses ephemeral presence but not agent-addressed unread
  messages or acknowledgement state.
- Connector caches are bounded and cleared when a successful empty fetch proves
  no notification remains.

## Verification

Required proof:

1. migration creation, idempotency, artifact, and index tests;
2. restart persistence and recipient-isolation tests;
3. explicit acknowledgement and broadcast isolation tests;
4. route, SDK-shape, MCP registration, and connector hook tests;
5. mutation proof showing the connector regression fails without notification
   wiring;
6. deterministic latency evaluation with a 250 ms budget;
7. live daemon send, hook delivery, acknowledgement suppression, restart, and
   re-delivery proof.

## Compatibility and rollback

Migration 115 is additive. Existing presence and SSE contracts remain. Rolling
back the binary leaves the new tables unused; data remains available to a later
compatible version. No destructive down migration is required.
