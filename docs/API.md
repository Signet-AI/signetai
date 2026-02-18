# API Reference

The Signet daemon exposes a REST API on `http://localhost:3850`. All endpoints return JSON.

The API has no authentication — it binds to `localhost` only and is not accessible from the network.

---

## Base URL

```
http://localhost:3850
```

Override the port with the `SIGNET_PORT` environment variable.

---

## Health & Status

### Health Check

```http
GET /health
```

Returns daemon health. Use this to check if the daemon is running.

**Response:**
```json
{
  "status": "healthy",
  "uptime": 3600.5,
  "pid": 12345,
  "version": "0.1.0",
  "port": 3850,
  "agentsDir": "/home/user/.agents"
}
```

### Daemon Status

```http
GET /api/status
```

More detailed status including memory database presence.

**Response:**
```json
{
  "status": "running",
  "version": "0.1.0",
  "pid": 12345,
  "uptime": 3600.5,
  "startedAt": "2025-02-17T16:00:00.000Z",
  "port": 3850,
  "host": "localhost",
  "agentsDir": "/home/user/.agents",
  "memoryDb": true
}
```

---

## Config API

### List Config Files

```http
GET /api/config
```

Returns all `.md` and `.yaml` files from `~/.agents/`, sorted by priority.

**Response:**
```json
{
  "files": [
    {
      "name": "agent.yaml",
      "content": "version: 1\nschema: signet/v1\n...",
      "size": 542
    },
    {
      "name": "AGENTS.md",
      "content": "# My Agent\n...",
      "size": 1234
    }
  ]
}
```

### Save Config File

```http
POST /api/config
Content-Type: application/json

{
  "file": "AGENTS.md",
  "content": "# Updated Agent\n..."
}
```

**Validation:**
- Filename cannot contain `/` or `..`
- Filename must end with `.md` or `.yaml`

**Response:**
```json
{ "success": true }
```

---

## Identity API

```http
GET /api/identity
```

Parses `IDENTITY.md` for structured identity fields.

**Response:**
```json
{
  "name": "Mr. Claude",
  "creature": "AI assistant",
  "vibe": "helpful and direct"
}
```

---

## Memory API

### List Memories

```http
GET /api/memories?limit=100&offset=0
```

Returns memories with pagination and stats.

**Query params:**

| Param | Default | Description |
|-------|---------|-------------|
| `limit` | 100 | Max memories to return |
| `offset` | 0 | Pagination offset |

**Response:**
```json
{
  "memories": [
    {
      "id": "uuid-string",
      "content": "nicholai prefers tabs over spaces",
      "created_at": "2025-02-17T18:00:00Z",
      "who": "claude-code",
      "importance": 0.8,
      "tags": "coding,preference",
      "source_type": "manual",
      "pinned": 0,
      "type": "preference"
    }
  ],
  "stats": {
    "total": 42,
    "withEmbeddings": 38,
    "critical": 5
  }
}
```

### Save a Memory (remember)

```http
POST /api/memory/remember
Content-Type: application/json

{
  "content": "nicholai prefers bun over npm",
  "who": "my-tool",
  "project": "/optional/project/path",
  "importance": 0.8,
  "tags": "coding,preference",
  "pinned": false
}
```

Only `content` is required. The `who` field identifies which harness/tool saved the memory.

The content may include prefix syntax:
- `"critical: never push to main"` — sets `pinned=true, importance=1.0`
- `"[tag1,tag2]: tagged content"` — adds tags

Body-level `importance`, `tags`, and `pinned` override parsed prefixes.

**Response:**
```json
{
  "id": "uuid-string",
  "type": "preference",
  "tags": "coding,preference",
  "pinned": false,
  "importance": 0.8,
  "content": "nicholai prefers bun over npm",
  "embedded": true
}
```

`embedded: false` means the memory was saved but embedding failed (keyword search still works).

**Alias:** `POST /api/memory/save` is an alias for the same endpoint.

### Search Memories (recall)

```http
POST /api/memory/recall
Content-Type: application/json

{
  "query": "coding preferences",
  "limit": 10,
  "type": "preference",
  "tags": "coding",
  "who": "claude-code",
  "since": "2025-01-01T00:00:00Z"
}
```

Only `query` is required.

**Response:**
```json
{
  "results": [
    {
      "content": "nicholai prefers tabs over spaces",
      "score": 0.87,
      "source": "hybrid",
      "type": "preference",
      "tags": "coding,preference",
      "pinned": false,
      "importance": 0.8,
      "who": "claude-code",
      "project": null,
      "created_at": "2025-02-15T10:00:00Z"
    }
  ],
  "query": "coding preferences",
  "method": "hybrid"
}
```

