---
title: "Daemon"
description: "Background service for file watching and HTTP API."
---

The Signet daemon is a background service that provides the [HTTP API](/api/),
serves the [Dashboard](/dashboard/), watches config files for changes, manages
[harness](/harnesses/) synchronization, and exposes an [MCP server](/mcp/) for
native tool access. It also runs the [memory pipeline](/pipeline/) and a
suite of subsystem workers for ingestion, retention, maintenance,
[Analytics](/analytics/), and [Diagnostics](/diagnostics/).

The daemon runs on `http://localhost:3850` by default.


## Starting and Stopping

### Via CLI

```bash
signet daemon start    # Start the daemon
signet daemon stop     # Stop the daemon
signet daemon restart  # Restart the daemon
signet status          # Check status
```

Top-level aliases `signet start`, `signet stop`, and `signet restart`
still exist, but `signet daemon ...` is the preferred command surface.

### Death evidence and the lifecycle record

The daemon writes its state to `<workspace>/.daemon/lifecycle.json`: `starting`
at boot, `running` once the HTTP server is ready, and a terminal `clean` or
`error` record (with exit path, exit code, and timestamp) on every catchable
exit — SIGTERM/SIGINT shutdowns and fatal errors. The record is written
synchronously and atomically, and the daemon flushes its log buffer before
exiting so the final log lines are never lost.

A process that is killed with SIGKILL, OOM-killed, or hard-crashed cannot write
a terminal record, so the file stays at `starting`/`running` — that stuck state
is the signal. `signet status` and `signet doctor` read the record whenever the
daemon is down and surface the distinction:

- `Last daemon exit was clean` (info) — the daemon shut down normally.
- `Daemon exited after an internal error` (error) — a fatal error with the
  message, worth reporting upstream.
- `Previous daemon exit was not recorded as clean` (warn) — killed or crashed.
  The finding points at the daemon log tail and, on Linux systemd launches, the
  transient unit's journald exit status (`journalctl --user -u
  signet-daemon-<pid>`), which distinguishes signals, core dumps, and OOM.

A concurrency load test for the bot-startup traffic profile (session-start
hooks, secrets, recall, status, optional writes) ships at
`scripts/load-test-daemon.ts`; run it against a live or scratch daemon with
`bun scripts/load-test-daemon.ts --port <port> [--writes]`.

### Via System Service

The daemon can be installed as a system service for auto-start on boot.

**macOS (launchd):**
```bash
cd platform/daemon
bun run install:service

launchctl load ~/Library/LaunchAgents/ai.signet.daemon.plist
launchctl unload ~/Library/LaunchAgents/ai.signet.daemon.plist
```

**Linux (systemd):**
```bash
cd platform/daemon
bun run install:service

systemctl --user start signet.service
systemctl --user stop signet.service
systemctl --user status signet.service
systemctl --user enable signet.service   # enable on boot
```


## Configuration

### Runtime

The daemon is a single TypeScript/Bun runtime (`@signet/daemon`). The
experimental Rust daemon rewrite (`platform/daemon-rs`) and the
`SIGNET_DAEMON_RUNTIME` selector have been removed; Rust is used only for
native accelerators (`@signet/native`), which load transparently with a
TypeScript fallback.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNET_PORT` | `3850` | HTTP server port |
| `SIGNET_HOST` | `127.0.0.1` | Daemon host used for local calls |
| `SIGNET_BIND` | network mode bind | Explicit bind address override; defaults to `127.0.0.1` in localhost mode and `0.0.0.0` in tailscale mode |
| `SIGNET_PATH` | `~/.agents` | Runtime override for the agents directory |
| `SIGNET_LOG_FILE` | — | Optional explicit log file path |
| `SIGNET_LOG_DIR` | `$SIGNET_WORKSPACE/.daemon/logs` | Optional log directory override |
| `SIGNET_SQLITE_PATH` | — | macOS explicit SQLite dylib override used before Bun opens the database |

### Files

When log path overrides are set:
- `SIGNET_LOG_FILE` takes highest precedence and points to the exact file.
- Else `SIGNET_LOG_DIR` overrides the default log directory.
- Else the default `$SIGNET_WORKSPACE/.daemon/logs/` paths below apply.

