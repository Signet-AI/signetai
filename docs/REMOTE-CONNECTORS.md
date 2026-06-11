---
title: "Remote Harness Connectors"
description: "Connect Claude Code, Codex, Pi, OpenCode, and other harnesses on one machine to a Signet daemon on another."
order: 16
section: "How-to"
---

# Remote Harness Connectors

Use remote harness connectors when Signet is running on one trusted machine and
your agent harness runs somewhere else: a laptop, desktop, server, VM, or
Tailscale peer.

The setup model is:

> Run one Signet daemon. Point every harness connector at it with
> `SIGNET_DAEMON_URL` and `SIGNET_API_KEY`.

The daemon keeps ownership of memory, sources, sessions, identity, auth, and
policy. The connector on the remote machine is a small adapter that installs
into the harness, forwards lifecycle events, and exposes Signet tools inside
that harness.

## What you need

- A Signet daemon running on the machine that owns your Signet workspace.
- Network reachability from the remote machine to that daemon.
- A named Signet API key for each remote connector.
- The target harness installed on the remote machine.

Examples below use a tailnet/LAN URL such as `http://signet-home:3850`. Replace
it with your daemon URL, for example:

```text
http://100.107.87.47:3850
http://signet-home.tailnet:3850
https://signet.example.com
```

Do not paste real API keys into chat, issues, logs, screenshots, or shell
history you plan to share. The raw key is shown once when created.

## 1. Prepare the Signet daemon machine

On the machine that already has your Signet workspace:

```bash
signet --version
signet daemon status --json
curl http://127.0.0.1:3850/health
```

The daemon must be reachable from the remote machine, not only from localhost.
For a trusted tailnet or private LAN, set the daemon network mode to `tailscale`
so it binds to `0.0.0.0`:

```yaml
# $SIGNET_WORKSPACE/agent.yaml
network:
  mode: tailscale
```

Then restart the daemon:

```bash
signet daemon restart
```

You can also use an explicit environment override when you manage the daemon
service yourself:

```bash
SIGNET_BIND=0.0.0.0 SIGNET_PORT=3850 signet daemon start
```

Check the reported bind mode:

```bash
signet daemon status --json
```

Look for `bindHost: "0.0.0.0"` and `networkMode: "tailscale"` in the daemon
status output.

## 2. Choose an auth mode

Use `hybrid` or `team` mode for remote connectors.

```yaml
# $SIGNET_WORKSPACE/agent.yaml
auth:
  mode: hybrid
```

- `hybrid` keeps local CLI/dashboard requests convenient while requiring a
  valid bearer key from remote machines.
- `team` requires auth for every request, including localhost.
- `local` has no auth. Only use it on a private, trusted network while
  testing, never on an exposed interface.

Restart after changing auth:

```bash
signet daemon restart
```

Verify remote unauthenticated requests are rejected in `hybrid` or `team` mode
from the remote machine:

```bash
curl -i http://signet-home:3850/api/auth/whoami
```

A `401 Unauthorized` response is expected for a remote request without a key.
`/health` may still be reachable because it is a basic health endpoint.

## 3. Create a connector API key

Create one key per machine/harness pair. This makes revocation and audit trails
clear.

```bash
signet api-key create \
  --name "work laptop pi" \
  --connector pi \
  --agent-id pi-work-laptop
```

The command prints the raw `sig_sk_...` key once. Save it in your password
manager or pass it directly to the remote installer. Do not commit it.

If you create the key with `--agent-id`, pass the same `--agent-id` when you
install the connector. This keeps scope-guarded API calls and connector
attribution aligned. In Signet 0.140.1, connector lifecycle hook traffic is
authenticated but not every hook path enforces agent scope as a hard isolation
boundary, so use one named key per connector and revoke keys you no longer
trust.

Codex note for Signet 0.140.1: the Codex installer does not yet persist
`SIGNET_AGENT_ID` into generated Codex hook/MCP config. Use a named but
unscoped Codex key for now unless you manually manage the generated Codex
runtime environment.

For other harnesses, change `--connector` and the name:

