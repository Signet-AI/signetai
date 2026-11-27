---
title: "SDK quickstart"
description: "Resolve a Signet target and make the first typed SDK calls."
---

## Node and Bun

```typescript
import { createNodeClient, resolveTarget } from "@signetai/sdk/node";

const target = await resolveTarget({ harness: "hermes", env: process.env });
const signet = createNodeClient(target);
await signet.remember("The project uses Bun");
const results = await signet.recall("package manager", { limit: 5 });
```

Resolve once, then reuse the client. The node layer reads the connector registry, OS keychain, or protected credential file. It never falls back from an unavailable organization daemon to a local daemon.

## Browser or embedded host

```typescript
import { SignetClient } from "@signetai/sdk";

const signet = new SignetClient({
  daemonUrl: window.location.origin,
  cookieAuth: true,
});
await signet.recall("project context", undefined, {
  deadline: Date.now() + 5000,
  signal: controller.signal,
});
```

A URL is required unless you supply a transport. Browser cookie mode includes cookies and CSRF. A bearer-authenticated host supplies `credentialProvider: async () => currentCredential`, not a raw key in the config object.

All methods return promises, throw typed errors, and accept an optional final control argument. See [Core client](/sdk/core-client/) for precedence, storage, retries, deadlines, login refresh, and durable delivery.
