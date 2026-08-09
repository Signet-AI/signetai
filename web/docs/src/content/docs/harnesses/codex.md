---
title: "Codex"
description: "Connect Signet to Codex."
---

## Codex

Codex is OpenAI's terminal coding agent (`codex-rs`). Signet integrates
with Codex through a generated Codex plugin bundle when the installed Codex
CLI supports plugin marketplaces. The plugin declares Signet metadata, skills,
and MCP configuration. Until Codex exposes plugin lifecycle hooks, Signet also
installs compatibility `hooks.json` entries for session start, prompt submit,
and session end. Older Codex versions fall back to direct hook and MCP config
patching.

### Files managed by Signet

| File | Description |
|------|-------------|
| `~/.codex/.tmp/signet-plugin-marketplace` | Generated local marketplace containing the Signet plugin bundle |
| `~/.codex/config.toml` | Plugin marketplace/config registration, or compatibility `[mcp_servers.signet]` on older Codex installs |
| `~/.codex/hooks.json` | Compatibility lifecycle hooks — SessionStart, UserPromptSubmit, Stop |
| `~/.codex/skills` | Compatibility symlink to `$SIGNET_WORKSPACE/skills` when plugin support is unavailable |

Generated Codex hook manifests contain only fields from Codex's hook schema.
Signet identifies its entries by their hook command when reinstalling or
uninstalling, so unrelated hook groups remain untouched without private metadata
inside Codex-owned configuration.

### Native memory bridge

Signet indexes Codex-owned memory artifacts without rewriting them or turning
them into Signet-authored memory rows. The daemon polls Codex memory files with
content hashes under `~/.codex/memories/`, including `memory_summary.md`,
`MEMORY.md`, rollout summaries, skill memories, ad-hoc extension notes, and
automation-local `~/.codex/automations/*/memory.md` files. Matching content is
indexed as `codex_native_memory` source artifacts with path, hash, line range,
and rollout-id metadata when present. Removed native files are soft-deleted
from active recall while preserving their artifact rows for lineage.

When Codex native memories are enabled, Signet's Codex prompt hook reduces
automatic injection of Codex-owned memory rows. Prompt-time context stays
focused on high-value Signet material: cross-harness history, source-backed
documents, ontology, explicit recalls, and accepted decisions. Explicit recall
still uses daemon-side dedupe keyed by `session_key`, `agent_id`, and
`context_epoch`.

### How it works

1. `signet setup --harness codex` feature-detects `codex plugin` support.
2. On supported Codex installs, Signet writes a local plugin marketplace bundle and registers `signet@signet-local` in `~/.codex/config.toml`.
3. While plugin lifecycle hooks are not available, Codex also reads compatibility hooks from `~/.codex/hooks.json`.
4. On session start, Codex fires `SessionStart` → calls `signet hook session-start -H codex --codex-json` → Signet returns identity + memories as `hookSpecificOutput.additionalContext` with `suppressOutput: true`, injected into the model's context window without printing the hook payload to the user transcript.
5. On every user prompt, Codex fires `UserPromptSubmit` → calls `signet hook user-prompt-submit -H codex --codex-json` → Signet returns bounded entity current-view context only when the prompt mentions a known entity or active alias. Empty matches return no additional context. This is blocking — Codex waits for the hook before sending to the model.
6. On session end, Codex fires `Stop` → calls `signet hook session-end -H codex` → Signet extracts memories from the transcript.
7. The MCP server exposes `signet_recall`, `signet_source_search`, `signet_session_search`, `signet_save_note`, and compatibility `memory_*` tools that Codex can invoke directly during sessions.

Codex `SessionStart` hook timeout defaults to 20 seconds: the Signet CLI
waits up to `SIGNET_SESSION_START_TIMEOUT` (`15000` ms by default) for
the daemon, and the generated Codex hook config adds 5 seconds of harness
grace. Codex `UserPromptSubmit` defaults to 7 seconds: `SIGNET_PROMPT_SUBMIT_TIMEOUT`
(`5000` ms by default) plus 2 seconds of harness grace. Rerun `signet setup`
or `signet connect codex` after upgrading to rewrite an existing
`~/.codex/hooks.json`.

For a remote Signet daemon, pass `--url` and `--api-key` when installing the
Codex connector:

```bash
signet api-key create --name "work laptop codex" --connector codex --agent-id <agent-name>
signet connect codex --url http://192.168.0.60:3850 --api-key sig_sk_...
```

Use `--agent-id` when creating the API key to bind the remote Codex install to
one Signet agent. The key scope becomes the default agent for Codex hook/MCP
requests, and requests for another agent are rejected by daemon auth scope.

Codex also has a native-plugin-oriented npm installer name for machines where
you do not want to install the full Signet CLI first:

```bash
npx -y @signetai/codex-plugin install --url http://192.168.0.60:3850 --api-key sig_sk_...
```

When `SIGNET_DAEMON_URL` or `--url` is set, the Codex connector writes
the plugin MCP URL, or compatibility `[mcp_servers.signet] url =
"<daemon>/mcp"` when plugin support is unavailable, and bakes the same daemon
URL into generated lifecycle hook commands. This keeps on-demand MCP tools and
automatic lifecycle memory pointed at the same Signet instance. When an API key
is provided, Codex MCP and lifecycle hook calls send it as bearer auth.
The URL value must be the daemon origin only, for example
`http://192.168.0.60:3850` or `https://signet.internal:3850`, with no
path, query string, fragment, or embedded credentials.

Codex matches the session-start, prompt-submit, and session-end path, but
it does **not** currently expose the same compaction lifecycle fidelity as
Claude Code or OpenCode.

### Supported hooks

| Hook | Supported |
|------|-----------|
| session-start | yes — identity + memories via `hookSpecificOutput.additionalContext` |
| user-prompt-submit | yes — entity current-view context via `hookSpecificOutput.additionalContext` when matched |
| session-end | yes — transcript extraction via `Stop` hook |

### MCP tools

When the Signet MCP server is registered, Codex gains access to these
tools (namespaced as `mcp__signet__*`):

- `signet_recall` — explicit Signet recall for cross-harness history and accepted decisions
- `signet_source_search` — search source-backed Signet artifacts and docs
- `signet_session_search` — search active or completed session transcripts
- `signet_save_note` — write a small explicit note into Codex native memory extensions
- `memory_search`, `memory_store`, `session_search`, and other legacy `memory_*` tools — compatibility aliases

MCP tools do not replace hooks. MCP gives Codex on-demand tools during a
session; hooks provide automatic identity injection, prompt-time recall,
and session-end extraction.

### Extraction provider

Codex can be selected as the extraction provider in `agent.yaml`. When set,
the pipeline uses the Codex CLI (similar to the `claude-code` provider) to
run extraction and decision passes against Codex's configured model rather
than a local Ollama instance.

### Prerequisites

- Codex (`codex-rs`) installed and in `PATH`
- Signet daemon running (`signet daemon start`)

---
