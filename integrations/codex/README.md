# Codex and ChatGPT Desktop Integration

Signet connector for [Codex CLI](https://github.com/openai/codex) and the
Codex runtime bundled inside the ChatGPT desktop app.

## What It Does

Integrates Signet with Codex CLI and ChatGPT desktop Work/Codex mode through
the native Codex plugin surfaces when available, with a compatibility path for
older Codex installs.

- Installs a local Codex plugin marketplace bundle with Signet metadata, hooks,
  and MCP configuration
- Discovers `Codex.app` and `ChatGPT.app` on macOS, the ChatGPT resource roots
  used by Linux desktop packages, and known per-user/system Windows roots,
  including bundled Codex executables and Node runtimes, so native plugin
  installation does not depend on the desktop app's shell `PATH`
- Honors `CODEX_HOME` (including `~` expansion) so multiple Codex clients on
  the same OS can deliberately share or separate their plugin/config state
- Uses absolute Signet launch commands when running from the packaged native
  binary; the MCP worker is started with `SIGNET_MCP_STDIO_WORKER=1`
- On Windows, writes a hashed `.cmd` hook wrapper so Codex can launch paths
  containing spaces without embedding environment assignments in its wrapped
  `cmd.exe /C` command line
- Registers compatibility lifecycle hooks for `SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, and `Stop` when native plugin hooks are not
  available
- Falls back to direct `hooks.json` and `[mcp_servers.signet]` patching for
  older Codex versions
- Indexes Codex native memory files as Signet source artifacts without editing
  Codex-generated `MEMORY.md` or `memory_summary.md`
- Configurable timeout grace periods (5 s for SessionStart, 2 s for UserPromptSubmit)
- Supports remote daemon URL via `SIGNET_DAEMON_URL` environment variable
- Discovers and validates the bundled desktop Node runtime on install and
  refreshes only stale Signet-owned hook and MCP commands after a desktop
  packaging update

## Installation

```bash
signet setup --harness codex
signet connect codex --url http://signet-home.tailnet:3850 --api-key sig_sk_...
```

For a remote Codex install that must write to one Signet agent, create the API
key with that agent scope on the daemon machine before installing:

```bash
signet api-key create --name "codex tailnet" --connector codex --agent-id <agent-name>
signet connect codex --url http://signet-home.tailnet:3850 --api-key sig_sk_...
```

The `--agent-id` on `signet api-key create` is enforced by daemon auth scope;
Codex requests using that key default to the scoped agent and cannot access another
agent's scoped data.

Interactive setup can also detect Codex CLI and offer to configure it. On a
machine where you only want to install the Codex integration, use the standalone
npm installer. The same installer works when the only Codex executable is the
one bundled by ChatGPT.app:

```bash
npx -y @signetai/codex-plugin install --url http://signet-home.tailnet:3850 --api-key sig_sk_...
```

## Uninstallation

The connector package exposes programmatic cleanup that removes plugin,
compatibility hook, and MCP registrations. Codex native memories and Signet
daemon memories are preserved.

## Package

| Field | Value |
|-------|-------|
| Package | `@signetai/connector-codex` |
| Native plugin installer | `@signetai/codex-plugin` |
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

The generated bundle uses the `.codex-plugin`/`.mcp.json` compatibility layout
that current Codex CLI and ChatGPT desktop Work/Codex runtimes load for local
stdio servers. A separate portable root manifest is intentionally deferred:
the current bundled Codex runtime does not load local stdio MCP reliably when
that manifest is present. When native plugin support is available, the Codex
CLI owns marketplace and plugin state; Signet only patches the legacy global
MCP/hooks path when it must fall back.

On Windows, the native ChatGPT app and native Codex CLI normally share
`%USERPROFILE%\\.codex`. Keep WSL/Linux and macOS installs on their native state
directories instead of pointing them at a Windows `CODEX_HOME`: generated hook
and MCP commands contain platform-specific absolute paths and Windows `.cmd`
wrappers. Install the integration separately per OS when those environments
need Signet. The Linux ChatGPT desktop app is currently preview software; the
connector checks its standard `/usr/lib/chatgpt`, `/opt/chatgpt`, and per-user
resource roots, then falls back to `PATH`.

In ChatGPT desktop Work/Codex mode, Codex presents the generated plugin hooks
for one-time manual review. Approve the Signet hooks in the desktop prompt so
they can run outside the sandbox; choosing to continue without trust leaves
the plugin installed but disables its lifecycle hooks. This integration targets
the local Codex runtime used by Work/Codex mode; Chat mode and hosted OAuth are
separate future work. It talks to that local Codex executable directly; the
Codex app server is not required for plugin installation.

The Codex plugin exposes Signet-specific tools such as `signet_recall`,
`signet_source_search`, `signet_session_search`, and `signet_save_note`.
Legacy `memory_*` tools remain available for compatibility, but Codex-facing
skills prefer the Signet-specific names to avoid confusing Signet recall with
Codex native memory.
