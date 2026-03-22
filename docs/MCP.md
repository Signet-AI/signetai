---
title: "MCP Server"
description: "Model Context Protocol integration for native tool access."
order: 17
section: "Reference"
---

MCP Server
==========

The Signet [[daemon]] exposes an MCP (Model Context Protocol) server that gives
AI [[harnesses]] native tool access to [[memory]] operations. Instead of relying
on shell commands or skill invocations, harnesses call Signet tools directly
through MCP's standardized interface.


Overview
--------

MCP complements Signet's existing hook-based integration:

- **[[hooks|Hooks]]** handle lifecycle events (session start/end, prompt submission,
  compaction). They run automatically.
- **MCP tools** provide on-demand operations (search, store, modify, forget).
  The agent invokes them when needed.

Both systems can be active simultaneously — they serve different purposes and
don't conflict.


When to Use MCP vs Hooks
------------------------

| Scenario | Use |
|----------|-----|
| Session start/end lifecycle | Hooks |
| Automatic memory extraction after each prompt | Hooks |
| Agent wants to search memories mid-conversation | MCP (`memory_search`) |
| Agent wants to store a specific fact | MCP (`memory_store`) |
| Agent needs to run a command with secrets | MCP (`secret_exec`) |
| Compaction boundary handling | Hooks |
| Agent-initiated memory edits or deletions | MCP (`memory_modify`, `memory_forget`) |

**Rule of thumb:** hooks are for automatic, lifecycle-driven events. MCP is
for agent-initiated, on-demand operations.


Tool Reference
--------------

All tools are defined in `packages/daemon/src/mcp/tools.ts`. Tool handlers
call the daemon's HTTP API internally — they don't duplicate business logic.

### memory_search

Hybrid vector + keyword search over stored memories. Returns results ranked
by combined BM25 + vector similarity score with optional graph boost and
reranking.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | yes | Search query text |
| `limit` | number | no | Max results to return (default 10) |
| `type` | string | no | Filter by memory type (e.g. `"preference"`, `"fact"`) |
| `min_score` | number | no | Minimum relevance score threshold |

**Returns:** Array of memory objects with content, type, importance, tags,
and relevance score.

**Example:**

```json
{
  "query": "user prefers dark mode",
  "limit": 5,
  "type": "preference"
}
```

**Daemon endpoint:** `POST /api/memory/recall`

### memory_store

Save a new memory to the database. Tags are prepended in `[tag1,tag2]: `
format before being sent to the daemon.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `content` | string | yes | Memory content to save |
| `type` | string | no | Memory type (`fact`, `preference`, `decision`, etc.) |
| `importance` | number | no | Importance score 0–1 |
| `tags` | string | no | Comma-separated tags for categorization |

**Returns:** The created memory object with its assigned ID.

**Example:**

```json
{
  "content": "User prefers Bun over npm for package management",
  "importance": 0.8,
  "tags": "preference,tooling"
}
```

**Daemon endpoint:** `POST /api/memory/remember`

### memory_get

Retrieve a single memory by its ID.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | yes | Memory ID to retrieve |

**Returns:** Full memory object including content, type, importance, tags,
created/updated timestamps, and version history.

**Example:**

```json
{
  "id": "a1b2c3d4-..."
}
```

**Daemon endpoint:** `GET /api/memory/:id`

### memory_list

List memories with optional pagination and type filtering.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `limit` | number | no | Max results (default 100) |
| `offset` | number | no | Pagination offset |
| `type` | string | no | Filter by memory type |

**Returns:** Array of memory objects.

**Example:**

```json
{
  "limit": 20,
  "offset": 0,
  "type": "decision"
}
```

**Daemon endpoint:** `GET /api/memories`

### memory_modify

Edit an existing memory. Requires a reason for the edit (used for version
history tracking).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | yes | Memory ID to modify |
| `reason` | string | yes | Why this edit is being made |
| `content` | string | no | New content |
| `type` | string | no | New type |
| `importance` | number | no | New importance |
| `tags` | string | no | New tags (comma-separated) |

**Returns:** Updated memory object.

**Example:**

```json
{
  "id": "a1b2c3d4-...",
  "content": "User prefers Bun for all JS projects",
  "reason": "Updated to reflect broader preference"
}
```

**Daemon endpoint:** `PATCH /api/memory/:id`

### memory_forget

Soft-delete a memory. The memory is not physically removed — it's marked
as forgotten with a reason for auditability.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | yes | Memory ID to forget |
| `reason` | string | yes | Why this memory should be forgotten |

