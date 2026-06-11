# Gemini CLI Integration

Signet connector for [Gemini CLI](https://github.com/google-gemini/gemini-cli).

## What It Does

Integrates Signet's memory system with Gemini CLI's settings and extension model.

- Patches Gemini CLI settings to register the Signet MCP server
- Symlinks the agent skills directory into the Gemini workspace
- Generates `AGENTS.md` identity files from your agent workspace
- Validates workspace path boundaries to prevent misconfiguration

## Installation

```bash
signet setup --harness gemini
```

Interactive setup can also detect Gemini CLI and offer to configure it.

## Uninstallation

The connector package exposes programmatic cleanup that removes settings patches and symlinks. Your memories are preserved in the Signet daemon.

## Package

| Field | Value |
|-------|-------|
| Package | `@signet/connector-gemini` |
| License | Apache-2.0 |

## Architecture

```
~/.gemini/settings.json    <-- MCP server registered here
~/.agents/                 <-- agent workspace (identity, skills, memories)
```

The connector extends `BaseConnector` from `@signet/connector-base` and implements `install()` / `uninstall()` for reversible setup.
