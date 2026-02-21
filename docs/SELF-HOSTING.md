Self-Hosting the Signet Daemon
===============================

The Signet daemon is a Hono HTTP server that runs as a background service,
providing memory storage, search, and the web dashboard. By default it
binds to `localhost:3850` and requires no authentication. This document
covers everything needed to run it persistently, expose it to a team, and
keep it healthy in production.


Overview
--------

The daemon process is a single Bun-targeted binary at
`packages/daemon/dist/daemon.js`. It owns two things: the SQLite database
at `~/.agents/memory/memories.db` and the config directory at `~/.agents/`.
Everything else — file watching, the memory pipeline, the dashboard —
runs inside that one process.

Environment variables control the network address:

- `SIGNET_HOST` — interface to bind (default: `localhost`)
- `SIGNET_PORT` — port to listen on (default: `3850`)
- `SIGNET_PATH` — override the data directory (default: `~/.agents/`)

Bun is a hard requirement. The daemon uses `bun:sqlite` directly and will
refuse to start under Node.


Running as a Service
--------------------

The easiest path is the CLI:

```bash
signet daemon install   # installs and starts the service
signet daemon uninstall # stops and removes it
```

The install command detects the platform and writes the appropriate service
definition, then starts it. Under the hood, it generates the unit file from
the actual runtime path (`which bun`) and the installed daemon path, so the
service file always reflects the current installation.

### systemd (Linux)

The CLI writes a user-level unit file to
`~/.config/systemd/user/signet.service` with `Restart=on-failure` and
`RestartSec=5`. The unit looks like this:

```ini
[Unit]
Description=Signet Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/bun /path/to/daemon.js
Environment=SIGNET_PORT=3850
Environment=SIGNET_PATH=/home/you/.agents
WorkingDirectory=/home/you/.agents
Restart=on-failure
RestartSec=5
StandardOutput=append:/home/you/.agents/.daemon/logs/daemon.out.log
StandardError=append:/home/you/.agents/.daemon/logs/daemon.err.log

[Install]
WantedBy=default.target
```

To manage it manually after installation:

```bash
systemctl --user status signet.service
systemctl --user restart signet.service
journalctl --user -u signet.service -f
```

For the service to survive logout on headless servers, you need lingering
enabled for your user:

```bash
loginctl enable-linger $USER
```

### launchd (macOS)

The CLI writes a plist to
`~/Library/LaunchAgents/ai.signet.daemon.plist` with `KeepAlive` and
`RunAtLoad` set to true, so it starts at login and restarts on crash.
Stdout and stderr go to `~/.agents/.daemon/logs/`.

```bash
launchctl list ai.signet.daemon   # check status
launchctl unload ~/Library/LaunchAgents/ai.signet.daemon.plist
launchctl load ~/Library/LaunchAgents/ai.signet.daemon.plist
```

The generated plist hard-codes the Bun path as `/opt/homebrew/bin/bun` for
Apple Silicon. If Bun is installed elsewhere, either re-run
`signet daemon install` after updating `PATH`, or edit the plist manually.


Team Mode Deployment
--------------------

By default the daemon runs in `local` mode: no authentication, no rate
limiting, localhost only. For shared deployments you switch to `team` mode,
which requires a bearer token on every request.

Add an `auth` block to `~/.agents/agent.yaml`:

```yaml
auth:
  mode: team
```

Then restart the daemon. On first start with a non-local mode, the daemon
generates a 32-byte HMAC secret at `~/.agents/.daemon/auth-secret` with
permissions `0600`. All tokens are signed against this secret. Rotating the
secret invalidates all existing tokens.

### Generating tokens

Tokens are created via the API. In `team` mode you need an existing admin
token to create more; on first setup, you can temporarily switch to
`hybrid` mode (which grants full access from localhost without a token) to
bootstrap.

```bash
curl -s -X POST http://localhost:3850/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{
    "role": "agent",
    "sub": "ci-runner",
    "ttlSeconds": 2592000
  }'
```

The response contains a `token` field. Distribute this string to the
consumer. All subsequent requests must include it as a bearer token:

```
Authorization: Bearer <token>
```

Tokens carry a `sub` (subject identifier), a `role`, a `scope`, and an
expiry. The token format is `{base64url(claims)}.{base64url(hmac-sha256)}`
— no external JWT library, no key infrastructure needed beyond the secret
file.

