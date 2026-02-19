---
name: remember
description: Save something to persistent memory with auto-embedding. Use when user says "/remember X" or asks to remember something important.
user_invocable: true
arg_hint: "[critical:] [[tag1,tag2]:] content to remember"
builtin: true
---

# /remember

Save to persistent memory across sessions. Shared between all agents
(claude-code, opencode, clawdbot). Memories are auto-embedded for
semantic search via the Signet daemon.

## syntax

```
/remember <content>
/remember critical: <content>
/remember [tag1,tag2]: <content>
/remember critical: [tag1,tag2]: <content>
```

## examples

```
/remember nicholai prefers tabs over spaces
/remember critical: never push directly to main
/remember [voice,tts]: qwen model needs 12GB VRAM minimum
/remember [signet,architecture]: agent profile lives at ~/.agents/
```

## implementation

Use the Signet CLI (requires running daemon):

```bash
signet remember "<content>" -w <agent-name>
```

Options:
- `-w, --who <who>` — who is remembering (default: "user")
- `-t, --tags <tags>` — comma-separated tags
- `-i, --importance <n>` — importance 0-1 (default: 0.7)
- `--critical` — mark as pinned (importance=1.0, never decays)

where `<agent-name>` is one of: claude-code, opencode, clawdbot

The daemon automatically:
- detects `critical:` prefix → pins memory (importance=1.0, never decays)
- parses `[tags]:` prefix → explicit tags
- infers type from keywords (prefer→preference, decided→decision, etc.)
- generates embedding via configured provider (Ollama/OpenAI)
- stores in SQLite + embeddings table

### daemon required

The daemon must be running for remember to work. Check status:

```bash
signet status
curl -s http://localhost:3850/health
```

If the daemon is down, start it with `signet start`.

## type inference

| keyword in content | inferred type |
|--------------------|---------------|
| prefer/likes/want  | preference    |
| decided/agreed     | decision      |
| learned/discovered | learning      |
| never/always/must  | rule          |
| bug/issue/broken   | issue         |
| (default)          | fact          |

## response

The daemon returns JSON:

```json
{
  "id": "uuid",
  "type": "preference",
  "tags": "coding",
  "pinned": false,
  "importance": 0.8,
  "content": "nicholai prefers tabs over spaces",
  "embedded": true
}
```

## confirmation

After saving, confirm to the user:

```
✓ Saved: "nicholai prefers tabs over spaces"
  type: preference | embedded
```

For critical:
```
✓ Saved (pinned): "never push directly to main"
  type: rule | importance: 1.0 | embedded
```

If embedding failed (daemon running but Ollama/OpenAI unavailable):
```
✓ Saved: "content..." (keyword search only — embedding unavailable)
```
