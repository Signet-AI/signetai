# Signet SDK

`@signet/sdk` is a typed HTTP client for the Signet daemon. The core entry runs in browsers, Node, Bun, and embedded plugins without importing Node or the core barrel. `@signet/sdk/node` adds local credential storage, target resolution, refresh, and durable delivery.

## Node and Bun

```typescript
import { createNodeClient, resolveTarget } from "@signet/sdk/node";

const target = await resolveTarget({ harness: "hermes", env: process.env });
const signet = createNodeClient(target);
const result = await signet.recall("deployment preferences", { limit: 5 });
```

`resolveTarget(options?: ResolveTargetOptions): Promise<ResolvedTarget>` resolves once and never switches daemons after an error. Its result is `{ url, origin, harness, remote, credential }`. `credential.source` is `flag`, `env`, `key-file`, `keychain`, `login-file`, or `none`; `credential.get(): Promise<string | null>` reads the current credential without putting its value in client configuration.

- URL: `flagUrl` > `SIGNET_DAEMON_URL` > harness registry URL > supplied `configUrl` (`daemon.url`) > core's `SIGNET_HOST` / `SIGNET_PORT` / loopback default. Core's URL validation and loopback normalization apply.
- Credential: `flagKey` > `SIGNET_API_KEY` > `SIGNET_API_KEY_FILE` > the selected harness's key file, only for the same origin > login credential for the resolved origin > no credential. A missing or unsafe explicit key file fails; it never falls back to another identity.
- `remote` is true for explicit URLs, including explicit loopback URLs, or for non-loopback hosts. Clients must not interpret an unreachable remote as permission to start a local daemon.
- `env` is a snapshot supplied by the caller. Legacy `SIGNET_TOKEN` is not read.

### Protected storage

`ConnectorRegistry({ env? })` exposes `read()`, `set(harness, entry)`, and `remove(harness)`. Entries are `{ url, keyFile?, agentId?, deviceId?, keyId? }`; these metadata fields do not assert identity on requests. `writeKeyFile(origin, harness, secret, { env? })` returns the protected path; `readKeyFile(path)` refuses POSIX files with group/world permissions or a different owner. Key files are opened nonblocking and validated with `fstat` before reading. Symlinks are allowed only when the opened target is a regular, current-user-owned 0600 file; FIFOs and devices are rejected.

Storage lives under `~/.config/signet` (Windows: `%APPDATA%\signet`):

- `connectors.json`
- `keys/<sha256-normalized-origin>/<harness>.key`
- `login/<sha256-normalized-origin>.json` when the keychain is unavailable
- `outbox/<sha256-normalized-origin>/<harness>/`

Credential and evidence writes use temporary files, fsync, and rename. Node’s ephemeral lock and claim-owner markers use atomic publication without a durability barrier; lost markers are recovered through process identity and retained evidence. POSIX files are 0600 and created directories are 0700. Windows ACLs are restricted before writing private data and verified on read. Only verified, unchanged identity/change-time fingerprints are cached; mutations invalidate them. A bounded JSON-lines PowerShell worker is reused while active and expires after a brief idle interval, avoiding repeated process starts during warm delivery. Cross-process locks record the PID and process creation time, cap owner age at two minutes, and remove corrupt participants. TypeScript and Python share this protocol. Removing a registry entry does not revoke the server key or delete its key file.

`LoginStore(origin, { env?, keyring? })` exposes `load()`, `save(credential)`, `clear()`, `accessToken(control?)`, and `refresh(rejectedAccessToken?, control?)`. A login credential contains `accessToken`, `refreshToken`, `accessExpiresAt`, and `refreshExpiresAt`. The default keychain uses core's bounded native helper, service `signet-login`, account equal to the normalized origin; `keyring` can supply the same `get`/`set` adapter for an embedding host. The protected fallback is reported as source `login-file`, not `keychain`. When the existing native helper is unavailable in the running runtime, including a Node-only macOS host without its Bun helper, saves use this file; no second keychain implementation is used. `LoginStore.reason` and `target.credential.reason` expose a safe machine-readable diagnostic such as `keyring_unavailable`, persisted with the fallback for doctor consumers. An existing keychain-only credential cannot be recovered without an available keyring adapter.

