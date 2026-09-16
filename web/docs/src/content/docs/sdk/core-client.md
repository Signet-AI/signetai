---
title: "Core client"
description: "Use core memory operations, token auth, and queued secret execution."
---

## Construct a client

```typescript
import { SignetClient } from "@signet/sdk";

const client = new SignetClient({
  daemonUrl: "http://localhost:3850",
  token: process.env.SIGNET_TOKEN,
  actor: "my-integration",
  actorType: "service",
});
```

The constructor defaults to `http://localhost:3850`, a 10-second request timeout, and two retries for GET requests. The `retries` option accepts values from 0 through 10. Mutation requests are not retried automatically.

## Memory lifecycle

```typescript
const remembered = await client.remember("The project uses Bun", {
  type: "fact",
  importance: 0.8,
  tags: "tooling,project",
  mode: "sync",
});

const recalled = await client.recall("package manager", {
  limit: 5,
  type: "fact",
  agentId: "my-agent",
  sessionKey: "session-123",
});

await client.modifyMemory(remembered.id, { content: "The project uses Bun for scripts", reason: "Clarified scope" });
```

SDK method names are camelCase. The transport maps established wire aliases where required; pass the TypeScript shape shown above rather than copying raw endpoint field names.

## Token creation

`createToken` calls the admin-protected token endpoint. The daemon accepts the roles `admin`, `operator`, `agent`, and `readonly`.

```typescript
const issued = await client.createToken({
  role: "readonly",
  scope: { project: "my-project", agent: "reporter" },
  ttlSeconds: 3600,
});

const caller = await client.whoami();
```

Keep issued tokens out of source control and logs. `reader` is not a valid role value.

## Secret execution is asynchronous

`execWithSecrets` queues a daemon-owned job. It returns a `SecretExecJob`, not process output. Poll `getSecretExecJob(job.id)` until the job reaches a terminal status, then read its redacted result fields.

```typescript
const job = await client.execWithSecrets("node ./sync.js", {
  API_TOKEN: "SYNC_SERVICE_TOKEN",
});

const status = await client.getSecretExecJob(job.id);
if (status.status === "completed") {
  console.log(status.result?.stdout, status.result?.stderr, status.result?.code);
}
```

Secret values are not returned by `listSecrets`, and execution output is redacted by the daemon. Do not put real tokens in examples or use a queued job as if it had already completed.
