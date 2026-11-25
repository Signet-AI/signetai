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

Expired access tokens and 401 `expired` responses use `POST /api/auth/refresh` once under the origin lock. Only a 401 or 403 from refresh is an authentication rejection; its original status and reason are preserved. Network, timeout, 5xx, and malformed-response errors remain their own errors, not a fabricated 401. After rotation, the server returns the same rotated pair when the old refresh token is retried until the new pair is first used, for up to 24 hours. This grace period lets a client recover from a crash between rotation and the local write without logging the user out. If the server rotates a pair but local storage fails, `SignetCredentialError` reports `reason: "refresh_in_doubt"`; the same store retains the pair privately and retries persistence before requesting another refresh. It never overwrites a newer stored pair or restores a cleared login. `revoked`, `refresh_reuse`, and `user_deactivated` persist a dead-login marker so subsequent clients fail without repeating refresh. A new `save` clears that marker. The UI should suggest `signet login` for a dead or expired login, not for temporary network failures.

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

Session-end requests get an idempotency key and are durably admitted under `outbox/<origin-hash>/<harness>/` before dispatch. Short locks cover admission and claiming, not the network attempt. A successful acknowledgment removes the entry; 401, network/timeout, and transient server failures retain it. The original failed call still rejects: queued is not delivered. Admission honors the caller’s deadline and cancellation; `SignetOutboxAdmissionError` means no request was sent. Designate additional JSON transcript-upload endpoints with `deliveryPaths: [uploadPath]`; this transport does not upload multipart forms.

Put delivery scope and provenance in the JSON body or captured scope headers. Query parameters and per-call headers other than `Idempotency-Key` or supported scope headers are rejected so replay cannot silently change scope. Explicit idempotency keys contain 1–512 printable non-space ASCII characters.

Outboxes are partitioned by normalized origin and connector registry key: `outbox/<origin-hash>/<harness>/`, with `cli` as the default. Each version-1 record carries its origin, harness, captured scope headers, JSON body, idempotency key, creation time, attempts, and last failure code. Replay uses the current credential but never another origin or harness, and never inherits a replaying transport’s current agent/session/runtime/harness headers. Admission budgets 200 records and 64 MiB, including space reserved for metadata updates. Oldest ready records can be evicted with a persisted counter; claimed and quarantined evidence is not evicted to make room. When those records exhaust the budget, admission fails without deleting them.

Flush is explicit: call it after login or connect, from doctor or an outbox-flush command, or let a successful designated delivery trigger it. Ordinary authenticated requests never inspect the outbox. A lock-free empty check avoids storage writes and ACL helpers for an empty queue. Each entry is claimed by atomic rename under a short lock; no outbox lock is held during credential lookup or network sends. The default replay deadline is five seconds, with capped backoff; `force` bypasses backoff, not the deadline.

Legacy origin-only queues have no reliable registry-harness identity. On explicit outbox work they move to the origin’s shared `.legacy-quarantine`, remain visible in `status().quarantine` as `legacy_unattributed`, and reserve admission capacity; they never replay automatically. After inspecting a record and verifying its harness, call `outbox.recoverLegacy(file, harness)` with the current box’s exact harness. Recovery preserves the original idempotency key, evidence, captured scope, creation time, and attempts, and atomically moves the record without making a second evidence copy. A failed move retains the selected harness so another harness cannot adopt it. Old counters remain quarantined as `legacy_metadata`. Normal `purge()` does not delete shared legacy records; `purge({ includeLegacy: true })` explicitly does. Python provides `recover_legacy(file, harness)` and `purge(include_legacy=True)` with the same semantics.

401 retains the entry. A 403 with `agent_not_permitted`, `agent_binding_conflict`, `actor_conflict`, `project_not_permitted`, or `permission` quarantines it instead of dropping it. Quarantines retain evidence for inspection and explicit purge. Entries quarantine after 20 attempts or seven days, and malformed, unsupported-version, or insecure files quarantine rather than blocking the queue. Other permanent 4xx responses, except 408/429, record a drop. Stale temporary files are reaped while holding the lock. `purge()` scans the directory rather than parsing records, so it also removes corrupt files, claims, quarantines, and counters.

`flush()` returns `OutboxFlushResult`: `{ state: "complete" | "deferred" | "failed", pending, sent, failure, quarantined?, dropped? }`. `failure` contains only a code, status, and reason; `pending: null` means storage could not be inspected, not zero pending work. `status()` reports pending work (including claims), the claimed subset, bytes, eviction/drop counters, quarantine filenames and reasons, and the last nonempty flush result. `countersLost` reports recovered corrupt diagnostic metadata rather than presenting reset counters as complete history. Empty flushes do not rewrite metadata. A completed foreground mutation is not changed into a failure by replay or acknowledgement cleanup. There is no `lastReplayError` side channel.

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
