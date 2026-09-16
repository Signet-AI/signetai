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

**Canonical.** Minimal process liveness response. It does not prove that the
workspace or database is ready.

## GET /health/ready

**Canonical.** Reports whether the daemon can serve requests. Clients and
orchestrators should use this endpoint for readiness gates.

## GET /api/status

**Canonical.** Returns current pipeline and workspace status.

## GET /api/features

**Canonical.** Returns the runtime feature/capability map. Clients should
feature-detect here rather than infer support from version strings.

## GET /api/mode

**Canonical.** Returns the configured runtime/network mode. It does not grant
access or replace authentication.

Responses are JSON. Route-specific fields are intentionally summarized rather
than duplicated here; treat the registered response types and `features` map as
the schema authority.