```bash
signet api-key create --name "work laptop codex" --connector codex
signet api-key create --name "work laptop opencode" --connector opencode --agent-id opencode-work-laptop
```

List keys without revealing secrets:

```bash
signet api-key list
```

Revoke a key if a machine is retired or the key was exposed:

```bash
signet api-key revoke <id-or-prefix>
```

## 4. Install the connector on the remote machine

There are two install paths.

### Option A: Signet CLI installed on the remote machine

Use this if the remote machine already has the `signet` CLI:

```bash
signet connector install pi \
  --url http://signet-home:3850 \
  --api-key sig_sk_... \
  --agent-id pi-work-laptop
```

`signet connect <harness>` is a short alias:

```bash
signet connect codex \
  --url http://signet-home:3850 \
  --api-key sig_sk_...
```

### Option B: connector-only npm installers

Use this if you only want to configure one harness and do not want to install
the full Signet CLI first:

```bash
npx -y @signetai/connector-pi install \
  --url http://signet-home:3850 \
  --api-key sig_sk_... \
  --agent-id pi-work-laptop
```

Available connector packages:

| Harness | Package | Binary |
|---|---|---|
| Claude Code | `@signetai/connector-claude-code` | `signet-connector-claude-code` |
| Codex | `@signetai/connector-codex` | `signet-connector-codex` |
| Codex native plugin UX | `@signetai/codex-plugin` | `signet-codex-plugin` |
| Gemini | `@signetai/connector-gemini` | `signet-connector-gemini` |
| Hermes Agent | `@signetai/connector-hermes-agent` | `signet-connector-hermes-agent` |
| Oh My Pi | `@signetai/connector-oh-my-pi` | `signet-connector-oh-my-pi` |
| OpenClaw | `@signetai/connector-openclaw` | `signet-connector-openclaw` |
| OpenCode | `@signetai/connector-opencode` | `signet-connector-opencode` |
| Pi | `@signetai/connector-pi` | `signet-connector-pi` |

Codex users should usually prefer the native-plugin-oriented package name:

```bash
npx -y @signetai/codex-plugin install \
  --url http://signet-home:3850 \
  --api-key sig_sk_...
```

The installer writes the daemon URL and API key into the harness config it
manages. It uses `SIGNET_DAEMON_URL` and `SIGNET_API_KEY` at runtime.
`SIGNET_TOKEN` remains a backwards-compatible alias, but new installs should
use `SIGNET_API_KEY`.

## 5. Verify the connection before first run

From the remote machine:

```bash
curl http://signet-home:3850/health
```

Then check the installed connector status:

```bash
npx -y @signetai/connector-pi status
npx -y @signetai/codex-plugin status
npx -y @signetai/connector-opencode status
```

If you installed through the Signet CLI, the harness-specific status commands
are still available through the package installers. `signet connector install`
only installs; it does not currently have a separate `status` subcommand.

For an authenticated route smoke test without printing the key, run this from a
shell where `SIGNET_API_KEY` is set:

```bash
export SIGNET_DAEMON_URL=http://signet-home:3850
export SIGNET_API_KEY=sig_sk_...

curl -fsS "$SIGNET_DAEMON_URL/api/auth/whoami" \
  -H "Authorization: Bearer $SIGNET_API_KEY"
```

You should get JSON describing the authenticated connector role/scope. If you
get `401`, check the key, auth mode, and daemon URL.

## 6. Start the harness and run a first check

Open a fresh session in the target harness after installing or updating a
connector. Most harnesses load extensions, plugins, MCP servers, or hooks at
process/session startup; an already-running session may still have the old tool
list.

Good first checks:

- Ask the harness to recall a harmless preference or project fact.
- Ask it to search source-backed context if the connector exposes
  `signet_source_search`.
- Ask it to search transcript/session history if the connector exposes
  `signet_session_search`.
- Save a harmless test memory, then revoke/delete it if you do not want to keep
  it.

For Pi and Oh My Pi, restart the Pi session after installing so the extension
bundle is reloaded. A refreshed install can be correct on disk while the current
session still shows the old tool list.

