# Claude Code Integration

Signet connector for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic CLI).

## What It Does

Integrates Signet's memory system with Claude Code's lifecycle hooks so your agent retains context across sessions.

- Registers hook scripts in `~/.claude/settings.json` for `SessionStart`, `UserPromptSubmit`, `PreCompact`, and `SessionEnd` events
- Registers the Signet MCP server in `~/.claude.json` for tool-based memory access
- Generates `AGENTS.md` identity files from your agent workspace

## Installation

```bash
signet setup --harness claude-code
```

Interactive setup can also detect Claude Code and offer to configure it.

## Uninstallation

The connector package exposes programmatic cleanup that removes hooks and MCP server registration. Your memories are preserved in the Signet daemon.

## Package

| Field | Value |
|-------|-------|
| Package | `@signet/connector-claude-code` |
| License | Apache-2.0 |

## Architecture

```
~/.claude/settings.json    <-- hooks registered here
~/.claude.json             <-- MCP server registered here
~/.agents/                 <-- agent workspace (identity, skills, memories)
```

The connector extends `BaseConnector` from `@signet/connector-base` and implements `install()` / `uninstall()` for reversible setup.
