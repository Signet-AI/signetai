---
title: "MCP Server"
description: "Model Context Protocol integration for native tool access."
order: 17
section: "Reference"
---

MCP Server
==========

The Signet daemon exposes an MCP (Model Context Protocol) server that gives
AI harnesses native tool access to memory operations. Instead of relying on
shell commands or skill invocations, harnesses call Signet tools directly
through MCP's standardized interface.


Overview
--------

MCP complements Signet's existing hook-based integration:

- **Hooks** handle lifecycle events (session start/end, prompt submission,
  compaction). They run automatically.
- **MCP tools** provide on-demand operations (search, store, modify, forget).
  The agent invokes them when needed.

Both systems can be active simultaneously — they serve different purposes and
don't conflict.


Available Tools
---------------

| Tool | Description | Parameters |
|------|-------------|------------|
| `memory_search` | Hybrid vector + keyword search | `query` (required), `limit`, `type`, `min_score` |
| `memory_store` | Save a new memory | `content` (required), `type`, `importance`, `tags` |
| `memory_get` | Retrieve a memory by ID | `id` (required) |
| `memory_list` | List memories with filters | `limit`, `offset`, `type` |
| `memory_modify` | Edit an existing memory | `id` (required), `reason` (required), `content`, `type`, `importance`, `tags` |
| `memory_forget` | Soft-delete a memory | `id` (required), `reason` (required) |

### Example: memory_search

```json
{
  "query": "user prefers dark mode",
  "limit": 5,
  "type": "preference"
}
```

Returns matching memories ranked by hybrid score (BM25 + vector similarity
with optional graph boost and reranking).

### Example: memory_store

```json
{
  "content": "User prefers Bun over npm for package management",
  "importance": 0.8,
  "tags": "preference,tooling"
}
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

1. Ensure the daemon is running: `signet start`
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


MCP Server Registry
--------------------

Signet can install, manage, and proxy third-party MCP servers. Installed
servers are stored in the `mcp_servers` SQLite table and appear in the
dashboard under **Skills → MCP Servers**.

### Installing a server

Via the dashboard **Discover** tab — Signet scans your existing harness
configs (Claude Code, Cursor, Codex, OpenCode, VS Code, Windsurf) and lets
you import them with one click.

Via API:

```bash
curl -X POST http://localhost:3850/api/mcp-servers/import \
  -H 'Content-Type: application/json' \
  -d '{"name":"context7","rawConfig":{"url":"https://mcp.context7.com/mcp"}}'
```

### Proxy through /mcp

Installed (and enabled) servers are automatically proxied through the
existing `/mcp` endpoint. Their tools appear prefixed as
`mcp__{serverName}__{toolName}` alongside Signet's native tools:

```
mcp__context7__resolve-library-id
mcp__linear__create_issue
memory_search          ← Signet native
memory_store           ← Signet native
```

The proxy runtime (mcporter) pools connections at daemon startup and
refreshes whenever a server is installed, removed, or toggled.

### Standalone CLI generation

For harnesses that don't speak MCP, each server can be compiled to a
self-contained binary:

```bash
# Via dashboard: click "Generate CLI" on any server card
# Via API:
curl -X POST http://localhost:3850/api/mcp-servers/context7/generate-cli
# → binary written to ~/.agents/mcp-bins/context7
```

The binary embeds the server config and calls the upstream server directly —
no daemon connection needed.

### API reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/mcp-servers` | GET | List all registered servers |
| `/api/mcp-servers` | POST | Register a server manually |
| `/api/mcp-servers/discover` | GET | Cross-harness discovery |
| `/api/mcp-servers/import` | POST | Import a discovered server |
| `/api/mcp-servers/:id/tools` | GET | List tools (lazy) |
| `/api/mcp-servers/:id` | PATCH | Toggle `enabled` |
| `/api/mcp-servers/:id` | DELETE | Remove server |
| `/api/mcp-servers/:id/generate-cli` | POST | Compile to standalone binary |


Roadmap
-------

Phase 2 tool candidates (not yet implemented):

- `secret_get` — retrieve a secret value
- `skill_list` — list installed skills
- `diagnostics` — health score summary
- `config_read` — read agent config
- `document_ingest` — ingest a document
