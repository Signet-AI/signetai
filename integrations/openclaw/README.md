# OpenClaw Integration

Signet connector for [OpenClaw](https://github.com/openclaw/openclaw) (and its earlier names: clawdbot, moltbot).

## What It Does

Integrates Signet's memory system with OpenClaw's hook and workspace configuration.

- Patches OpenClaw config to set `agents.defaults.workspace` to `~/.agents`
- Enables the `signet-memory` internal hook entry
- Installs hook handler files for `/remember`, `/recall`, and `/context` commands
- Supports JSON5 configuration parsing (OpenClaw uses `.json5` / JSONC config files)

Unlike other connectors, OpenClaw reads `~/.agents/AGENTS.md` directly, so no generated output file is needed.

## Installation

```bash
signet setup --harness openclaw
```

Interactive setup can also detect OpenClaw and offer to configure it.

## Uninstallation

The connector package exposes programmatic cleanup that removes hook handlers and configuration patches. Your memories are preserved in the Signet daemon.

## Package

| Field | Value |
|-------|-------|
| Package | `@signetai/connector-openclaw` |
| License | Apache-2.0 |
| Extra dependency | `json5` (for JSONC config parsing) |

## Architecture

```
<openclaw-config>/config.json5  <-- workspace + hook config patched here
<openclaw-hooks>/                <-- hook handler files installed here
~/.agents/AGENTS.md             <-- read directly by OpenClaw
```

The connector extends `BaseConnector` from `@signetai/connector-base` and implements deep-merge config patching with `json5` for JSONC support.