| File | Description |
|------|-------------|
| `$SIGNET_WORKSPACE/.daemon/pid` | Process ID file |
| `$SIGNET_WORKSPACE/.daemon/logs/` | Log directory |
| `$SIGNET_WORKSPACE/.daemon/logs/signet-YYYY-MM-DD.log` | Daily log file |
| `$SIGNET_WORKSPACE/.daemon/logs/daemon.out.log` | stdout capture |
| `$SIGNET_WORKSPACE/.daemon/logs/daemon.err.log` | stderr capture |


## Subsystems

The daemon starts several concurrent workers when it initializes. Each
worker runs its own loop and stops cleanly when the daemon shuts down.

### Pipeline Workers

The pipeline lives at `platform/daemon/src/pipeline/` and is managed
by `startPipeline()` / `stopPipeline()`. The standalone extraction
worker (`worker.ts`) and its decision/escalation stages were retired
under the Dreaming cutover (#946); Dreaming now owns semantic writes.
The remaining workers run in parallel:

**Document worker** (`document-worker.ts`) polls `memory_jobs` for
`document_ingest` jobs. It fetches remote URLs if needed, chunks the
content hierarchically, embeds each chunk, and links chunks to their
source document via `document_memories`. The same transaction
discipline applies: no provider calls inside write locks.

**Retention worker** (`retention-worker.ts`) runs on a periodic timer
and purges memories that have decayed below their retention threshold.
It can also be triggered manually by the maintenance worker.

**Maintenance worker** (`maintenance-worker.ts`) runs diagnostics on
a configurable interval and, depending on `maintenanceMode`, either
logs recommendations (`observe`) or executes repair actions
(`execute`). It tracks consecutive ineffective repairs and halts a
given repair action after three failed attempts to avoid thrashing.
Requires `autonomousEnabled: true` and `autonomousFrozen: false` in
pipeline config to activate the timed loop; otherwise it is passive
and can be triggered via the API.

Pipeline config modes:

| Mode flag | Effect |
|-----------|--------|
| `shadowMode` | Extract memories but do not write them |
| `mutationsFrozen` | Read-only; no writes at all |
| `graph.enabled` | Enable knowledge graph traversal on recall |
| `autonomous.enabled` | Allow the maintenance worker to run repairs |
| `autonomous.frozen` | Pause autonomous repairs without disabling |
| `autonomous.maintenanceMode` | `"observe"` (log only) or `"execute"` (act) |

### Session Tracker

The session tracker (`session-tracker.ts`) enforces a mutex on the
runtime path per session. Connectors send an `x-signet-runtime-path`
header with each hook request — either `"plugin"` or `"legacy"`. Once
a session is claimed by one path, any request arriving from the other
path receives a `409 Conflict`. Stale sessions expire after 4 hours
and are cleaned up every 15 minutes.

### Auth Middleware

The daemon supports three deployment modes: `local` (default, no
authentication required), `team` (all requests require a bearer
token), and `hybrid` (localhost requests bypass auth, remote requests
require a token). Token roles are `admin`, `operator`, `agent`, and
`readonly`, each with a different permission set. Rate limiting is
applied per token. See [authentication guide](/auth/) for full details on
configuration, token creation, and permission scopes.

### Analytics

The analytics collector (`analytics.ts`) accumulates ephemeral
in-memory counters for the lifetime of the daemon process. Nothing
is persisted to disk — the structured logs and `memory_history` table
provide durable backing. The collector tracks:

- **Usage counters** — per-endpoint call counts, error counts, and
  total latency; per-actor request/remember/recall/mutation counts;
  per-provider call counts and latency; per-connector sync counts.
- **Error ring buffer** — a fixed-size circular buffer of recent
  errors keyed by stage (`extraction`, `decision`, `embedding`,
  `mutation`, `connector`).
- **Latency histograms** — bucketed latency distributions per stage,
  useful for spotting tail latency without external tooling.

All counters reset on daemon restart. See [analytics reference](/analytics/)
for the API endpoints and data shapes.

### Timeline

The timeline builder (`timeline.ts`) reconstructs a chronological
incident trace for a given entity ID — a memory ID, request ID, or
session ID. It joins across `memory_history`, `memory_jobs`, the
in-process log buffer, and the error ring buffer to produce an ordered
list of events. This is primarily a debugging tool for tracing what
happened to a specific memory across extraction, decision, embedding,
and mutation phases. See [analytics reference](/analytics/) for
details on the timeline endpoint.

### Diagnostics

The diagnostics module (`diagnostics.ts`) evaluates six health
domains and returns a composite score:

| Domain | What it measures |
|--------|-----------------|
| `queue` | Job queue depth, dead job rate, stale leases |
| `storage` | Total memories, tombstone ratio, database size |
| `index` | FTS row count vs active memories, embedding coverage |
| `provider` | Ollama availability rate, recent timeouts and failures |
| `mutation` | Recent recover and delete event rates |
| `connector` | Active connector count, sync errors, error age |

Each domain produces a `score` (0–1) and a `status` of `healthy`,
`degraded`, or `unhealthy`. The composite score is a weighted average
across all six. The maintenance worker uses this report to decide
which repair actions to invoke. See [diagnostics guide](/diagnostics/)
for the full report schema and repair action catalog.


## HTTP API

The daemon exposes endpoints across these domains: memory, skills,
secrets, hooks, harnesses, auth, documents, connectors, diagnostics,
pipeline, repair, analytics, telemetry, timeline, git sync, update,
tasks, and logs. The table below lists the major groups. See
[HTTP API reference](/api/) for the full reference including
request/response schemas.

| Group | Base path | Description |
|-------|-----------|-------------|
| Health | `/health`, `/health/live`, `/health/ready` | Liveness and readiness probes, daemon status |
| Auth | `/api/auth/*` | Token issuance, validation, rate limit status |
| Config | `/api/config` | Read and write identity files |
| Identity | `/api/identity` | Parsed identity fields |
| Memories | `/api/memories`, `/memory/*` | List, search, similarity, remember, recall |
| Embeddings | `/api/embeddings` | Export embedding vectors |
| Documents | `/api/documents/*` | Document ingest and chunk retrieval |
| Connectors | `/api/connectors/*` | Connector registry, status, cursor updates |
| Skills | `/api/skills` | List installed skills |
| Harnesses | `/api/harnesses` | List harnesses, regenerate configs |
| Secrets | `/api/secrets` | List, get, set, delete secrets |
| Hooks | `/api/hooks/*` | Session start/stop, synthesis hooks |
| Git | `/api/git/*` | Commit history, sync status |
| Update | `/api/update` | Version check |
| Diagnostics | `/api/diagnostics` | Live health report across all domains |
| Repair | `/api/repair/*` | Manually trigger repair actions |
| Analytics | `/api/analytics` | Usage counters, error buffer, histograms |
| Timeline | `/api/timeline/:id` | Incident reconstruction by entity ID |
| Logs | `/api/logs` | Recent in-process log entries |
| MCP | `/mcp` | Model Context Protocol server (Streamable HTTP) |

### Health Check

```http
GET /health
```

```json
{
  "status": "healthy",
  "uptime": 3600,
  "pid": 12345,
  "version": "0.124.3",
  "port": 3850,
  "agentsDir": "/home/user/.agents",
  "db": true,
  "shuttingDown": false,
  "updateAvailable": false,
  "pendingRestart": false,
  "resources": { "...": "..." }
}
```

`GET /health` is the legacy health check. For orchestration and monitoring,
prefer the dedicated probes: `GET /health/live` is a cheap liveness probe that
never touches the database or subsystems (always 200 while the process is up),
and `GET /health/ready` returns 200 only when the database, migrations,
embedding, inference, and queue gates all pass — 503 with a `reasons` list
otherwise. See [Health and status API](/api/health-status/).

### Daemon Status

```http
GET /api/status
```

```json
{
  "status": "running",
  "version": "0.124.3",
  "pid": 12345,
  "uptime": 3600,
  "startedAt": "2025-02-17T16:00:00.000Z",
  "port": 3850,
  "host": "127.0.0.1",
  "bindHost": "127.0.0.1",
  "networkMode": "localhost",
  "agentsDir": "/home/user/.agents",
  "memoryDb": true,
  "pipelineV2": { "...": "..." },
  "pipeline": { "extraction": { "...": "..." } },
  "providerResolution": { "extraction": { "...": "..." } },
  "logging": {
    "logDir": "/home/user/.agents/.daemon/logs",
    "logFile": "/home/user/.agents/.daemon/logs/signet-2026-04-29.log"
  },
  "activeSessions": 0,
  "bypassedSessions": 0,
  "agentCreatedAt": "2025-02-17T16:00:00.000Z",
  "update": { "...": "..." },
  "embedding": { "...": "..." }
}
```


## File Watcher

The daemon watches these paths with chokidar:

- `$SIGNET_WORKSPACE/agent.yaml`
- `$SIGNET_WORKSPACE/AGENTS.md`
- `$SIGNET_WORKSPACE/SOUL.md`
- `$SIGNET_WORKSPACE/MEMORY.md`
- `$SIGNET_WORKSPACE/IDENTITY.md`
- `$SIGNET_WORKSPACE/USER.md`
- `$SIGNET_WORKSPACE/memory/` (entire directory)
- `~/.claude/projects/*/memory/MEMORY.md` (Claude Code project memories)

### Auto-Ingestion

When memory markdown files are created or modified, the daemon
automatically ingests them using hierarchical chunking to preserve
section structure. Each chunk includes its section header for context.
A SHA-256 hash prevents re-processing unchanged files. Ingestion runs
on startup and on file change.

| File pattern | Who | Tags |
|--------------|-----|------|
| `$SIGNET_WORKSPACE/memory/*.md` (not MEMORY.md) | `openclaw-memory` | `openclaw`, `memory-log`, date |
| `~/.claude/projects/*/memory/MEMORY.md` | `claude-code` | `claude-code`, `claude-project-memory`, project ID |

### Auto Git Commit

When a watched file changes, the daemon waits 5 seconds (debounce),
checks whether `$SIGNET_WORKSPACE/` is a git repository, stages all changes
with `git add -A`, and commits with a message in the form
`YYYY-MM-DDTHH-MM-SS_auto_<filename>`.

### Harness Sync

When `AGENTS.md` changes, the daemon waits 2 seconds, then
regenerates harness configuration files. It writes to:

- `~/.claude/CLAUDE.md` (if `~/.claude/` exists)
- `~/.config/opencode/AGENTS.md` (if `~/.config/opencode/` exists)

Each generated file includes a header noting the source path and
timestamp.


## Security

### Network Binding

The daemon binds to loopback by default and is not reachable from
other machines. Set `network.mode: tailscale` or `SIGNET_BIND` to expose it
on a broader interface, but pair that with auth mode `team` or `hybrid`.

### Auth Modes

In `local` mode (the default), no credentials are required. This is
fine for single-user local use. For any networked or shared
deployment, switch to `team` or `hybrid` mode. See
[authentication guide](/auth/) for setup instructions.

### File Permissions

The daemon reads and writes only files accessible to the running user.
It does not escalate privileges.


## Logging

Logs are written to the console and to a daily file at
`$SIGNET_WORKSPACE/.daemon/logs/signet-YYYY-MM-DD.log` by default. When
`SIGNET_LOG_FILE` is set, logs are written to that exact file.
When `SIGNET_LOG_DIR` is set (and `SIGNET_LOG_FILE` is unset), daily
logs are written under `$SIGNET_LOG_DIR/`.

```
[2025-02-17T18:00:00.000Z] [INFO] Message here
[2025-02-17T18:00:01.000Z] [WARN] Warning message
[2025-02-17T18:00:02.000Z] [ERROR] Error message
```

Log levels: `INFO` for normal operations, `WARN` for non-fatal issues,
`ERROR` for errors that do not crash the daemon.


## Troubleshooting

### Daemon won't start

Check whether port 3850 is already in use:
```bash
lsof -i :3850
```

Remove a stale PID file if present:
```bash
rm $SIGNET_WORKSPACE/.daemon/pid
signet daemon start
```

Read the error log:
```bash
cat "${SIGNET_LOG_FILE:-$HOME/.agents/.daemon/logs/daemon.err.log}"
```

### Daemon keeps crashing

Check for syntax errors in config:
```bash
cat $SIGNET_WORKSPACE/agent.yaml
```

Verify database integrity:
```bash
sqlite3 $SIGNET_WORKSPACE/memory/memories.db "PRAGMA integrity_check;"
```

### Dashboard not loading

Confirm the daemon is running and the dashboard was built:
```bash
signet status
curl http://localhost:3850/health
curl http://localhost:3850/health/ready
ls surfaces/dashboard/build/
```

### File changes not syncing

Check the watcher logs, confirm the git repository exists, and verify
file permissions:
```bash
ls $SIGNET_WORKSPACE/.git
```

### Pipeline jobs stuck

Check diagnostics for queue health and dead job rates:
```bash
curl http://localhost:3850/api/diagnostics
```

If the dead job rate is high, trigger a repair manually:
```bash
curl -X POST http://localhost:3850/api/repair/requeue-dead-jobs
```
