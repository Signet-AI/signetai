# Signet Architecture

Technical deep dive into Signet's design and implementation.

---

## Overview

Signet consists of four main components:

1. **CLI** (`@signet/cli`) - User interface: setup wizard, config editor, daemon management
2. **Daemon** (`@signet/daemon`) - Background service: HTTP API, file watching, harness sync
3. **Core** (`@signet/core`) - Shared library: types, database, search, manifest parsing
4. **SDK** (`@signet/sdk`) - Integration library for third-party apps

---

## Directory Structure

### Source Layout

```
signetai/
├── packages/
│   ├── cli/
│   │   ├── src/
│   │   │   └── cli.ts           # Main CLI entry point (~1600 LOC)
│   │   ├── dashboard/           # SvelteKit web UI
│   │   │   └── src/routes/      # Dashboard pages
│   │   └── templates/           # Setup wizard templates
│   ├── daemon/
│   │   └── src/
│   │       ├── daemon.ts        # HTTP server + file watcher
│   │       ├── service.ts       # System service installation
│   │       └── index.ts         # Package exports
│   ├── core/
│   │   └── src/
│   │       ├── types.ts         # TypeScript interfaces
│   │       ├── signet.ts        # Signet class
│   │       ├── database.ts      # SQLite wrapper
│   │       ├── search.ts        # Hybrid search
│   │       ├── manifest.ts      # YAML parsing
│   │       ├── memory.ts        # Memory helpers
│   │       ├── import.ts        # Memory import & hierarchical chunking
│   │       ├── soul.ts          # Soul template
│   │       └── constants.ts     # Shared constants
│   └── sdk/
│       └── src/
│           └── index.ts         # SignetSDK class
└── docs/
    └── *.md                     # Documentation
```

### User Data Layout

```
~/.agents/
├── agent.yaml                   # Combined manifest & config
├── AGENTS.md                    # Agent identity/instructions
├── SOUL.md                      # Personality & tone
├── MEMORY.md                    # Generated working memory
├── memory/
│   ├── memories.db              # SQLite database
│   ├── vectors.zvec             # Vector embeddings (planned)
│   └── scripts/
│       ├── memory.py            # Memory CLI tool
│       └── export_embeddings.py # Embedding export
├── skills/                      # Installed skills
│   ├── remember/
│   └── recall/
├── secrets/                     # Encrypted storage (planned)
│   ├── keyring.enc
│   └── meta.json
├── harnesses/                   # Harness-specific config
├── hooks/                       # OpenClaw hooks
│   └── agent-memory/
└── .daemon/
    ├── pid                      # Daemon process ID
    └── logs/
        └── daemon-YYYY-MM-DD.log
```

---

## Core Library (`@signet/core`)

### Key Types

```typescript
interface AgentManifest {
  version: number;
  schema: string;              // "signet/v1"
  
  agent: {
    name: string;
    description?: string;
    created: string;           // ISO timestamp
    updated: string;
  };
  
  harnesses?: string[];        // ["claude-code", "openclaw", ...]
  
  embedding?: {
    provider: 'ollama' | 'openai';
    model: string;
    dimensions: number;
    base_url?: string;
    api_key?: string;
  };
  
  search?: {
    alpha: number;             // Vector weight (0-1)
    top_k: number;             // Candidates per source
    min_score: number;         // Minimum threshold
  };
  
  memory?: {
    database: string;          // Relative path
    vectors?: string;
    session_budget?: number;   // Character limit
    decay_rate?: number;       // Importance decay per day
  };
}

interface Memory {
  id: string;
  type: 'fact' | 'preference' | 'decision' | 'rule' | 'learning' | 'issue';
  content: string;
  importance: number;          // 0-1, with decay
  tags: string[];
  who: string;                 // Source harness
  pinned: boolean;             // Critical memories
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
  accessCount: number;
}
```

### Database Schema

SQLite with FTS5 for full-text search. Signet uses a unified schema that consolidates fields from multiple sources (Python memory system, early CLI versions, and the core library).

