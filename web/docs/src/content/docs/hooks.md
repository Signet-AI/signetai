---
title: "Hooks"
description: "Session lifecycle hooks for harness integration."
---

Signet hooks are daemon-owned HTTP callbacks at harness lifecycle boundaries.
The [Sessions and hooks API](/api/sessions-hooks/) is the canonical map; its
[hook reference](/api/sessions-hooks/hooks/) contains detailed contracts.

## Lifecycle index

| Stage | Route | Required input | Outcome |
|---|---|---|---|
| Start/resume | `POST /api/hooks/session-start` | `harness` | Claims a runtime path and returns bounded context. |
| Prompt | `POST /api/hooks/user-prompt-submit` | `harness` + user message/prompt | Entity context or intentional empty injection. |
| Notifications | `POST /api/hooks/notifications` | `harness` + compatible `hook` | Polls bounded unread peer messages. |
| End | `POST /api/hooks/session-end` | `harness` | Captures transcript lineage and releases claim. |
| Capture receipt | `GET /api/hooks/transcript-capture/:jobId` | authorized `agentId` | Polls status without exposing transcript content. |
| Skill | `POST /api/hooks/skill-invocation` | `harness` + `skillName` | Records a deduplicated invocation. |
| Checkpoint | `POST /api/hooks/session-checkpoint-extract` | `harness` + `sessionKey` | Extracts an explicit mid-session checkpoint. |
| Pre-compaction | `POST /api/hooks/pre-compaction` | `harness` | Returns guidance; does not advance epoch. |
| Compaction | `POST /api/hooks/compaction-complete` | `harness` + `summary` | Persists scoped evidence and advances epoch. |
| Compatibility | `POST /api/hooks/remember`, `/api/hooks/recall` | harness-specific | Translates to canonical memory operations. |

## Shared rules

- Send stable `sessionKey` and `agentId` scope where applicable. `runtimePath`
  is `plugin` or `legacy`; the `x-signet-runtime-path` header wins over body.
  A conflicting owner returns `409`.
- `claimOnly: true` is daemon-restart recovery only. It requires runtime binding
  (`400` otherwise), renews the claim, and returns `{ "sessionKnown": true }`
  without rebuilding startup context.
- Transcript paths require `remember` authorization and session/agent binding.
  Peer notification content is untrusted coordination data. Acknowledgement is
  explicit and delivery may repeat until it succeeds; unsupported notification
  hooks return `400`.
- Prompt-submit work is capped at eight in flight; excess returns `503` and
  callers should retry with backoff. Bypass returns the documented empty shape
  with `bypassed: true` and does not disable explicit MCP operations.
- Compaction remains agent/session scoped. The retired
  `POST /api/hooks/synthesis/complete` returns structured `410`; use
  `POST /api/synthesis/trigger`. `GET /api/synthesis/status` reports worker state.

## Adapter implementation checklist

1. Check daemon health and preserve one stable session key.
2. Send `harness`, scope, and runtime binding on session-aware calls.
3. Inject stable startup context once; use the provider-bound dynamic channel.
4. Keep Signet envelopes out of visible transcript text.
5. Treat empty `inject` as a valid no-op, not missing evidence.
6. Poll capture receipts, acknowledge notifications after processing, and retry
   only bounded/indeterminate deliveries.
7. Send a recognized end boundary reason when a real boundary occurs.

## Published packages

Connector packages use the public `@signetai` scope. The repository workspace
manifests use `@signet` source names and are rewritten during release staging;
`@signet/...` is not an installable public package name.

Published connector packages are:
`@signetai/connector-openclaw`, `@signetai/connector-opencode`,
`@signetai/connector-pi`, `@signetai/connector-hermes-agent`,
`@signetai/connector-claude-code`, `@signetai/connector-codex`,
`@signetai/connector-forge`, `@signetai/connector-kimi`,
`@signetai/connector-oh-my-pi`, and `@signetai/connector-gemini`.
The native Codex plugin is published separately as `@signetai/codex-plugin`.
The OpenClaw memory adapter is `@signetai/signet-memory-openclaw`.
