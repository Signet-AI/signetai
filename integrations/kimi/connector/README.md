# @signet/connector-kimi

Signet connector for [Kimi CLI / Kimi Code](https://github.com/MoonshotAI/kimi-cli).

## What it does

- Merges Signet lifecycle hooks into Kimi's `config.toml` as `[[hooks]]` entries (`SessionStart`, `UserPromptSubmit`, `SessionEnd`) — existing user config and hooks are preserved, installs are idempotent.
- Registers the Signet MCP stdio server in Kimi's `mcp.json` (`mcpServers.signet`).
- Makes Signet workspace skills available in Kimi's selected home.

Current Kimi uses `KIMI_SHARE_DIR` (default `~/.kimi`). Legacy Kimi Code 0.x
uses `KIMI_CODE_HOME` (default `~/.kimi-code`). The connector prefers explicit
environment overrides, then an existing current or legacy home.

## Usage

```sh
signet-connector-kimi install
signet-connector-kimi status
signet-connector-kimi uninstall
```

Or via the Signet CLI: `signet setup` / `signet connector install kimi`.
