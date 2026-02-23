---
title: "Memory Skills"
description: "Built-in memory management skills."
order: 6
section: "Core Concepts"
---

# Built-in Memory Skills

> **Status:** Implemented
>
> The `remember` and `recall` commands work via the Signet CLI (`signet remember`,
> `signet recall`) which calls the daemon HTTP API.

---

Signet ships with three core skills for memory management: `remember`, `recall`, and `memory-debug`. These integrate directly with the Signet daemon.

## Overview

| Skill | CLI Command | Harness Command | Purpose |
|-------|-------------|-----------------|---------|
| remember | `signet remember <content>` | `/remember <content>` | Save to persistent memory |
| recall | `signet recall <query>` | `/recall <query>` | Search persistent memory |
| memory-debug | diagnostic checks | `/memory-debug [symptom]` | Diagnose memory failures and quality issues |

These are the primary interface between agents and the memory system.

## remember

### Syntax

```bash
# CLI
signet remember <content>
signet remember <content> --critical
signet remember <content> -t tag1,tag2

# In harness
/remember <content>
/remember critical: <content>
/remember [tag1,tag2]: <content>
```

### Features

- **Auto-embedding**: Content is vectorized for semantic search
- **Type inference**: Detects preferences, decisions, facts, etc.
- **Critical marking**: `--critical` flag or `critical:` prefix pins memories (never decay)
- **Tagging**: `-t` flag or `[tag1,tag2]:` prefix adds explicit tags
- **Cross-harness**: Memories shared across all AI tools

### Examples

```bash
signet remember "nicholai prefers tabs over spaces"
signet remember "never push directly to main branch" --critical
signet remember "agent profile lives at ~/.agents/" -t signet,architecture
```

### Implementation

The CLI calls the daemon HTTP API:

```bash
# CLI (preferred)
signet remember "content to save" -w claude-code

# Direct API call
curl -X POST http://localhost:3850/api/memory/remember \
  -H "Content-Type: application/json" \
  -d '{"content": "content to save", "who": "claude-code"}'
```

The daemon handles:
1. Parsing prefixes (critical:, [tags]:)
2. Inferring memory type from content
3. Generating embedding via configured provider
4. Storing in SQLite + vector store
5. Returning confirmation

### Response Format

After saving, the agent should confirm:

```
✓ Saved: "nicholai prefers tabs over spaces"
  type: preference | tags: [coding] | embedded
```

For critical:
```
✓ Saved (pinned): "never push directly to main"
  type: rule | importance: 1.0 | embedded
```

## recall

### Syntax

```bash
# CLI
signet recall <query>
signet recall <query> -l 5
signet recall <query> --type decision --tags project

# In harness
/recall <query>
```

### Features

- **Hybrid search**: Combines vector similarity (70%) + keyword matching (30%)
- **Score display**: Shows relevance scores for transparency
- **Rich results**: Content, tags, source, type, timestamps
- **Filters**: Filter by type (`--type`), tags (`--tags`), who (`--who`)

### Examples

```bash
signet recall "signet architecture"
signet recall "preferences" -l 5
signet recall "API" --type decision --tags project
signet recall "bun vs npm" --json
```

### Implementation

The CLI calls the daemon HTTP API:

```bash
# CLI (preferred)
signet recall "search query" -l 10

# Direct API call
curl -X POST http://localhost:3850/api/memory/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "search query", "limit": 10}'
```

### Response Format

```
[0.92|hybrid] Agent profile lives at ~/.agents/ [signet,architecture] [pinned]
       type: fact | who: claude-code | Feb 15

[0.78|hybrid] Signet uses SQLite for memory storage
       type: fact | who: opencode | Feb 14

[0.65|vector] Memory system supports hybrid search
       type: fact | who: claude-code | Feb 12
```

Score breakdown:
- `[0.92|hybrid]` - Combined score, search method
- `[pinned]` - Critical/pinned memory
- Individual components available: `vec: 0.88, bm25: 0.95`

## Configuration

### Embedding Provider

In `~/.agents/agent.yaml`:

```yaml
embedding:
  provider: ollama          # or 'openai'
  model: nomic-embed-text   # or 'text-embedding-3-small'
  dimensions: 768           # or 1536 for OpenAI
```

### Search Tuning

```yaml
search:
  alpha: 0.7        # Vector weight (0-1, higher = more semantic)
  top_k: 20         # Candidates per search method
  min_score: 0.3    # Minimum score threshold
```

## Memory Types

The system auto-infers types from content:

| Type | Triggered by | Example |
|------|--------------|---------|
| preference | "prefers", "likes", "wants" | "nicholai prefers dark mode" |
| decision | "decided", "agreed", "will" | "decided to use bun" |
| fact | default | "signet stores data in SQLite" |
| rule | "never", "always", "must" | "never commit secrets" |
| learning | "learned", "discovered", "TIL" | "learned that X causes Y" |
| issue | "bug", "problem", "broken" | "auth is broken on Safari" |

## Importance Decay

Non-pinned memories decay over time:

```
importance(t) = base_importance × decay_factor^(days_since_access)
```

- `decay_factor`: 0.99 (1% decay per day)
- Accessing a memory resets its decay
- Pinned memories (`critical:`) never decay

## Daemon Integration

When Signet daemon is running, the skills talk directly to the daemon API:

```
POST /api/memory/save
  { content, who, project, importance?, tags?, pinned? }
  → { id, embedded: true/false }

GET /api/memory/search?q=<query>&limit=10&type=&tags=
  → { results: [...] }

GET /api/memory/similar?id=<memory_id>&k=5
  → { results: [...] }
```

This is faster and more reliable than spawning Python subprocesses.

## SKILL.md Files

The skills ship as standard SKILL.md files in `~/.agents/skills/`:

### remember/SKILL.md

```markdown
---
name: remember
description: Save to persistent memory with auto-embedding
user_invocable: true
arg_hint: "[critical:] [tags]: content"
builtin: true
---

# /remember

[Full documentation...]
```

### recall/SKILL.md

```markdown
---
name: recall
description: Query persistent memory using hybrid search
user_invocable: true
arg_hint: "search query"
builtin: true
---

# /recall

[Full documentation...]
```

The `builtin: true` frontmatter indicates these ship with Signet and integrate with the daemon directly.

## Migration Path

### Completed: Daemon-Native Hooks

All memory hooks now route through the daemon HTTP API. The migration from Python subprocess calls to daemon-native operations is complete:

- Memory operations handled by daemon (TypeScript)
- Skills call daemon HTTP API via `signet remember` / `signet recall`
- No Python dependency for core functionality
- Python scripts remain as optional batch tools (reindexing, export, migration)

## Error Handling

### remember errors

```
✗ Failed to save: embedding provider unavailable
  Memory saved without embedding (keyword search only)
```

```
✗ Failed to save: database locked
  Retry in a moment
```

### recall errors

```
No results found for "obscure query"
Try broader terms or check /memory in dashboard
```

```
✗ Search failed: daemon not running
  Start with: signet start
```

---

## See Also

- [Architecture](./ARCHITECTURE.md) - Technical deep dive
- [Configuration](./CONFIGURATION.md) - All config options
- [Skills](./SKILLS.md) - Full skills system design
