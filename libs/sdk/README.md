# Signet SDK

`@signet/sdk` is a typed HTTP client for the Signet daemon. The core entry runs in browsers, Node, Bun, and embedded plugins without importing Node or the core barrel. `@signet/sdk/node` adds local credential storage, target resolution, refresh, and durable delivery.

## Node and Bun

```typescript
import { createNodeClient, resolveTarget } from "@signet/sdk/node";

const target = await resolveTarget({ harness: "hermes", env: process.env });
const signet = createNodeClient(target);
const result = await signet.recall("deployment preferences", { limit: 5 });
```

`resolveTarget(options?: ResolveTargetOptions): Promise<ResolvedTarget>` resolves once and never switches daemons after an error. Its result is `{ url, origin, remote, credential }`. `credential.source` is `flag`, `env`, `key-file`, `keychain`, `login-file`, or `none`; `credential.get(): Promise<string | null>` reads the current credential without putting its value in client configuration.

- URL: `flagUrl` > `SIGNET_DAEMON_URL` > harness registry URL > supplied `configUrl` (`daemon.url`) > core's `SIGNET_HOST` / `SIGNET_PORT` / loopback default. Core's URL validation and loopback normalization apply.
- Credential: `flagKey` > `SIGNET_API_KEY` > `SIGNET_API_KEY_FILE` > the selected harness's key file, only for the same origin > login credential for the resolved origin > no credential. A missing or unsafe explicit key file fails; it never falls back to another identity.
- `remote` is true for explicit URLs, including explicit loopback URLs, or for non-loopback hosts. Clients must not interpret an unreachable remote as permission to start a local daemon.
- `env` is a snapshot supplied by the caller. Legacy `SIGNET_TOKEN` is not read.

### Protected storage

`ConnectorRegistry({ env? })` exposes `read()`, `set(harness, entry)`, and `remove(harness)`. Entries are `{ url, keyFile?, agentId?, deviceId?, keyId? }`; these metadata fields do not assert identity on requests. `writeKeyFile(origin, harness, secret, { env? })` returns the protected path; `readKeyFile(path)` refuses POSIX files with group/world permissions or a different owner.

Storage lives under `~/.config/signet` (Windows: `%APPDATA%\signet`):

- `connectors.json`
- `keys/<sha256-normalized-origin>/<harness>.key`
- `login/<sha256-normalized-origin>.json` when the keychain is unavailable
- `outbox/<sha256-normalized-origin>/`

Writes use temporary files, fsync, and rename. POSIX files are 0600 and created directories are 0700. Windows writes restrict ACLs. Registry mutation and refresh are serialized across processes with bounded, PID-and-age-checked file locks. Bounded owner-ticket arbitration uses unique generation paths, so stale cleanup never unlinks a replacement live owner’s reusable claim file. TypeScript and Python share this lock protocol. Removing a registry entry does not revoke its server key or delete its key file; the connector owner must perform that cleanup explicitly.

`LoginStore(origin, { env?, keyring? })` exposes `load()`, `save(credential)`, `clear()`, `accessToken(control?)`, and `refresh(rejectedAccessToken?, control?)`. A login credential contains `accessToken`, `refreshToken`, `accessExpiresAt`, and `refreshExpiresAt`. The default keychain uses core's bounded native helper, service `signet-login`, account equal to the normalized origin; `keyring` can supply the same `get`/`set` adapter for an embedding host. The protected fallback is reported as source `login-file`, not `keychain`. When the existing native helper is unavailable in the running runtime, including a Node-only macOS host without its Bun helper, saves use this file; no second keychain implementation is used. `LoginStore.reason` and `target.credential.reason` expose a safe machine-readable diagnostic such as `keyring_unavailable`, persisted with the fallback for doctor consumers. An existing keychain-only credential cannot be recovered without an available keyring adapter.

Expired access tokens and 401 `expired` responses refresh through `POST /api/auth/refresh`. Refresh is never retried automatically. The rotated credential is stored before reuse; concurrent refreshes reread under the same origin lock to avoid reusing the previous refresh token. Other 401 reasons do not refresh. Refresh failure is a `SignetUnauthorizedError` with the server reason when supplied; the original HTTP/network/timeout error remains in `cause`. The outer status is 401 for refresh failure, even when that cause has a different status, so callers retain the login-recovery contract without losing diagnostics; the calling UI should print “Signet session expired, run `signet login`”.

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