`source` is one of `hybrid`, `vector`, or `keyword`.

**GET alias:**

```http
GET /api/memory/search?q=coding+preferences&limit=10&type=preference
```

### Legacy Search (BM25 only)

```http
GET /memory/search?q=query&limit=20&type=preference&tags=tag1&who=claude-code&pinned=true
```

This endpoint does BM25 keyword search only (no semantic component). Use `/api/memory/recall` for hybrid search.

**Additional params:**

| Param | Description |
|-------|-------------|
| `importance_min` | Minimum importance score |
| `since` | ISO date filter |
| `distinct=who` | Return distinct values for the `who` column |

**Response:**
```json
{
  "results": [
    {
      "id": "uuid",
      "content": "...",
      "score": -1.5,
      "type": "preference",
      "pinned": 0,
      ...
    }
  ]
}
```

Note: BM25 scores are negative (lower = better match); this is a quirk of SQLite FTS5.

### Similar Memories (Vector Search)

```http
GET /memory/similar?id=<memory-uuid>&k=10&type=preference
```

Finds memories most similar to the given memory by vector cosine similarity.

| Param | Default | Description |
|-------|---------|-------------|
| `id` | required | Memory UUID |
| `k` | 10 | Number of results |
| `type` | — | Filter by type |

**Response:**
```json
{
  "results": [
    {
      "id": "uuid",
      "content": "prefers spaces in Python only",
      "similarity": 0.87
    }
  ]
}
```

---

## Embeddings API

```http
GET /api/embeddings?vectors=true
```

Returns embedding data for all memories that have vectors. Used by the dashboard's visualization.

| Param | Default | Description |
|-------|---------|-------------|
| `vectors` | false | Include actual vector arrays |

**Response:**
```json
{
  "embeddings": [
    {
      "id": "uuid",
      "text": "nicholai prefers bun",
      "who": "claude-code",
      "importance": 0.8,
      "vector": [0.1, 0.2, ...],
      "created_at": "2025-02-17T18:00:00Z"
    }
  ],
  "count": 38,
  "dimensions": 768
}
```

With `vectors=false`, the `vector` field is omitted.

---

## Skills API

### List Installed Skills

```http
GET /api/skills
```

**Response:**
```json
{
  "skills": [
    {
      "name": "remember",
      "description": "Save to persistent memory",
      "version": "1.0.0",
      "author": "signet",
      "user_invocable": true,
      "arg_hint": "[critical:] [tags]: content",
      "path": "/home/user/.agents/skills/remember"
    }
  ],
  "count": 4
}
```

### Search skills.sh Registry

```http
GET /api/skills/search?q=browser
```

**Response:**
```json
{
  "results": [
    {
      "name": "browser-use",
      "description": "browser-use/browser-use@browser-use (32.6K installs)",
      "installed": false
    }
  ]
}
```

### Get Skill Details

```http
GET /api/skills/:name
```

Returns skill metadata and the full SKILL.md content.

**Response:**
```json
{
  "name": "browser-use",
  "description": "Browser automation",
  "version": "1.2.0",
  "content": "---\nname: browser-use\n...\n---\n\n# browser-use\n..."
}
```

Returns 404 if not installed.

### Install a Skill

```http
POST /api/skills/install
Content-Type: application/json

{
  "name": "browser-use",
  "source": "owner/repo@skill-name"
}
```

`name` is required. `source` is optional (defaults to `name`).

**Response:**
```json
{
  "success": true,
  "name": "browser-use",
  "output": "..."
}
```

### Remove a Skill

```http
DELETE /api/skills/:name
```

**Response:**
```json
{
  "success": true,
  "name": "browser-use",
  "message": "Removed browser-use"
}
```

---

## Harnesses API

### List Harnesses

```http
GET /api/harnesses
```

**Response:**
```json
{
  "harnesses": [
    { "name": "Claude Code", "path": "/home/user/.claude/CLAUDE.md", "exists": true },
    { "name": "OpenCode", "path": "/home/user/.config/opencode/AGENTS.md", "exists": true },
    { "name": "OpenClaw (Source)", "path": "/home/user/.agents/AGENTS.md", "exists": true }
  ]
}
```

### Regenerate Harness Configs

```http
POST /api/harnesses/regenerate
```

Triggers regeneration of all harness config files from AGENTS.md.

