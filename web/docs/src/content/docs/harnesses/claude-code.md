---
title: "Claude Code"
description: "Connect Signet to Claude Code."
---

## Claude Code

The Claude Code connector installs Signet lifecycle hooks, a skills symlink, and an MCP registration. Run `signet setup` and select Claude Code, or rerun the Claude Code connector after an upgrade.

### Files managed by Signet

| Location | Purpose |
|---|---|
| `~/.claude/settings.json` | Signet hook configuration |
| `~/.claude.json` | Top-level `mcpServers.signet` registration |
| `~/.claude/skills` | Symlink to the Signet workspace skills directory |

Signet no longer generates `~/.claude/CLAUDE.md`. Identity and memory context are delivered by the session-start hook. During installation, Signet removes only a stale `CLAUDE.md` that it can identify as previously generated; it does not replace user-authored files.

### Hook behavior and timeouts

The connector writes hooks to `~/.claude/settings.json`:

| Hook | Signet command | Installed timeout |
|---|---|---|
| `SessionStart` | `signet hook session-start -H claude-code --project "$(pwd)"` | resolved session-start budget plus 2 seconds |
| `UserPromptSubmit` | `signet hook user-prompt-submit -H claude-code --project "$(pwd)"` | resolved prompt-submit budget plus 2 seconds |
| `PreToolUse` | `signet hook notifications -H claude-code --hook PreToolUse --project "$(pwd)" --hook-json` | 3 seconds |
| `PreCompact` | `signet hook pre-compaction -H claude-code --project "$(pwd)"` | 3 seconds |
| `SessionEnd` | `signet hook session-end -H claude-code` | 15 seconds |

Signet identifies its own entries by their `signet hook <name> -H claude-code` command. Installation adds the Signet hook groups after the groups already on each event. A later installation replaces only the Signet entries, and disconnecting Claude Code removes only those entries. Hooks you add yourself stay in place. If `settings.json` is not valid JSON, or its `hooks` value is not an object, installation and disconnect stop with an error and leave the file unchanged.

The default daemon session-start budget is 15 seconds, so the default installed `SessionStart` timeout is 17 seconds. The connector computes this when it writes the configuration from `SIGNET_SESSION_START_TIMEOUT` (or the compatibility fetch-timeout variable). It does not assume a home directory or bake a personal path into the hook command.

Likewise, the prompt-submit hook uses the resolved `SIGNET_PROMPT_SUBMIT_TIMEOUT` plus two seconds. Existing settings are not changed until setup or connector installation runs again.

### MCP tools

The connector writes the stdio server to `~/.claude.json`, not `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "signet": {
      "type": "stdio",
      "command": "signet-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

See the [MCP server reference](/mcp/) for the current tool schemas. Hooks supply automatic lifecycle context; MCP tools are for agent-initiated operations.

### Native memory bridge

Signet indexes Claude Code-owned memory artifacts without rewriting them into Signet-authored files. Recall surfaces expose matching entries with Claude Code provenance. Removing a native file removes it from active recall while preserving the artifact record for lineage.

### Commands in a session

When the matching skills are installed, Claude Code can use:

```text
/remember a durable preference or decision
/recall the decision about the deployment workflow
```

### Prerequisites

- Claude Code is installed and available in `PATH`.
- The Signet daemon is running.
- The connector is installed through `signet setup` or the Claude Code connector command.