The node transport durably admits the JSON request before dispatch and holds the origin lock through its first attempt. It assigns an `Idempotency-Key` before admission, removes the entry after a successful acknowledgment, and retains it on 401, network/timeout, or transient server failure. The original failed call still rejects: queued is not delivered. Admission itself uses the caller’s deadline and cancellation; `SignetOutboxAdmissionError` means no request was sent and no durable admission completed. JSON transcript-upload endpoints can be designated with `NodeTransport(target, { deliveryPaths: [uploadPath] })`; multipart/form-data is not supported by this JSON transport.

Durable delivery scope and provenance belong in the JSON body or captured scope headers; per-call headers other than `Idempotency-Key` or supported scope headers, and delivery query parameters, are rejected rather than silently lost on replay. Explicit idempotency keys must contain 1–512 printable non-space ASCII characters.

The origin-specific outbox holds at most 200 entries and 64 MiB, reserving a small amount of space per entry for failure metadata updates. Oversized single entries are rejected. Oldest entries are evicted with a persisted counter. Entries contain `{ origin, headers, id, idempotencyKey, method, path, body, createdAt, attempts, lastError }`. The JSON body and scope-bearing agent, session, runtime-path, and harness headers are captured before admission. Replay strips the replaying transport’s current scope headers and uses the captured headers, including their absence. Origin-mismatched entries remain pending without dispatch. Credentials are never stored in entries. Replay uses the same resolved target, the current credential, and the original idempotency key.

Replay runs on the next authenticated success or explicit `flush()`, with a five-second default total deadline and capped backoff. `force` bypasses stored backoff, not the deadline. Permanent 4xx responses other than 401/408/429 are dropped with a persisted count and last-drop record. `outbox.status()` reports pending count, bytes, evictions, and drops; `entries()` exposes sanitized failure codes and attempt counts. `purge()` removes queued data and its counters. All processes sharing an origin use the same replay/admission lock. An automatic replay or acknowledgment-cleanup failure cannot turn an already accepted mutation into a failed response: it is exposed separately through `transport.lastReplayError`. Explicit `flush()` rejects on delivery, storage, deadline, or cancellation failures. A completed pass returns `{ pending }`; a nonzero count means stored backoff deferred entries, not completed delivery. `lastReplayError` is cleared only after a pass leaves no pending entries. The Python mirror uses the same result and error contract.

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

Retries are jittered exponential backoff, at most two retries. GET, HEAD, OPTIONS, PUT, and DELETE are eligible; POST is eligible only with a nonempty `Idempotency-Key` header. Network errors and HTTP 408/429/500/502/503/504 can retry. Authentication/authorization failures never enter the generic retry loop. A refresh after a definitive 401 `expired` is a separate, single authentication recovery attempt.

Errors exported from `@signet/sdk`:

- `SignetUnauthorizedError(reason, body?)`: status 401, machine-readable `reason`.
- `SignetForbiddenError(reason, required?, body?)`: status 403, `reason`, optional `required`.
- `SignetApiError(status, body)`: other HTTP failures. Auth errors also extend this class.
- `SignetNetworkError(message, cause)` and `SignetTimeoutError(timeoutMs)`.
- `SignetOutboxAdmissionError(cause)`: designated delivery could not be admitted; the daemon was not contacted.

The existing client methods, React helpers, AI SDK adapter, and OpenAI adapter remain available. The unused regex-generated client and generator are retired; Rust/domain contract generation and connector migration are separate work.

## Hermes Python mirror

`integrations/hermes-agent/connector/hermes-plugin/signet_transport.py` uses only the Python standard library. It implements the same registry, protected key files, JSON outbox layout, origin-bound resolution, typed 401/403 errors, refresh, and JSON transport. Python hosts can inject a keyring adapter; without one it reads/writes the shared protected login fallback. It does not yet replace `client.py`. Python calls accept an absolute millisecond `deadline`, a second-based `timeout`, and a cancellation `threading.Event`; `resolve_target` accepts these controls too and bounds initial keyring lookup in the credential-worker pool. IPv6, internationalized hostnames, numeric IPv4 aliases, percent-encoded hosts, and explicit port zero normalize to shared origin keys. Unsupported raw Unicode format characters require an ASCII/punycode hostname rather than producing a different origin hash. Blocking credential providers and network I/O cross separate admission-limited worker pools (four credential callbacks and eight socket operations). Cancellation interrupts active sockets and prevents a late credential result from starting HTTP. An uncooperative host callback can finish after cancellation, but cannot accumulate unbounded workers or make the transport dispatch a late request.

```bash
python3 -m unittest discover -s integrations/hermes-agent/connector/hermes-plugin -p test_signet_transport.py
```
