---
title: "Core client"
description: "The public SignetClient HTTP surface."
---

Construct `SignetClient` with `daemonUrl`, `token`, `actor`, `actorType`, `timeoutMs`, and `retries`. Defaults are the resolved local daemon URL, 10 seconds, and two retries for idempotent requests. Mutations are not retried.

```ts
import { SignetClient } from "@signet/sdk";
const client = new SignetClient({ daemonUrl: "http://localhost:3850", token: process.env.SIGNET_TOKEN });
const saved = await client.remember("The project uses Bun", { type: "fact", mode: "sync" });
const result = await client.recall("package manager", { limit: 5, minScore: 0.5 });
```

## Public groups

- Memory: `remember`, `recall`, `getMemory`, `listMemories`, `modifyMemory`, `forgetMemory`, `batchForget`, `batchModify`, `getHistory`, `recoverMemory`.
- Documents: `createDocument`, `getDocument`, `listDocuments`, `getDocumentChunks`, `deleteDocument`.
- Status/timeline: `health`, `status`, `diagnostics`, `getJob`, `getPipelineStatus`, `getTimeline`, `exportTimeline`, `getFeatures`, `getGreeting`, sessions, and checkpoints.
- Hooks: `sessionStart`, `userPromptSubmit`, `sessionEnd`, `preCompaction`, `compactionComplete`, `hookRemember`, `hookRecall`, `requestSynthesis`.
- Connectors: `listConnectors`, `getConnector`, `createConnector`, `syncConnector`, `resyncAllConnectors`, `fullSyncConnector`, `deleteConnector`, `getConnectorHealth`.

Use exported camelCase TypeScript options where the SDK defines them; some batch/document wire fields remain snake_case. `createConnector` uses `settings`; current providers are `filesystem`, `github-docs`, and `gdrive`. `requestSynthesis` requests a daemon-owned run. Secret execution returns a job; poll it before reading redacted results.

> **Privileged:** `createToken`, secret/provider operations, and configuration-changing methods require daemon authorization. The SDK does not elevate callers.
