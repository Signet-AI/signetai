# Codex CLI Integration

Signet connector for [Codex CLI](https://github.com/openai/codex).

## What It Does

Integrates Signet with Codex CLI through the native Codex plugin surfaces when
available, with a compatibility path for older Codex installs.

- Installs a local Codex plugin marketplace bundle with Signet metadata, skills,
  and MCP configuration
- Registers compatibility lifecycle hooks for `SessionStart`,
  `UserPromptSubmit`, and `SessionEnd` while Codex plugin hook loading is not
  available
- Falls back to direct `hooks.json` and `[mcp_servers.signet]` patching for
  older Codex versions
- Indexes Codex native memory files as Signet source artifacts without editing
  Codex-generated `MEMORY.md` or `memory_summary.md`
- Configurable timeout grace periods (5 s for SessionStart, 2 s for UserPromptSubmit)
- Supports remote daemon URL via `SIGNET_DAEMON_URL` environment variable

## Installation

```bash
signet setup --harness codex
```

Interactive setup can also detect Codex CLI and offer to configure it.

## Uninstallation

The connector package exposes programmatic cleanup that removes plugin,
compatibility hook, and MCP registrations. Codex native memories and Signet
daemon memories are preserved.

## Package

| Field | Value |
|-------|-------|
| Package | `@signet/connector-codex` |
| License | Apache-2.0 |

## Architecture

```
~/.codex/.tmp/signet-plugin-marketplace/   <-- generated local plugin bundle
~/.codex/config.toml                       <-- marketplace/plugin config
~/.codex/hooks.json                        <-- compatibility lifecycle hooks
~/.codex/memories/                         <-- Codex-owned memory source
~/.agents/                                 <-- Signet workspace
```

The connector extends `BaseConnector` from `@signet/connector-base` and implements `install()` / `uninstall()` for reversible setup.

The Codex plugin exposes Signet-specific tools such as `signet_recall`,
`signet_source_search`, `signet_session_search`, and `signet_save_note`.
Legacy `memory_*` tools remain available for compatibility, but Codex-facing
skills prefer the Signet-specific names to avoid confusing Signet recall with
Codex native memory.
