---
title: "Runtime operations"
description: "Control the daemon, updates, and inference routing."
---

## Daemon

```bash
signet daemon start
signet daemon stop
signet daemon restart
signet daemon pause
signet daemon resume
signet daemon status
signet daemon logs
```

`start` and `restart` accept `-p, --path <path>`, `--runtime <runtime>`
(`compiled` or `bun-js`), and `--daemon-js-path <path>`. The JavaScript runtime
requires a complete daemon bundle; an explicit `--daemon-js-path` overrides
`SIGNET_DAEMON_JS_PATH`. `status` also accepts `--json`.

`logs` accepts `-p, --path <path>`, `-n, --lines <lines>` (default `50`),
`-f, --follow`, `-l, --level <level>` (`debug`, `info`, `warn`, `error`), and
`-c, --category <category>` (`daemon`, `api`, `memory`, `sync`, `git`,
`watcher`). `restart` accepts `--no-sync` (and the deprecated
`--no-openclaw` alias). The same commands are available as top-level aliases.

Supported desktop installs use the user service manager when available
(systemd user services on Linux, launchd on macOS). There are no separate
public `service install` or `service uninstall` commands; packaged service
installation and removal are handled by the installer/runtime.

## Updates

```bash
signet update check
signet update install
signet update status
signet update channel
signet update channel <channel>
signet update enable
signet update disable
```

`channel` reads or sets the update channel. Use `status` before automation.

## Routing and inference

`route` is also registered as `inference`:

```bash
signet route list
signet route status
signet route doctor
signet route explain <prompt>
signet route test <prompt>
signet route pin <targetRef>
signet route unpin
```

`doctor` accepts `--json`, reports unavailable targets and warnings, and exits
with code 1 when it finds target issues (warnings alone do not fail it).
`explain` accepts `--agent`, `--task-class`, `--operation`, `--privacy`,
`--policy`, `--target`, `--refresh`, `--debug`, and `--json`; it is a dry run
and exits 1 for a failed daemon request. `test` additionally accepts
`--max-tokens`, `--timeout` (1–600000 ms), and the same refresh/debug/json
controls, and exits 1 for invalid options or a failed request.

Use `signet route <command> --help` for the current flag set rather than
relying on stale target or policy prose. Other runtime groups are `mcp`,
`desktop`, and `browse` (`navigate`, `extract`, `watch`).
