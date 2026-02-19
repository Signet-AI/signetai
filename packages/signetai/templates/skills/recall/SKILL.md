---
name: recall
description: Query persistent memory using hybrid search (vector + keyword). Use when user says "/recall X" or asks to recall/find something from memory.
user_invocable: true
arg_hint: "search query"
builtin: true
---

# /recall

Query persistent memory shared between all agents (claude-code, opencode,
clawdbot) using hybrid search: 70% semantic vector similarity + 30% BM25
keyword matching.

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

### fallback (daemon not running)

If the daemon is unavailable, fall back to the Python script:

```bash
python ~/.agents/memory/scripts/memory.py query "<search>"
```

Check daemon status: `signet status` or `curl -s http://localhost:3850/health`

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
- save new related memories (`/remember ...`)
- search with different terms
- show memories by type: add `"type": "preference"` to the request