### Roles and permissions

Four roles are supported. Each grants a fixed set of permissions:

| Role       | Permissions |
|------------|-------------|
| `admin`    | all, including token creation and admin operations |
| `operator` | remember, recall, modify, forget, recover, documents, connectors, diagnostics, analytics |
| `agent`    | remember, recall, modify, forget, recover, documents |
| `readonly` | recall only |

Scope restrictions can narrow a token further. A token scoped to
`project: acme` will be rejected when accessing memories tagged to a
different project. Admin tokens bypass all scope checks.

```bash
# Scoped token for a specific agent
curl -s -X POST http://localhost:3850/api/auth/token \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "role": "agent",
    "sub": "claude-code:acme",
    "scope": { "project": "acme" },
    "ttlSeconds": 86400
  }'
```

Default token TTL is 7 days. Session tokens (issued by hook endpoints) are
24 hours. Both are configurable in `agent.yaml`:

```yaml
auth:
  mode: team
  defaultTokenTtlSeconds: 604800   # 7 days
  sessionTokenTtlSeconds: 86400    # 24 hours
```

### Rate limits

In `team` and `hybrid` modes, destructive operations are rate-limited per
actor (the token's `sub` field) using an in-memory sliding window. Defaults:

| Operation    | Window | Max requests |
|--------------|--------|--------------|
| `forget`     | 60s    | 30           |
| `modify`     | 60s    | 60           |
| `batchForget`| 60s    | 5            |
| `forceDelete`| 60s    | 3            |
| `admin`      | 60s    | 10           |

These can be overridden in `agent.yaml`:

```yaml
auth:
  mode: team
  rateLimits:
    forget:
      windowMs: 60000
      max: 10
```

Rate limit state is in-memory and resets on daemon restart.


Hybrid Mode
-----------

`hybrid` mode gives you the convenience of `local` mode for local tooling
while requiring tokens from remote clients. Requests arriving with a
`host` header of `localhost`, `127.0.0.1`, or `::1` bypass authentication
entirely and receive full admin-equivalent access. All other origins must
present a valid bearer token.

```yaml
auth:
  mode: hybrid
```

This is a practical default for development machines where you want the
local dashboard and CLI to work without tokens, but also want to call the
daemon from CI pipelines or remote agents. Note the localhost bypass is
checked against the `Host` header, not the TCP peer address, so it is
trusting the client to report its own address honestly. For anything
exposed to untrusted networks, use `team` mode with a reverse proxy.


Network Configuration
---------------------

The daemon is HTTP-only. TLS must be terminated upstream.

To bind to all interfaces (required when using a reverse proxy on the same
host, or when hosting on a VM):

```bash
SIGNET_HOST=0.0.0.0 SIGNET_PORT=3850 bun daemon.js
```

Or set it in the systemd unit:

```ini
Environment=SIGNET_HOST=0.0.0.0
Environment=SIGNET_PORT=3850
```

Never expose port 3850 directly to the internet in `local` or `hybrid`
mode. Use `team` mode plus a reverse proxy that terminates TLS.


Reverse Proxy
-------------

### nginx

```nginx
server {
    listen 443 ssl;
    server_name signet.example.com;

    ssl_certificate     /etc/letsencrypt/live/signet.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/signet.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:3850;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # SSE support
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}
```

### Caddy

```caddy
signet.example.com {
    reverse_proxy localhost:3850 {
        flush_interval -1
    }
}
```

Caddy handles TLS automatically via Let's Encrypt. The `flush_interval -1`
directive is needed for the `/sse` endpoint to stream events correctly
without buffering.

In both cases, set `auth.mode: team` in `agent.yaml` before exposing the
daemon. Hybrid mode's localhost bypass does not apply when the request
arrives through a proxy — the `Host` header will be the public hostname,
not `localhost`.


Backup and Restore
------------------

All persistent state lives in two places:

- `~/.agents/memory/memories.db` — the SQLite database
- `~/.agents/` — config files, secrets, skills

The database runs in WAL mode, which makes it safe to copy while the
daemon is running. A simple backup:

```bash
cp ~/.agents/memory/memories.db /backup/memories-$(date +%Y%m%d).db
```

For a full backup including config and the auth secret:

```bash
rsync -a ~/.agents/ /backup/agents-$(date +%Y%m%d)/
```

The auth secret lives at `~/.agents/.daemon/auth-secret` (binary, 32
bytes, mode `0600`). Back it up with your config. Losing it invalidates all
issued tokens.

To restore, stop the daemon, copy the files back, and restart:

```bash
systemctl --user stop signet.service
rsync -a /backup/agents-20260101/ ~/.agents/
systemctl --user start signet.service
```

For scheduled backups, a daily cron that copies the database and rotates
old copies is sufficient. Incremental WAL checkpoints happen automatically
during normal operation.


Monitoring
----------

### Health check

```
GET /health
```

Returns HTTP 200 with JSON `{ status: "healthy", uptime: <seconds>, pid: <int> }`.
Use this for load balancer health checks and uptime monitors. It has no
authentication requirement regardless of auth mode.

### Diagnostics

```
GET /api/diagnostics
```

Returns a scored health report covering database integrity, FTS consistency,
embedding provider status, memory pipeline state, and mutation health.
Requires the `diagnostics` permission (available to `admin` and `operator`
roles).

### Analytics

```
GET /api/analytics/usage    # request counts by route and method
GET /api/analytics/errors   # pipeline errors, filterable by stage
GET /api/analytics/latency  # p50/p95/p99 latency histograms
GET /api/analytics/logs     # recent structured log entries
```

All analytics endpoints require the `analytics` permission. Data is
collected in-memory and resets on daemon restart. For durable metrics,
scrape these endpoints on a schedule and push to your monitoring stack.

A quick check to confirm the daemon is healthy and the pipeline is running:

```bash
curl -s http://localhost:3850/health | jq .
curl -s http://localhost:3850/api/diagnostics | jq '.score'
```


Troubleshooting
---------------

### Daemon won't start

Check whether the port is already in use:

```bash
ss -tlnp | grep 3850
lsof -i :3850
```

If another process holds the port, either stop it or change `SIGNET_PORT`.
If the daemon starts then immediately exits, check the log file:

```bash
tail -50 ~/.agents/.daemon/logs/daemon.out.log
tail -50 ~/.agents/.daemon/logs/daemon.err.log
```

The most common cause is Bun not being found. The systemd unit and launchd
plist hard-code the Bun path detected at install time. If Bun was moved or
reinstalled, re-run `signet daemon install` to regenerate the service file.

### Auth issues

If requests return `401 authentication required`, confirm the auth mode:

```bash
curl -s http://localhost:3850/api/auth/status | jq .mode
```

If the mode is `team` or `hybrid`, the request needs a valid bearer token.
Tokens expire — check the `exp` field by base64-decoding the first segment
of the token:

```bash
TOKEN="<your-token>"
echo "${TOKEN%%.*}" | base64 -d 2>/dev/null | jq .exp
```

Compare the epoch value against `date +%s`. If expired, generate a new
token. If you've lost all admin tokens, temporarily set `auth.mode: local`
in `agent.yaml`, restart the daemon, generate a new admin token, then
switch back to `team` mode.

### Pipeline not processing

The memory extraction pipeline requires Ollama running locally with the
extraction model pulled. Confirm:

```bash
curl -s http://localhost:11434/api/tags | jq '.models[].name'
```

The default model is `qwen3:4b`. If it is not listed:

```bash
ollama pull qwen3:4b
```

If Ollama is running but the pipeline is still idle, check whether it is
enabled in `agent.yaml`:

```yaml
memory:
  pipelineV2:
    enabled: true
```

`shadowMode: true` means the pipeline extracts but does not write to the
database — useful for testing, but memories will not persist. Set it to
`false` for production operation.

### High memory usage

If the daemon process grows unboundedly, retention is likely not running or
the embedding index has accumulated too many orphaned entries. Check
diagnostics:

```bash
curl -s http://localhost:3850/api/diagnostics | jq '{score, memory, mutation}'
```

A low score in the `memory` domain often means retention sweeps have
stopped. Restarting the daemon triggers a fresh sweep on startup. If the
issue persists, check for stale job leases in the pipeline queue — the
`GET /api/diagnostics` response includes queue depth and lease counts.

For embeddings specifically: each memory stores a vector, and deleted
memories leave tombstones until the next retention run. If tombstone count
is high, trigger a repair manually:

```bash
curl -s -X POST http://localhost:3850/api/repair/requeue-dead-jobs \
  -H "Authorization: Bearer <admin-token>"
```