Expired access tokens and 401 `expired` responses use `POST /api/auth/refresh` once under the origin lock. Only a 401 or 403 from refresh is an authentication rejection; its original status and reason are preserved. Network, timeout, 5xx, and malformed-response errors remain their own errors, not a fabricated 401. If the server rotates a pair but local storage fails, `SignetCredentialError` reports `reason: "refresh_in_doubt"`; the same store retains the pair privately and retries persistence before requesting another refresh. It never overwrites a newer stored pair or restores a cleared login. `revoked`, `refresh_reuse`, and `user_deactivated` persist a dead-login marker so subsequent clients fail without repeating refresh. A new `save` clears that marker. The UI should suggest `signet login` for a dead or expired login, not for temporary network failures.

### Durable session-end delivery

```typescript
import { SignetClient } from "@signet/sdk";
import { NodeTransport, resolveTarget } from "@signet/sdk/node";

const transport = new NodeTransport(await resolveTarget({ harness: "hermes" }));
const client = new SignetClient({ transport });
await client.sessionEnd({ sessionKey: "session-123", harness: "hermes", reason: "session_shutdown", transcript: "…" });
const replay = await transport.flush({ timeoutMs: 5000, force: true });
const status = await transport.outbox.status();
```

Session-end inline evidence capture requires an explicit boundary reason, such as `session_shutdown`; an ordinary turn-end call is not a session boundary. The SDK preserves the daemon’s existing lifecycle semantics.

The node transport durably admits and claims JSON delivery before dispatch. It assigns an `Idempotency-Key`, removes acknowledged evidence, and retains failed delivery for the same target. Queued is not delivered: the foreground call still rejects. `SignetOutboxAdmissionError` means foreground dispatch was not reached; inspect the outbox before retrying because an interrupted publication can leave recoverable evidence. Additional JSON delivery paths can be designated with `NodeTransport(target, { deliveryPaths: [uploadPath] })`; multipart/form-data is not supported.

Durable delivery scope and provenance belong in the JSON body or captured scope headers; per-call headers other than `Idempotency-Key` or supported scope headers, and delivery query parameters, are rejected rather than silently lost on replay. Explicit idempotency keys must contain 1–512 printable non-space ASCII characters.

Outboxes are partitioned by normalized origin and connector registry key: `outbox/<origin-hash>/<harness>/`, with `cli` as the default. Each version-1 record carries its origin, harness, captured scope headers, JSON body, idempotency key, creation time, attempts, and last failure code. Replay uses the current credential but never another origin or harness, and never inherits a replaying transport’s current agent/session/runtime/harness headers. Admission budgets 200 records and 64 MiB, including space reserved for metadata updates. Oldest ready records can be evicted with a persisted counter; claimed and quarantined evidence is not evicted to make room. When those records exhaust the budget, admission fails without deleting them.

Flush is explicit: call it after login or connect, from doctor or an outbox-flush command, or let a successful designated delivery trigger it. Ordinary authenticated requests never inspect the outbox. A lock-free empty check avoids storage writes and ACL helpers for an empty queue. Each entry is claimed by atomic rename under a short lock; no outbox lock is held during credential lookup or network sends. The default replay deadline is five seconds, with capped backoff; `force` bypasses backoff, not the deadline.

Legacy origin-only queues have no reliable registry-harness identity. On explicit outbox work they move to the origin’s shared `.legacy-quarantine`, remain visible in `status().quarantine` as `legacy_unattributed`, and reserve admission capacity; they never replay automatically. After inspecting a record and verifying its harness, call `outbox.recoverLegacy(file, harness)` with the current box’s exact harness. Recovery preserves the original idempotency key, evidence, captured scope, creation time, and attempts, and atomically moves the record without making a second evidence copy. A failed move retains the selected harness so another harness cannot adopt it. Old counters remain quarantined as `legacy_metadata`. Normal `purge()` does not delete shared legacy records; `purge({ includeLegacy: true })` explicitly does. Python provides `recover_legacy(file, harness)` and `purge(include_legacy=True)` with the same semantics.

401 retains the entry. A 403 with `agent_not_permitted`, `agent_binding_conflict`, `actor_conflict`, `project_not_permitted`, or `permission` quarantines it instead of dropping it. Quarantines retain evidence for inspection and explicit purge. Entries quarantine after 20 attempts or seven days, and malformed, unsupported-version, or insecure files quarantine rather than blocking the queue. Other permanent 4xx responses, except 408/429, record a drop. Stale temporary files are reaped while holding the lock. `purge()` scans the directory rather than parsing records, so it also removes corrupt files, claims, quarantines, and counters.

