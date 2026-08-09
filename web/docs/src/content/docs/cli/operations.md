---
title: "Runtime operations"
description: "Inspect status, open the dashboard, route inference, manage the daemon, update, and bypass hooks."
---

## `signet status`

Show comprehensive status of the Signet installation.

```bash
signet status
signet status --path /custom/path
```

Options:

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Custom base path |

Output:

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

  Status

  ● Daemon running
    PID: 12345
    Uptime: 2h 15m
    Dashboard: http://localhost:3850

  ✓ AGENTS.md
  ✓ agent.yaml
  ✓ memories.db

  Memories: 42
  Conversations: 7

  Path: /home/user/.agents
```

---

## `signet dashboard`

Open the Signet web dashboard in your default browser.

```bash
signet dashboard
signet ui          # Alias
```

Options:

| Option | Description |
|--------|-------------|
| `-p, --path <path>` | Custom base path |

If the daemon is not running, it will be started automatically.

---

## `signet route`

Inspect and control the shared inference router. Requires the daemon to be
running for `list`, `status`, `doctor`, `explain`, and `test`.

```bash
signet route list
signet route status
signet route doctor
signet route explain "fix this bun test" --agent rose --task-class hard_coding
signet route test "summarize this transcript" --agent dot --task-class casual_chat --timeout 60000
signet route pin opus/opus46 --agent rose --task-class hard_coding
signet route unpin --agent rose --task-class hard_coding
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet route list` | List router config plus runtime health |
| `signet route status` | Show configured targets, policies, and workload bindings |
| `signet route doctor` | Report broken or unavailable route targets |
| `signet route explain <prompt>` | Dry-run a route decision and print the trace |
| `signet route test <prompt>` | Execute a real prompt through the router |
| `signet route pin <targetRef>` | Write a hard pin into `agent.yaml` |
| `signet route unpin` | Remove a hard pin from `agent.yaml` |

Common options:

| Option | Description |
|--------|-------------|
| `--agent <agent>` | Agent id override |
| `--task-class <taskClass>` | Task-class override |
| `--operation <operation>` | Routing operation kind |
| `--privacy <privacy>` | Privacy tier override |
| `--policy <policy>` | Explicit policy override |
| `--target <targetRef>` | Explicit target pin for the current request |
| `--timeout <ms>` | Request timeout for `route test`, up to 600000 ms |
| `--refresh` | Re-check target health before routing |
| `--debug` | Print the full routing decision trace |
| `--json` | Emit raw JSON |

Pins are stored under `routing.agents.<agent>.pinnedTargets` in
`$SIGNET_WORKSPACE/agent.yaml`.

---

## Daemon Commands

Daemon operations live under the `signet daemon` subcommand group. The
top-level shortcuts still exist as backwards-compatible aliases, but the
grouped form is the preferred surface.

```bash
signet daemon start
signet daemon stop
signet daemon restart
signet daemon status
signet daemon logs

# Backwards-compatible aliases
signet start
signet stop
signet restart
signet logs
```

### `signet daemon start`

Start the Signet daemon if not already running.

```
  ◈ signet v0.1.0
  own your agent. bring it anywhere.

✔ Daemon started
  Dashboard: http://localhost:3850
```

Top-level alias: `signet start`

### `signet daemon stop`

Stop the running Signet daemon.

Top-level alias: `signet stop`

### `signet daemon restart`

Stop and start the daemon. Useful after installing an update.

Top-level alias: `signet restart`

### `signet daemon logs`

View daemon logs.

```bash
signet daemon logs
signet daemon logs -n 100
signet daemon logs --follow
signet daemon logs --level warn
signet daemon logs --category memory
```

Top-level alias: `signet logs`

Options:

| Option | Description |
|--------|-------------|
| `-n, --lines <n>` | Number of lines to show (default: 50) |
| `-f, --follow` | Follow log output in real-time |
| `-l, --level <level>` | Filter by level: `debug`, `info`, `warn`, `error` |
| `-c, --category <category>` | Filter by category: `daemon`, `api`, `memory`, `sync`, `git`, `watcher` |

### Service Installation

The daemon can be installed as a system service (systemd on Linux,
launchd on macOS) using the daemon package's bun scripts:

```bash
cd platform/daemon
bun run install:service    # Install as systemd/launchd service
bun run uninstall:service  # Remove the service
```

These are package-level scripts, not top-level `signet` CLI commands.
They register a unit that starts the daemon automatically at login.

---

## `signet update`

Check for updates, install them manually, or configure unattended
auto-installs. Use an explicit subcommand such as `signet update check`.

```bash
signet update check         # check for updates
signet update check --force
signet update install
signet update status
signet update enable
signet update enable --interval 3600
signet update disable
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet update check` | Check if a newer version is available |
| `signet update install` | Download and install the latest version |
| `signet update status` | Show auto-update settings and last result |
| `signet update enable` | Enable unattended background installs |
| `signet update disable` | Disable unattended background installs |

`signet update check` options:

| Option | Description |
|--------|-------------|
| `-f, --force` | Force a fresh check, ignoring cached result |

`signet update enable` options:

| Option | Description |
|--------|-------------|
| `-i, --interval <seconds>` | Check interval in seconds (default: 21600; range: 300-604800) |

After `signet update install` completes, a daemon restart is required to
run the new version: `signet daemon restart`. When a direct native install
coexists with an npm/Bun/pnpm/Yarn wrapper, the updater uses the native binary
instead of selecting a package manager from PATH. The CLI prints an exact
command that removes only the duplicate launcher after the update; `signet
doctor` reports the same conflict. Do not uninstall the whole package, because
it may also provide `signet-mcp`. Signet never removes the duplicate
automatically.

---

## `signet bypass`

Toggle per-session hook bypass. When bypass is enabled for a session, all
Signet hooks return empty no-op responses — the daemon is still running,
but it stays silent for that session. MCP tools (memory_search, memory_store,
etc.) continue to work normally.

```bash
signet bypass                   # List active sessions with bypass status
signet bypass --list            # Same as above
signet bypass <session-key>     # Enable bypass for a session
signet bypass --off <session-key>  # Disable bypass for a session
```

Subcommands:

| Command | Description |
|---------|-------------|
| `signet bypass` | List active sessions and their bypass status |
| `signet bypass --list` | Same as `signet bypass` with no arguments |
| `signet bypass <session-key>` | Enable bypass for the given session |
| `signet bypass --off <session-key>` | Disable bypass for the given session |

You can also bypass hooks entirely at the process level using the
`SIGNET_BYPASS` environment variable (see below).

---
