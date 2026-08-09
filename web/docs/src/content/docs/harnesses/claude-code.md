---
title: "Claude Code"
description: "Connect Signet to Claude Code."
---

## Claude Code

Claude Code is Anthropic's official CLI for Claude. It reads configuration from `~/.claude/`.

### Files managed by Signet

| File | Description |
|------|-------------|
| `~/.claude/CLAUDE.md` | Auto-synced from `$SIGNET_WORKSPACE/AGENTS.md` |
| `~/.claude/settings.json` | Hook configuration (written once during setup) |

### Memory hooks

Signet writes [Hooks](/hooks/) to `~/.claude/settings.json` that fire at session lifecycle events. The hooks call the Signet [CLI](/cli/), which routes requests through the daemon HTTP API:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "signet hook session-start -H claude-code --project \"$(pwd)\"",
        "timeout": 3000
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "signet hook user-prompt-submit -H claude-code --project \"$(pwd)\"",
        "timeout": 7000
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "signet hook session-end -H claude-code",
        "timeout": 15000
      }]
    }]
  }
}
```

Prompt-submit timeout note: `SIGNET_PROMPT_SUBMIT_TIMEOUT` defaults to
`5000` (daemon wait budget). Claude Code hook config adds a `+2000ms`
grace buffer when written to `settings.json`, so the installed
`UserPromptSubmit` timeout default is `7000`.

Upgrade note: Claude Code hook timeouts are written to
`~/.claude/settings.json` at install/update time. Existing installs keep
their previous timeout values until you rerun `signet connect
claude-code` (or `signet setup`) to rewrite hook config.

**SessionStart** — loads memories and context, outputs them as text that Claude Code injects into the system prompt.

**UserPromptSubmit** — optionally loads per-prompt context (lighter weight than session start).

**SessionEnd** — automatically saves a session summary to memory.

### Native memory bridge

Signet indexes Claude Code-owned memdir artifacts without rewriting them or
turning them into Signet-authored rows. The daemon watches Claude Code
entrypoint indexes and memory files under `~/.claude/projects/*/memory/`,
session memory under `~/.claude/session-memory/`, and agent-scoped memory
under `~/.claude/agent-memory/` and `~/.claude/agent-memory-local/`. Matching
content is exposed through Signet recall as `native_memory` results with
Claude Code provenance. Removed native files are soft-deleted from active
recall while preserving their artifact rows for lineage.

This replaces the older daemon-local Claude watcher that only read
`~/.claude/projects/*/memory/MEMORY.md` and pushed chunks back through
`/api/memory/remember`. Claude Code remains the owner of those native files;
Signet indexes them as artifacts.

### Using /remember and /recall

In Claude Code sessions, use these commands directly:

```
/remember nicholai prefers bun over npm
/recall coding preferences
```

These work via the built-in skills in `$SIGNET_WORKSPACE/skills/`. The skill instructions tell Claude how to call the Signet daemon API.

### MCP Tools

Claude Code also gets native MCP tool access to Signet memory via the
`signet-mcp` stdio server, registered in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "signet": {
      "type": "stdio",
      "command": "signet-mcp",
      "args": []
    }
  }
}
```

This gives Claude Code direct access to `memory_search`, `session_search`,
`memory_store`, `memory_get`, `memory_list`, `memory_modify`, and
`memory_forget` tools.

### Prerequisites

- Claude Code installed and in `PATH`
- `~/.claude/` directory exists

---
