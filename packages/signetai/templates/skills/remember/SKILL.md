# remember

Save something to persistent memory with auto-embedding.

## Usage

Use when user says "/remember X" or asks to remember something important.

## How it works

Call the Signet daemon API to save a memory:

```bash
curl -X POST http://localhost:3850/api/hook/remember \
  -H "Content-Type: application/json" \
  -d '{"content": "the thing to remember", "who": "claude-code"}'
```

Or via the CLI:

```bash
signet hook remember --content "the thing to remember" --who claude-code
```

## Parameters

- `content` (required): The text to remember
- `who` (optional): Who is saving the memory (defaults to "user")
- `why` (optional): Context for why this is being remembered
- `importance` (optional): 0.0-1.0, defaults to 0.5
- `tags` (optional): Comma-separated tags for organization
- `pinned` (optional): Set to true for critical memories that shouldn't decay

## Response

Returns the created memory ID on success.
