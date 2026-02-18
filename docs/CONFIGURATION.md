# Configuration Reference

Complete reference for all Signet configuration options.

---

## Configuration Files

All files live in `~/.agents/` (or your custom `SIGNET_PATH`).

| File | Purpose |
|------|---------|
| `agent.yaml` | Main configuration and manifest |
| `AGENTS.md` | Agent identity and instructions (synced to harnesses) |
| `SOUL.md` | Personality and tone |
| `MEMORY.md` | Working memory summary (auto-generated) |
| `IDENTITY.md` | Optional identity metadata (name, creature, vibe) |
| `USER.md` | Optional user preferences and profile |

---

## agent.yaml

The primary configuration file. Created by `signet setup` and editable via `signet config` or the dashboard's config editor.

### Full Schema

```yaml
# Version and schema identifier
version: 1
schema: signet/v1

# Agent identity
agent:
  name: "My Agent"
  description: "Personal AI assistant"
  created: "2025-02-17T00:00:00Z"
  updated: "2025-02-17T00:00:00Z"

# Optional owner information
owner:
  address: "0x..."           # Ethereum address
  localId: "user123"         # Local identifier
  ens: "user.eth"            # ENS name
  name: "User Name"          # Display name

# Configured harnesses
harnesses:
  - claude-code
  - openclaw
  - opencode

# Embedding configuration
embedding:
  provider: ollama           # 'ollama' | 'openai'
  model: nomic-embed-text    # Model name
  dimensions: 768            # Vector dimensions
  base_url: http://localhost:11434  # Ollama URL
  api_key: $secret:OPENAI_API_KEY   # OpenAI key (use secret reference)

# Search configuration
search:
  alpha: 0.7                 # Vector weight (0-1)
  top_k: 20                  # Candidates per search source
  min_score: 0.3             # Minimum relevance threshold

# Memory configuration
memory:
  database: memory/memories.db
  session_budget: 2000       # Max chars for session context
  decay_rate: 0.95           # Importance decay per day

  # MEMORY.md synthesis (optional)
  synthesis:
    harness: openclaw        # Which harness runs synthesis
    model: sonnet            # Model to use
    schedule: daily          # 'daily' | 'weekly' | 'on-demand'
    max_tokens: 4000

# Hooks configuration (optional)
hooks:
  sessionStart:
    recallLimit: 10          # Memories to inject at session start
    includeIdentity: true
    includeRecentContext: true
    recencyBias: 0.7         # Weight toward recent vs. important
  preCompaction:
    includeRecentMemories: true
    memoryLimit: 5

# Optional: trust/verification settings
trust:
  verification: none         # 'none' | 'erc8128' | 'gpg' | 'did'
```

---

### Section Details

#### `agent`

Core agent identity metadata.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✓ | Agent display name |
| `description` | string | | Short description |
| `created` | string | ✓ | ISO 8601 creation timestamp |
| `updated` | string | ✓ | ISO 8601 last update timestamp |

#### `owner`

Optional owner identification. Reserved for future verification features.

| Field | Type | Description |
|-------|------|-------------|
| `address` | string | Ethereum wallet address |
| `localId` | string | Local user identifier |
| `ens` | string | ENS domain name |
| `name` | string | Human-readable name |

#### `harnesses`

List of AI platforms to integrate with. Valid values:

- `claude-code` — Anthropic's Claude Code CLI
- `opencode` — OpenCode
- `openclaw` — OpenClaw
- `cursor` — Cursor IDE (planned)
- `windsurf` — Windsurf (planned)
- `chatgpt` — ChatGPT (planned)
- `gemini` — Google Gemini (planned)

#### `embedding`

Vector embedding configuration for semantic search.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | string | — | `ollama` or `openai` |
| `model` | string | — | Embedding model name |
| `dimensions` | number | — | Output vector dimensions |
| `base_url` | string | `http://localhost:11434` | Ollama API URL |
| `api_key` | string | — | OpenAI API key or `$secret:NAME` reference |

**Ollama Models:**

