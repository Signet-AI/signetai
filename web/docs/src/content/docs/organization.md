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

## Invite people

An administrator creates an invitation with `POST /api/org/invites`, choosing a role and optional group IDs. Signet returns a one-use link; it does not send email. Invitations expire after seven days and can be revoked.

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

Keep password login enabled until SSO is working. `requireSso` prevents password sign-in. Changing authentication policy does not revoke existing sessions; use session or device revocation when needed.

## Offboarding and audit

Deactivation is a dry run by default. `POST /api/org/users/:id/deactivate` returns a plan for `keep`, `transfer`, or `purge`; send `dryRun: false` to execute it as a tracked job. Keep retains evidence, transfer moves personal-agent ownership to another active person without rewriting the original authors or speakers, and purge invokes the evidence deletion owners. Pinned evidence can make a purge fail; inspect the job rather than assuming it completed.

Deactivation revokes credentials before returning. The next request from a deactivated user fails, including a previously valid connector request. Reactivation does not restore revoked sessions or keys.

Credential and administrative changes are audited with their transaction. Read events are buffered and flushed every two seconds; the buffer is capped at 10,000 events. Overflow is visible in status and an `audit.dropped` event. Audit queries require `audit`; exports use NDJSON. Administrators can configure audit retention.

## Upgrade an existing team workspace

Claiming does not delete or remap old data. Existing agents are marked `legacy`; administrators can inspect and map them through `/api/org/agents/legacy` and `/api/org/agents/:id/map`.

Existing API keys receive a migration grace period of fourteen days after claim. Inspect them with `/api/org/keys?legacy=1`, assign them to active users, or revoke them before the deadline. Administrators can adjust `legacyKeyDeadline`. Legacy signed tokens do not authenticate after claim; replace them with user sessions or owned API keys.
