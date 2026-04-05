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
- `SIGNET_AGENT_ID` — Agent scope identifier (default: `default`)

## Tools

| Tool | Description |
|------|-------------|
| `signet_search` | Hybrid memory search (keyword + semantic + knowledge graph) |
| `signet_store` | Store a fact, preference, or decision to memory |
| `signet_profile` | Broad overview of stored memories and context |

## How It Works

The plugin bridges Hermes Agent's memory lifecycle to the Signet daemon:

1. **Session start** — Calls Signet's session-start hook, which returns identity files (AGENTS.md, SOUL.md, USER.md, MEMORY.md), scored memories, and knowledge graph constraints. Injected into the system prompt.

2. **Per-turn recall** — On each user message, calls the user-prompt-submit hook. Signet runs hybrid search (BM25 + vector similarity + knowledge graph traversal + predictive scoring) and returns the most relevant memories.

3. **Session end** — Sends the conversation transcript to Signet's session-end hook, which queues it for the memory pipeline: extraction, knowledge graph updates, retention decay, and MEMORY.md synthesis.

4. **Explicit tools** — The agent can call `signet_search`, `signet_store`, and `signet_profile` directly during conversation for on-demand memory operations.
