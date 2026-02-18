# Signet Daemon

The Signet daemon is a background service that provides the HTTP API, serves the dashboard, watches files for changes, and manages harness synchronization.

---

## Overview

The daemon runs on `http://localhost:3850` by default and provides:

- **HTTP API** - RESTful endpoints for memory, config, and harness management
- **Static Dashboard** - SvelteKit web UI for visualization and editing
- **File Watcher** - Monitors config files for changes
- **Auto-Commit** - Git version control with automatic commits
- **Harness Sync** - Propagates AGENTS.md changes to all harnesses

---

## Starting & Stopping

### Via CLI

```bash
signet start      # Start the daemon
signet stop       # Stop the daemon
signet restart    # Restart the daemon
signet status     # Check status
```

### Via System Service

The daemon can be installed as a system service for auto-start on boot.

**macOS (launchd):**
```bash
# Install
signet install-service

# Control
launchctl load ~/Library/LaunchAgents/ai.signet.daemon.plist
launchctl unload ~/Library/LaunchAgents/ai.signet.daemon.plist
```

**Linux (systemd):**
```bash
# Install
signet install-service

# Control
systemctl --user start signet.service
systemctl --user stop signet.service
systemctl --user status signet.service

# Enable on boot
systemctl --user enable signet.service
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNET_PORT` | `3850` | HTTP server port |
| `SIGNET_HOST` | `localhost` | Bind address |
| `SIGNET_PATH` | `~/.agents` | Base agents directory |

### Files

| File | Description |
|------|-------------|
| `~/.agents/.daemon/pid` | Process ID file |
| `~/.agents/.daemon/logs/` | Log directory |
| `~/.agents/.daemon/logs/daemon-YYYY-MM-DD.log` | Daily log file |
| `~/.agents/.daemon/logs/daemon.out.log` | stdout capture |
| `~/.agents/.daemon/logs/daemon.err.log` | stderr capture |

---

## HTTP API

### Health Check

```http
GET /health
```

Returns daemon health status.

**Response:**
```json
{
  "status": "healthy",
  "uptime": 3600,
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

Returns comprehensive daemon status.

**Response:**
```json
{
  "status": "running",
  "version": "0.1.0",
  "pid": 12345,
  "uptime": 3600,
  "startedAt": "2025-02-17T16:00:00.000Z",
  "port": 3850,
  "host": "localhost",
  "agentsDir": "/home/user/.agents",
  "memoryDb": true
}
```

---

### Config API

#### List Config Files

```http
GET /api/config
```

Returns all .md and .yaml files from ~/.agents/.

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

#### Save Config File

```http
POST /api/config
Content-Type: application/json

