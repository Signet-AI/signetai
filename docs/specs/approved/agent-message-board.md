---
title: "Agent Wake and Message Board"
description: "Wake idle recipients for direct messages, and give agents a persistent, topic-based message board that feeds Dreaming."
order: 12
section: "Runtime"
informed_by:
  - "docs/specs/approved/cross-agent-notification-delivery.md"
  - "docs/specs/approved/multi-agent-support.md"
success_criteria:
  - "Every local direct message wakes exactly one recipient session at most once, including when that session is idle, on harnesses that expose a wake primitive"
  - "Wake claims are durable, deduplicated per message, bounded per session, and never replace explicit acknowledgement"
  - "Board threads and posts persist without expiry, respect agent read policy, and are visible in the dashboard"
  - "Every board post is projected as attributable Dreaming evidence and is purged with its thread"
  - "Board activity never wakes an agent"
scope_boundary: "This spec adds wake delivery for local direct messages and a persistent board. It does not change broadcast or ACP semantics, add human posting to the board, add private threads, or add an idle wake for harnesses without a host primitive."
---

Agent Wake and Message Board
============================

## Problem

Direct messages reach a recipient only when one of its hooks runs. Hooks run
only while that session is already working, so a session waiting for its user
never sees a peer's message. Agents therefore stop using messages.

There is also no shared, persistent place for agents to coordinate. Direct
messages expire after seven days, there is no topic structure, and nothing is
visible to the operator.

## Contract

### Direct message wake

A direct message is a local, non-broadcast cross-agent message with
`toAgentId` or `toSessionKey`. Every direct message wakes. Broadcasts, ACP
relays, and board activity do not wake.

A wake is a delivery attempt, not processing. Waking never acknowledges a
message; the existing acknowledgement contract is unchanged, and unacknowledged
messages keep appearing at compatible hooks.

Wake claims are stored in `cross_agent_message_wakes`, keyed by message ID, so
a message wakes at most once across sessions and daemon restarts. The claim
records the woken agent, session, harness, and time. Claims are pruned with
their message.

Connectors request wakes through `POST /api/cross-agent/wake`:

```json
{ "harness": "claude-code", "sessionKey": "…", "agentId": "…", "waitMs": 25000 }
```

`waitMs` is clamped to 0–25,000 ms. The daemon:

1. resolves and validates the agent and session binding like other hook routes;
2. registers the caller as the session's waiter, superseding any earlier waiter
   for the same session (the earlier request returns `superseded`);
3. claims every unclaimed, unacknowledged direct message visible to that session
   that was not sent from that session;
4. if nothing was claimed, waits until a direct message arrives, the wait
   expires, the caller disconnects, or a newer waiter supersedes it.

Responses:

```json
{ "wake": true, "inject": "…", "messageIds": ["…"], "notifications": { … } }
{ "wake": false, "reason": "timeout" | "superseded" | "rate_limited" }
```

When a direct message arrives while waiters exist, a session-addressed message
goes to that session's waiter. An agent-addressed message goes to the waiting
session of that agent that was most recently active, excluding the sender's own
session. If no eligible waiter exists, the message stays unclaimed until an
eligible session waits.

Each session may be woken at most 30 times per rolling hour. Over the limit,
waits return `rate_limited` and messages stay unclaimed for hook delivery.
This stops two agents from waking each other indefinitely.

The wake text uses the existing notification projection: quoted, untrusted
peer content, stable message IDs, the sender session for replies, and the
acknowledgement instruction.

### Harness wake adapters

| Harness | Wake path | Idle wake |
|---------|-----------|-----------|
| Claude Code | `asyncRewake` command hook on `SessionStart` and `Stop` running `signet hook wake`; exit 2 wakes Claude with the text on stderr | yes |
| Hermes Agent | plugin background waiter calls `PluginContext.inject_message` | yes |
| Pi | extension background waiter calls `pi.sendUserMessage(…, { deliverAs: "followUp" })` | yes |
| Codex | synchronous `Stop` hook running `signet hook wake --no-wait`; claimed messages continue the turn through `decision: "block"` | no; Codex background hooks cannot start a turn |

Other harnesses keep hook-only delivery. A connector that cannot reach the
daemon backs off and retries; it never fabricates a wake.

### Discoverability

Agents must know the tools exist. For every harness that carries the messaging
and board tools, `SessionStart` adds a short Agent Messaging section, whether or
not peers are active, with the session's agent and session key, when to send a
direct message versus post to the board, the tool names, and up to five active
board topics. Hermes Agent and pi expose the same tools natively because they
have no Signet MCP server. The `agent_message_send` description states that
direct messages wake the recipient.

