---
title: "Remote Harness Connectors"
description: "Install, verify, rotate, and retire remote Signet connectors."
---

A remote connector sends harness requests to a Signet daemon. The daemon owns the workspace; the remote machine needs a connector package, a daemon URL, and a scoped API key.

## 1. Prepare the daemon

Use `team` or `hybrid` authentication and a private network or HTTPS proxy. Create one key per connector and machine:

```bash
signet api-key create --name "work laptop codex" --connector codex --agent-id codex-work-laptop
signet api-key list
```

The raw `sig_sk_...` value is shown once. Store it in the connector's secret mechanism. `SIGNET_API_KEY` is the current runtime variable; `SIGNET_TOKEN` is a backwards-compatible alias.

## 2. Install a connector

Use the CLI when it is already installed:

```bash
signet connector install codex \
  --url https://signet.example.com \
  --api-key sig_sk_... \
  --agent-id codex-work-laptop
```

Or use the connector package directly:

```bash
npx -y @signetai/codex-plugin install \
  --url https://signet.example.com \
  --api-key sig_sk_... \
  --agent-id codex-work-laptop
```

The current package families include `connector-claude-code`, `connector-codex`, `connector-gemini`, `connector-hermes-agent`, `connector-oh-my-pi`, `connector-openclaw`, `connector-opencode`, `connector-pi`, and the native `codex-plugin`. Installers manage the harness configuration and use `SIGNET_DAEMON_URL` and `SIGNET_API_KEY` at runtime.

Start a fresh harness session after installation so its plugin, hook, or MCP configuration is loaded.

## 3. Verify the connection

Check the daemon and authenticated identity without exposing the key:

```bash
curl -fsS "$SIGNET_DAEMON_URL/health/ready"
curl -fsS "$SIGNET_DAEMON_URL/api/auth/whoami" \
  -H 'Authorization: Bearer '"$SIGNET_API_KEY"
```

For a connector-specific inspection, the installed package may provide `status`; use the package's current CLI help when available. The Signet CLI install command itself installs configuration and is not a general connector health command.

The dashboard reads connector state from `GET /api/harnesses`. Refresh one connector with `GET /api/harnesses/<id>/health`. Recovery actions are admin-only:

```text
POST /api/harnesses/<id>/repair
POST /api/harnesses/<id>/reinitialize
```

Include `{ "confirm": true }` when reinitialization changes connector-owned configuration. Run the health route after either action.

## 4. Rotate and retire

Revoke a key when a machine is retired or a value may have been exposed:

```bash
signet api-key revoke <id-or-prefix>
```

Create a replacement key, reinstall or update the connector, and start a fresh harness session. Use one agent-scoped key per client so authorization and attribution remain aligned.

## Troubleshooting path

- `401`: verify the daemon URL, key variable, auth mode, and key list.
- `403`: inspect the key's agent scope and requested agent.
- No tools in the harness: start a fresh session and rerun the installer.
- Health unreachable: verify bind address, private-network routing, firewall, and TLS before changing workspace state.

See [Authentication](/auth/) for credential policy, [Self-hosting](/self-hosting/) for deployment, and [Diagnostics](/diagnostics/) for daemon evidence.