**Returns:** Confirmation of deletion.

**Example:**

```json
{
  "id": "a1b2c3d4-...",
  "reason": "User corrected this preference"
}
```

**Daemon endpoint:** `DELETE /api/memory/:id`

### memory_feedback

Rate how relevant injected memories were to the current conversation.
Scores update `session_memories.relevance_score` immediately, feeding the
predictor scorer's training pipeline and the aspect feedback loop.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `session_key` | string | yes | Current session key |
| `ratings` | object | yes | Map of memory ID to relevance score (−1 to 1) |

Score interpretation: `1` = directly helpful, `0` = unused/neutral,
`−1` = harmful or misleading.

**Returns:** Object with `ok: true` and `recorded` count.

**Example:**

```json
{
  "session_key": "abc123",
  "ratings": {
    "a1b2c3d4-e5f6-...": 0.9,
    "b2c3d4e5-f6a7-...": 0.0,
    "c3d4e5f6-a7b8-...": -0.5
  }
}
```

**Daemon endpoint:** `POST /api/memory/feedback`

**Note:** Prefer this tool over embedding feedback as raw JSON text. Both
are supported for backward compatibility, but the MCP tool is recorded
immediately on the current turn.

### agent_peers

List currently active peer sessions for cross-agent coordination.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | no | Current agent id (default `default`) |
| `session_key` | string | no | Current session key (used to exclude self session) |
| `include_self` | boolean | no | Include this agent's sessions (default `false`) |
| `project` | string | no | Optional project filter |
| `limit` | number | no | Max sessions to return |

**Returns:** Object with `sessions` array and `count`.

**Daemon endpoint:** `GET /api/cross-agent/presence`

### agent_message_send

Send a message to another agent/session or broadcast to all active peers.
Supports local daemon delivery and optional ACP relay.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `content` | string | yes | Message body |
| `from_agent_id` | string | no | Sender agent id |
| `from_session_key` | string | no | Sender session key |
| `to_agent_id` | string | no | Target agent id |
| `to_session_key` | string | no | Target session key |
| `broadcast` | boolean | no | Broadcast to all sessions |
| `type` | enum | no | `assist_request`, `decision_update`, `info`, `question` |
| `via` | enum | no | `local` (default) or `acp` |
| `acp_base_url` | string | no | ACP server URL (required if `via=acp`) |
| `acp_target_agent_name` | string | no | ACP target agent name (required if `via=acp`) |
| `acp_timeout_ms` | number | no | ACP relay timeout in milliseconds (used when `via=acp`) |

**Returns:** Stored message object including delivery status.

**Daemon endpoint:** `POST /api/cross-agent/messages`

### agent_message_inbox

Read recent inbound cross-agent messages for an agent/session.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `agent_id` | string | no | Recipient agent id (default `default`) |
| `session_key` | string | no | Recipient session key |
| `since` | string | no | ISO timestamp lower bound |
| `limit` | number | no | Max messages to return |
| `include_sent` | boolean | no | Include messages sent by this agent |
| `include_broadcast` | boolean | no | Include broadcast messages |

**Returns:** Object with `items` array and `count`.

**Daemon endpoint:** `GET /api/cross-agent/messages`


### session_bypass

Toggle per-session hook bypass. When enabled, all hook endpoints for the
target session return empty no-op responses with `bypassed: true`. MCP tools
(memory_search, memory_store, etc.) continue to work normally — only automatic
hooks are silenced.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `session_key` | string | yes | Session key to toggle bypass for |
| `enabled` | boolean | yes | `true` to enable bypass, `false` to disable |

**Returns:** Object with `key` and `bypassed` fields confirming the new state.

**Example:**

```json
{
  "session_key": "session-uuid",
  "enabled": true
}
```

**Daemon endpoint:** `POST /api/sessions/:key/bypass`

### secret_list

List available secret names. Returns names only — raw secret values are
never exposed to agents.

**Parameters:** None.

**Returns:** Object with a `secrets` array of string names.

**Example:**

```json
{}
```

**Daemon endpoint:** `GET /api/secrets`

### secret_exec

Run a shell command with secrets injected as environment variables. Output
is automatically redacted — secret values never appear in results.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `command` | string | yes | Shell command to execute |
| `secrets` | object | yes | Map of env var name to secret reference (Signet name or `op://...`) |

**Returns:** Object with `stdout`, `stderr`, and `code` (exit code).
Secret values in output are replaced with `[REDACTED]`.

