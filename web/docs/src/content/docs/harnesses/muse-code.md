---
title: "Muse Code"
description: "Connect Signet to Meta's Muse Code CLI through lifecycle hooks and MCP."
---

Signet connects to [Muse Code](https://dev.meta.ai/docs/muse-code), Meta's terminal coding agent, through its settings-file hooks and MCP server registry.

## Setup

Select Muse Code in the interactive wizard, or run:

```bash
signet setup --harness muse-code
```

The connector edits `~/.config/muse/settings.json` (or `$XDG_CONFIG_HOME/muse/settings.json`). It adds Signet hook groups under `hooks` and a `signet` entry under `mcp_servers`, and leaves model settings, other hooks, and other MCP servers untouched. Re-running setup replaces only Signet-owned entries.

Muse requires `"schema_version": 1` in that file. When the file is missing, Signet creates it with that version. When it exists but is not valid JSON, lacks `schema_version: 1`, or has a non-object `hooks` or `mcp_servers` block, setup refuses to modify it and reports why. Muse itself rejects such a file, so fix it first.

Signet detects Muse from its config directory, its data directory (`~/.local/share/muse`), or a `muse` binary on `PATH`.

## Hook behavior

| Muse event | Signet command | Effect |
| --- | --- | --- |
| `SessionStart` | `signet hook session-start -H muse-code --codex-json` | Injects identity and recalled context as a developer context block. |
| `UserPromptSubmit` | `signet hook user-prompt-submit -H muse-code --codex-json` | Injects prompt-time recall and clock context. |
| `Stop` | `signet hook session-end -H muse-code` | Records a turn checkpoint and runs deferred session-end work. |

Context hooks emit `hookSpecificOutput.additionalContext` JSON. Muse parses hook stdout as JSON whenever it starts with `[` or `{`, so plain Signet context, which begins with `[signet active]`, would be rejected as malformed.

Signet uses `Stop` instead of `SessionEnd`. Muse cancels unfinished `SessionEnd` hooks within about half a second of its shutdown budget, which is shorter than the Signet CLI needs to start. Muse's `SessionEnd` payload carries `reason: "other"`, which the daemon treats as a turn checkpoint, so `Stop` delivers the same request at a point where it can complete.

Muse sends `transcript_path: null` in hook payloads, so Signet captures Muse sessions from the hook stream keyed by Muse's `session_id`. It does not read Muse's own session log. `PreCompact` is not installed.

## Environment

Muse runs hook commands with a cleared environment that keeps only `HOME`, `PATH`, `USER`, `SHELL`, `TERM`, `LANG`, `PWD`, and `LOGNAME`. Setup therefore writes the values hooks need into each command:

- `SIGNET_PATH` is always set to the workspace selected during setup.
- `SIGNET_DAEMON_URL` is set when the resolved daemon address differs from `http://127.0.0.1:3850`, including `SIGNET_HOST`/`SIGNET_PORT` overrides.
- `SIGNET_API_KEY` is set when it is present at setup time. It is then stored in `settings.json` in plain text, as with other harness configurations that carry daemon credentials.

The MCP entry receives the same values through its `env` block and is registered with `mode: "optional"`. A required server that fails to start aborts every Muse run; an optional one is skipped with a startup warning.

Re-run setup after changing the workspace, daemon address, or API key.

## Skills

Muse discovers skills from `~/.agents/skills` on its own, so Signet does not link a skills directory. If your Signet workspace is not `~/.agents`, setup warns that workspace skills are not visible to Muse.

## Platform support

Setup is supported on macOS and Linux. On Windows, Muse runs hooks through PowerShell, and setup refuses rather than writing POSIX hook commands.

## Remove the integration

Disconnect Muse Code from the dashboard's harness list, or run the connector's uninstall command:

```bash
bunx @signetai/connector-muse-code uninstall
```

Uninstall removes only Signet-owned hooks and the `signet` MCP entry, and keeps `schema_version` and the rest of the file.
