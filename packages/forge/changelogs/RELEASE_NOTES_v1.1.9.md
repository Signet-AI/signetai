# Forge v1.1.9

## Highlights

- installed **Signet skills** now become automatic Forge slash commands
- installed **Signet MCP servers and tools** now become automatic Forge slash commands
- skill slash commands support:
  - `/skill-name` to arm the next prompt with the skill
  - `/skill-name <prompt>` to run immediately with the skill
- MCP slash commands support:
  - `/mcp`
  - `/mcp-<server-id> <tool> [json args]`
  - `/mcp-<server-id>-<tool-name> [json args]`

## Also included

- persisted CLI auth detection for supported CLI providers
- refreshed connected-model discovery when opening `/model`
- curated CLI model coverage for Codex/Claude/Gemini
- Codex CLI model selection is now actually applied via `codex exec --model`
