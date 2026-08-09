---
title: "CLI environment and exit codes"
description: "Environment variables and exit-code contracts for automation."
---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SIGNET_PORT` | Daemon HTTP port | `3850` |
| `SIGNET_PATH` | Base agents directory | `$SIGNET_WORKSPACE` |
| `SIGNET_HOST` | Daemon host for local calls and default bind address | `127.0.0.1` |
| `SIGNET_BIND` | Explicit daemon bind address override | `SIGNET_HOST` |
| `SIGNET_LOG_FILE` | Explicit daemon log file path | unset |
| `SIGNET_LOG_DIR` | Daemon log directory override | `$SIGNET_WORKSPACE/.daemon/logs` |
| `SIGNET_SQLITE_PATH` | macOS explicit SQLite dylib override used by the daemon before opening the database | unset |
| `SIGNET_SESSION_START_TIMEOUT` | Session-start daemon wait budget in ms for Signet-managed clients. Generated Claude Code hook config writes this value directly. Generated Codex hook config rounds up to seconds and adds 5 seconds of harness grace | `15000` |
| `SIGNET_FETCH_TIMEOUT` | Legacy fallback for session-start timeout in ms when `SIGNET_SESSION_START_TIMEOUT` is unset | `15000` |
| `SIGNET_PROMPT_SUBMIT_TIMEOUT` | Prompt-submit daemon wait budget in ms; OpenCode uses this value directly, generated Claude Code hook config writes this value + 2000 ms grace, and generated Codex hook config rounds up to seconds and adds 2 seconds of harness grace | `5000` |
| `SIGNET_BYPASS` | Skip all hook processing (exit immediately) | unset |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
