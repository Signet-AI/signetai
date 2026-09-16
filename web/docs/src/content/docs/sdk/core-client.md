---
title: "Core client"
description: "The public SignetClient HTTP surface."
---

Construct `SignetClient` with `daemonUrl`, `token`, `actor`, `actorType`, `timeoutMs`, and `retries`. Defaults are the resolved local daemon URL, 10 seconds, and two retries for idempotent requests. Mutations are not retried.

```ts
import { SignetClient } from "@signet/sdk";
const client = new SignetClient({ daemonUrl: "http://localhost:3850", token: process.env.SIGNET_API_KEY });
const saved = await client.remember("The project uses Bun", { type: "fact", mode: "sync" });
const result = await client.recall("package manager", { limit: 5, minScore: 0.5 });
```

`createToken({ role, scope?, ttlSeconds? })` returns `{ token, expiresAt }`.
The daemon's role-to-permission mapping is: `admin` → `remember`, `recall`,
`modify`, `forget`, `recover`, `admin`, `documents`, `connectors`,
`diagnostics`, `analytics`; `operator` → the same except `admin`; `agent` →
`remember`, `recall`, `modify`, `forget`, `recover`, `documents`; and
`readonly` → `recall`. See [Authentication](/auth/#roles-permissions-and-one-time-credentials/)
for scope restrictions and permission narrowing. `scope` may contain
`project`, `agent`, and `user`; matching request targets are required for
scoped non-admin tokens. `whoami()` returns `{ authenticated, claims }`.

```ts
const issued = await client.createToken({ role: "agent", scope: { project: "demo", agent: "writer" }, ttlSeconds: 3600 });
const identity = await client.whoami();
```

## Public groups

- Memory: `remember`, `recall`, `getMemory`, `listMemories`, `modifyMemory`, `forgetMemory`, `batchForget`, `batchModify`, `getHistory`, `recoverMemory`.
- Documents: `createDocument`, `getDocument`, `listDocuments`, `getDocumentChunks`, `deleteDocument`.
- Status/timeline: `health`, `status`, `diagnostics`, `getJob`, `getPipelineStatus`, `getTimeline`, `exportTimeline`, `getFeatures`, `getGreeting`, sessions, and checkpoints.
- Hooks: `sessionStart`, `userPromptSubmit`, `sessionEnd`, `preCompaction`, `compactionComplete`, `hookRemember`, `hookRecall`, `requestSynthesis`.
- Connectors: `listConnectors`, `getConnector`, `createConnector`, `syncConnector`, `resyncAllConnectors`, `fullSyncConnector`, `deleteConnector`, `getConnectorHealth`.

Use exported camelCase options where defined; some batch/document wire fields remain snake_case. `createConnector` uses `settings`. Secret execution returns a job; poll it before reading redacted results. Privileged methods require daemon authorization; the SDK does not elevate callers.
