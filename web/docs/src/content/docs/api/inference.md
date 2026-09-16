---
title: "Inference API"
description: "Inference catalog, OAuth, execution, streaming, and cancellation."
---

[Back to HTTP API](/api/).

| Method | Route | Status | Permission |
|---|---|---|---|
| GET | `/api/inference/status` | canonical | inference read |
| GET | `/api/inference/catalog` | canonical | inference read |
| GET | `/api/inference/oauth/providers` | canonical | inference read |
| POST | `/api/inference/oauth/login/:id` | canonical | inference mutate |
| POST | `/api/inference/oauth/complete` | canonical | inference mutate |
| POST | `/api/inference/oauth/disconnect/:id` | canonical | inference mutate |
| GET | `/api/inference/history` | canonical | inference read |
| POST | `/api/inference/explain` | canonical | inference explain |
| POST | `/api/inference/execute` | canonical | inference execute |
| POST | `/api/inference/stream` | canonical | inference execute |
| DELETE | `/api/inference/requests/:id` | canonical | inference execute |
| GET | `/v1/models` | compatibility OpenAI-style surface | inference read |
| POST | `/v1/chat/completions` | compatibility OpenAI-style surface | inference execute |

`catalog` is authoritative for available providers and models. It may include
`recommendedModels`; a recommendation is returned only when that model exists
in the provider's current catalog.

`explain` returns the selected routing decision without executing it. `execute`
performs one request. `stream` returns incremental output. Cancellation is a
`DELETE` for the request id and must be treated as a state transition, not as a
retry signal.

OAuth routes manage the provider login lifecycle. Provider-specific failures
remain explicit; clients must not fall back to a different provider silently.

Request and response fields are defined by the inference route types. Keep
payloads bounded and send JSON. Request size and count limits are enforced by
the route handlers. Authenticated modes may also apply rate limits to inference
operations.
