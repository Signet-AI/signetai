# Signet Memory Provider

Persistent cross-session memory powered by the [Signet](https://github.com/Signet-AI/signetai) daemon. Hybrid search (BM25 + vector + knowledge graph), predictive recall, automatic entity extraction, and retention decay.

## Requirements

- Signet daemon running on localhost:3850 (default)
- Install: `curl -fsSL https://signetai.sh/install.sh | bash`, `npm install -g signetai`, or `bun add -g signetai`

## Setup

```bash
hermes memory setup    # select "signet"
```

Or manually:
```bash
hermes config set memory.provider signet
signet start   # ensure daemon is running
```

## Config

Environment variables:
- `SIGNET_DAEMON_URL` — Full daemon URL (default: `http://localhost:3850`)
- `SIGNET_HOST` / `SIGNET_PORT` — Host and port separately
- `SIGNET_TOKEN` — Optional daemon bearer token; sent to loopback daemon URLs by default
- `SIGNET_TRUSTED_DAEMON_ORIGINS` — Comma-separated remote daemon origins allowed to receive `SIGNET_TOKEN`
- `SIGNET_AGENT_ID` — Agent scope identifier (unset: inherit the daemon's configured agent, usually `default`)
- `SIGNET_AGENT_WORKSPACE` — Optional named-agent workspace path (for example `~/.agents/agents/dot`)
- `SIGNET_AGENT_READ_POLICY` — Optional named-agent memory policy for first registration: `shared` (default), `isolated`, or `group`
- `SIGNET_AGENT_POLICY_GROUP` — Required when `SIGNET_AGENT_READ_POLICY=group`
- `PYTHON` — Optional Python interpreter command or path for connector probes; defaults to `python3` then `python` on Unix and `py -3`, `python`, then `python3` on Windows

## Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid memory search (keyword + semantic + knowledge graph) |
| `signet_session_search` | Search active or completed Signet session transcripts (namespaced to avoid Hermes's built-in `session_search` core tool) |
| `memory_store` | Store a fact, preference, or decision to memory |
| `memory_get` | Retrieve a memory by ID |
| `memory_list` | List memories with optional filters |
| `memory_modify` | Edit an existing memory |
| `memory_forget` | Soft-delete a memory |
| `recall` / `remember` | Compatibility aliases for search/store |

`memory_store` exposes the full Signet remember surface, including:

- `content`, `type`, `importance`, `tags`, `pinned`, and `project`
- `hints` for prospective recall hints and alternate phrasings
- `transcript` for lossless source text alongside the saved memory
- `structured.entities`, `structured.aspects`, and `structured.hints` for callers that already extracted graph-ready memory metadata

## How It Works

The plugin bridges Hermes Agent's memory lifecycle to the Signet daemon:

1. **Session start** — Calls Signet's session-start hook, which returns identity files (AGENTS.md, SOUL.md, USER.md, MEMORY.md), scored memories, and knowledge graph constraints. The deterministic `stableSystemPrompt` is returned by `system_prompt_block()`; state-dependent `dynamicContext` is staged for Hermes' API-only prefetch path rather than being added to the canonical transcript.

2. **Per-turn recall** — On each user message, calls the user-prompt-submit hook. Signet runs hybrid search (BM25 + vector similarity + knowledge graph traversal + predictive scoring) and returns the most relevant memories.

3. **Session end** — Sends a transcript with internal Signet memory delimiters removed to Signet's session-end hook, which queues it for the memory pipeline: extraction, knowledge graph updates, retention decay, and MEMORY.md synthesis.

4. **Explicit tools** — The agent can call canonical Signet tools such as `memory_search` and `memory_store` directly during conversation for on-demand memory operations. Legacy `signet_*` names are handled for compatibility but are not advertised to the model.

## Built-in memory synchronization

The plugin uses a **synchronization** model for Hermes's built-in
`on_memory_write()` hook:

- `add` creates an immutable episodic Signet row tagged with
  `hermes-builtin` and the Hermes target (`memory` or `user`).
- `replace` creates a new episodic row and atomically supersedes the mirrored
  row identified by Hermes's `old_text`.
- `remove` soft-deletes the matching mirrored row.

Superseded and soft-deleted rows remain available as historical evidence and
audit history, but Signet's current recall/list views exclude them. The
connector queues hook callbacks on one FIFO worker, so operations emitted for
an already-committed Hermes batch retain their order. Each operation carries
session, project, agent, source, and a deterministic idempotency key. Mirror
rows use Signet's default `global` visibility, matching the connector's prior
write contract; agent and project filters still bound lookup and mutation.
Retrying the same callback does not create a second current row. A failed
lookup never falls back to mutating an untagged Signet memory.
