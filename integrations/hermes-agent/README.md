# Hermes Agent Integration

Signet connector for [Hermes Agent](https://github.com/hermes-ai/hermes-agent) -- installs Signet as a pluggable memory provider.

## What It Does

Integrates Signet's memory system into Hermes Agent as a native plugin.

- Installs the Signet memory plugin into the Hermes plugin directory
- Registers memory tools: `memory_search`, `memory_store`, `memory_get`, `memory_list`, `memory_modify`, `memory_forget`, `session_search`, `recall`, and `remember`
- Backs up existing provider configuration for safe uninstallation
- Uses content hashing to detect when the plugin needs updating

## Installation

```bash
signet setup --harness hermes-agent
```

Interactive setup can also detect Hermes Agent and offer to configure it.

## Uninstallation

The connector package exposes programmatic cleanup that restores the previous memory provider configuration. Your memories are preserved in the Signet daemon.

## Package

| Field | Value |
|-------|-------|
| Package | `@signet/connector-hermes-agent` |
| License | Apache-2.0 |

## Architecture

```
<hermes-home>/plugins/signet/   <-- plugin files installed here
<hermes-home>/signet.install.json <-- install marker with metadata
~/.agents/                       <-- agent workspace (identity, skills, memories)
```

The connector extends `BaseConnector` from `@signet/connector-base` and ships a bundled Python plugin (`__init__.py`, `client.py`, `plugin.yaml`).