## Common setups

### One desktop daemon, laptop connectors over Tailscale

On the desktop:

```yaml
# $SIGNET_WORKSPACE/agent.yaml
network:
  mode: tailscale
auth:
  mode: hybrid
```

```bash
signet daemon restart
signet api-key create --name "laptop codex" --connector codex
```

On the laptop:

```bash
npx -y @signetai/codex-plugin install \
  --url http://100.107.87.47:3850 \
  --api-key sig_sk_...
```

Start a new Codex session and use the Signet MCP tools from that session.

### Remote OpenCode connector

On the daemon machine:

```bash
signet api-key create --name "mini pc opencode" --connector opencode --agent-id opencode-mini-pc
```

On the OpenCode machine:

```bash
npx -y @signetai/connector-opencode install \
  --url http://signet-home.tailnet:3850 \
  --api-key sig_sk_... \
  --agent-id opencode-mini-pc
```

Start a new OpenCode session so it picks up the new plugin/config.

### Remote Pi connector

On the daemon machine:

```bash
signet api-key create --name "work laptop pi" --connector pi --agent-id pi-work-laptop
```

On the Pi machine:

```bash
npx -y @signetai/connector-pi install \
  --url http://signet-home.tailnet:3850 \
  --api-key sig_sk_... \
  --agent-id pi-work-laptop
```

Start a new Pi session. The Pi connector should expose Signet tools such as
`signet_recall`, `signet_remember`, `signet_source_search`, and
`signet_session_search`.

## Troubleshooting

### `curl /health` fails from the remote machine

- Confirm the daemon is running: `signet daemon status --json`.
- Confirm it is not bound only to localhost. Use `network.mode: tailscale` or
  `SIGNET_BIND=0.0.0.0`.
- Confirm firewall, tailnet ACLs, or security-group rules allow TCP port 3850.
- Try the daemon machine's tailnet IP directly instead of a hostname.

### Authenticated requests return `401 Unauthorized`

- Make sure the remote connector uses `SIGNET_API_KEY`, not a placeholder.
- Confirm the key was not revoked: `signet api-key list`.
- Create a fresh key and reinstall the connector if the original key may have
  been copied incorrectly.
- Confirm the daemon URL points to the Signet daemon origin only, not a nested
  path.

### The harness starts but no Signet tools appear

- Restart the harness session after installing the connector.
- Re-run the connector install command to refresh managed config.
- Check the package status command, for example
  `npx -y @signetai/connector-pi status`.
- For MCP-based harnesses, inspect the harness MCP config and confirm the
  Signet server entry is present.

### Local CLI works but remote connector fails in `hybrid` mode

That usually means auth is working: localhost is allowed without a key, while
remote requests require one. Verify with:

```bash
curl -i http://signet-home:3850/api/auth/whoami
curl -i http://signet-home:3850/api/auth/whoami \
  -H "Authorization: Bearer $SIGNET_API_KEY"
```

The first remote request should be `401`; the second should succeed.

### You exposed a key accidentally

Revoke it immediately:

```bash
signet api-key revoke <id-or-prefix>
```

Then create a new key and rerun the connector installer on the affected
machine.

## Security notes

- Prefer Tailscale, WireGuard, a private LAN, or HTTPS through a reverse proxy.
- Do not expose a `local` auth-mode daemon to the public internet.
- Use one named key per connector/machine so revocation is precise.
- Store API keys in the target harness config or a local secret manager, not in
  shell scripts committed to a repo.
- If the daemon is reachable from untrusted networks, use `auth.mode: team` and
  terminate TLS with a reverse proxy. See [[self-hosting|Self-Hosting]] and
  [[auth|Authentication]].

## Related docs

- [[auth|Authentication]] — auth modes, API-key records, roles, and revocation.
- [[harnesses|Harnesses]] — harness-specific files and runtime behavior.
- [[cli|CLI Reference]] — exact CLI command reference.
- [[self-hosting|Self-Hosting]] — service deployment, reverse proxy, TLS, and
  production hardening.
