---
title: "Organizations"
description: "Set up a shared Signet workspace with people, revocable credentials, and owned agents."
---

Organization mode adds individual identities to a daemon running in `team` mode. Each person signs in as themselves. A connector credential belongs to that person and a device; a harness name is not a user or an agent identity.

**Your personal agent is yours to organize. The organization can read it unless it's hidden.** Agents organize work. Classifications control who can read sensitive material; an administrator does not automatically gain access to classified material.

## Claim a new organization

Set `auth.mode: team` in the server workspace's `agent.yaml` and start the daemon. An unclaimed team daemon prints a setup URL and a setup token. Keep the token private. Restarting an unclaimed daemon replaces its setup token.

Submit the token to `POST /api/org/claim` with an organization name and the first administrator:

```json
{
  "setupToken": "the-token-printed-by-your-server",
  "organizationName": "Acme",
  "admin": {
    "username": "alice",
    "displayName": "Alice",
    "email": "alice@example.com",
    "password": "a-unique-password"
  }
}
```

The token is consumed once. Claiming marks the existing `default` agent as the organization agent, creates the administrator's personal agent, and starts a browser session. Existing evidence stays in place.

Use HTTPS for a network-facing server. Set `publicUrl` through `PATCH /api/org/settings` to the externally reachable origin before configuring SSO or distributing device-approval links.

## Classified imports

Choose a classification when creating a transcript import: `POST /api/sources/imports` accepts an optional `classificationId` alongside `files`. Multipart document uploads to `POST /api/sources/import` accept the same optional form field. You must be allowed to apply the classification and read the destination, including its inherited classifications. A denied admission writes no import job or evidence. Project-bound credentials cannot start these imports because the manifest does not establish every record's project.

The job and its labels are committed together, before uploaded evidence can be indexed. Finalizing a transcript upload carries those labels to its source atomically. Imported transcripts, artifacts, and derived rows inherit them when written; there is no public interval followed by background classification. Readers outside the audience do not see staging jobs, filenames, source listings, or exported records.

A duplicate or reimport must have the same labels as the existing destination. Different labels return HTTP 409 with `reason: import_classification_conflict`; Signet never silently merges labels or drops a classification. With the same labels, retrying is idempotent. Use the source's normal deletion operation to purge its imported and derived data.

## Invite people

An administrator creates an invitation with `POST /api/org/invites`, choosing a role and optional group IDs. Signet returns a one-use link; it does not send email. Invitations expire after seven days and can be revoked.

Clients inspect an invitation with `POST /api/auth/invites/lookup` and a JSON `{ token }` body. Do not put the token in an API path.

Password accounts accept through `POST /api/auth/invites/accept`. An SSO-required organization sends invitees to its SSO flow instead. The invitation's email, when specified, must match the verified SSO identity.

## Roles and teams

- **Admin** manages people, policy, agents, credentials, and audit. Admin does not include the `classify` permission.
- **Operator** has operational permissions without organization administration.
- **Member** can remember, recall, modify, forget, recover, and work with documents.
- **Readonly** can recall.
- **Compliance** is an additional flag, not a role. It adds `classify` and `audit`; it does not bypass classification audiences.

Groups are teams. Any member of a group may act through that group's team agent. Group owners may manage membership. When an identity provider manages a group, manual membership changes return `409 managed_by_idp`.

## Agents and attribution

The default agent model is `personal`:

- Reads default to the organization agent.
- Writes default to your personal agent.
- A write addressed to the organization agent is filed in your personal agent instead.
- You may act through your personal agents and the team agents whose groups you belong to.
- Archived agents cannot receive writes.

The `single` agent model stores default writes in the organization agent. Administrators choose the model and whether personal-agent self-service is allowed under organization settings.

Connector keys bind an agent. A different agent in a request body, query, session key, or `x-signet-agent-id` is rejected, not silently substituted. Conflicting request aliases return `400 agent_conflict`. The daemon records the user from the credential, not a submitted author or actor header. The `x-signet-agent-id` response header on memory capture reports the agent actually used.

## Provision a connector