```sql
-- Schema migrations tracking
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);

-- Conversations table
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  topics TEXT,
  decisions TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  vector_clock TEXT NOT NULL DEFAULT '{}',
  version INTEGER DEFAULT 1,
  manual_override INTEGER DEFAULT 0
);

-- Unified memories table
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'fact',
  category TEXT,
  content TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  importance REAL DEFAULT 0.5,
  source_id TEXT,
  source_type TEXT,
  tags TEXT,                        -- JSON array
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  last_accessed TEXT,
  access_count INTEGER DEFAULT 0,
  vector_clock TEXT NOT NULL DEFAULT '{}',
  version INTEGER DEFAULT 1,
  manual_override INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0
);

-- Embeddings table
CREATE TABLE embeddings (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  vector BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Full-text search index
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  content='memories',
  content_rowid=rowid
);

-- FTS sync triggers
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

### Schema Migration

Signet automatically detects and migrates older database schemas:

| Schema Type | Detection | Migration |
|-------------|-----------|-----------|
| **python** | Has `who`, `why`, `project` columns | Maps fields to unified schema |
| **cli-v1** | Has `source`, `accessed_at` columns | Maps fields to unified schema |
| **core** | Has `category`, `confidence`, `vector_clock` | Already unified |

Use `signet migrate-schema` to explicitly migrate a database. See [CLI.md](./CLI.md#signet-migrate-schema) for details.

### Constants

```typescript
const DEFAULT_BASE_PATH = '~/.agents';
const SCHEMA_VERSION = 1;
const DEFAULT_HYBRID_ALPHA = 0.7;      // Vector weight
const DEFAULT_EMBEDDING_DIMENSIONS = 768;
```

---

## CLI (`@signet/cli`)

### Commands

| Command | Description |
|---------|-------------|
| `signet` | Interactive TUI menu |
| `signet setup` | First-time setup wizard |
| `signet config` | Interactive config editor |
| `signet start` | Start daemon |
| `signet stop` | Stop daemon |
| `signet restart` | Restart daemon |
| `signet status` | Show status |
| `signet dashboard` | Open web UI |
| `signet logs` | View daemon logs |
| `signet migrate` | Import from other platforms |

### Setup Wizard Flow

1. Check for existing installation
2. Collect agent name & description
3. Select harnesses (Claude Code, OpenCode, OpenClaw, Cursor, Windsurf)
4. Configure OpenClaw workspace if selected
5. Choose embedding provider (Ollama, OpenAI, none)
6. Select embedding model
7. Configure search balance (semantic vs keyword)
8. Optionally configure advanced settings
9. Initialize git repository
10. Create directory structure and files
11. Initialize SQLite database
12. Configure harness hooks
13. Start daemon
14. Optionally open dashboard

### Harness Hook Configuration

For each selected harness, Signet generates integration files:

**Claude Code:**
```typescript
// ~/.claude/settings.json
{
  hooks: {
    SessionStart: [{
      hooks: [{
        type: 'command',
        command: 'memory.py load --mode session-start',
        timeout: 3000
      }]
    }]
  }
}

