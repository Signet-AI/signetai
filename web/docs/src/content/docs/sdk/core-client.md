---
title: "Core client"
description: "Use core memory operations, token auth, and queued secret execution."
---

## Construct a client

For Node and Bun, resolve the target once and read credentials through the node layer:

```typescript
import { createNodeClient, resolveTarget } from "@signet/sdk/node";

const target = await resolveTarget({ harness: "hermes", env: process.env });
const client = createNodeClient(target);
```

URL precedence is `flagUrl`, `SIGNET_DAEMON_URL`, the harness registry entry, supplied `configUrl` (`daemon.url`), then core's host/port default. Credentials come from `flagKey`, `SIGNET_API_KEY`, `SIGNET_API_KEY_FILE`, the matching-origin registry key file, then login for the selected origin. A remote failure never selects another daemon. `target.remote` is also true for explicit loopback URLs; it is not permission to start a local daemon.

For a browser or embedded plugin, supply a URL explicitly:

```typescript
import { SignetClient } from "@signet/sdk";

const client = new SignetClient({
  daemonUrl: window.location.origin,
  cookieAuth: true,
});
```

Cookie mode sends `credentials: "include"` and the current `signet_csrf` cookie as `x-signet-csrf`. Bearer callers instead supply `credentialProvider: async () => currentCredential`. The SDK never sends actor headers. Use `runtimePath` only for non-authoritative provenance. The old `token`, `actor`, and `actorType` options are removed.

Every method accepts an optional final control argument with `signal`, `deadline` (Unix milliseconds), `timeoutMs`, and per-call `headers`. The default total request deadline is ten seconds; polling helpers default to thirty seconds. Cancellation also stops backoff and polling waits.

```typescript
await client.recall("deployment preferences", { limit: 5 }, {
  deadline: Date.now() + 5000,
  signal: controller.signal,
});
```

At most two retries use jittered exponential backoff. GET, HEAD, OPTIONS, PUT, and DELETE are eligible. POST is eligible only with a nonempty `Idempotency-Key` header. Network failures and HTTP 408/429/500/502/503/504 can retry; 401 and 403 never enter this retry loop.

## Login storage and refresh

`ConnectorRegistry({ env? })` reads and atomically updates `~/.config/signet/connectors.json`. Each harness entry contains `{ url, keyFile?, agentId?, deviceId?, keyId? }`. `writeKeyFile(origin, harness, secret, { env? })` writes a protected key and returns its path; `readKeyFile(path)` refuses group/world-readable POSIX files rather than falling back to another credential.

`LoginStore(origin, { env?, keyring? })` provides `load`, `save`, `clear`, `accessToken`, and `refresh`. Credentials contain access and refresh tokens with their expiration timestamps. The OS keychain service is `signet-login`, with the origin as account. When unavailable, the protected fallback is `login/<origin-hash>.json`, reported as credential source `login-file`. `target.credential.reason` and `LoginStore.reason` expose a persisted diagnostic such as `keyring_unavailable` for doctor output. A runtime without the existing native helper uses the file fallback; it does not introduce another keychain backend. POSIX files are 0600 and created directories are 0700. Windows uses `%APPDATA%\signet` and restricted ACLs.

Expired access tokens and 401 `expired` responses use `POST /api/auth/refresh`. The rotated refresh token is persisted before reuse. Cross-process locking prevents concurrent clients from reusing the previous refresh token. Other 401 reasons do not refresh. A refresh failure has outer status 401, retains a supplied server reason, and keeps the original HTTP or network error in `cause`. Display “Signet session expired, run `signet login`” when a login can no longer refresh.

## Durable session-end delivery

```typescript
import { SignetClient } from "@signet/sdk";
import { NodeTransport, resolveTarget } from "@signet/sdk/node";

const transport = new NodeTransport(await resolveTarget({ harness: "hermes" }));
const client = new SignetClient({ transport });
await client.sessionEnd({ sessionKey: "s1", harness: "hermes", reason: "session_shutdown", transcript: "…" });
const replay = await transport.flush({ timeoutMs: 5000, force: true });
const status = await transport.outbox.status();
```

Pass a boundary reason such as `session_shutdown` when closing a session with inline evidence. A turn-end without a boundary reason does not trigger the same transcript capture.

Session-end requests get an idempotency key and are durably admitted under `outbox/<origin-hash>/` before dispatch. The same origin lock covers admission and the first attempt. A successful acknowledgment removes the entry; 401, network/timeout, and transient server failures retain it. The original failed call still rejects: queued is not delivered. Admission honors the caller’s deadline and cancellation; `SignetOutboxAdmissionError` means no request was sent. Designate additional JSON transcript-upload endpoints with `deliveryPaths: [uploadPath]`; this transport does not upload multipart forms.

Put delivery scope and provenance in the JSON body or captured scope headers. Query parameters and per-call headers other than `Idempotency-Key` or supported scope headers are rejected so replay cannot silently change scope. Explicit idempotency keys contain 1–512 printable non-space ASCII characters.

The durable outbox holds 200 entries and 64 MiB at most, including reserved room for metadata updates. It evicts oldest entries with a persisted count and rejects a single oversized entry. Each record contains request data, an idempotency key, attempt count, and sanitized failure code, never a credential. Each entry binds its original origin, JSON body, and scope-bearing headers. Replay uses the captured agent, session, runtime-path, and harness headers rather than the current transport’s fixed headers; foreign-origin entries remain pending without dispatch. Replay uses the same target and the current credential, on the next authenticated success or explicit `flush`. It has a five-second default overall deadline and capped backoff. `force` bypasses stored backoff, not the deadline.

Permanent 4xx responses other than 401/408/429 drop the entry and record the drop. `status()` reports pending count, bytes, evictions, drops, and the last drop; `entries()` includes attempt counts and failure codes. `purge()` deletes the queued data and counters. Registry removal alone does not revoke a server key or remove its key file. If automatic replay or acknowledgment cleanup fails after a daemon mutation succeeds, the completed call still returns its result and `transport.lastReplayError` reports the separate local failure. Explicit `flush()` throws delivery, storage, deadline, and cancellation errors. A completed pass returns `{ pending }`, which can be nonzero when backoff defers entries. `lastReplayError` clears only after a pass leaves no entries pending.

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