{
  "file": "AGENTS.md",
  "content": "# Updated Agent\n..."
}
```

**Response:**
```json
{
  "success": true
}
```

**Validation:**
- Filename cannot contain `/` or `..`
- Filename must end with `.md` or `.yaml`

---

### Identity API

```http
GET /api/identity
```

Parses IDENTITY.md for agent identity fields.

**Response:**
```json
{
  "name": "My Agent",
  "creature": "AI Assistant",
  "vibe": "helpful and friendly"
}
```

---

### Memories API

#### List Memories

```http
GET /api/memories?limit=100&offset=0
```

**Query Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| `limit` | 100 | Max memories to return |
| `offset` | 0 | Pagination offset |

**Response:**
```json
{
  "memories": [
    {
      "id": "abc123",
      "content": "nicholai prefers tabs over spaces",
      "created_at": "2025-02-17T18:00:00Z",
      "who": "claude-code",
      "importance": 0.8,
      "tags": "[\"coding\", \"preference\"]",
      "source_type": "explicit",
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

---

### Search API

#### Hybrid Search

```http
GET /memory/search?q=preferences&limit=20
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query |
| `limit` | number | Max results (default: 20) |
| `type` | string | Filter by type (fact, preference, decision, etc.) |
| `tags` | string | Filter by tags (comma-separated) |
| `who` | string | Filter by source harness |
| `pinned` | boolean | Filter pinned only |
| `importance_min` | number | Minimum importance (0-1) |
| `since` | string | Filter by date (ISO format) |
| `distinct` | string | Return distinct values for column (e.g., `who`) |

**Response:**
```json
{
  "results": [
    {
      "id": "abc123",
      "content": "nicholai prefers tabs over spaces",
      "created_at": "2025-02-17T18:00:00Z",
      "who": "claude-code",
      "importance": 0.8,
      "tags": "[\"coding\"]",
      "type": "preference",
      "pinned": 0,
      "score": -1.5
    }
  ]
}
```

#### Get Distinct Values

```http
GET /memory/search?distinct=who
```

**Response:**
```json
{
  "values": ["claude-code", "openclaw", "manual"]
}
```

---

#### Similar Memories (Vector Search)

```http
GET /memory/similar?id=abc123&k=10
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | Memory ID to find similar to |
| `k` | number | Number of similar memories (default: 10) |
| `type` | string | Filter by type |

**Response:**
```json
{
  "results": [
    {
      "id": "def456",
      "content": "prefers spaces in Python only",
      "similarity": 0.87
    }
  ]
}
```

This endpoint calls `memory.py similar` internally.

---

### Embeddings API

```http
GET /api/embeddings?vectors=true
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `vectors` | boolean | Include vector data (large!) |

Returns embeddings for visualization. When `vectors=true`, includes the actual vector arrays.

**Response:**
```json
{
  "embeddings": [
    {
      "id": "abc123",
      "text": "nicholai prefers tabs",
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

---

### Harnesses API

#### List Harnesses

```http
GET /api/harnesses
```

**Response:**
```json
{
  "harnesses": [
    {
      "name": "Claude Code",
      "path": "/home/user/.claude/CLAUDE.md",
      "exists": true
    },
    {
      "name": "OpenCode",
      "path": "/home/user/.config/opencode/AGENTS.md",
      "exists": true
    },
    {
      "name": "OpenClaw (Source)",
      "path": "/home/user/.agents/AGENTS.md",
      "exists": true
    }
  ]
}
```

#### Regenerate Harness Configs

```http
POST /api/harnesses/regenerate
```

Regenerates harness configuration files from AGENTS.md.

**Response:**
```json
{
  "success": true,
  "message": "Configs regenerated successfully"
}
```

---

## File Watcher

The daemon watches these files for changes:

- `~/.agents/agent.yaml`
- `~/.agents/AGENTS.md`
- `~/.agents/SOUL.md`
- `~/.agents/MEMORY.md`
- `~/.agents/IDENTITY.md`
- `~/.agents/USER.md`
- `~/.agents/memory/*.md`

### Auto Git Commit

When a watched file changes:

1. Wait 5 seconds (debounce)
2. Check if `~/.agents/` is a git repository
3. Run `git add -A`
4. Check for uncommitted changes
5. Commit with message: `YYYY-MM-DDTHH-MM-SS_auto_<filename>`

### Harness Sync

When `AGENTS.md` changes:

1. Wait 2 seconds (debounce)
2. Read AGENTS.md content
3. Generate header with source path and timestamp
4. Write to:
   - `~/.claude/CLAUDE.md` (if ~/.claude/ exists)
   - `~/.config/opencode/AGENTS.md` (if ~/.config/opencode/ exists)

---

## Logging

Logs are written to:
- Console (stdout)
- Daily log file: `~/.agents/.daemon/logs/daemon-YYYY-MM-DD.log`

### Log Format

```
[2025-02-17T18:00:00.000Z] [INFO] Message here
[2025-02-17T18:00:01.000Z] [WARN] Warning message
[2025-02-17T18:00:02.000Z] [ERROR] Error message
```

### Log Levels

- `INFO` - Normal operations
- `WARN` - Non-fatal issues
- `ERROR` - Errors that don't crash daemon

---

## Security

### Network Binding

The daemon binds to `localhost` only by default. It is not accessible from other machines on the network.

### No Authentication

The local API has no authentication. This is intentional for local-only access. Do not expose the daemon to the network.

### File Permissions

The daemon respects file system permissions. It can only read/write files that the running user has access to.

---

## Troubleshooting

### Daemon Won't Start

1. Check if port 3850 is in use:
   ```bash
   lsof -i :3850
   ```

2. Check for stale PID file:
   ```bash
   rm ~/.agents/.daemon/pid
   signet start
   ```

3. Check logs:
   ```bash
   signet logs
   cat ~/.agents/.daemon/logs/daemon.err.log
   ```

### Daemon Keeps Crashing

1. Check for syntax errors in config:
   ```bash
   cat ~/.agents/agent.yaml
   ```

2. Verify database integrity:
   ```bash
   sqlite3 ~/.agents/memory/memories.db "PRAGMA integrity_check;"
   ```

### Dashboard Not Loading

1. Verify daemon is running:
   ```bash
   signet status
   curl http://localhost:3850/health
   ```

2. Check if dashboard was built:
   ```bash
   ls packages/cli/dashboard/build/
   ```

### File Changes Not Syncing

1. Check if file watcher is running (look in logs)
2. Verify git repository exists:
   ```bash
   ls ~/.agents/.git
   ```

3. Check file permissions
