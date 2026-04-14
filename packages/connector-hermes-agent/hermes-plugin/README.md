# Signet Memory Provider

Persistent cross-session memory powered by the [Signet](https://github.com/signetai/signetai) daemon. Hybrid search (BM25 + vector + knowledge graph), predictive recall, automatic entity extraction, and retention decay.

## Requirements

- Signet daemon running on localhost:3850 (default)
- Install: `npm install -g signetai` or `bun install -g signetai`

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
- `SIGNET_AGENT_ID` — Agent scope identifier (default: `hermes-agent`)
- `SIGNET_AGENT_WORKSPACE` — Optional named-agent workspace path (for example `~/.agents/agents/dot`)
- `SIGNET_AGENT_READ_POLICY` — Optional named-agent memory policy for first registration: `shared` (default), `isolated`, or `group`
- `SIGNET_AGENT_POLICY_GROUP` — Required when `SIGNET_AGENT_READ_POLICY=group`

## Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid memory search (keyword + semantic + knowledge graph) |
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

1. **Session start** — Calls Signet's session-start hook, which returns identity files (AGENTS.md, SOUL.md, USER.md, MEMORY.md), scored memories, and knowledge graph constraints. Injected into the system prompt.

2. **Per-turn recall** — On each user message, calls the user-prompt-submit hook. Signet runs hybrid search (BM25 + vector similarity + knowledge graph traversal + predictive scoring) and returns the most relevant memories.

3. **Session end** — Sends the conversation transcript to Signet's session-end hook, which queues it for the memory pipeline: extraction, knowledge graph updates, retention decay, and MEMORY.md synthesis.

4. **Explicit tools** — The agent can call canonical Signet tools such as `memory_search` and `memory_store` directly during conversation for on-demand memory operations. Legacy `signet_*` names are handled for compatibility but are not advertised to the model.