**Response:**
```json
{
  "success": true,
  "message": "Configs regenerated successfully"
}
```

---

## Secrets API

### List Secret Names

```http
GET /api/secrets
```

Returns only names — never values.

**Response:**
```json
{
  "secrets": ["OPENAI_API_KEY", "GITHUB_TOKEN"]
}
```

### Store a Secret

```http
POST /api/secrets/:name
Content-Type: application/json

{
  "value": "sk-proj-..."
}
```

Secret names must match `[A-Za-z_][A-Za-z0-9_]*`.

**Response:**
```json
{ "success": true, "name": "OPENAI_API_KEY" }
```

### Delete a Secret

```http
DELETE /api/secrets/:name
```

**Response:**
```json
{ "success": true, "name": "OPENAI_API_KEY" }
```

Returns 404 if the secret doesn't exist.

### Execute with Secret

```http
POST /api/secrets/:name/exec
Content-Type: application/json

{
  "command": "curl https://api.openai.com/v1/models",
  "secrets": {
    "OPENAI_API_KEY": "OPENAI_API_KEY"
  }
}
```

`secrets` maps env var names to secret names. The daemon decrypts values, injects them into the subprocess environment, and redacts them from the output.

**Response:**
```json
{
  "stdout": "...",
  "stderr": "",
  "code": 0
}
```

Any secret value found in stdout/stderr is replaced with `[REDACTED]`.

---

## Hooks API

### Session Start

```http
POST /api/hooks/session-start
Content-Type: application/json

{
  "harness": "openclaw",
  "agentId": "optional",
  "sessionKey": "optional"
}
```

**Response:**
```json
{
  "identity": { "name": "Mr. Claude", "description": "..." },
  "memories": [...],
  "recentContext": "...",
  "inject": "You are Mr. Claude...\n\n## Relevant Memories\n..."
}
```

### Pre-Compaction

```http
POST /api/hooks/pre-compaction
Content-Type: application/json

{
  "harness": "openclaw",
  "messageCount": 150,
  "sessionKey": "optional"
}
```

**Response:**
```json
{
  "summaryPrompt": "Pre-compaction memory flush...",
  "guidelines": "Summarize this session focusing on..."
}
```

### Compaction Complete

```http
POST /api/hooks/compaction-complete
Content-Type: application/json

{
  "harness": "openclaw",
  "summary": "Session summary text...",
  "sessionKey": "optional"
}
```

**Response:**
```json
{ "success": true, "memoryId": 123 }
```

### Request Synthesis

```http
POST /api/hooks/synthesis
Content-Type: application/json

{
  "trigger": "manual"
}
```

**Response:**
```json
{
  "harness": "openclaw",
  "model": "sonnet",
  "prompt": "You are regenerating MEMORY.md...",
  "memories": [...]
}
```

### Save Synthesis Result

```http
POST /api/hooks/synthesis/complete
Content-Type: application/json

{
  "content": "# Memory\n\n## Active Projects\n..."
}
```

**Response:**
```json
{ "success": true }
```

### Get Synthesis Config

```http
GET /api/hooks/synthesis/config
```

**Response:**
```json
{
  "harness": "openclaw",
  "model": "sonnet",
  "schedule": "daily",
  "max_tokens": 4000
}
```

---

## Logs API

### Get Recent Logs

```http
GET /api/logs?limit=100&level=warn&category=memory
```

| Param | Description |
|-------|-------------|
| `limit` | Max entries (default: 100) |
| `level` | Filter: `debug`, `info`, `warn`, `error` |
| `category` | Filter by category: `memory`, `harness`, `git`, `skills`, `hooks`, etc. |
| `since` | ISO date — logs since this time |

**Response:**
```json
{
  "logs": [
    {
      "timestamp": "2025-02-17T18:00:01.000Z",
      "level": "info",
      "category": "memory",
      "message": "Memory saved",
      "data": { "id": "uuid", "type": "preference" }
    }
  ],
  "count": 1
}
```

### Stream Logs (Server-Sent Events)

```http
GET /api/logs/stream
```

Returns a real-time event stream. Each event is a JSON log entry:

```
data: {"timestamp":"...","level":"info","category":"memory","message":"Memory saved"}

data: {"type":"connected"}
```

---

## Error Responses

All errors return a JSON body with an `error` field:

```json
{ "error": "Description of what went wrong" }
```

Standard HTTP status codes:
- `400` — bad request (missing required fields, invalid params)
- `404` — resource not found
- `500` — internal error
- `504` — timeout (e.g. similarity search timed out)
