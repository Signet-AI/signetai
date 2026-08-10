---
title: "Hermes Agent"
description: "Connect Signet to Hermes Agent."
---

## Hermes Agent

Hermes Agent is an open-source terminal AI agent by Nous Research. Signet
integrates as a pluggable memory provider via Hermes's `MemoryProvider` ABC,
deploying a Python plugin that bridges all Signet daemon hooks into the
Hermes lifecycle.

### Files managed by Signet

| Location | Description |
|----------|-------------|
| `~/.hermes/plugins/signet/__init__.py` | User-level Signet `MemoryProvider` implementation |
| `~/.hermes/plugins/signet/client.py` | User-level HTTP client for the Signet daemon API |
| `~/.hermes/plugins/signet/plugin.yaml` | User-level plugin metadata |
| `~/.hermes/plugins/signet/signet.install.json` | Install marker with connector version and plugin source hash |
| `<hermes-repo>/plugins/memory/signet/__init__.py` | Signet `MemoryProvider` implementation |
| `<hermes-repo>/plugins/memory/signet/client.py` | HTTP client for the Signet daemon API |
| `<hermes-repo>/plugins/memory/signet/plugin.yaml` | Plugin metadata |
| `<hermes-repo>/plugins/memory/signet/signet.install.json` | Install marker with connector version and plugin source hash |
| `~/.hermes/config.yaml` | `memory.provider: signet` activation |
| `~/.hermes/.env` | Daemon connection environment variables |

### How it works

1. `signet setup` (with `hermes-agent` selected) copies the Python plugin
   into both `~/.hermes/plugins/signet/` and, when discovered,
   `<hermes-repo>/plugins/memory/signet/`.
2. The connector writes install markers, daemon connection env vars to
   `~/.hermes/.env`, and activates the provider by setting
   `memory.provider: signet` in Hermes config.
3. At session start, Hermes calls `initialize()` on the plugin, which fires
   `POST /api/hooks/session-start` to load identity, memories, and system
   prompt injection from the daemon.
4. On each user turn, `queue_prefetch()` fires
   `POST /api/hooks/user-prompt-submit` for entity current-view context when
   the prompt mentions a known entity or active alias.
5. At session end, `on_session_end()` sends the accumulated transcript via
   `POST /api/hooks/session-end` for async pipeline extraction.
6. Committed Hermes built-in memory writes are mirrored through a serialized
   FIFO queue so add/replace/remove callbacks retain their batch order.

### Built-in memory mirror semantics

The Hermes connector uses synchronization rather than leaving Signet with an
add-only copy of Hermes memory:

- `add` creates immutable episodic evidence in Signet.
- `replace` creates a new row and atomically supersedes the row matched by
  Hermes's `old_text`.
- `remove` soft-deletes the matched row.

Superseded and deleted rows remain available for provenance and audit history,
but current Signet recall and list views exclude them. Mirror rows are tagged
with their Hermes target and use Signet's default `global` visibility, matching
the connector's existing write contract. They carry agent, project, session,
source, and a deterministic idempotency key. Retrying a callback is therefore
safe, and a missing or ambiguous mirrored match is never treated as permission
to mutate an unrelated Signet memory.

### Native memory bridge

Hermes keeps its curated profile memory in `<HERMES_HOME>/memories/`, using
`MEMORY.md` for durable profile context and `USER.md` for user context. Signet
resolves the configured `HERMES_HOME` (defaulting to `~/.hermes`) and reads
only those two files; a named Hermes profile should set `HERMES_HOME` to its
profile directory before starting the daemon.

The daemon stores each file as a provenance-bearing native artifact with the
Hermes profile identity, profile-relative path, content hash, and source
timestamp. It never writes to Hermes memory files or creates a second semantic
extraction pipeline. Edits update the artifact row, while missing files are
soft-deleted and excluded from active recall. Artifacts remain scoped to the
current Signet agent, and an exact current `hermes-memory-write` mirror is not
returned a second time during recall.

### Tools exposed to the agent

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid memory search (keyword + semantic + knowledge graph) |
| `signet_session_search` | Search active or completed session transcripts |
| `memory_store` | Store a fact/preference/decision with auto entity extraction |
| `memory_get` | Retrieve a memory by ID |
| `memory_list` | List memories with optional filters |
| `memory_modify` | Edit an existing memory |
| `memory_forget` | Soft-delete a memory |
| `recall` / `remember` | Compatibility aliases for search/store |

### Supported hooks

| Hook | Supported |
|------|-----------|
| session-start | yes — identity + memories via `system_prompt_block()` |
| user-prompt-submit | yes — entity current-view context via `queue_prefetch()` / `prefetch()` |
| pre-compaction | yes — daemon-generated summary guidelines via `on_pre_compress()` |
| compaction-complete | yes — saves summary as session memory via `on_compaction_complete()` |
| checkpoint-extract | yes — periodic mid-session delta extraction every 30 turns |
| session-end | yes — transcript extraction via `on_session_end()` |

### Delegation support

When Hermes delegates to subagents, the parent's `on_delegation()` hook
stores the task+result pair as a Signet memory tagged `["delegation", "subagent"]`.

### Prerequisites

- Hermes Agent installed (repo with `plugins/memory/` directory)
- Signet daemon running (`signet start`)
- `signet setup --harness hermes-agent`
- `signet doctor hermes` reports daemon health, plugin freshness, config
  activation, and Hermes tool routing

---
