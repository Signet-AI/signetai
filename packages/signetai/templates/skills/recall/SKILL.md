---
name: recall
description: "Query persistent memory using hybrid search (vector + keyword). NOTE: Relevant memories are automatically injected at session start. Use /recall for targeted searches beyond current context."
user_invocable: true
arg_hint: "search query"
builtin: true
---

# /recall

Query persistent memory shared between all agents (claude-code, opencode,
clawdbot) using hybrid search: 70% semantic vector similarity + 30% BM25
keyword matching.

## When You Need This (And When You Don't)

At session start, Signet automatically injects relevant memories into
your context — scored by importance, recency, and relevance to the
current conversation. MEMORY.md is also regenerated periodically from
the full database using decay-weighted scoring. For most interactions,
the right memories are already present without any manual searching.

Use /recall when you need to:
- Search for something specific that isn't in current context
- Look up old decisions or past conversations
- Debug whether a memory was actually captured
- Find memories by type, tag, or date range
- Explore what the system knows about a topic

You do NOT need /recall to:
- Access recent memories (they're already injected)
- Check if the system "remembers" something (it does, automatically)
- Build session-start rituals (injection handles this)

## syntax

```
/recall <search>
```

## examples

```
/recall voice
/recall signet architecture
/recall preferences
/recall bun vs npm
/recall what did we decide about the API
```

## implementation

Use the Signet CLI (requires running daemon):

```bash
signet recall "<search>" -l 10
```

Options:
- `-l, --limit <n>` — max results (default: 10)
- `-t, --type <type>` — filter by type (preference, decision, rule, etc.)
- `--tags <tags>` — filter by tags (comma-separated)
- `--who <who>` — filter by who saved it
- `--json` — output as JSON for parsing

Example with filters:

```bash
signet recall "signet" --type preference --tags architecture -l 5
```

### daemon required

The daemon must be running for recall to work. Check status:

```bash
signet status
curl -s http://localhost:3850/health
```

If the daemon is down, start it with `signet start`.

## response format

The daemon returns:

```json
{
  "results": [
    {
      "content": "agent profile lives at ~/.agents/",
      "score": 0.92,
      "source": "hybrid",
      "type": "fact",
      "tags": "signet,architecture",
      "pinned": true,
      "importance": 1.0,
      "who": "claude-code",
      "project": "/home/nicholai/signet",
      "created_at": "2026-02-15T20:38:00.000Z"
    }
  ],
  "query": "signet architecture",
  "method": "hybrid"
}
```

## display format

After getting results, show them like this:

```
[0.92|hybrid] agent profile lives at ~/.agents/ [signet,architecture] [pinned]
       type: fact | who: claude-code | Feb 15

[0.78|hybrid] Signet uses SQLite for memory storage
       type: fact | who: opencode | Feb 14

[0.65|vector] Memory system supports hybrid search
       type: fact | who: claude-code | Feb 12
```

Score format: `[score|source]` where source is hybrid/vector/keyword.

## configuration

Edit `~/.agents/config.yaml` or `~/.agents/AGENT.yaml` to adjust:
- `search.alpha`: Vector weight (default 0.7)
- `search.top_k`: Candidates per source (default 20)
- `search.min_score`: Minimum score threshold (default 0.3)

## follow-up

After showing results, offer to:
- search with different terms
- show memories by type: add `"type": "preference"` to the request
- filter by date range or project
