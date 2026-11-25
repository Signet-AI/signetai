---
title: "HTTP API"
description: "Signet daemon HTTP API reference."
---

The Signet [Daemon](/daemon/) exposes a REST API on `http://localhost:3850` by default.
All requests and responses use JSON unless otherwise noted. The base URL and
port are configurable via environment variables (see [Configuration](/configuration/)).

> Path note: `$SIGNET_WORKSPACE` means your active Signet workspace path.
> Default is `~/.agents`, configurable via `signet workspace set <path>`.

## Connection

```
Base URL: http://localhost:3850
SIGNET_PORT  — override port (default: 3850)
SIGNET_HOST  — daemon host for local calls (default: 127.0.0.1)
SIGNET_BIND  — bind host override (defaults to the configured network mode:
               127.0.0.1 for localhost mode, 0.0.0.0 for tailscale mode)
```

### Request and response conventions

- JSON is the default request and response format.
- Authenticated modes use `Authorization: Bearer <token>`.
- Most list endpoints accept `limit` and `offset` or a route-specific bounded
  limit. Out-of-range values return `400` or are clamped where noted.
- Errors generally use `{ "error": "human-readable message" }`; route-specific
  errors may include structured fields such as `status`, `code`, or
  `missingCapabilities`.

## Authentication

The daemon supports three [Auth](/auth/) modes, set in `agent.yaml`:

- `local` — no authentication required. All requests are trusted. This is
  the default for single-user local installs.
- `team` — all requests require a `Bearer` token in the `Authorization`
  header.
- `hybrid` — requests from `localhost` are trusted without a token; requests
  from any other origin require a `Bearer` token.

