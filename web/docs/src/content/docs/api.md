---
title: "HTTP API"
description: "Transport, authentication, and navigation for the Signet daemon HTTP API."
---

The Signet daemon serves a JSON HTTP API at `http://127.0.0.1:3850` by default.
See [Daemon](/daemon/) and [Configuration](/configuration/) for changing the
listener. This page is the transport and authentication overview; endpoint
contracts live in the section indexes below.

## Transport

- Use the daemon base URL and send JSON with `Content-Type: application/json`.
- `GET /health/live` is the liveness probe; `GET /health/ready` reports readiness.
- Errors are JSON, normally `{ "error": "message" }`; validation is `400`,
  authentication is `401`, authorization is `403`, conflicts are `409`, rate
  limits are `429`, and unavailable/disabled operations may return `503`.
- Streaming inference uses `POST /api/inference/stream`; it is the only API
  reference route documented as a streaming response.

## Authentication and permissions

Auth mode is configured in `agent.yaml`:

| Mode | Behavior |
|---|---|
| `local` | Local requests are trusted; no bearer token is required. |
| `team` | API requests require an `Authorization: Bearer ***` header. |
| `hybrid` | Loopback is trusted; non-loopback requests require a bearer token. |

Use `GET /api/auth/methods`, `POST /api/auth/login`, and `GET /api/auth/whoami`
to discover/login/check the active auth configuration. Admin-only token and API
key management is under `/api/auth/token` and `/api/auth/api-keys`.

| Role | Permission boundary |
|---|---|
| `admin` | All registered permissions. |
| `operator` | Operational diagnostics, analytics, connectors, documents, and memory mutations. |
| `agent` | Agent-scoped memory and document operations. |
| `readonly` | Read-only recall access. |

Routes additionally enforce their registered scope and permissions. Treat `401`, `403`, and `503` as authoritative outcomes;
clients must not retry by silently switching identity or using a legacy fallback.

## Reference navigation

| Section | Scope |
|---|---|
| [Health and status API](/api/health-status/) | Health probes, status, features, and mode. |
| [Inference API](/api/inference/) | Catalog, OAuth, explain/execute, streaming, and request cancellation. |
| [Core configuration API](/api/core-configuration/) | Auth, configuration, agents, and identity. |
| [Documents and sources API](/api/documents-sources/) | Source and document ingestion contracts. |
| [Runtime extensions API](/api/runtime-extensions/) | Connectors, harnesses, skills, plugins, and secrets. |
| [Sessions and hooks API](/api/sessions-hooks/) | Sessions, hooks, and cross-agent messaging. |
| [Operations API](/api/operations/) | Pipeline, diagnostics, sync, repair, and maintenance. |
| [Knowledge and ontology API](/api/knowledge-ontology/) | Knowledge navigation, ontology, and dreaming. |
| [Telemetry and logs API](/api/telemetry-logs/) | Telemetry, analytics, logs, and health telemetry. |
| [Memory API](/api/memory/) | Memory-owned endpoints; maintained separately. |

Status labels in child pages mean **canonical** (preferred contract), **alias**
(equivalent current route), **compatibility** (accepted translation), or
**retired** (explicitly rejected, commonly `410`). A route absent from the
current registration and tests is not part of this reference.
