---
title: "Sessions and hooks API"
description: "Canonical map for session lifecycle, hooks, synthesis, and cross-agent routes."
---

[Back to HTTP API](/api/).

Use the child references for normative payloads, responses, authorization, and
lifecycle behavior:

- [Hook endpoints](./sessions-hooks/hooks/) — hook lifecycle, transcript capture,
  notifications, compaction, skill/checkpoint extraction, and synthesis.
- [Session endpoints](./sessions-hooks/sessions/) — listing, status, renewal,
  transcript authorization, replay, search, summaries, expansion, and bypass.

## Canonical route map

| Method | Route | Contract |
|---|---|---|
| `POST` | `/api/hooks/session-start` | Claim or recover a session; bounded startup context; `claimOnly`. |
| `POST` | `/api/hooks/user-prompt-submit` | Entity-scoped prompt context and bounded concurrency. |
| `POST` | `/api/hooks/notifications` | Compatible-hook notification polling and acknowledgement workflow. |
| `POST` | `/api/hooks/session-end` | Transcript capture, lineage, and runtime-claim release. |
| `GET` | `/api/hooks/transcript-capture/:jobId` | Authorized asynchronous capture receipt polling. |
| `POST` | `/api/hooks/skill-invocation` | Record a harness skill invocation. |
| `POST` | `/api/hooks/session-checkpoint-extract` | Process an explicit long-lived-session checkpoint. |
| `POST` | `/api/hooks/remember` | Permissioned memory-write compatibility wrapper. |
| `POST` | `/api/hooks/recall` | Permissioned recall compatibility wrapper. |
| `POST` | `/api/hooks/pre-compaction` | Return compaction guidance without advancing the epoch. |
| `POST` | `/api/hooks/compaction-complete` | Persist compaction evidence and advance the epoch. |
| `GET` | `/api/hooks/synthesis/config` | Legacy synthesis configuration. |
| `POST` | `/api/hooks/synthesis` | Legacy synthesis request compatibility boundary. |
| `POST` | `/api/hooks/synthesis/complete` | Retired; structured `410`, use Dreaming trigger. |
| `POST` | `/api/synthesis/trigger` | Request daemon-owned synthesis. |
| `GET` | `/api/synthesis/status` | Read synthesis worker status. |
| `GET/POST` | `/api/cross-agent/presence` | List or publish scoped peer presence. |
| `DELETE` | `/api/cross-agent/presence/:sessionKey` | Remove scoped peer presence. |
| `GET/POST` | `/api/cross-agent/messages` | List or create scoped messages. |
| `POST` | `/api/cross-agent/messages/:messageId/ack` | Acknowledge a delivered message. |
| `POST` | `/api/cross-agent/messages/:messageId/retry` | Retry an indeterminate ACP delivery. |
| `GET` | `/api/cross-agent/stream` | Scoped SSE presence/message stream. |
| `GET` | `/api/sessions`, `/api/sessions/:key` | Active or retained session status. |
| `POST` | `/api/sessions/:key/renew` | Renew a scoped live claim; `403` for unauthorized agent scope and `404` for a missing or expired claim. |
| `GET` | `/api/sessions/:key/transcript` | Authorized cleaned transcript retrieval. |
| `GET/POST` | `/api/sessions/blackbox`, `/api/sessions/:key/blackbox` | Scoped replay evidence. |
| `POST` | `/api/sessions/search` | Scoped transcript search. |
| `GET` | `/api/sessions/summaries` | Scoped temporal summary listing. |
| `POST` | `/api/sessions/summaries/expand` | Scoped temporal expansion. |
| `POST` | `/api/sessions/:key/bypass` | Per-session bypass toggle. |

All routes resolve agent/session scope at the daemon boundary. The retired
synthesis completion route remains only as an explicit compatibility response;
it must not accept generated content.
