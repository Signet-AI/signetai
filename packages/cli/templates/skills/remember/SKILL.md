# remember

Save something to persistent memory with auto-embedding.

## Usage

Use when user says "/remember X" or asks to remember something important.

## How it works

Use the Signet CLI (requires running daemon):

```bash
signet remember "the thing to remember" -w claude-code
```

Or call the daemon API directly:

```bash
curl -X POST http://localhost:3850/api/memory/remember \
  -H "Content-Type: application/json" \
  -d '{"content": "the thing to remember", "who": "claude-code"}'
```

## CLI Options

- `-w, --who <who>` — who is remembering (default: "user")
- `-t, --tags <tags>` — comma-separated tags
- `-i, --importance <n>` — importance 0-1 (default: 0.7)
- `--critical` — mark as pinned (never decays)

## Response

Returns the created memory ID and embedding status.
