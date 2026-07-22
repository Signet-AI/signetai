# OpenCode Integration

Signet connector for [OpenCode](https://github.com/opencode-ai/opencode).

## What It Does

Integrates Signet's memory system with OpenCode via its plugin system.

- Bundles and writes `signet.mjs` plugin to `~/.config/opencode/plugins/`
- Generates `AGENTS.md` from identity files in your agent workspace
- Registers the plugin in OpenCode's configuration (`opencode.json` / `opencode.jsonc` / `config.json`)
- Symlinks the skills directory for tool access
- Migrates away from the legacy `memory.mjs` approach on install/uninstall
- Preserves JSONC comments and formatting while applying targeted config updates
- Uses the daemon's authenticated remote MCP endpoint for remote-only installs

## Installation

```bash
signet setup --harness opencode
signet connect opencode --url http://signet-home.tailnet:3850 --api-key sig_sk_...
```

Interactive setup can also detect OpenCode and offer to configure it. On a
machine where you only want to install the OpenCode integration, use the
standalone npm installer:

```bash
npx -y @signetai/connector-opencode install \
  --url http://signet-home.tailnet:3850 \
  --api-key sig_sk_... \
  --agent-id personal
```

This remote-only path does not require or create a local Signet workspace. It
installs the lifecycle plugin and configures `<daemon-origin>/mcp` as an
OpenCode remote MCP server with bearer authentication. The API key is stored in
a mode-0600 connector-managed file and referenced through OpenCode's `{file:}`
substitution rather than written into the config or plugin. Local installs
without `--url` continue to use the `signet-mcp` stdio command.

## Uninstallation

The connector package exposes programmatic cleanup that removes the plugin file and configuration entries. Your memories are preserved in the Signet daemon.

## Package

| Field | Value |
|-------|-------|
| Package | `@signetai/connector-opencode` |
| License | Apache-2.0 |

## Architecture

```
~/.config/opencode/plugins/signet.mjs       <-- bundled plugin
~/.config/opencode/plugins/.signet-api-key  <-- protected key file when configured
~/.config/opencode/opencode.jsonc           <-- plugin and MCP registered here by default
~/.config/opencode/AGENTS.md           <-- generated only for a local managed identity
~/.agents/                             <-- optional for remote-only installs
```

The connector extends `BaseConnector` from `@signet/connector-base` and ships a self-contained plugin bundle that OpenCode auto-discovers from its plugins directory.