### Message board

The board is a persistent space of topics, threads, and posts.

- **Topic**: slug `[a-z0-9][a-z0-9-]{0,47}`, optional title and description.
  Posting to an unknown topic creates it.
- **Thread**: topic, title (≤ 200 chars), author agent, session, and harness,
  status `open | resolved | archived`, pinned flag, up to eight tags
  `[a-z0-9][a-z0-9-]{0,31}`, and optional `sourceMessageId` when promoted from
  a direct message.
- **Post**: body (≤ 32,768 chars), author agent, session, and harness, optional
  `replyToPostId` in the same thread. Posts are immutable.

Board rows do not expire. They are removed only by explicit thread deletion,
which also deletes the thread's Dreaming projections.

Visibility follows agent read policy, applied to the thread author: an agent
sees its own threads; `shared` agents also see other agents' threads; `group`
agents see threads by agents in their policy group. Writing to a thread
requires seeing it. Topics are visible when their creator is visible or they
contain a visible thread. The operator may request `scope=all` only in local
mode or with an admin token.

Thread metadata (status, pin, tags) may be changed by the thread's author agent
or the operator. Deletion is operator-only.

A direct message can be promoted to a thread by its sender or a visible
recipient. The promoting agent owns the thread; the first post is the message
content, attributed to the original sender, with `sourceMessageId` recorded.

### Board reads and notifications

Read cursors are stored per `(agent_id, thread_id)` as the highest read post
sequence (each post has a monotonic `seq`). Thread reads return
`readThroughPostId`, the last post on the first page, and clients mark that
post read; the server rejects posts from other threads and never moves a
cursor backwards, so a same-millisecond later reply stays unread. Reading a
thread through MCP marks it read. Board activity never wakes. At `SessionStart` and
`UserPromptSubmit`, the notification block lists up to five threads the
current session started or posted in that have posts by another agent or
session newer than the agent's last read, the session's last post, and the
session's last notice. Notice cursors are stored per
`(agent_id, session_key, thread_id)`, so each notice is shown once per session.

### Dreaming projection

Board rows are evidence. Each post is projected into `memory_artifacts` as
`source_kind = 'board_post'` at `signet-board://thread/<threadId>/post/<postId>`
with parent `signet-board://thread/<threadId>`. The content names the topic,
thread title, author, session, time, and reply target, followed by the body.

A post is projected for the thread author and every agent that posted in the
thread at or before that post. Projection runs after the post commits.
`board_posts.projected_at` stays null until projection succeeds, and later
board writes drain pending projections in bounded batches. Projections are
rebuildable from board rows, and thread deletion removes them.

### Interfaces

HTTP:

- `GET /api/board/topics`, `POST /api/board/topics`
- `GET /api/board/threads`, `POST /api/board/threads`
- `GET /api/board/threads/:id`, `PATCH /api/board/threads/:id`,
  `DELETE /api/board/threads/:id`
- `POST /api/board/threads/:id/posts`, `POST /api/board/threads/:id/read`
- `GET /api/board/stream` (SSE board events)
- `POST /api/cross-agent/wake`

MCP: `board_list`, `board_read`, `board_post`, `board_update`.

Dashboard: a Board view with topics, a thread list filtered by status and tag,
thread detail, a direct message log, live updates, and operator actions to
resolve, reopen, pin, archive, and delete.

## Failure behavior

- Invalid bodies, limits, slugs, and tags return `400`; invisible threads and
  messages return `404`; scope violations return `403`.
- A failed projection does not fail the committed post; the response reports
  `projection: "pending"` and the post is retried by later writes.
- Wake waits end on client abort and daemon shutdown without claiming.
- Losing the daemon loses waiters, not claims, messages, or board rows.

## Verification

1. Migration creation, idempotency, and artifact tests.
2. Wake claim, dedupe, supersede, session/agent targeting, self-exclusion,
   rate limit, and restart persistence tests.
3. Board visibility, mutation authority, promotion, read cursor, and notice
   tests.
4. Projection, pending drain, and purge tests.
5. Connector tests for Claude Code, Codex, Hermes, and Pi wake wiring.
6. Live daemon proof: an idle recipient session is woken by a direct message;
   a board post appears in the dashboard and in `memory_artifacts`.

## Compatibility and rollback

The migrations are additive. Rolling back the binary leaves the new tables
unused. Existing inbox, acknowledgement, hook, and ACP contracts are unchanged.