Tokens use Signet's signed bearer-token format with a role, optional scope, and
optional permissions. Dashboard password login uses `POST /api/auth/login` to
exchange the configured admin username/password for an admin session token, and
`POST /api/auth/session` exchanges any valid credential, including an API key,
for a session with the same claims. The dashboard shell, `/api/auth/login`,
`/api/auth/methods`, `/api/auth/whoami`, `/api/auth/handoff/redeem`, and
reserved `/api/auth/sso/*` and `/api/auth/saml/*` provider paths are reachable
without an existing bearer token so users can sign in. Other daemon API routes
remain protected in `team` mode. See [Core configuration](/api/core-configuration/#auth).

### Organization identity API

After a team workspace is claimed, credentials resolve a server-side principal. User deactivation, session revocation, device revocation, and key revocation take effect on the next request. Legacy signed tokens are rejected with `401 legacy_token`. Existing API keys keep their migration grace period; new credentials must have an owned identity or explicit scope.

Browser login and claim responses set `signet_session` and `signet_csrf`. Cookie-authenticated POST, PUT, PATCH, and DELETE requests require `x-signet-csrf`. Device sessions use `sig_ses_` access and `sig_ref_` rotating refresh tokens. Bearer requests do not require CSRF. `whoami` returns organization, user, groups, credential, effective permissions, default read/write agents, providers, and `hybridProxyDetected`; `effectiveAccess` is `open`, `authenticated`, or `none`.

All organization API bodies are JSON. Error responses include `error` and `reason`; missing permissions may also name `required`. `401` responses include `WWW-Authenticate: Bearer`. Invitation, device-start, device-token, refresh, claim, login, methods, and OIDC entry points are open. Other operations require authentication and the authority noted below.

| Method | Path | Body or behavior |
|---|---|---|
| GET | `/api/auth/methods` | Mode, organization claim state, and available password/OIDC providers. |
| GET | `/api/auth/whoami` | Resolved identity and effective access; safe without a credential. |
| POST | `/api/auth/login` | `{ username, password, client?: "browser" }`; returns user, expiry, CSRF, and session cookies. Rate limited. |
| GET | `/api/auth/sso/start` | OIDC authorization redirect; optional invite token. |
| GET | `/api/auth/sso/callback` | PKCE code exchange with one-use state and nonce validation. |
| POST | `/api/auth/logout` | `{ all?: boolean }`; revoke this session or all of your sessions, not connector keys. |
| GET | `/api/auth/sessions` | Your sessions, without token hashes. |
| DELETE | `/api/auth/sessions/:id` | Revoke an owned session; admin may revoke another user's. |
| POST | `/api/auth/device/start` | `{ client: "cli" | "desktop", deviceName, platform? }`; returns device/user codes, verification URLs, 2-second poll interval, 600-second expiry. |
| GET | `/api/auth/device/:userCode` | Signed-in user previews the device requesting approval. |
| POST | `/api/auth/device/approve` | `{ userCode, decision: "approve" | "deny" }`. |
| POST | `/api/auth/device/token` | `{ deviceCode }`; `428 authorization_pending`, `429 slow_down`, `403 denied`, `410 expired`, or access/refresh tokens. |
| POST | `/api/auth/refresh` | `{ refreshToken }`; rotate both tokens. A consumed token retried within 60 seconds returns the same current pair; older reuse revokes the session with `refresh_reuse`. |
| GET | `/api/auth/devices` | Your devices and connector keys. |
| PATCH | `/api/auth/devices/:id` | `{ name }`; owned device only. |
| DELETE | `/api/auth/devices/:id` | Revoke the owned device, its sessions, and its keys. |
| POST | `/api/auth/connector-keys` | User session required. `{ harness, deviceId, agentId? }`; `201 { key, secret }`, secret shown once. |
| GET | `/api/auth/connector-keys` | Your connector keys. |
| DELETE | `/api/auth/connector-keys/:id` | Revoke your key. |
| POST | `/api/auth/api-keys` | `{ name, agentId?, permissions, expiresAt, kind?: "personal" | "shared" }`; shared requires an agent and admin or group ownership. |
| GET | `/api/auth/api-keys` | Your keys; `?all=1` requires admin. |
| DELETE | `/api/auth/api-keys/:id` | Revoke an owned key; admin may revoke any key. |
| POST | `/api/org/claim` | `{ setupToken, organizationName, admin: { username, displayName, email?, password } }`; consumes setup token and creates the first admin/browser session. |
| GET | `/api/auth/invites/:token` | Organization, role, and optional invite email; never exposes password or hash. |
| POST | `/api/auth/invites/accept` | `{ token, username, displayName, password? }`; browser session or `ssoStartPath`. |
| GET | `/api/org/users` | Admin; optional `status`, `role`, `group`, `q`. |
| PATCH | `/api/org/users/:id` | Admin; `{ role?, compliance?, displayName? }`. |
| POST | `/api/org/users/:id/deactivate` | Admin; `{ mode: "keep" | "transfer" | "purge", transferTo?, dryRun?: true }`; plan, or `202 { jobId }` when `dryRun: false`. |
| POST | `/api/org/users/:id/reactivate` | Admin; does not restore revoked credentials. |
| POST | `/api/org/invites` | Admin; `{ email?, role, groupIds }`; one-use `inviteUrl` and expiry. |
| GET | `/api/org/invites` | Admin; invitation metadata, never token hashes. |
| DELETE | `/api/org/invites/:id` | Admin; revoke invitation. |
| GET | `/api/org/groups` | Group directory. |
| POST | `/api/org/groups` | Admin; `{ name, description? }`. |
| GET | `/api/org/groups/:id` | Group and membership. |
| PATCH | `/api/org/groups/:id` | Admin; `{ name?, description? }`. |
| DELETE | `/api/org/groups/:id` | Admin; remove group membership. |
| PUT | `/api/org/groups/:id/members/:userId` | Admin or group owner; `{ role: "owner" | "member" }`. |
| DELETE | `/api/org/groups/:id/members/:userId` | Admin or group owner. Provider-managed groups reject manual edits with `409 managed_by_idp`. |
| GET | `/api/agents` | Adds kind, owner user/group, archive state, and `canActAs`. |
| POST | `/api/agents` | `{ name, kind: "personal" | "team", ownerGroupId? }`; self-service personal policy or team ownership/admin required. |
| PATCH | `/api/agents/:id` | Admin; `{ name?, ownerUserId?, ownerGroupId?, archived? }`. |
| GET | `/api/org/agents/legacy` | Admin; legacy agents awaiting mapping. |
| POST | `/api/org/agents/:id/map` | Admin; `{ kind, ownerUserId?, ownerGroupId? }`. |
| GET | `/api/org/access/:userId` | Admin or compliance; effective roles, groups, act-as agents, and readable classifications. |
| GET | `/api/org/settings` | Admin; organization policy and OIDC configuration, never client-secret values. |
| PATCH | `/api/org/settings` | Admin; name, agent model, self-service, login policy, TTLs, legacy deadline, retention, public URL, OIDC. |
| GET | `/api/org/keys` | Admin; filter by `userId`, `deviceId`, `harness`, `agentId`, `legacy`. |
| POST | `/api/org/keys/revoke` | Admin; `{ ids: [] }`; `202 { jobId }`. |
| PATCH | `/api/org/keys/:id` | Admin; `{ userId }` assigns a legacy key to an active user. |
| GET | `/api/org/audit` | Audit permission; actor/action/target/time filters, cursor, limit; `{ events, nextCursor }`. |
| GET | `/api/org/audit/export` | Audit permission; NDJSON; narrow the time range for large exports. |
| GET | `/api/org/jobs` | Admin; optional `kind`. |
| GET | `/api/org/jobs/:id` | Issuing user or admin; durable progress and terminal status. |

`POST /api/auth/token` and legacy stateless session/handoff exchanges are disabled after claim (`403 org_policy`). OIDC settings accept `clientSecretRef`, a Signet Secrets name, never a secret value. See [Organizations](/organization/) for provisioning, ownership, and migration behavior.

Roles and their permissions:

| Role       | Permissions                                                          |
|------------|----------------------------------------------------------------------|
| `admin`    | all permissions except classify                                                      |
| `operator` | remember, recall, modify, forget, recover, documents, connectors, diagnostics, analytics |
| `member`   | remember, recall, modify, forget, recover, documents |
| `agent`    | remember, recall, modify, forget, recover, documents                 |
| `readonly` | recall only                                                          |

Token scopes (`project`, `agent`, `user`) restrict mutations to records
matching the scope. Admin role bypasses scope checks. Unscoped tokens have
full access within their role.

Rate limits apply in `team` and `hybrid` modes:

| Operation      | Limit       |
|----------------|-------------|
| forget         | 30 / min    |
| modify         | 60 / min    |
| batchForget    | 5 / min     |
| admin actions  | 10 / min    |
| login attempts | 5 / min     |
| inferenceExplain | 120 / min |
| inferenceExecute | 20 / min  |
| inferenceGateway | 30 / min  |
| recallLlm      | 60 / min    |

Errors follow a consistent shape:

```json
{ "error": "human-readable message" }
```

Rate-limit rejections return `429`. Auth failures return `401`. Permission
violations return `403`. Version conflicts and state violations return `409`.
Mutations blocked by the kill switch return `503`.

## Transcript deletion

`DELETE /api/sessions/:key/transcript` removes an owning agent's transcript
without creating a summary. It requires `forget` permission and returns a
resumable `complete` or `pending` receipt with counts and a capture generation.
`?purge=hard` requires `admin` permission instead of `forget`, plus an authenticated
admin role in team and hybrid modes. Optional `generation=N` makes retries fail
with `409` if the capture generation changed. Pinned
memories remain; memories with other evidence are retained for Dreaming
re-evaluation. See [transcript deletion](/api/sessions-hooks/#delete-apisessionskeytranscript)
for identity, live-session bypass, key-reuse, and retry semantics. Resumed keys
drop only an exact replayed prefix, using the deleted generation's record count
and ordered SHA-256 chain. Later identical turns and fresh snapshots that do not
replay that prefix remain eligible. Records dated after the deletion watermark
remain eligible even when they match the deleted prefix. Usable record timestamps
at or before the watermark are still dropped. Receipts retain counts and chain
hashes, not removed content. Starts received during pending cleanup are applied
when it completes.
A failure-only start/end intent outbox retries owner contact; it is not deletion
state and drained files are removed.

For harnesses whose snapshot records carry no timestamp, a lagging stored copy
limits replay protection: records that existed in the harness file but had not
yet been captured when deletion ran are not covered by the fence and can be
captured again by the next generation.

## Reference sections

| Section | Contents |
|---|---|
| [Health and status API](/api/health-status/) | Health, status, and runtime feature endpoints. |
| [Inference API](/api/inference/) | Inference routing, execution, streaming, and OpenAI-compatible gateway endpoints. |
| [Core configuration API](/api/core-configuration/) | Auth, config, and identity endpoints. |
| [Memory API](/api/memory/) | Memory, embedding, recall, and similarity endpoints. |
| [Documents and sources API](/api/documents-sources/) | Document ingestion and source-backed recall endpoints. |
| [Runtime extensions API](/api/runtime-extensions/) | Connector, agent, skill, harness, plugin, and secret endpoints. |
| [Sessions and hooks API](/api/sessions-hooks/) | Harness hook and session lifecycle endpoints. |
| [Operations API](/api/operations/) | Git sync, updates, diagnostics, repair, and pipeline operation endpoints. |
| [Knowledge and ontology API](/api/knowledge-ontology/) | Knowledge navigation, ontology proposal, dreaming, and checkpoint endpoints. |
| [Telemetry and logs API](/api/telemetry-logs/) | Analytics, telemetry, log, and MCP endpoints. |
| [Additional route inventory](/api/route-inventory/) | Support, dashboard, repair, marketplace, and runtime routes not expanded in the main API reference. |

## Maintenance

Route details live in `docs/api/` so the root API page stays readable. When
adding or changing daemon routes, update the matching reference file and run
`bun scripts/doc-drift.ts --markdown`.


## Agent policy

`GET /api/agents/:name` returns the agent's `read_policy`, optional `policy_group`, timestamps, and resolved `effective_scope` (`agent`, `global`, or `group`). `POST /api/agents` and `PATCH /api/agents/:name` accept `isolated`, `shared`, or `group`; `group` requires a group name and the other policies reject one. The daemon validates at the boundary and never falls back to local `agent.yaml` state. `signet agent set` uses PATCH, `signet agent show` uses GET, and `signet agent info` remains a compatibility alias.

## Onboarding

The dashboard modal at `/#setup` uses the existing configuration, inference/OAuth,
Sources, pipeline, and scoped memory APIs. It does not expose a second setup-plan
executor. `GET /api/inference/catalog` includes `recommendedModels`, an optional
provider-to-model-ID map drawn from curated defaults only when the provider's
current catalog contains that model. Absence requires an explicit model choice.

`POST /api/harnesses/:id/disconnect` requires admin permission. It runs the
connector's uninstall method in the same bounded worker used for installation,
then verifies that the integration is no longer installed. It removes Signet's
harness integration, not the harness application or Signet memories. Responses
include `success`, `id`, `action`, and `message`; failures return an error.

`POST /api/harnesses/:id/connect` requires admin permission and accepts
`claude-code`, `codex`, `hermes-agent`, `opencode`, `openclaw`, `gemini`,
`pi`, `oh-my-pi`, `kimi`, `muse-code`, or `forge`. It installs into the daemon host's agent
configuration using the same connector implementation as the CLI, with the
resolved daemon workspace. No request body or arbitrary filesystem path is
accepted. Success returns `{success: true, id}` after connector verification and
worker exit. Unsupported IDs return 400, concurrent installation returns 409,
and failures return 500 with an error. One installation is admitted at a time;
it has a 30-second deadline and a two-second forced-stop grace period. Cancellation
or failure may leave partial integration files; retry the same operation to
reconcile them. OpenClaw preserves its configured runtime path and requires the
existing CLI-managed plugin package for plugin mode; missing packages fail
explicitly before configuration is written.

`GET /api/harnesses` includes `connectors` with independent installation and health
observations. `installed` means the connector found its Signet installation files;
`detected` means only that the harness configuration exists. A workspace connection
record or previous activity does not prove a current installation. The dashboard
lists installed connectors and retains its last known installations while checks
are unavailable. A completed inspection reporting `installed: false` removes the
connector from that list.

`inspectionStatus` is `complete` when inspection returns a result, or `unavailable`
when the inspector cannot complete. Inspection timeouts, cancellation, loader
failures, and thrown probes report health `unknown`, not `unhealthy`. Installation
files alone do not establish runtime health; connectors without a runtime probe
also report `unknown`. The dashboard presents those installations as Installed,
without suggesting repair. Repair and reinitialization controls appear in connector details only for a
completed check reporting a concrete problem. Request failures also preserve the
Home page connection record instead of suggesting setup or repair.

`GET /api/harnesses` also reports each harness's home-directory `exists` state plus
`configuredHarnesses`: the harness ids recorded as connected in the workspace's
agent.yaml, written when a connect (or `signet setup`) succeeds. `configuredHarnesses`
is the Signet-owned connection record; `exists` alone proves only that a harness
is installed on the machine, never that Signet was connected to it. Clients
deciding whether onboarding is still needed must gate on `configuredHarnesses`
(the field is absent on older daemons; treat absence as unknown and fall back
without hiding setup affordances).
