---
title: "Health and status API"
description: "Daemon health, readiness, status, feature, and mode endpoints."
---

[Back to HTTP API](/api/).

## GET /health

**Canonical.** Returns daemon health, version, database/owner state, and
capability information. This is a diagnostic health document, not a liveness
probe.

## GET /health/live

**Canonical.** Cheap process liveness response. It reports process/runtime
fields but does not prove that the workspace, database, or other dependencies
are ready.

## GET /health/ready

**Canonical.** Reports structured readiness. It is degraded when the workspace,
database owner, database integrity, embedding provider, or required inference
path is unavailable; the response includes check details and reasons. Clients
and orchestrators should use this endpoint for readiness gates.

## GET /api/status

**Canonical.** Returns current pipeline and workspace status.

## GET /api/features

**Canonical.** Returns the runtime feature/capability map. Clients should
feature-detect here rather than infer support from version strings.

## GET /api/mode

**Canonical.** Returns the configured runtime/network mode. It does not grant
access or replace authentication.

Responses are JSON. `/health/live` is the cheap process probe and returns 200
without touching the database or other subsystems. `/health` is diagnostic and
includes workspace, database/owner, integrity, event-loop, resource, and update
state. Route response types remain the schema authority.
