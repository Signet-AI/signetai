# Memory Architecture

Why Forge exists as Signet's native terminal — and why it solves the memory problem that connector-based agents can't.

---

## The Problem: Dual Memory Systems

When Signet runs as a plugin inside another AI harness (Claude Code, Cursor, etc.), two independent memory systems end up competing:

1. **Signet's memory DB** — vector + keyword hybrid search, extraction pipeline, importance scoring, session captures. The system we built and control.
2. **The host's built-in memory** — file-based auto-memory (e.g., `~/.claude/projects/`), static indexes, no semantic search. The system the harness provides and we can't disable.

These systems don't sync. Project context ends up split — some in Signet's DB, some in the host's file-based memory — with no bridge between them. The agent checks two places with two different interfaces and has no clear source of truth.

### Specific friction points

- **Session-start injection is a guess.** The host fires a recall query before knowing what the conversation will be about. Memories injected are "probably relevant," not targeted. A session about Forge might get shell alias setup memories because those scored high recently.
- **No deduplication across systems.** The same fact can exist in both Signet's DB and the host's auto-memory, worded differently, with different update timestamps. Neither system knows about the other's entries.
- **Static indexes vs. semantic search.** The host's `MEMORY.md` index is a flat file of pointers. Useful for direct lookups, useless for "what do I know about X?" queries. Signet's vector search handles that — but the host doesn't know to defer to it.
- **Memory storage is inconsistent.** When the agent stores a memory, which system does it write to? The answer depends on which tool it reaches for first, not which system is architecturally correct.

---

## Forge's Solution: One System, Native Integration

Forge eliminates the dual-system problem by being the harness. There's no host memory system to compete with because Forge *is* the host, and it delegates all memory to Signet.

### How memory flows in Forge

```
User types prompt
       │
       ├── Speculative pre-recall (500ms debounce while typing)
       │     └── HTTP GET → Signet daemon /api/memory/recall
       │
       ├── Prompt submitted
       │     ├── Per-prompt recall (targeted to actual input)
       │     │     └── HTTP GET → Signet daemon /api/memory/recall
       │     └── Memories injected into LLM context
       │
       ├── During session
       │     ├── /recall <query> → Signet hybrid search
       │     └── /remember <text> → Signet memory store
       │
       └── Session ends
             └── Transcript submitted → Signet extraction pipeline
                   └── Pipeline: synthesis → extraction → embedding
```

Every memory operation hits one system: Signet's daemon over localhost HTTP. No file-based fallback, no competing index, no ambiguity about where to read or write.

### What this changes

| Connector model (Claude Code + Signet) | Native model (Forge) |
|---|---|
| Two memory systems, no sync | One memory system |
| Session-start injection guesses relevance | Speculative pre-recall targets what you're actually typing |
| ~200ms recall through shell hooks + MCP | ~5ms recall over localhost HTTP |
| Host auto-memory can't be disabled | No competing memory system exists |
| Memory storage path depends on which tool fires first | All storage routes to Signet |
| Static MEMORY.md index, no semantic search | Vector + keyword hybrid search on every query |

### Identity is separate from memory

The identity stack — `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md` — loads at startup and lives in the system prompt. This isn't memory recall; it's structural. It defines who the agent is before any conversation begins.

Forge loads these from `~/.agents/` on launch via the Signet config module. They don't need semantic search because they're always relevant. This is the same mechanism whether running through a connector or natively — the difference is that in Forge, nothing else is fighting for that system prompt space.

### Extraction stays daemon-side

Forge submits session transcripts to the Signet daemon on quit. The daemon's extraction pipeline handles synthesis, fact extraction, and embedding — Forge never touches that pipeline directly. This boundary is intentional: extraction is a daemon responsibility, not a harness responsibility.

---

## Architecture

```
┌─────────────────────────────────────┐
│              Forge TUI              │
│  ┌───────────┐  ┌────────────────┐  │
│  │  Input    │  │  Chat View     │  │
│  │  Handler  │  │  (Markdown)    │  │
│  └─────┬─────┘  └────────────────┘  │
│        │                            │
│  ┌─────▼─────────────────────────┐  │
│  │       forge-agent loop        │  │
│  │  prompt → recall → LLM →     │  │
│  │  tools → execute → loop      │  │
│  └─────┬─────────────────────────┘  │
│        │                            │
│  ┌─────▼─────┐  ┌────────────────┐  │
│  │  forge-   │  │  forge-        │  │
│  │  provider │  │  tools         │  │
│  │  (LLM)   │  │  (6 built-in)  │  │
│  └───────────┘  └────────────────┘  │
│                                     │
│  ┌──────────────────────────────┐   │
│  │        forge-signet          │   │
│  │  memory · identity · secrets │   │
│  │  hooks · config · extraction │   │
│  └─────────────┬────────────────┘   │
└────────────────┼────────────────────┘
                 │ HTTP (localhost:3850)
┌────────────────▼────────────────────┐
│          Signet Daemon              │
│  memory DB · extraction pipeline   │
│  embeddings · knowledge graph      │
│  secret store · session tracking   │
└─────────────────────────────────────┘
```

Forge is a thin client. The daemon holds all persistent state. If Forge crashes, nothing is lost — the daemon has the memories, the sessions, the embeddings. Forge just provides the interface and the agentic loop.

---

## Summary

The connector model works. Signet inside Claude Code is functional and useful. But it's architecturally compromised by the host's own memory system running in parallel. Forge exists because the cleanest solution to "two memory systems fighting each other" is to not have two memory systems. One harness, one daemon, one source of truth.
