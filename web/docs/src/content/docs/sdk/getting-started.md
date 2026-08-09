---
title: "SDK quickstart"
description: "Install, configure, and make the first typed Signet SDK calls."
---

## Basic Usage

```typescript
import { SignetClient } from "@signet/sdk";

const signet = new SignetClient({ daemonUrl: "http://localhost:3850" });

await signet.remember("User prefers dark mode");
const results = await signet.recall("user preferences");
```

All methods return promises and throw typed errors on failure. The client
is safe to instantiate once and reuse across the lifetime of your process.

## Configuration

`SignetClient` accepts an optional config object:

```typescript
interface SignetClientConfig {
  daemonUrl?: string;    // Default: "http://localhost:3850"
  timeoutMs?: number;    // Per-request timeout in ms. Default: 10000
  retries?: number;      // Retry attempts for GET requests. Default: 2
  token?: string;        // Bearer token for authenticated daemon modes
  actor?: string;        // Sets x-signet-actor header (e.g. agent name)
  actorType?: string;    // Sets x-signet-actor-type header
}
```

`token`, `actor`, and `actorType` are sent as request headers on every
call (see [Auth](/auth/) for token details). Only GET requests are retried;
POST/PATCH/DELETE are not, since they are not idempotent by default. Retry backoff is linear at 500ms
intervals.
