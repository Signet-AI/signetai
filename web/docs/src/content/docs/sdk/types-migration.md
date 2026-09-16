---
title: "Helpers, types, and migration"
description: "Polling, transport errors, typed exports, and migration mappings."
---

`waitForJob` and `waitForDocument` poll until terminal state (defaults: 30s timeout, 500ms interval). `createAndIngestDocument` composes creation and both waits. `recallOrThrow`, `getMemoryOrThrow`, `getDocumentOrThrow`, and `batchModifyWithProgress` are convenience helpers; progress is `{ done, total }`.

`execWithSecrets(command, secrets, options?)` uses positional arguments and
returns a job. Poll `getSecretExecJob(job.id)` until its status is `completed`
or `failed`. `waitForJob` treats `completed`, `done`, `failed`, and `dead` as
terminal; `pending`, `leased`, and `retry_scheduled` are non-terminal.

Scoped examples: `listKnowledgeEntities({ agentId: "writer", type: "person" })`, `listAgentPresence({ agentId: "writer", project: "demo" })`, and `sendAgentMessage({ toAgentId: "reviewer", type: "question", content: "Please review this." })`. These calls require explicit authorization.

`SignetTransport` is exported as a type-only name; it sends JSON, applies auth/actor headers, and retries only idempotent `GET`, `HEAD`, and `OPTIONS`. Failures are `SignetApiError`, `SignetNetworkError`, or `SignetTimeoutError`.

| Retired/compatibility name | Current mapping |
|---|---|
| `SignetSDK`, `Signet` | `SignetClient` |
| `rememberHook`, `recallHook` | `hookRemember`, `hookRecall` |
| `checkConnectorHealth` | `getConnectorHealth` |
| connector `config` | connector `settings` |
| predictor methods | Removed runtime feature; remove calls |

The root export provides `SignetClient`, errors, public response/input types,
and `SignetTransport` as a type. Use declarations built from the workspace as
the complete typed surface; do not substitute `@signet/core` types. The SDK is
pre-1.0 and workspace-only, so review source changes before upgrading.
