---
title: "Teams"
description: "Run one Signet daemon for a team and sign in from the dashboard, the CLI, and harnesses."
---

A team can share one Signet daemon. Run it in `team` mode, and every request needs a credential. People sign in to the dashboard in a browser, the CLI and harness connectors send an API key, and the daemon serves the same memory to all of them.

This guide covers setup and day-to-day access. [Authentication](/auth/) has the full reference for modes, roles, and scopes.

## What team mode gives you today

- One daemon and one workspace that the whole team reads and writes.
- A required credential on every request, from localhost too.
- A dashboard sign-in screen, with password sign-in for the admin and API-key sign-in for everyone else.
- API keys you can scope to an agent, give a role, set to expire, and revoke.

It does not yet have accounts for individual people. Password sign-in is one shared admin login, and an API key identifies a key, not a person, so name each key after the person and device it belongs to. Anything a key's role and agent scope allow, its holder can read. Per-person accounts, SSO, and hidden classifications are planned but not available.

## Before you start

- A machine your teammates can reach: a host on a private network or tailnet, or a public server behind HTTPS.
- The Signet CLI installed on that machine, with a workspace.
- A secret manager for the admin password and the API keys you hand out.

Passwords and keys travel in requests. Off a private network, serve the daemon over HTTPS. The [Docker deployment](/self-hosting/) includes a Caddy proxy that handles TLS.

## 1. Put the daemon in team mode

In the workspace `agent.yaml` on the daemon machine:

```yaml
network:
  mode: tailscale

auth:
  mode: team
```

`network.mode: tailscale` makes the daemon listen on the network instead of only on localhost. See [Remote connectors](/remote-connectors/#1-prepare-the-signet-daemon-machine) for other ways to bind it. Don't use `hybrid` mode behind a reverse proxy on the same host: the daemon would treat proxied requests as local and skip authentication.

Running the Docker deployment? It starts in `team` mode already. Continue at step 3.

## 2. Start the daemon with an admin password

Load the password from your secret manager into the environment, then start the daemon:

```bash
SIGNET_ADMIN_USERNAME=admin \
SIGNET_ADMIN_PASSWORD='load-this-from-a-secret-manager' \
signet daemon start
```

To keep a password across restarts without an environment variable, store a hash in `agent.yaml` instead. See [Password login configuration](/auth/#password-login-configuration).

## 3. Sign in to the dashboard

Open the daemon's address in a browser, for example `http://signet-home:3850` or your HTTPS domain. Instead of the usual dashboard you see a sign-in screen that names the mode and address, such as `Team · signet-home:3850`.

Sign in with the admin username and password. The topbar then shows the same `Team · …` label. Select it to see who you're signed in as, your role, and when the session expires.

If you run `signet dashboard` on the daemon machine with `SIGNET_API_KEY` set, the page opens already signed in.

## 4. Create a key for each teammate

Creating keys needs an admin credential. On the daemon machine, trade the admin password for a short-lived admin session. `printf` keeps the password off the command line:

```bash
export SIGNET_API_KEY="$(
  printf '{"username":"%s","password":"%s"}' "$SIGNET_ADMIN_USERNAME" "$SIGNET_ADMIN_PASSWORD" |
    curl -fsS -X POST http://127.0.0.1:3850/api/auth/login \
      -H 'content-type: application/json' --data @- |
    jq -r .token
)"
```

On the Docker deployment, use the bootstrap token from [First admin credential](/self-hosting/#first-admin-credential) instead.

Then create one key per person and device:

```bash
signet api-key create \
  --name "alice-laptop" \
  --role agent \
  --agent-id alice \
  --expires-at 2027-01-01T00:00:00Z
```

- `--role agent` allows reading and writing memories; `readonly` allows recall only. See [Roles and scopes](/auth/#roles-and-scopes).
- `--agent-id` limits the key to one agent's memories. Leave it out to give the key the whole workspace within its role.
- `--expires-at` is optional but recommended.

The raw key is printed once. Send it to the teammate through your secret manager, never in chat or email. `signet api-key list` shows existing keys and when each was last used.

## 5. Teammates sign in

**In a browser.** Open the daemon's address, select **Use an API key instead**, and paste the key. The dashboard swaps the key for a browser session and doesn't store the key itself.

**With the CLI.** Point the CLI at the daemon and give it the key, loaded from a secret manager:

```bash
export SIGNET_DAEMON_URL=https://signet.example.com
export SIGNET_API_KEY='load-this-from-a-secret-manager'
signet dashboard
```

`signet dashboard` opens the team daemon already signed in. The key never appears in the address bar: the CLI gets a one-time code that expires after 60 seconds, and the page exchanges it for a session. Other CLI commands use the same two variables. To make the address permanent, set `daemon.url` in the local `agent.yaml` instead of `SIGNET_DAEMON_URL`.

**From a harness.** To connect Claude Code, Codex, OpenCode, or another harness to the team daemon, follow [Remote connectors](/remote-connectors/).

## Sessions

A browser session lasts `auth.sessionTokenTtlSeconds`, and never longer than the key it came from. When a session ends while someone is working, a sign-in dialog opens over the page so they keep their place. The dialog says why the session ended, for example that it expired or that the key was revoked.

**Sign out of this browser**, in the topbar menu, ends the session in that browser only.

## Remove someone's access

Revoke their key:

```bash
signet api-key list
signet api-key revoke <id-or-prefix>
```

The key stops working at once for the CLI, connectors, and new sign-ins. A dashboard session already started with that key keeps working until it expires, because the daemon doesn't track sessions. A session never outlives `auth.sessionTokenTtlSeconds` or the key's own expiry.

To end every session immediately, rotate the daemon's signing secret. That signs everyone out, including the admin. See [Rotate and recover](/auth/#rotate-and-recover).

## Troubleshooting

**The dashboard shows "Password sign-in is not configured on this daemon."**
The daemon started without `SIGNET_ADMIN_PASSWORD`, `SIGNET_ADMIN_PASSWORD_HASH`, or a stored hash. Set one and restart. API-key sign-in still works without it.

**"Too many attempts. Try again in 42s."**
Sign-in is rate limited. Wait for the countdown.

**`signet dashboard` opens a local daemon instead of the team one.**
Check that `SIGNET_DAEMON_URL` is exported in that shell, or that `daemon.url` is set in the local `agent.yaml`.

**`signet dashboard` says "No Signet daemon answered at …".**
The address is wrong or unreachable from this machine. Test it with `curl -i <address>/health`.

**Check which credential a client is using.**
`/api/auth/whoami` reports whether a credential is accepted, and why not if it isn't:

```bash
curl -fsS "$SIGNET_DAEMON_URL/api/auth/whoami" \
  -H "Authorization: Bearer $SIGNET_API_KEY"
```

`"authenticated": true` with the key's `sub` means it works. Otherwise `error` gives the reason, such as `api key revoked` or `api key expired`.

Related: [Authentication](/auth/), [Dashboard](/dashboard/#signing-in), [Self-hosting](/self-hosting/), [Remote connectors](/remote-connectors/).
