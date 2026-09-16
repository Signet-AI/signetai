---
title: "Telemetry and logs API"
description: "Telemetry, analytics, log, and operational health endpoints."
---

[Back to HTTP API](/api/).

| Method | Route | Status | Permission |
|---|---|---|---|
| GET | `/api/telemetry/memory-search` | canonical | analytics |
| GET | `/api/telemetry/memory-search/export` | canonical | analytics |
| GET | `/api/telemetry/health` | canonical | diagnostics |
| GET | `/api/skills/analytics` | canonical | analytics |
| GET | `/api/mcp/analytics` and `/api/mcp/analytics/:server` | canonical | analytics |

Telemetry endpoints expose operational measurements, not a second source of
truth. Export responses are bounded by route parameters and permissions. Health
telemetry is distinct from `/health/live` and `/health/ready`, which remain the
process and readiness probes.

This page intentionally excludes deleted MCP marketplace, operating-system,
widget, and event-bus route families. Those are not current HTTP API contracts.
