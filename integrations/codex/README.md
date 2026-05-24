# Codex CLI Integration

Signet connector for [Codex CLI](https://github.com/openai/codex).

## What It Does

Integrates Signet's memory system with Codex CLI's hook and MCP configuration.

- Registers JSON hooks at `~/.codex/hooks.json` for `SessionStart`, `UserPromptSubmit`, and `SessionEnd` events
- Registers the Signet MCP server in `~/.codex/config.toml`
- Configurable timeout grace periods (5 s for SessionStart, 2 s for UserPromptSubmit)
- Supports remote daemon URL via `SIGNET_DAEMON_URL` environment variable

## Installation

```bash
signet setup --harness codex
```

Interactive setup can also detect Codex CLI and offer to configure it.

## Uninstallation

The connector package exposes programmatic cleanup that removes hooks and MCP server registration. Your memories are preserved in the Signet daemon.

## Package

| Field | Value |
|-------|-------|
| Package | `@signet/connector-codex` |
| License | Apache-2.0 |

## Architecture

```
~/.codex/hooks.json        <-- hooks registered here
~/.codex/config.toml       <-- MCP server registered here
~/.agents/                 <-- agent workspace (identity, skills, memories)
```

The connector extends `BaseConnector` from `@signet/connector-base` and implements `install()` / `uninstall()` for reversible setup.
