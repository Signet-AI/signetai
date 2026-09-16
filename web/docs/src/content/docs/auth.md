---
title: "Authentication"
description: "Bootstrap protected access, issue scoped keys, and revoke credentials."
---

Signet supports `local`, `team`, and `hybrid` authentication. Local mode is for a trusted local process. Use team or hybrid mode for remote clients.

## Bootstrap a team deployment

Set the bootstrap password through the secret-safe mechanism used by the service, then configure the daemon:

```yaml
auth:
  mode: team
```

Start or restart the daemon, then log in through the current auth route and keep the returned admin bearer credential in a secret manager. Do not put passwords, bearer tokens, or API keys in `agent.yaml`, shell history, screenshots, or source control.

The normal client variable is `SIGNET_API_KEY`. `SIGNET_TOKEN` is a backwards-compatible alias; new configuration should use `SIGNET_API_KEY`.

## Issue a scoped connector key

Create one named key for each connector and machine:

```bash
signet api-key create --name "work laptop pi" --connector pi --agent-id pi-work-laptop
signet api-key list
```

The raw `sig_sk_...` value is displayed once. Store it securely. `--agent-id` makes the key agent-scoped; requests for another agent fail authorization. Use the connector-specific permission set and minimum scope required by the client.

Clients send the key as a bearer credential. Verify the identity without printing the key:

```bash
curl -fsS http://127.0.0.1:3850/api/auth/whoami \
  -H 'Authorization: Bearer '"$SIGNET_API_KEY"
```

Revoke a retired or exposed key:

```bash
signet api-key revoke <id-or-prefix>
```

## Lifecycle and compatibility

Revoking a key takes effect for subsequent requests. Replacing the daemon signing secret invalidates signed tokens and dashboard sessions; restart the daemon and issue fresh credentials afterward. The SSO and SAML routes are reserved compatibility surfaces and are not configured login providers today.

For remote connectors, continue with [Remote Harness Connectors](/remote-connectors/). For deployment and TLS, see [Self-hosting](/self-hosting/).
