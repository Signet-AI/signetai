# recall

Query persistent memory using hybrid search (vector + keyword).

## Usage

Use when user says "/recall X" or asks to recall/find something from memory.

## How it works

Use the Signet CLI (requires running daemon):

```bash
signet recall "your search query"
```

Or call the daemon API directly:

```bash
curl -X POST http://localhost:3850/api/memory/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "your search query", "limit": 10}'
```

## CLI Options

- `-l, --limit <n>` — max results (default: 10)
- `-t, --type <type>` — filter by type (preference, decision, rule, etc.)
- `--tags <tags>` — filter by tags (comma-separated)
- `--who <who>` — filter by who saved it
- `--json` — output as JSON for parsing

## Response

Returns matching memories with relevance scores:

```json
{
  "results": [
    {
      "content": "The remembered content",
      "score": 0.85,
      "source": "hybrid",
      "type": "fact",
      "who": "claude-code",
      "tags": "project,important",
      "created_at": "2025-01-15T10:30:00Z"
    }
  ]
}
```

## Search behavior

Uses hybrid search combining:
- **Semantic search** (70%): Vector similarity using embeddings
- **Keyword search** (30%): BM25 full-text search

This finds memories that are conceptually similar even if exact words don't match.
