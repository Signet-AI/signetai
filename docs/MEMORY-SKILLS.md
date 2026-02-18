# Built-in Memory Skills

> **Status:** Partially implemented
> 
> The `remember` and `recall` commands work via Python scripts today.
> Native daemon integration is planned for v1.0.

---

Signet ships with two core skills for memory management: `remember` and `recall`. These integrate directly with the Signet daemon rather than calling external scripts.

## Overview

| Skill | Command | Purpose |
|-------|---------|---------|
| remember | `/remember <content>` | Save to persistent memory |
| recall | `/recall <query>` | Search persistent memory |

These are the primary interface between agents and the memory system.

## remember

### Syntax

```
/remember <content>
/remember critical: <content>
/remember [tag1,tag2]: <content>
```

### Features

- **Auto-embedding**: Content is vectorized for semantic search
- **Type inference**: Detects preferences, decisions, facts, etc.
- **Critical marking**: `critical:` prefix pins memories (never decay)
- **Tagging**: `[tag1,tag2]:` prefix adds explicit tags
- **Cross-harness**: Memories shared across all AI tools

### Examples

```
/remember nicholai prefers tabs over spaces
/remember critical: never push directly to main branch
/remember [signet,architecture]: agent profile lives at ~/.agents/
/remember [voice,tts]: qwen model needs 12GB VRAM minimum
```

### Implementation

#### Current (Script-based)

```bash
~/.agents/memory/scripts/memory.py save \
  --mode explicit \
  --who <harness> \
  --project "$(pwd)" \
  --content "<content>"
```

#### Future (Daemon API)

```typescript
// Agent calls the remember tool
await signet.memory.save({
  content: "nicholai prefers tabs",
  who: "claude-code",
  project: "/current/project",
  importance: 0.8,  // or 1.0 for critical
  tags: ["preference"],
  pinned: false
});
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

```
/recall <query>
```

### Features

- **Hybrid search**: Combines vector similarity (70%) + keyword matching (30%)
- **Score display**: Shows relevance scores for transparency
- **Rich results**: Content, tags, source, type, timestamps
- **Filters**: Can filter by type, tags, date (in advanced usage)

### Examples

```
/recall signet architecture
/recall preferences
/recall what did we decide about the API
/recall bun vs npm
```

### Implementation

#### Current (Script-based)

```bash
~/.agents/memory/scripts/memory.py query "<search>" --limit 10
```

#### Future (Daemon API)

```typescript
const results = await signet.memory.search({
  query: "signet architecture",
  limit: 10,
  filters: {
    type: "fact",      // optional
    tags: ["signet"],  // optional
    since: "2025-01-01" // optional
  }
});
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

### Current State (v0.1)

- Scripts in `~/.agents/memory/scripts/`
- Skills call Python scripts via subprocess
- Works but slow, requires Python

### Target State (v1.0)

- Memory operations in daemon (TypeScript)
- Skills call daemon HTTP API
- No Python dependency for core functionality
- Scripts remain for advanced operations (reindexing, export)

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
- [Roadmap](./ROADMAP.md) - Development timeline