**Example:**

```json
{
  "command": "curl -H \"Authorization: Bearer $OPENAI_API_KEY\" https://api.openai.com/v1/models",
  "secrets": {
    "OPENAI_API_KEY": "OPENAI_API_KEY"
  }
}
```

**Daemon endpoint:** `POST /api/secrets/exec` (30s timeout)


Discovery Protocol
------------------

AI harnesses discover Signet's MCP server in one of two ways:

### Automatic (via `signet install`)

The connector for each harness registers the MCP server in the harness's
configuration file during installation. No manual steps needed.

### Manual discovery

1. The daemon must be running (`signet daemon start`)
2. The MCP server is available at:
   - **Streamable HTTP:** `http://localhost:3850/mcp`
   - **stdio:** spawn the `signet-mcp` binary as a subprocess
3. The daemon port can be overridden via `SIGNET_PORT` (default: 3850)
4. The daemon host can be overridden via `SIGNET_HOST` (default: localhost)

Clients can verify the server is reachable with the MCP `initialize`
handshake:

```bash
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test","version":"1.0"},"capabilities":{}},"id":1}' | signet-mcp
```


Transports
----------

The MCP server supports two transports:

### Streamable HTTP

Embedded in the daemon's Hono server at `/mcp`. Uses the web-standard
Streamable HTTP transport (MCP spec 2025-03-26). Runs stateless — each
request gets a fresh server instance.

```
POST http://localhost:3850/mcp     # Send MCP messages
GET  http://localhost:3850/mcp     # SSE stream (server notifications)
DELETE http://localhost:3850/mcp   # Session termination (no-op, stateless)
```

### stdio

The `signet-mcp` binary runs as a subprocess, reading JSON-RPC from stdin
and writing to stdout. The daemon must be running — tool handlers call the
daemon's HTTP API internally.

```bash
signet-mcp
```

Environment variables:

```
SIGNET_DAEMON_URL   # Override daemon URL (default: http://localhost:3850)
SIGNET_HOST         # Override daemon host (default: localhost)
SIGNET_PORT         # Override daemon port (default: 3850)
```


Configuration per Harness
-------------------------

### Claude Code

The Claude Code connector registers the MCP server in
`~/.claude/settings.json` during `signet install`:

```json
{
  "mcpServers": {
    "signet": {
      "type": "stdio",
      "command": "signet-mcp",
      "args": []
    }
  }
}
```

### OpenCode

The OpenCode connector registers the MCP server in
`~/.config/opencode/opencode.json` during `signet install`:

```json
{
  "mcp": {
    "signet": {
      "type": "local",
      "command": ["signet-mcp"],
      "enabled": true
    }
  }
}
```

This coexists with the plugin (`plugins/signet.mjs`) — the plugin handles
lifecycle hooks, MCP handles on-demand tool calls.

### OpenClaw

OpenClaw uses the `@signetai/adapter-openclaw` runtime plugin, which already
provides the same tool surface. MCP registration will be added when OpenClaw
supports native `mcpServers` configuration.


Manual Setup
------------

If you don't use `signet install`, you can configure MCP manually:

1. Ensure the daemon is running: `signet daemon start`
2. Add the MCP server to your harness config (see examples above)
3. Verify connectivity: `echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test","version":"1.0"},"capabilities":{}},"id":1}' | signet-mcp`


Authentication
--------------

MCP connections inherit the daemon's auth model:

- **local** (default): No authentication required.
- **team**: Streamable HTTP requests require a Bearer token. The stdio
  bridge runs locally and connects to the daemon with the same auth context.
- **hybrid**: Localhost requests (including MCP) are trusted; remote
  requests require a token.


Internals
---------

The MCP tool handlers use a shared `daemonFetch` helper that sends HTTP
requests to the daemon API with these headers:

- `x-signet-runtime-path: plugin` — identifies this as a plugin-path request
- `x-signet-actor: mcp-server` — identifies the calling actor
- `x-signet-actor-type: harness` — actor type classification

The default request timeout is 10 seconds, except for `secret_exec` which
uses 30 seconds to allow for longer-running commands.

Errors are returned as MCP error results with `isError: true` and a
human-readable message.


Roadmap
-------

Phase 2 tool candidates (not yet implemented):

- `secret_get` — retrieve a secret value
- `skill_list` — list installed skills
- `diagnostics` — health score summary
- `config_read` — read agent config
- `document_ingest` — ingest a document