1. Start a CLI or desktop sign-in with `POST /api/auth/device/start`.
2. Open the returned verification URL and approve its user code while signed in.
3. Poll `POST /api/auth/device/token` no more frequently than the returned interval.
4. Use the resulting user session to call `POST /api/auth/connector-keys` with `harness` and `deviceId`, and optionally an agent.
5. Store the returned secret in the client's credential store. It is shown once; never put it in harness configuration, command arguments, or a repository.

Connector keys grant `recall`, `remember`, `documents`, and `modify`, limited by their user's permissions. They expire after 30 days by default. An eligible key renews silently while its issuing CLI or desktop session remains renewable. Signing out does not revoke connector keys. Revoke the connector key or its device to stop capture.

Personal API keys can choose a smaller permission set. Shared-agent keys require an administrator or the owning team's owner. Shared keys must identify their agent.

## SSO

Configure OIDC through organization settings with `issuer`, `clientId`, `allowedDomains`, and optional `scopes`, `groupClaim`, and `groupMap`. Store the client secret in Signet Secrets first, then set `clientSecretRef` to that secret's name. Never put a client secret value in settings.

Register `<publicUrl>/api/auth/sso/callback` with your identity provider. Signet uses PKCE, one-use state, and nonce validation. State expires after ten minutes. It validates the identity token's signature, issuer, audience, and expiry. Joining requires a verified email address in an allowed domain. Accounts are linked by issuer and subject; an existing password account with the same email is not silently linked.

An allowed-domain user can join on first sign-in. Mapped identity-provider groups synchronize during sign-in, including removing stale provider-managed memberships. Manually managed memberships are retained.

Signet rejects disabling password login until an OIDC provider is configured. New password hashes use 600,000 PBKDF2 iterations; existing hashes continue to verify using their stored iteration count.

Keep password login enabled until SSO is working. `requireSso` prevents password sign-in. Changing authentication policy does not revoke existing sessions; use session or device revocation when needed.

## Agents and API keys from the CLI

Against an organization, `signet agent list` shows each agent's owner IDs and `canActAs` result. `signet agent add notes` creates a personal agent without scaffolding local files; `signet agent add payments --team <group-id>` creates a team agent. `signet agent use <name-or-id>` changes your default read agent. Writes still default to your personal agent.

Administrators can rename with `signet agent set <name-or-id> --name <new-name>`, archive with `signet agent remove <name-or-id>`, and transfer with `signet agent transfer <name-or-id> --user <user-id>` or `--team <group-id>`. Transfer changes ownership, not evidence authorship. Local read policies do not apply in organization mode. Organization agent purge is not yet available through the CLI; it refuses without changing local files.

`signet api-key create --name CI` creates a personal key using your permissions and a 30-day expiry. Restrict it with `--permission recall remember`, or set `--expires-at <ISO timestamp>`. `--agent <id>` requests a shared-agent key, which the daemon allows only for administrators or the owning team's owner. `signet api-key list` lists your keys; `--all` requires admin. Revoke by ID with `signet api-key revoke <id>`. The secret is printed once; JSON creation also prints a warning on stderr. List responses never include secrets.

## Organization commands

The CLI resolves its target once: `--url` or `--local`, then `SIGNET_DAEMON_URL` and credentials, then the stored `daemon.url` from login. `--org` requires an organization target. `--local` ignores organization credentials and selects the loopback daemon. Switching targets does not rebind connected harnesses.

Local filesystem and process commands (`start`, `stop`, `install`, `setup`, `migrate-schema`, `migrate-vectors`, `git`, `sync`, and `workspace`) refuse against a remote target. Pass `--local` or run them on the instance host. Existing JSON memory commands use the selected instance and accept a global `--agent` override; omitted agent selection is resolved by the daemon under your identity.

Remote streaming requests use the selected instance and its resolved credential; they never fall back to the local daemon. `signet pause` and `signet resume` (also under `signet daemon`) control the organization's pipeline through authenticated API calls and support `--json`. They require an administrator without agent or project restrictions. Remote operator commands (`logs`, `restart`, `repair`, and `embed`) and portable bundle import/export are not available yet and refuse before touching local files, databases, or processes. Organization imports require an explicit `--agent`.

Administrators can use:

