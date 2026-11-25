---
title: "Helpers, types, and migration"
description: "Use public helpers, types, error contracts, and current SDK version guidance."
---

## Helpers and errors

`SignetClient` includes helpers such as `waitForJob`, `recallOrThrow`, `getMemoryOrThrow`, `getDocumentOrThrow`, `createAndIngestDocument`, and `batchModifyWithProgress`.

```typescript
import { SignetApiError, SignetClient, SignetNetworkError, SignetUnauthorizedError, SignetForbiddenError } from "@signet/sdk";

const client = new SignetClient({ daemonUrl: "http://127.0.0.1:3850" });
try {
  const result = await client.recallOrThrow("deployment preferences", { limit: 5, minScore: 0.5 });
  console.log(result.results);
} catch (error) {
  if (error instanceof SignetUnauthorizedError) console.error("Signet session expired, run `signet login`", error.reason);
  else if (error instanceof SignetForbiddenError) console.error(error.reason, error.required);
  else if (error instanceof SignetApiError) console.error(error.status, error.body);
  else if (error instanceof SignetNetworkError) console.error("Daemon unavailable");
  else throw error;
}
```

Import public response and record types directly from `@signet/sdk` when a function signature needs them. Use the generated declaration files shipped with the installed SDK as the authoritative type reference for the installed version.

## Version guidance

Pin the SDK version you use and read its shipped declarations when upgrading. This transport requires an explicit URL or the node resolver, replaces the raw `token` option with `credentialProvider`, removes actor options, and limits retries to two. Existing client methods remain available with an optional final request-control argument:

```bash
bun add @signet/sdk@latest
```

For migration, replace retired method names with the current client surface documented in this section. In particular, predictor APIs were removed in v0.112 and are deprecated methods that throw instead of working runtime endpoints.
