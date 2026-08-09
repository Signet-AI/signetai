---
title: "OpenCode"
description: "Connect Signet to OpenCode."
---

## OpenCode

OpenCode is an open-source AI coding tool. Signet integrates via a
bundled plugin and AGENTS.md sync.

### Files managed by Signet

| File | Description |
|------|-------------|
| `~/.config/opencode/AGENTS.md` | Auto-synced from `$SIGNET_WORKSPACE/AGENTS.md` |
| `~/.config/opencode/plugins/signet.mjs` | Bundled plugin providing memory tools |

### Plugin Bundle

During `signet install`, the connector writes a self-contained
`signet.mjs` file to `~/.config/opencode/plugins/` and registers
`./plugins/signet.mjs` in the OpenCode config so the runtime loads it
consistently at startup.

The plugin is built from `@signet/opencode-plugin` source and bundled
into a single ESM file at build time (stored as a string constant in
`plugin-bundle.ts`). This means the plugin has no external dependencies
at runtime.

The previous approach (`memory.mjs` in the OpenCode root directory)
is considered legacy. The connector automatically migrates away from
it during install by deleting the old file and scrubbing any
`memory.mjs` references from the config's `plugin` or `plugins` arrays.

### Config File Detection

The connector writes the highest-precedence global OpenCode config file:

1. `~/.config/opencode/opencode.jsonc`
2. `~/.config/opencode/opencode.json`
3. `~/.config/opencode/config.json`

This matches OpenCode's load order, where `opencode.jsonc` is merged last. If
none exist, `opencode.jsonc` is created. Config updates are targeted JSONC
edits, so comments, trailing commas, and unrelated settings are preserved.

### MCP Tools

The plugin handles lifecycle hooks; MCP provides on-demand Signet tools. A
local install without an explicit daemon URL uses the packaged stdio command:

```json
{
  "mcp": {
    "signet": {
      "type": "local",
      "command": ["signet-mcp"],
      "enabled": true
    }
  }
}
```

A standalone remote install with `--url` uses OpenCode's remote MCP transport
instead, pointing at `<daemon-origin>/mcp`, setting `oauth: false`, and adding
the supplied API key as a bearer header. The key is kept in a mode-0600 managed
file referenced through OpenCode's `{file:}` substitution, not embedded in the
config or plugin. This path does not require or create a local Signet identity
workspace.

### Supported hooks

| Hook | Supported |
|------|-----------|
| session-start | yes |
| user-prompt-submit | yes |
| pre-compaction | yes |
| compaction-complete | yes |
| session-end | yes |

### Prerequisites

- OpenCode installed
- `~/.config/opencode/` directory exists

---
