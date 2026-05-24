---
title: "HTTP API"
description: "Signet daemon HTTP API reference."
order: 10
section: "Reference"
---

# Signet Daemon HTTP API

The Signet [[daemon]] exposes a REST API on `http://localhost:3850` by default.
All requests and responses use JSON unless otherwise noted. The base URL and
port are configurable via environment variables (see [[configuration]]).

> Path note: `$SIGNET_WORKSPACE` means your active Signet workspace path.
> Default is `~/.agents`, configurable via `signet workspace set <path>`.

## Connection

```
Base URL: http://localhost:3850
SIGNET_PORT  — override port (default: 3850)
SIGNET_HOST  — daemon host for local calls (default: 127.0.0.1)
SIGNET_BIND  — bind host override (defaults to the configured network mode:
               127.0.0.1 for localhost mode, 0.0.0.0 for tailscale mode)
```

### Request and response conventions

- JSON is the default request and response format.
- Authenticated modes use `Authorization: Bearer <token>`.
- Most list endpoints accept `limit` and `offset` or a route-specific bounded
  limit. Out-of-range values return `400` or are clamped where noted.
- Errors generally use `{ "error": "human-readable message" }`; route-specific
  errors may include structured fields such as `status`, `code`, or
  `missingCapabilities`.

## Authentication

The daemon supports three [[auth]] modes, set in `agent.yaml`:

- `local` — no authentication required. All requests are trusted. This is
  the default for single-user local installs.
- `team` — all requests require a `Bearer` token in the `Authorization`
  header.
- `hybrid` — requests from `localhost` are trusted without a token; requests
  from any other origin require a `Bearer` token.

Tokens are signed JWTs with a role and optional scope. Roles and their
permissions:

| Role       | Permissions                                                          |
|------------|----------------------------------------------------------------------|
| `admin`    | all permissions                                                      |
| `operator` | remember, recall, modify, forget, recover, documents, connectors, diagnostics, analytics |
| `agent`    | remember, recall, modify, forget, recover, documents                 |
| `readonly` | recall only                                                          |

Token scopes (`project`, `agent`, `user`) restrict mutations to records
matching the scope. Admin role bypasses scope checks. Unscoped tokens have
full access within their role.

Rate limits apply in `team` and `hybrid` modes:

| Operation      | Limit       |
|----------------|-------------|
| forget         | 30 / min    |
| modify         | 60 / min    |
| batchForget    | 5 / min     |
| admin actions  | 10 / min    |
| inferenceExplain | 120 / min |
| inferenceExecute | 20 / min  |
| inferenceGateway | 30 / min  |
| recallLlm      | 60 / min    |

Errors follow a consistent shape:

```json
{ "error": "human-readable message" }
```

Rate-limit rejections return `429`. Auth failures return `401`. Permission
violations return `403`. Version conflicts and state violations return `409`.
Mutations blocked by the kill switch return `503`.

## Reference sections

| Section | Contents |
|---|---|
| [Health and status API](./api/health-status.md) | Health, status, and runtime feature endpoints. |
| [Inference API](./api/inference.md) | Inference routing, execution, streaming, and OpenAI-compatible gateway endpoints. |
| [Core configuration API](./api/core-configuration.md) | Auth, config, and identity endpoints. |
| [Memory API](./api/memory.md) | Memory, embedding, recall, and similarity endpoints. |
| [Documents and sources API](./api/documents-sources.md) | Document ingestion and source-backed recall endpoints. |
| [Runtime extensions API](./api/runtime-extensions.md) | Connector, agent, skill, harness, plugin, and secret endpoints. |
| [Sessions and hooks API](./api/sessions-hooks.md) | Harness hook and session lifecycle endpoints. |
| [Operations API](./api/operations.md) | Git sync, updates, diagnostics, repair, and pipeline operation endpoints. |
| [Knowledge and ontology API](./api/knowledge-ontology.md) | Knowledge navigation, ontology proposal, dreaming, and checkpoint endpoints. |
| [Telemetry and logs API](./api/telemetry-logs.md) | Analytics, telemetry, log, MCP, and scheduled task endpoints. |
| [Additional route inventory](./api/route-inventory.md) | Support, dashboard, repair, marketplace, and runtime routes not expanded in the main API reference. |

## Maintenance

Route details live in `docs/api/` so the root API page stays readable. When
adding or changing daemon routes, update the matching reference file and run
`bun scripts/doc-drift.ts --markdown`.