```bash
signet org users list --json
signet org users invite --email bob@example.com --role member --team grp_engineering --json
signet org users role usr_bob readonly
signet org users deactivate usr_bob
signet org users deactivate usr_bob --mode transfer --transfer-to usr_alice --confirm --wait
signet org users reactivate usr_bob
signet org teams list
signet org teams create payments
signet org teams add grp_payments usr_bob --role owner
signet org teams remove grp_payments usr_bob
signet org teams show grp_payments
signet org teams rename grp_payments billing
signet org teams delete grp_payments
signet org access usr_bob --json
signet org jobs job_id --json
signet audit --actor usr_bob --action user.deactivated --since 2026-11-01T00:00:00Z --json
```

Use server IDs for users and teams. Deactivation prints a plan unless `--confirm` is supplied. `--wait` follows the job for up to five minutes; a timeout does not cancel server work. Inspect its job ID before retrying.

`signet classify memory:<id> --agent <agent-id> --as HR --wait` previews readable impact before submitting a classification job. Targets also accept `session:<key>`, `source:<id>`, and `agent:<id>`. `--json` returns the preview, job ID, and terminal job when waiting. Without `--json`, the preview is printed before dispatch. Classification authority and audience visibility are checked by the daemon, not inferred by the CLI.

`signet status` against an organization starts with its name, your identity, default read agent, and credential expiry. `signet dashboard` opens the selected instance through a short-lived one-time handoff in the URL fragment, never a bearer token. The browser exchanges it for cookie authentication. `--non-interactive` refuses browser sign-in and dashboard opening; credential resolution refuses keychain access instead of prompting. Environment credentials and protected credential files remain usable for scripting.

`signet classification list` shows definitions visible to your identity. Compliance users can create a definition with `signet classification create HR --audience group:<group-id> user:<user-id>` and replace its audience with `signet classification audience <classification-id> --audience group:<group-id>`. These commands do not grant the caller classification access automatically.

Agents can use MCP tools `signet_org_access`, `signet_org_audit`, `signet_org_job`, and `signet_classify` (including `preview: true`). They call the same HTTP operations and retain the caller's permissions and scopes; forbidden responses never fall back to local access.

Classification definition reads (`GET /api/classifications` and `GET /api/classifications/:id`) include `audience` and `appliers` arrays with `{ kind, id, displayName }` only when the caller has classification-management authority. Other readers keep the existing definition shape. Classification definitions outside the caller's visibility remain absent from lists and return `404` when requested directly.

## Operator log feeds

Organization log feeds require both `admin` and `diagnostics`, without an agent or project restriction. `GET /api/logs` returns up to 500 recent operational events; `GET /api/logs/stream` uses server-sent events. Both are audited. Remote events contain only timestamp, severity, category, and an explicit redaction notice—not messages, request bodies, credential values, or other log metadata. Local-mode logging is unchanged.

A stream ends after at most 60 seconds or the requested event limit (1–500, default 100). Each user can hold two streams, with 32 streams across the instance. Buffered data is limited to 64 KiB; overflow closes the stream. Cancelling the request or response releases its listener, timer, and capacity. The MCP tool `signet_operator_logs` reads the same bounded snapshot through HTTP authorization.

## Memory review filters

`GET /api/memories` accepts `author` (user ID), `team` (owning team ID), and `classification` (classification ID), together with the existing type, agent, and pagination options. Filters are combined before pagination in the read owner. `stats.total`, `stats.critical`, and `stats.withEmbeddings` describe only matching readable memories, not hidden material. Unknown and unreadable classifications both return no matches. Classified rows include `classifications: [{ id, name }]` only for audience members; unclassified rows and existing local responses do not gain that key. The MCP `memory_list` tool accepts the same filters.

## User lookup for compliance

`GET /api/org/users/lookup?q=<name-or-email>` lets administrators and compliance officers find active people without granting the full user directory. Results contain only `id`, `displayName`, and `email`. Search is literal, case-insensitive, and bounded to 128 characters. Pages default to 20 people with a maximum `limit` of 50; pass the returned `nextCursor` as `cursor` for the next page. Agent- or project-restricted credentials cannot search this organization-wide directory. Queries are audited without recording the search text. `GET /api/org/users` remains admin-only. Agents can use the same operation through `signet_org_user_lookup`.

## Worker pause controls

