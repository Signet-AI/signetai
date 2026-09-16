---
title: "Helpers, types, and migration"
description: "Polling, transport errors, typed exports, and migration mappings."
---

`waitForJob` and `waitForDocument` poll until terminal state (defaults: 30s timeout, 500ms interval). `createAndIngestDocument` composes creation and both waits. `recallOrThrow`, `getMemoryOrThrow`, `getDocumentOrThrow`, and `batchModifyWithProgress` are convenience helpers; progress is `{ done, total }`.

`SignetTransport` is exported as a type-only name; applications normally use `SignetClient` rather than constructing transport directly. The transport sends JSON, applies configured auth/actor headers, and retries only idempotent `GET`, `HEAD`, and `OPTIONS`. Failures are `SignetApiError` (`status`, `body`), `SignetNetworkError`, or `SignetTimeoutError`.

| Retired/compatibility name | Current mapping |
|---|---|
| `SignetSDK`, `Signet` | `SignetClient` (deprecated aliases) |
| `rememberHook`, `recallHook` | `hookRemember`, `hookRecall` |
| `checkConnectorHealth` | `getConnectorHealth` |
| connector `config` | connector `settings` |
| predictor methods | Removed runtime feature; remove calls |

The root export provides `SignetClient`, errors, public response/input types, and `SignetTransport` as a type. Use installed declarations as the complete typed surface; do not substitute `@signet/core` types or assume package interchangeability.
