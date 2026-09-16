---
title: "Telemetry and logs API"
description: "Bounded telemetry, exports, health, and log streams."
---

[Back to HTTP API](/api/).

Telemetry is operational data, not a second source of truth. Authentication, agent scope, permissions, validated filters, pagination, and time/export bounds apply at every route.

| Method | Route | Permission | Use |
|---|---|---|---|
| GET | `/api/telemetry/events` | analytics | Filtered telemetry events. |
| GET | `/api/telemetry/memory-search`, `/api/telemetry/stats` | analytics | Bounded search measurements and aggregates. |
| GET | `/api/telemetry/export`, `/api/telemetry/memory-search/export` | analytics | Permission-checked bounded exports. |
| GET | `/api/telemetry/health` | diagnostics | Operational health/workload state. |
| GET | `/api/logs` | diagnostics | Recent logs with level/category/time filters. |
| GET | `/api/logs/stream` | diagnostics | Bounded live server-log stream. |

Invalid filters or limits are rejected rather than widened. `/health/live` and `/health/ready` remain the process and readiness probes; telemetry health is distinct. See [authentication](/auth/) and [memory telemetry](/api/memory/).
