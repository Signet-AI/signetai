---
title: "Sessions and hooks API"
description: "Session lifecycle, harness hooks, notifications, and cross-agent messaging."
---

[Back to HTTP API](/api/).

| Method | Route | Status | Permission |
|---|---|---|---|
| POST | `/api/hooks/notifications` | canonical | hooks |
| POST | `/api/hooks/session-start` | canonical | hooks |
| POST | `/api/hooks/synthesis/complete` | compatibility; use `/api/synthesis/trigger` | hooks |
| GET/POST/DELETE | `/api/cross-agent/presence` and `:sessionKey` | canonical | cross-agent |
| GET/POST | `/api/cross-agent/messages` | canonical | cross-agent |
| POST | `/api/cross-agent/messages/:messageId/ack` | canonical | cross-agent |
| POST | `/api/cross-agent/messages/:messageId/retry` | canonical | cross-agent |
| GET | `/api/cross-agent/stream` | canonical | cross-agent |
| POST | `/api/synthesis/trigger` | canonical | synthesis |
| GET | `/api/synthesis/status` | canonical | synthesis read |
| POST | `/api/sessions/:key/renew` | canonical | session |

Hook payloads are validated at the route boundary. Cross-agent operations retain
explicit agent/session scope and never broaden to a default identity. The old
synthesis completion hook is a compatibility translation; new clients should
call the canonical trigger route.