| Model | Dimensions | Notes |
|-------|------------|-------|
| `nomic-embed-text` | 768 | Recommended; good quality/speed balance |
| `all-minilm` | 384 | Faster, smaller vectors |
| `mxbai-embed-large` | 1024 | Better quality, more resource usage |

**OpenAI Models:**

| Model | Dimensions | Notes |
|-------|------------|-------|
| `text-embedding-3-small` | 1536 | Cost-effective, solid quality |
| `text-embedding-3-large` | 3072 | Best quality, higher cost |

**Secret references** — Instead of putting your API key in plain text, store it with `signet secret put OPENAI_API_KEY` and reference it as:
```yaml
api_key: $secret:OPENAI_API_KEY
```

#### `search`

Hybrid search tuning. Controls the blend between semantic (vector) and keyword (BM25) search.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `alpha` | number | 0.7 | Vector weight 0–1. Higher = more semantic. |
| `top_k` | number | 20 | Candidates fetched from each search method |
| `min_score` | number | 0.3 | Minimum combined score to include a result |

**Alpha guide:**

| Value | Behavior |
|-------|----------|
| 0.9 | Heavily semantic — good for conceptual queries |
| 0.7 | Balanced — default, works well generally |
| 0.5 | Equal weighting |
| 0.3 | Heavily keyword — good for exact-phrase lookups |

#### `memory`

Memory system settings.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `database` | string | `memory/memories.db` | SQLite database path (relative to `~/.agents/`) |
| `session_budget` | number | 2000 | Character limit for session context injection |
| `decay_rate` | number | 0.95 | Daily importance decay factor for non-pinned memories |

**Decay rate:**

Non-pinned memories lose importance over time:
```
importance(t) = base_importance × decay_rate^days_since_access
```

Accessing a memory resets the decay timer.

| Rate | Effect |
|------|--------|
| 0.99 | Slow decay (1% per day) |
| 0.95 | Moderate (5% per day) — default |
| 0.90 | Fast (10% per day) |

#### `memory.synthesis`

Configuration for periodic MEMORY.md regeneration via an AI harness. The synthesis process reads all memories and asks a model to write a coherent summary into `MEMORY.md`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `harness` | string | `openclaw` | Which harness runs the synthesis |
| `model` | string | `sonnet` | Model identifier |
| `schedule` | string | `daily` | `daily`, `weekly`, or `on-demand` |
| `max_tokens` | number | 4000 | Max output tokens for synthesis |

#### `hooks`

Controls what Signet injects during harness lifecycle events. See [HOOKS.md](./HOOKS.md) for full details.

**`hooks.sessionStart`:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `recallLimit` | number | 10 | Number of memories to inject |
| `includeIdentity` | boolean | true | Include agent name/description |
| `includeRecentContext` | boolean | true | Include MEMORY.md content |
| `recencyBias` | number | 0.7 | Weight toward recent vs. important memories |

**`hooks.preCompaction`:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `includeRecentMemories` | boolean | true | Include recent memories in the prompt |
| `memoryLimit` | number | 5 | How many recent memories to include |
| `summaryGuidelines` | string | built-in | Custom instructions for session summary |

---

## AGENTS.md

The main agent identity file. This is the "personality" that gets synced to all harnesses. Write it in plain markdown — there's no required format, but a typical structure looks like this:

```markdown
# Agent Name

Short introduction paragraph. What is this agent? Who does it serve?

## Personality

Describe communication style, tone, and approach.

## Instructions

Specific behaviors, preferences, and task guidance.

## Rules

Hard rules the agent should follow (never do X, always do Y).

## Context

Background information — who the user is, what they work on, etc.
```

### Auto-sync behavior

When `AGENTS.md` changes, the daemon detects it within 2 seconds and writes updated copies to:

- `~/.claude/CLAUDE.md` (if `~/.claude/` exists)
- `~/.config/opencode/AGENTS.md` (if `~/.config/opencode/` exists)

Each copy is prefixed with a header identifying the source:

```
# CLAUDE.md
# ============================================================================
# AUTO-GENERATED from ~/.agents/AGENTS.md by Signet
# Generated: 2025-02-17T18:00:00.000Z
# 
# DO NOT EDIT THIS FILE - changes will be overwritten
# Edit the source file instead: ~/.agents/AGENTS.md
# ...
```

---

## SOUL.md

Optional personality file for deeper character definition. Loaded by some harnesses that support separate personality/instruction files. Not required.

```markdown
# Soul

Core personality traits and values.

## Voice

How the agent speaks and writes.

## Values

What the agent prioritizes and cares about.

## Quirks

Unique personality characteristics.
```

---

## MEMORY.md

Auto-generated working memory summary. Updated by the synthesis system. Do not edit by hand — changes will be overwritten. This file is loaded at session start (if `hooks.sessionStart.includeRecentContext` is true) to give the agent a sense of recent context.

---

## IDENTITY.md

Optional file for structured identity metadata. Currently used by the dashboard to display the agent's name, creature type, and vibe.

```markdown
- name: My Agent
- creature: AI assistant
- vibe: helpful and direct
```

---

## Database Schema

The SQLite database at `memory/memories.db` contains three main tables:

### memories

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Primary key (UUID) |
| `content` | TEXT | Memory content |
| `type` | TEXT | `fact`, `preference`, `decision`, `rule`, `learning`, `issue`, `session_summary` |
| `source` | TEXT | Source system/harness |
| `importance` | REAL | 0–1 score, decays over time |
| `tags` | TEXT | Comma-separated tags |
| `who` | TEXT | Source harness name |
| `pinned` | INTEGER | 1 if critical/pinned (never decays) |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |
| `last_accessed` | TEXT | Last access timestamp |
| `access_count` | INTEGER | Number of times recalled |

### embeddings

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT | Primary key (UUID) |
| `content_hash` | TEXT | SHA-256 hash of embedded text |
| `vector` | BLOB | Float32 array (raw bytes) |
| `dimensions` | INTEGER | Vector size (e.g. 768) |
| `source_type` | TEXT | `memory`, `conversation`, etc. |
| `source_id` | TEXT | Reference to parent memory UUID |
| `chunk_text` | TEXT | The text that was embedded |
| `created_at` | TEXT | ISO timestamp |

### memories_fts

FTS5 virtual table for keyword search:

| Column | Description |
|--------|-------------|
| `content` | Full-text indexed memory content |
| `tags` | Full-text indexed tags |

---

## Harness-Specific Configuration

### Claude Code

**Location:** `~/.claude/`

`settings.json` configures memory hooks that run at session lifecycle events:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.agents/memory/scripts/memory.py load --mode session-start",
        "timeout": 3000
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.agents/memory/scripts/memory.py load --mode prompt",
        "timeout": 2000
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.agents/memory/scripts/memory.py save --mode auto",
        "timeout": 10000
      }]
    }]
  }
}
```

### OpenCode

**Location:** `~/.config/opencode/`

`memory.mjs` is an OpenCode plugin that provides `/remember` and `/recall` as native tools.

### OpenClaw

**Location:** `~/.agents/hooks/agent-memory/` (hook directory)

Also configures the OpenClaw workspace in `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.agents"
    }
  }
}
```

For the full OpenClaw adapter, see [HARNESSES.md](./HARNESSES.md).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNET_PATH` | `~/.agents` | Base agents directory |
| `SIGNET_PORT` | `3850` | Daemon HTTP port |
| `SIGNET_HOST` | `localhost` | Daemon bind address |

---

## Git Integration

If `~/.agents/` is a git repository:

1. The setup wizard offers to initialize git
2. The daemon auto-commits on file changes (5s debounce after last change)
3. Commit messages: `YYYY-MM-DDTHH-MM-SS_auto_<filename>`
4. Setup creates a backup commit before making changes

Recommended `.gitignore` for `~/.agents/`:

```gitignore
# Daemon runtime files
.daemon/

# Encrypted secrets (keep out of git)
.secrets/

# Python caches
__pycache__/
*.pyc

# Logs
*.log
```