Administrators without an agent or project restriction can call `POST /api/pipeline/pause` or `POST /api/pipeline/resume` with an empty JSON body. The daemon persists the setting before restarting its pipeline runtime; it survives a daemon restart. Repeating the current setting succeeds with `changed: false`. A failed runtime transition restores the previous configuration and runtime rather than reporting success. Start, completion, and failure events are audited.

## Offboarding and audit

Deactivation is a dry run by default. `POST /api/org/users/:id/deactivate` returns a plan for `keep`, `transfer`, or `purge`; send `dryRun: false` to execute it as a tracked job. Keep retains evidence, transfer moves personal-agent ownership to another active person without rewriting the original authors or speakers, and purge invokes the evidence deletion owners. Purge publishes removed counts only after durable deletion and cleanup complete. Running jobs report their phase; an incomplete job does not claim completed removal counts. Pinned evidence or a derivation beyond the bounded batch can leave a job `incomplete`; inspect its readable residuals instead of assuming it completed.

Offboarding previews use the deletion owner's planner, including copied memories and summary descendants, rather than a separate direct-row count. They include readable impact counts for memories, summaries, transcripts, artifacts, documents, active keys and sessions, and owned agents. The synchronous preview admits at most 1,000 reachable objects; a larger plan fails explicitly with `plan_limit` instead of returning a partial count. `ownedAgents` lists each readable agent and its transfer recipient. Counts respect the requesting administrator's agent, project, and classification scope: content outside an HR audience does not contribute, and no hidden totals are returned. Expired sessions without a valid refresh token do not count as active. Previewing is audited without deactivating the user.

Deactivation revokes credentials before returning. The next request from a deactivated user fails, including a previously valid connector request. Reactivation does not restore revoked sessions or keys.

Credential and administrative changes are audited with their transaction. Read events are buffered and flushed every two seconds; the buffer is capped at 10,000 events. Overflow is visible in status and an `audit.dropped` event. Audit queries require `audit`; exports use NDJSON. Administrators can configure audit retention.

CLI and desktop refresh retries survive a lost response or client crash for up to 24 hours, including daemon restarts. The old refresh token returns the same current pair until that pair is first used. An authenticated request with the new access token, or a refresh with the new refresh token, ends the grace; subsequent reuse revokes the session.

## Request safety and reverse proxies

JSON API mutations require `Content-Type: application/json` when a body is present; other media types return `415 unsupported_media_type`. Empty JSON bodies are accepted. Multipart source uploads (`POST /api/sources/import`), streamed import file uploads (`PUT` and `PATCH /api/sources/imports/:id/files/:id`), and the MCP transport use their own parsers and limits.

Open authentication mutations accept the daemon origin (including the browser-facing origin supplied by a trusted proxy) or `publicUrl`. Local and hybrid deployments also allow the development dashboard origins; team deployments do not. Other origins are rejected. Secure deployments use `__Host-signet_session`, `__Host-signet_csrf`, and `__Host-signet_oidc_state` cookies; HTTP loopback uses the plain names. Cookie-authenticated mutations still require the CSRF header.

Open authentication endpoints are rate-limited by client address. Login allows five attempts per minute per username/client-address pair and 30 per username across clients. Device lookups and approvals also have signed-in limits. Configure `auth.trustedProxies` in `agent.yaml` with the IPs or CIDRs of your controlled proxies (empty by default). A trusted socket peer enables the rightmost untrusted `X-Forwarded-For` hop and forwarded protocol/host; otherwise these headers do not change addressing or origin, so clients share the proxy’s bucket. Require your proxy to replace incoming forwarding headers. Forwarded headers never restore loopback trust in hybrid mode. See [reverse proxy configuration](/auth/#reverse-proxies-and-browser-origins). Pending device flows are capped at 1,000 and expired flows are pruned. OIDC discovery is cached for five minutes.

## Upgrade an existing team workspace

Claiming does not delete or remap old data. Existing agents are marked `legacy`; administrators can inspect and map them through `/api/org/agents/legacy` and `/api/org/agents/:id/map`.

Existing API keys receive a migration grace period of fourteen days after claim. Inspect them with `/api/org/keys?legacy=1`, assign them to active users, or revoke them before the deadline. Administrators can adjust `legacyKeyDeadline`. Legacy signed tokens do not authenticate after claim; replace them with user sessions or owned API keys.
