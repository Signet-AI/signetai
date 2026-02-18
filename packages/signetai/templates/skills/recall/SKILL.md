# recall

Query persistent memory using hybrid search (vector + keyword).

## Usage

Use when user says "/recall X" or asks to recall/find something from memory.

## How it works

Call the Signet daemon API to search memories:

```bash
curl "http://localhost:3850/api/hook/recall?q=your+search+query"
```

Or via the CLI:

```bash
signet hook recall "your search query"
```

## Parameters

- `q` (required): The search query
- `limit` (optional): Max results to return (default: 10)
- `min_score` (optional): Minimum relevance score 0.0-1.0 (default: 0.3)

## Response

Returns matching memories with relevance scores:

```json
{
  "memories": [
    {
      "id": "mem_123",
      "content": "The remembered content",
      "score": 0.85,
      "created_at": "2025-01-15T10:30:00Z",
      "who": "claude-code",
      "tags": "project,important"
    }
  ]
}
```

## Search behavior

Uses hybrid search combining:
- **Semantic search** (70%): Vector similarity using embeddings
- **Keyword search** (30%): BM25 full-text search

This finds memories that are conceptually similar even if exact words don't match.
