---
title: "Sessions and hooks API"
description: "Session lifecycle, harness hooks, notifications, and cross-agent messaging."
---

[Back to HTTP API](/api/).

| Method | Route | Status | Permission |
|---|---|---|---|
| POST | `/api/hooks/notifications` | canonical | hooks |
| POST | `/api/hooks/session-start` | canonical | hooks |
| POST | `/api/hooks/synthesis/complete` | retired; returns `410`; use Dreaming | hooks |
| GET/POST/DELETE | `/api/cross-agent/presence` and `:sessionKey` | canonical | cross-agent |
| GET/POST | `/api/cross-agent/messages` | canonical | cross-agent |
| POST | `/api/cross-agent/messages/:messageId/ack` | canonical | cross-agent |
| POST | `/api/cross-agent/messages/:messageId/retry` | canonical | cross-agent |
| GET | `/api/cross-agent/stream` | canonical | cross-agent |
| POST | `/api/synthesis/trigger` | canonical | synthesis |
| GET | `/api/synthesis/status` | canonical | synthesis read |
| POST | `/api/sessions/:key/renew` | canonical | session |

Hook payloads are validated at the route boundary. Cross-agent operations carry
agent/session scope. `/api/hooks/synthesis/complete` is retained only as an
explicit retirement response; new clients should use `/api/synthesis/trigger`.
