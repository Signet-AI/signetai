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

Muse requires `"schema_version": 1` in that file. When the file is missing, Signet creates it with that version. Setup refuses to modify the file, and reports why, in these cases:

- it is not valid JSON;
- it lacks `schema_version: 1`;
- `hooks` or `mcp_servers` is not an object;
- a hook group is not an object with a `hooks` array of objects, or a handler `timeout` is not a non-negative integer.

Muse rejects the first three outright, and either of the last problems disables every hook in the file. Other handler problems, such as a missing command, make Muse skip only that handler, so setup leaves them alone. Fix the file first. A symlinked `settings.json` is updated at its target.

Signet detects Muse from its config directory, its data directory (`~/.local/share/muse`), or a `muse` binary on `PATH`.

## Hook behavior

| Muse event | Signet command | Effect |
| --- | --- | --- |
| `SessionStart` | `signet hook session-start -H muse-code --codex-json` | Injects identity and recalled context as a developer context block. |
| `UserPromptSubmit` | `signet hook user-prompt-submit -H muse-code --codex-json` | Injects prompt-time recall and clock context. |
| `Stop` | `signet hook session-end -H muse-code` | Records a turn checkpoint and runs deferred session-end work. |

Context hooks emit `hookSpecificOutput.additionalContext` JSON. Muse parses hook stdout as JSON whenever it starts with `[` or `{`, so plain Signet context, which begins with `[signet active]`, would be rejected as malformed.

Signet uses `Stop` instead of `SessionEnd`. Muse cancels unfinished `SessionEnd` hooks within about half a second of its shutdown budget, which is shorter than the Signet CLI needs to start. Muse's `SessionEnd` payload carries `reason: "other"`, which the daemon treats as a turn checkpoint, so `Stop` delivers the same request at a point where it can complete.

Muse sends `transcript_path: null` in hook payloads, so Signet records Muse sessions from the hook stream keyed by Muse's `session_id`: each prompt from `UserPromptSubmit`, and each turn's final assistant reply from the `last_assistant_message` field of `Stop`. Intermediate assistant text and tool calls within a turn are not recorded, and Signet does not read Muse's own session log. `PreCompact` is not installed.

## Environment

Muse starts hook commands and MCP servers with a cleared environment. Hooks keep only `HOME`, `PATH`, `USER`, `SHELL`, `TERM`, `LANG`, `PWD`, and `LOGNAME`. Setup therefore writes the same set of values into each hook command and into the MCP entry's `env` block, so both reach the same daemon and workspace:

- `SIGNET_PATH` is always set to the absolute workspace path selected during setup.
- `SIGNET_DAEMON_URL` is set when the resolved daemon address differs from `http://127.0.0.1:3850`, including `SIGNET_HOST`/`SIGNET_PORT` overrides.
- `SIGNET_API_KEY` is set when it is present at setup time, and is then stored in `settings.json` in plain text. A settings file that Signet creates is written with mode `0600`. Signet does not change the mode of an existing file.
- `SIGNET_SESSION_START_TIMEOUT`, `SIGNET_FETCH_TIMEOUT`, and `SIGNET_PROMPT_SUBMIT_TIMEOUT` are carried over when set, and size the hook timeouts.

When setup runs from the native `signet` binary, the hooks and the MCP server use that same binary path. Otherwise the hooks call `signet` from `PATH`. The MCP entry is registered with `mode: "optional"`. A required server that fails to start aborts every Muse run; an optional one is skipped with a startup warning.

Re-run setup after changing the workspace, daemon address, API key, or timeouts.

## Agent identity

`signet hook user-prompt-submit` and `session-end` have no agent option, so Muse hooks write as the daemon's default agent. Setup refuses when `SIGNET_AGENT_ID` names another agent, rather than splitting a session between agents.

## Skills

Muse discovers skills from `~/.agents/skills` on its own, so Signet does not link a skills directory. If your Signet workspace is not `~/.agents`, setup warns that workspace skills are not visible to Muse.

## Platform support

Setup is supported on macOS and Linux. On Windows, Muse runs hooks through PowerShell, and setup refuses rather than writing POSIX hook commands.

## Remove the integration

Disconnect Muse Code from the dashboard's harness list, or run the connector's uninstall command:

```bash
bunx @signetai/connector-muse-code uninstall
```

Uninstall removes only Signet-owned hooks and the `signet` MCP entry, and keeps `schema_version` and the rest of the file. If the file cannot be parsed, uninstall fails with the reason instead of reporting success.
