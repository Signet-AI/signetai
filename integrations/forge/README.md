# ForgeCode Integration

Signet connector for [ForgeCode](https://forgecode.dev).

## What It Does

Integrates Signet's memory system with ForgeCode's configuration and hook system.

- Registers the Signet MCP server in ForgeCode's MCP configuration
- Symlinks the agent skills directory into the ForgeCode workspace
- Generates `AGENTS.md` identity files from your agent workspace
- Manages marker-tagged configuration entries for clean install/uninstall

## Installation

```bash
signet setup --harness forge
```

Interactive setup can also detect ForgeCode and offer to configure it.

## Uninstallation

The connector package exposes programmatic cleanup that removes configuration entries and symlinks. Your memories are preserved in the Signet daemon.

## Package

| Field | Value |
|-------|-------|
| Package | `@signet/connector-forge` |
| License | Apache-2.0 |

## Architecture

```
~/.forge/mcp.json          <-- MCP server registered here
~/.agents/                 <-- agent workspace (identity, skills, memories)
```

The connector extends `BaseConnector` from `@signet/connector-base` and implements `install()` / `uninstall()` for reversible setup.