// ~/.claude/CLAUDE.md
// Auto-generated from ~/.agents/AGENTS.md
```

**OpenCode:**
```typescript
// ~/.config/opencode/memory.mjs
// Plugin with remember/recall tools
```

**OpenClaw:**
```typescript
// ~/.agents/hooks/agent-memory/
// - HOOK.md
// - handler.js
// - package.json
```

---

## Daemon (`@signet/daemon`)

### HTTP Server

Hono-based HTTP server on port 3850:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with uptime/pid |
| `/api/status` | GET | Full daemon status |
| `/api/config` | GET | List config files (*.md, *.yaml) |
| `/api/config` | POST | Save config file |
| `/api/identity` | GET | Agent identity from IDENTITY.md |
| `/api/memories` | GET | List memories with pagination |
| `/memory/search` | GET | Hybrid search with filters |
| `/memory/similar` | GET | Vector similarity search |
| `/api/embeddings` | GET | Export embeddings for visualization |
| `/api/harnesses` | GET | List configured harnesses |
| `/api/harnesses/regenerate` | POST | Regenerate harness configs |
| `/*` | GET | Static dashboard files |

### File Watcher

Watches config files for changes:

```typescript
// Files watched:
'~/.agents/agent.yaml'
'~/.agents/AGENTS.md'
'~/.agents/SOUL.md'
'~/.agents/MEMORY.md'
'~/.agents/IDENTITY.md'
'~/.agents/USER.md'
```

**Auto-commit (5s debounce):**
On any change, if git repo exists, commit with timestamp:
`YYYY-MM-DDTHH-MM-SS_auto_<filename>`

**Harness sync (2s debounce):**
When AGENTS.md changes, regenerate harness configs:
- `~/.claude/CLAUDE.md`
- `~/.config/opencode/AGENTS.md`

### System Service

**macOS (launchd):**
```xml
<!-- ~/Library/LaunchAgents/ai.signet.daemon.plist -->
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>ai.signet.daemon</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    ...
  </dict>
</plist>
```

**Linux (systemd):**
```ini
# ~/.config/systemd/user/signet.service
[Unit]
Description=Signet Daemon

[Service]
Type=simple
ExecStart=/usr/bin/node daemon.js
Restart=on-failure

[Install]
WantedBy=default.target
```

---

## Dashboard

SvelteKit application built to static files, served by daemon.

### Features

1. **Config Editor**
   - Loads all .md and .yaml files from ~/.agents/
   - Syntax-aware textarea
   - Cmd+S to save
   - Auto-sync to server

2. **Embeddings Visualization**
   - Fetches embeddings with vectors from API
   - UMAP dimensionality reduction (2D projection)
   - D3-force layout for interactive graph
   - KNN edges connecting similar memories
   - Color-coded by source harness

3. **Memory Browser**
   - Hybrid search (query + filters)
   - Filter by: type, tags, who, pinned, importance, date
   - Click to find similar memories (vector search)

4. **Harness Status**
   - Shows configured harnesses
   - Indicates which config files exist

---

## Search System

### Hybrid Search

Combines vector similarity (semantic) and BM25 (keyword) matching:

```typescript
interface SearchOptions {
  query: string;
  limit?: number;
  alpha?: number;     // Vector weight (default 0.7)
  type?: string;
  tags?: string;
  who?: string;
  pinned?: boolean;
  importance_min?: number;
  since?: string;
}
```

**Algorithm:**
1. Run FTS5 query for keyword matches
2. Run vector similarity search (via Python script)
3. Blend scores: `final = alpha * vector + (1-alpha) * keyword`
4. Apply filters
5. Return top-k results

### Memory Importance Decay

Non-pinned memories decay over time:

```
importance(t) = base_importance × decay_rate^(days_since_access)
```

Accessing a memory resets its decay timer.

---

## Memory Import System

### Hierarchical Chunking

The `import.ts` module provides `chunkMarkdownHierarchically()` for preserving document structure when ingesting markdown files:

```typescript
interface HierarchicalChunk {
  text: string;              // Chunk content (includes header)
  tokenCount: number;        // Estimated tokens (~4 chars/token)
  header: string;            // Section heading (e.g., "## API Notes")
  level: 'section' | 'paragraph';
  chunkIndex: number;        // Position in document
}

function chunkMarkdownHierarchically(
  content: string,
  options?: { maxTokens: number }
): HierarchicalChunk[];
```

**Chunking algorithm:**

1. Parse document by markdown headers (h1-h3)
2. For each section:
   - If section fits within `maxTokens`: create a **section chunk**
   - If section exceeds limit: split into **paragraph chunks** with header preserved
3. Each chunk includes its section header for context

### Auto-Ingestion

The daemon automatically ingests memory files on startup and when files change:

| Source | Location | Who | Trigger |
|--------|----------|-----|---------|
| OpenClaw memory logs | `~/.agents/memory/*.md` | `openclaw-memory` | Startup + file watcher |
| Claude Code project memories | `~/.claude/projects/*/memory/MEMORY.md` | `claude-code` | Startup + file watcher |

**Deduplication:**
- File-level SHA-256 hash prevents re-processing unchanged files
- Content-level deduplication via hash in tags

---

## Embedding Pipeline

### Current Implementation (Python)

```bash
~/.agents/memory/scripts/memory.py save --mode explicit --content "..."
~/.agents/memory/scripts/memory.py query "search query"
~/.agents/memory/scripts/memory.py similar <id>
```

### Providers

**Ollama (local):**
```yaml
embedding:
  provider: ollama
  model: nomic-embed-text
  dimensions: 768
```

**OpenAI:**
```yaml
embedding:
  provider: openai
  model: text-embedding-3-small
  dimensions: 1536
```

---

## Security Considerations

1. **Daemon binds to localhost only** - No network exposure
2. **Secrets never exposed to agents** - Daemon-mediated execution (planned)
3. **Git history for audit trail** - All changes versioned
4. **No telemetry** - All data stays local

---

## Future Architecture

### Planned: Daemon-Native Memory

Move memory operations from Python scripts to TypeScript daemon:

```typescript
// Current
spawn('python3', [MEMORY_SCRIPT, 'save', ...])

// Future
await this.memoryService.save(content, options);
```

### Planned: Skills System

```
~/.agents/skills/
├── remember/
│   └── SKILL.md
├── recall/
│   └── SKILL.md
└── github/
    └── SKILL.md
```

### Planned: Secrets Manager

```typescript
interface SecretManager {
  put(name: string, value: string): Promise<void>;
  has(name: string): Promise<boolean>;
  execWithSecrets(cmd: string, refs: Record<string, string>): Promise<Result>;
}
```
