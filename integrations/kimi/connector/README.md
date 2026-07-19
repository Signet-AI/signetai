# @signet/connector-kimi

Signet connector for [Kimi CLI / Kimi Code](https://github.com/MoonshotAI/kimi-cli).

## What it does

- Merges Signet lifecycle hooks into `~/.kimi-code/config.toml` as `[[hooks]]` entries (`SessionStart`, `UserPromptSubmit`, `SessionEnd`) — existing user config and hooks are preserved, installs are idempotent.
- Registers the Signet MCP stdio server in `~/.kimi-code/mcp.json` (`mcpServers.signet`).
- Symlinks the Signet workspace skills into `~/.kimi-code/skills`.

The config home respects `KIMI_CODE_HOME` (default `~/.kimi-code`).

## Usage

```sh
signet-connector-kimi install
signet-connector-kimi status
signet-connector-kimi uninstall
```

Or via the Signet CLI: `signet setup` / `signet connector install kimi`.
