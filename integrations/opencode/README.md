# OpenCode Integration

Signet connector for [OpenCode](https://github.com/opencode-ai/opencode).

## What It Does

Integrates Signet's memory system with OpenCode via its plugin system.

- Bundles and writes `signet.mjs` plugin to `~/.config/opencode/plugins/`
- Generates `AGENTS.md` from identity files in your agent workspace
- Registers the plugin in OpenCode's configuration (`opencode.json` / `opencode.jsonc` / `config.json`)
- Symlinks the skills directory for tool access
- Migrates away from the legacy `memory.mjs` approach on install/uninstall
- Supports JSONC configuration files (strips comments before parsing)

## Installation

```bash
signet setup --harness opencode
signet connect opencode --url http://signet-home.tailnet:3850 --api-key sig_sk_...
```

Interactive setup can also detect OpenCode and offer to configure it. On a
machine where you only want to install the OpenCode integration, use the
standalone npm installer:

```bash
npx -y @signetai/connector-opencode install --url http://signet-home.tailnet:3850 --api-key sig_sk_...
```

## Uninstallation

The connector package exposes programmatic cleanup that removes the plugin file and configuration entries. Your memories are preserved in the Signet daemon.

## Package

| Field | Value |
|-------|-------|
| Package | `@signetai/connector-opencode` |
| License | Apache-2.0 |

## Architecture

```
~/.config/opencode/plugins/signet.mjs  <-- bundled plugin
~/.config/opencode/opencode.json       <-- plugin registered here
~/.config/opencode/AGENTS.md           <-- generated identity file
~/.agents/                             <-- agent workspace
```

The connector extends `BaseConnector` from `@signet/connector-base` and ships a self-contained plugin bundle that OpenCode auto-discovers from its plugins directory.
