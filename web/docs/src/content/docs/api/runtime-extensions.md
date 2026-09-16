---
title: "Runtime extensions API"
description: "Extension lifecycle, scope, capabilities, audit, and probes."
---

[Back to HTTP API](/api/).

Runtime extensions are daemon-owned. Registered identifiers—not arbitrary paths—are the install boundary.

| Operation | Route | Contract |
|---|---|---|
| Install/connect | `POST /api/harnesses/:id/connect`, `POST /api/skills/install`, `POST /api/marketplace/mcp/install` | Authorized, bounded, serialized lifecycle work. |
| Register | `POST /api/marketplace/mcp/register` | Validate and register external-server metadata/config. |
| Update | `PATCH /api/plugins/:id`, `PATCH /api/marketplace/mcp/:id` | Explicit fields; scope and policy are revalidated. |
| Disable/uninstall | `PATCH /api/marketplace/mcp/:id`, `DELETE /api/marketplace/mcp/:id` | Disable or remove a routed server. |
| Inspect/resync | `GET /api/connectors`, `/api/harnesses`, `/api/skills`, `/api/plugins`, `/api/marketplace/mcp`; `POST /api/connectors/resync` | Read current state or resync connectors. |

Scope and capability guards fail closed. MCP scope covers harness, channel, and workspace; disabled or out-of-scope servers cannot be called. Policy is read/updated at `/api/marketplace/mcp/policy`. Partial failures are reported explicitly; acceptance does not mean downstream work completed.

`GET /api/mcp/analytics` and `/api/mcp/analytics/:server` expose bounded audit views. Health/capability probes are asynchronous observations with deadlines; they never install, register, or mutate an extension. Distinguish queued, running, ready, disabled, failed, and timed-out states.
