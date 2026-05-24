---
title: "Inference API"
description: "Inference routing, execution, streaming, and OpenAI-compatible gateway endpoints."
order: 12
section: "Reference"
---

# Inference API

Inference routing, execution, streaming, and OpenAI-compatible gateway endpoints.

[Back to HTTP API overview](../API.md).

## Inference

The daemon exposes Signet's inference control plane over both native RPC-style
routes and an OpenAI-compatible gateway. Native inference routes are intended
for first-party harnesses and CLI tooling. The OpenAI-compatible gateway is for
harnesses that can point at a model endpoint but cannot yet send the richer
Signet routing metadata.

### GET /api/inference/status

Requires `diagnostics` permission in authenticated modes.

Returns configured accounts, targets, policies, workload bindings, and the
current runtime snapshot for each route target.

**Response**

```json
{
  "enabled": true,
  "source": "explicit",
  "defaultPolicy": "auto",
  "defaultAgentId": "default",
  "policies": ["auto", "strict-coding"],
  "taskClasses": ["casual_chat", "hard_coding", "hipaa_sensitive"],
  "targetRefs": ["sonnet/default", "gpt/gpt54", "local/gemma4"],
  "workloadBindings": {
    "interactive": "auto",
    "memoryExtraction": "memory-pipeline",
    "sessionSynthesis": "memory-pipeline"
  },
  "runtimeSnapshot": {
    "targets": {
      "sonnet/default": {
        "available": true,
        "health": "healthy",
        "circuitOpen": false,
        "accountState": "ready"
      }
    }
  },
  "concurrency": {
    "active": {
      "execute": 0,
      "nativeStream": 1,
      "gatewayStream": 0,
      "total": 1
    },
    "limits": {
      "execute": 8,
      "nativeStream": 8,
      "gatewayStream": 16,
      "total": 24
    }
  }
}
```

Inference concurrency limits can be tuned with:

- `SIGNET_INFERENCE_MAX_CONCURRENT_EXECUTE`
- `SIGNET_INFERENCE_MAX_CONCURRENT_NATIVE_STREAMS`
- `SIGNET_INFERENCE_MAX_CONCURRENT_GATEWAY_STREAMS`
- `SIGNET_INFERENCE_MAX_CONCURRENT_TOTAL`

### GET /api/inference/history

Requires `diagnostics` permission in authenticated modes.

Returns recent local inference telemetry in a redacted, operator-friendly
shape. The endpoint only returns events when telemetry is enabled.

**Query parameters**

| Parameter  | Type    | Description                                      |
|------------|---------|--------------------------------------------------|
| `limit`    | integer | Max events, default `50`, max `500`              |
| `since`    | string  | ISO timestamp lower bound                        |
| `until`    | string  | ISO timestamp upper bound                        |
| `event`    | string  | One inference event type to include              |
| `failures` | `1`     | Include only failed, cancelled, or fallback rows |

**Response**

```json
{
  "enabled": true,
  "events": [
    {
      "event": "inference.fallback",
      "timestamp": "2026-04-10T18:12:00.000Z",
      "surface": "native",
      "agentId": "rose",
      "operation": "interactive",
      "taskClass": "interactive",
      "policyId": "auto",
      "selectedTarget": "primary/fast",
      "finalTarget": "backup/safe",
      "attemptPath": "primary/fast -> secondary/deep -> backup/safe",
      "failedTargets": "primary/fast,secondary/deep",
      "fallbackCount": 2,
      "errorCode": "RATE_LIMITED"
    }
  ],
  "summary": {
    "total": 1,
    "failures": 1,
    "fallbacks": 1,
    "cancelled": 0
  }
}
```

Inference history excludes raw prompts, response text, credentials, and session
references.

### POST /api/inference/explain

Requires `admin` permission in authenticated modes.

Dry-runs a route decision without executing the request. This is the backend
used by `signet route explain`.

**Request body**

```json
{
  "agentId": "rose",
  "operation": "interactive",
  "taskClass": "hard_coding",
  "privacy": "restricted_remote",
  "promptPreview": "fix this failing bun test",
  "refresh": true
}
```

Boundary guards:

- `explicitTargets` may contain at most 8 entries.
- `expectedInputTokens`, `expectedOutputTokens`, and `latencyBudgetMs` are
  clamped to sane non-negative bounds.
- `promptPreview` is truncated to 4,000 characters.
- Oversized request bodies return `413`.

**Response**

Returns a full `RouteDecision` object, including `trace.candidates[]` with the
ordered scoring and policy gates applied to each target.

### POST /api/inference/execute

Requires `admin` permission in authenticated modes.

Routes and executes a prompt using the Signet inference layer.

**Request body**

```json
{
  "agentId": "miles",
  "operation": "code_reasoning",
  "taskClass": "hard_coding",
  "prompt": "explain why this Rust borrow checker error happens",
  "maxTokens": 1200
}
```

Boundary guards:

- Request bodies over 512 KiB return `413`.
- `prompt` is capped at 200,000 characters.
- `maxTokens` and `timeoutMs` are clamped to sane non-negative bounds.
- `explicitTargets` may contain at most 8 entries.

**Response**

```json
{
  "text": "The borrow error happens because ...",
  "usage": {
    "inputTokens": 322,
    "outputTokens": 471,
    "cacheReadTokens": null,
    "cacheCreationTokens": null,
    "totalCost": null,
    "totalDurationMs": null
  },
  "decision": {
    "policyId": "auto",
    "mode": "automatic",
    "taskClass": "hard_coding",
    "targetRef": "gpt/gpt54"
  },
  "attempts": [
    { "targetRef": "gpt/gpt54", "ok": true, "durationMs": 1840 }
  ]
}
```

### POST /api/inference/stream

Requires `admin` permission in authenticated modes.

Streams a routed inference request over Server-Sent Events for first-party
Signet consumers. The request body matches `POST /api/inference/execute`.

**SSE events**

- `meta` — includes `requestId` and the selected route decision
- `delta` — streamed text chunks
- `done` — final text, usage, and attempt metadata
- `cancelled` — emitted when the stream is cancelled explicitly or by
  disconnect
- `error` — emitted when a provider dies mid-stream, including partial text

The response also includes `x-signet-request-id`, which can be used with the
cancellation endpoint below.

### DELETE /api/inference/requests/:id

Requires `admin` permission in authenticated modes.

Cancels an active native or gateway inference stream by request id.

### GET /v1/models

Requires `admin` permission in authenticated modes.

OpenAI-compatible model listing for the Signet gateway. Returned IDs include:

- `signet:auto`
- `policy:<policy-id>`
- explicit target refs like `gpt/gpt54`

### POST /v1/chat/completions

Requires `admin` permission in authenticated modes.

OpenAI-compatible chat completion endpoint. Signet routes the request before
execution. The request body accepts standard OpenAI-style `model`, `messages`,
and `max_tokens` fields.

Signet-specific routing hints can be provided in headers:

- `x-signet-agent-id`
- `x-signet-task-class`
- `x-signet-privacy-tier`
- `x-signet-operation`
- `x-signet-route-policy`
- `x-signet-explicit-target`

Boundary guards:

- Request bodies over 512 KiB return `413`.
- `messages` may contain at most 128 entries and 200,000 total characters of
  string content.
- Signet routing headers are normalized and invalid hint values return `400`.

When `stream: true`, the gateway returns OpenAI-style SSE chunks and includes
`x-signet-request-id` in the response headers so operators can cancel the
stream through `DELETE /api/inference/requests/:id`.