`flush()` returns `OutboxFlushResult`: `{ state: "complete" | "deferred" | "failed", pending, sent, failure, quarantined?, dropped? }`. `failure` contains only a code, status, and reason; `pending: null` means storage could not be inspected, not zero pending work. `status()` reports pending work (including claims), the claimed subset, bytes, eviction/drop counters, quarantine filenames and reasons, and the last nonempty flush result. `countersLost` reports recovered corrupt diagnostic metadata rather than presenting reset counters as complete history. Empty flushes do not rewrite metadata. A completed foreground mutation is not changed into a failure by replay or acknowledgement cleanup. There is no `lastReplayError` side channel.

## Browser-safe core

```typescript
import { SignetClient } from "@signet/sdk";

const signet = new SignetClient({
  daemonUrl: window.location.origin,
  cookieAuth: true,
});
await signet.recall("project context", undefined, {
  deadline: Date.now() + 5000,
  signal: controller.signal,
});
```

`daemonUrl` is required unless a transport is supplied. Browser cookie mode sends `credentials: "include"` and reads the current `signet_csrf` cookie into `x-signet-csrf`. A server-side or plugin caller can instead pass `credentialProvider: async () => currentCredential`; do not place a raw key in a client options object. `token`, `actor`, and `actorType` options are removed. `runtimePath` remains non-authoritative provenance. Actor headers are stripped even when supplied to the raw transport.

Every client method accepts an optional final `RequestControl`: `{ signal?, deadline?, timeoutMs?, headers? }`. `deadline` is an absolute Unix timestamp in milliseconds. The ten-second default deadline covers credential lookup, request/body reads, retries, and backoff; polling helpers have a thirty-second default overall limit. Earlier caller deadlines always win.

`SignetTransport({ baseUrl, credentialProvider?, cookieAuth?, timeoutMs?, retries?, retryDelayMs?, headers? })` exposes `request<T>(method, path, options?)`, `get<T>(path, query?, control?)`, `post<T>(path, body?, control?)`, `put<T>(path, body?, control?)`, `patch<T>(path, body?, control?)`, and `del<T>(path, query?, control?)`. Request paths must stay on the configured daemon; redirects are rejected.

Retries are jittered exponential backoff, at most two retries. GET, HEAD, OPTIONS, PUT, and DELETE are eligible; POST is eligible only with a nonempty `Idempotency-Key` header. Network errors and HTTP 408/429/500/502/503/504 can retry. Authentication/authorization failures never enter the generic retry loop. A refresh after a definitive 401 `expired` is a separate, single authentication recovery attempt. Credential-provider failures are terminal and never enter the HTTP retry loop.

Errors exported from `@signet/sdk`:

- `SignetUnauthorizedError(reason, body?)`: status 401, machine-readable `reason`.
- `SignetForbiddenError(reason, required?, body?)`: status 403, `reason`, optional `required`.
- `SignetApiError(status, body)`: other HTTP failures. Auth errors also extend this class.
- `SignetNetworkError(message, cause)` and `SignetTimeoutError(timeoutMs)`.
- `SignetOutboxAdmissionError(cause)`: foreground durable admission or claim did not complete. Inspect the outbox before retrying.
- `SignetCredentialError(cause, reason?)`: terminal credential-provider failure; `refresh_in_doubt` distinguishes a received rotation that could not yet be persisted.

The existing client methods, React helpers, AI SDK adapter, and OpenAI adapter remain available. The unused regex-generated client and generator are retired; Rust/domain contract generation and connector migration are separate work.

## Hermes Python mirror

`integrations/hermes-agent/connector/hermes-plugin/signet_transport.py` uses only the Python standard library. It implements the same registry, protected key files, JSON outbox layout, origin-bound resolution, typed 401/403 errors, refresh, and JSON transport. Python has no built-in OS-keychain integration. It reads key files and the shared 0600 login file, reporting `python_file_store`, not `keyring_unavailable`. A host can explicitly inject an adapter; no OS keychain is queried by default. It does not yet replace `client.py`. Python calls accept an absolute millisecond `deadline`, a second-based `timeout`, and a cancellation `threading.Event`; `resolve_target` accepts these controls too and bounds initial keyring lookup in the credential-worker pool. IPv6, internationalized hostnames, numeric IPv4 aliases, percent-encoded hosts, and explicit port zero normalize to shared origin keys. Unsupported raw Unicode format characters require an ASCII/punycode hostname rather than producing a different origin hash. Blocking credential providers and network I/O cross separate admission-limited worker pools (four credential callbacks and eight socket operations). Cancellation interrupts active sockets and prevents a late credential result from starting HTTP. An uncooperative host callback can finish after cancellation, but cannot accumulate unbounded workers or make the transport dispatch a late request.

```bash
python3 -m unittest discover -s integrations/hermes-agent/connector/hermes-plugin -p test_signet_transport.py
```
