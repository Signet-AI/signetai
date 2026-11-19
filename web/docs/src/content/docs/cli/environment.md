---
title: "CLI environment and exit codes"
description: "Environment variables, workspace resolution, and automation boundaries."
---

## Workspace resolution

The CLI, connector base, and desktop shell use this resolution order:

1. `SIGNET_PATH`
2. `SIGNET_WORKSPACE`
3. Persisted `$XDG_CONFIG_HOME/signet/workspace.json` with a `workspace` field
4. `~/.agents`

Use `signet workspace status` to see the effective path, state, and source. `signet workspace set <path>` writes the persisted selection. `SIGNET_PATH` takes precedence over both the persisted setting and `SIGNET_WORKSPACE`.

The daemon and client surfaces use this same resolution order. Once a workspace is configured, daemon startup fails closed if the selected directory, workspace configuration, or memory database is missing. Restore the configured path or use an explicit setup or replacement action; Signet does not silently bootstrap a replacement at the old path.

Workspace status is `fresh` for an unconfigured default, `ready` when the configuration and database are present, `missing` when a configured directory is absent, and `incomplete` when an established workspace is missing required state. Legacy installations without a dedicated workspace identity marker remain supported through the persisted workspace selection and existing configuration/database files.

## Daemon and client variables

| Variable | Used by | Meaning |
|---|---|---|
| `SIGNET_PATH` | CLI, connector/desktop resolver, daemon | Highest-precedence workspace path. |
| `SIGNET_WORKSPACE` | CLI, connector/desktop resolver, daemon | Lower-precedence workspace alias. |
| `SIGNET_PORT` | daemon and local clients | HTTP port. Default: `3850`. |
| `SIGNET_HOST` | daemon and local clients | Explicit daemon host override. Without it, the daemon derives its host from `agent.yaml` network configuration. |
| `SIGNET_BIND` | daemon | Explicit listen-address override. Without it, `network.mode: localhost` binds `127.0.0.1`; `network.mode: tailscale` binds `0.0.0.0`. |
| `SIGNET_DAEMON_URL` | CLI and connector clients | Remote daemon origin. It takes precedence over the local host/port client URL. |
| `SIGNET_API_KEY` | CLI and connector clients | Bearer credential for protected daemon calls. |
| `SIGNET_TOKEN` | CLI and connector clients | Backwards-compatible bearer-credential alias. |
| `SIGNET_LOG_FILE` | daemon | Explicit log file path. |
| `SIGNET_LOG_DIR` | daemon | Daemon log-directory override. |
| `SIGNET_BYPASS` | harness hooks | Skip hook processing for that process. |

`SIGNET_ADMIN_PASSWORD`, `SIGNET_ADMIN_PASSWORD_HASH`, and `SIGNET_ADMIN_USERNAME` configure the optional dashboard password login. They are credential inputs, not general shell configuration; use a secret manager or service-environment mechanism and do not commit them. See [Authentication](/auth/).

## Hook timeout variables

| Variable | Default | Meaning |
|---|---:|---|
| `SIGNET_SESSION_START_TIMEOUT` | `15000` ms | Session-start daemon wait budget for Signet-managed clients. |
| `SIGNET_FETCH_TIMEOUT` | `15000` ms | Legacy session-start fallback when `SIGNET_SESSION_START_TIMEOUT` is unset or blank. |
| `SIGNET_PROMPT_SUBMIT_TIMEOUT` | `5000` ms | Prompt-submit daemon wait budget. Harness-specific generated configs add their documented grace time when they are written; rerun `signet setup` after changing it. |

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Command completed successfully. |
| `1` | General command, validation, daemon, or request error. |

Scripts should inspect both the exit code and structured `--json` output when a command supports it. Do not treat a successful process launch as proof that a remote daemon accepted an authenticated request.
