---
title: "Runtime extensions API"
description: "Connector, agent, skill, harness, plugin, and secret endpoints."
order: 16
section: "Reference"
---

# Runtime extensions API

Connector, agent, skill, harness, plugin, and secret endpoints.

[Back to HTTP API overview](../API.md).

## Connectors

Connectors ingest documents from external sources on a schedule or on demand.
Currently only the `filesystem` provider is operational; `github-docs` and
`gdrive` are registered but not yet functional.

GET requests to connector endpoints are open. POST, DELETE, and mutation
requests require `admin` permission (or `connectors` for operators).

### GET /api/connectors

List all registered connectors.

**Response**

```json
{
  "connectors": [
    {
      "id": "uuid",
      "status": "idle",
      "config_json": "{...}",
      "cursor_json": "{...}",
      "last_sync_at": "2026-02-21T09:00:00.000Z",
      "last_error": null
    }
  ],
  "count": 1
}
```

### POST /api/connectors

Register a new connector. Requires `admin` permission.

**Request body**

```json
{
  "provider": "filesystem",
  "displayName": "My Notes",
  "settings": {
    "rootPath": "/home/nicholai/notes",
    "glob": "**/*.md"
  }
}
```

`provider` must be `filesystem`, `github-docs`, or `gdrive`.

**Response**

```json
{ "id": "uuid" }
```

Returns `201`.

### GET /api/connectors/:id

Get a single connector's details and current state.

### POST /api/connectors/:id/sync

Trigger an incremental sync for a filesystem connector. The sync runs in the
background — poll `GET /api/connectors/:id` for status updates. Requires
`admin` permission.

**Response**

```json
{ "status": "syncing" }
```

Returns `{ "status": "syncing", "message": "Already syncing" }` if a sync is
already running.

### POST /api/connectors/:id/sync/full

Trigger a full resync, discarding the cursor. Requires `?confirm=true` query
parameter as a safety guard. Requires `admin` permission.

**Response**

```json
{ "status": "syncing" }
```

### DELETE /api/connectors/:id

Remove a connector from the registry. Requires `admin` permission.

**Query parameters**

| Parameter | Description                                              |
|-----------|----------------------------------------------------------|
| `cascade` | `true` — also soft-delete documents from this connector  |

**Response**

```json
{ "deleted": true }
```

### GET /api/connectors/:id/health

Lightweight health check for a connector, including document count.

**Response**

```json
{
  "id": "uuid",
  "status": "idle",
  "lastSyncAt": "2026-02-21T09:00:00.000Z",
  "lastError": null,
  "documentCount": 142
}
```


## Agents

Multi-agent endpoints for managing the agent roster. All agents share one
SQLite database; memories are scoped by `agent_id` and `visibility`. The
read policy controls which other agents' global memories each agent can see.

### GET /api/agents

List all registered agents. Requires no permission (local mode) or `recall`.

**Response**

```json
{
  "agents": [
    {
      "id": "default",
      "name": "default",
      "read_policy": "shared",
      "policy_group": null,
      "created_at": "2026-03-24T00:00:00.000Z",
      "updated_at": "2026-03-24T00:00:00.000Z"
    },
    {
      "id": "alice",
      "name": "alice",
      "read_policy": "isolated",
      "policy_group": null,
      "created_at": "2026-03-24T12:00:00.000Z",
      "updated_at": "2026-03-24T12:00:00.000Z"
    }
  ]
}
```

`read_policy` is one of:
- `isolated` — agent sees only its own memories
- `shared` — agent sees all `visibility=global` memories from any agent
- `group` — agent sees `visibility=global` memories from agents in the same `policy_group`

### GET /api/agents/:name

Get a single agent by name. Returns `404` if not found.

**Response** — same shape as a single entry in `GET /api/agents`.

### POST /api/agents

Register a new agent. Requires `remember` permission.

**Request body**

```json
{
  "name": "alice",
  "read_policy": "isolated",
  "policy_group": null
}
```

Only `name` is required. `read_policy` defaults to `"isolated"`.

**Response** — the created agent record.

### DELETE /api/agents/:name

Remove an agent from the roster. Memories owned by the agent are marked
`visibility='archived'` (not deleted). Requires `admin` permission.

**Query parameters**

| Parameter | Description |
|-----------|-------------|
| `purge`   | Set to `true` to permanently delete all memories where `agent_id = name`. |

**Response**

```json
{ "success": true, "purged": false }
```


## Skills

### GET /api/skills

List all installed skills from `$SIGNET_WORKSPACE/skills/`. Each skill must have a
`SKILL.md` with YAML frontmatter.

**Response**

```json
{
  "skills": [
    {
      "name": "browser-use",
      "description": "Browser automation skill",
      "version": "1.0.0",
      "author": "browser-use",
      "license": "MIT",
      "user_invocable": true,
      "arg_hint": "<url>",
      "path": "/home/user/.agents/skills/browser-use"
    }
  ],
  "count": 3
}
```

### GET /api/skills/search

Search the skills.sh registry for installable skills.

**Query parameters**

| Parameter | Description                     |
|-----------|---------------------------------|
| `q`       | Search query string (required)  |

**Response**

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

### GET /api/skills/:name

Get a single skill's metadata and full `SKILL.md` content.

**Response**

```json
{
  "name": "browser-use",
  "description": "...",
  "version": "1.0.0",
  "path": "/home/user/.agents/skills/browser-use",
  "content": "---\ndescription: ...\n---\n\n# Browser Use\n..."
}
```

Returns `400` for invalid names (path traversal). Returns `404` if not
installed.

### POST /api/skills/install

Install a skill via the configured package manager (bun, npm, or pnpm).
Runs `skills add <pkg> --global --yes`. Times out after 60 seconds.

**Request body**

```json
{
  "name": "browser-use",
  "source": "browser-use/browser-use@browser-use"
}
```

`name` is required. `source` overrides the install package name if provided.

**Response**

```json
{ "success": true, "name": "browser-use", "output": "..." }
```

Returns `500` with `{ "success": false, "error": "..." }` on failure.

### DELETE /api/skills/:name

Uninstall a skill by removing its directory from `$SIGNET_WORKSPACE/skills/`.

**Response**

```json
{ "success": true, "name": "browser-use", "message": "Removed browser-use" }
```

### GET /api/skills/analytics

Return usage analytics for skill invocations recorded by the daemon.

**Query parameters**

| Parameter  | Description |
|------------|-------------|
| `agent_id` | Optional agent scope override. Defaults to the request-scoped agent or `default`. |
| `since`    | Optional ISO 8601 UTC timestamp filter, e.g. `2026-03-01T00:00:00Z`. |
| `limit`    | Optional max number of top skills to return. Default `10`, range `1-100`. |

**Response**

```json
{
  "totalCalls": 12,
  "successRate": 0.917,
  "topSkills": [
    {
      "skillName": "web-search",
      "count": 5,
      "successCount": 5,
      "avgLatencyMs": 184
    }
  ],
  "latency": {
    "p50": 160,
    "p95": 310
  }
}
```

Returns `400` if `since` is not an ISO 8601 UTC timestamp.


## Harnesses

### GET /api/harnesses

List known harness config file locations and whether each exists on disk.

**Response**

```json
{
  "harnesses": [
    { "name": "Claude Code", "path": "/home/user/.claude/CLAUDE.md", "exists": true },
    { "name": "OpenCode", "path": "/home/user/.config/opencode/AGENTS.md", "exists": false },
    { "name": "OpenClaw (Source)", "path": "/home/user/.agents/AGENTS.md", "exists": true }
  ]
}
```

### POST /api/harnesses/regenerate

Run the `generate-harness-configs.py` script from the scripts directory to
rebuild all harness config files from source. The script must exist at
`$SIGNET_WORKSPACE/scripts/generate-harness-configs.py`.

**Response**

```json
{ "success": true, "message": "Configs regenerated successfully", "output": "..." }
```

Returns `404` if the script is not found.


## Plugins

Plugin diagnostics expose the daemon-owned Plugin SDK V1 registry. The
first bundled core plugin is `signet.secrets`, which owns the existing
Secrets API, CLI, MCP, dashboard, SDK, connector, and prompt-contribution
surfaces. Diagnostics never include raw secret values.

### GET /api/plugins

List registered plugins and their lifecycle state, grants, pending
capabilities, and active surface metadata. Active surface metadata is
filtered by granted capabilities. Planned surfaces remain visible through
plugin diagnostics.

**Response**

```json
{
  "plugins": [
    {
      "id": "signet.secrets",
      "name": "Signet Secrets",
      "state": "active",
      "enabled": true,
      "declaredCapabilities": ["secrets:list", "secrets:exec"],
      "grantedCapabilities": ["secrets:list", "secrets:exec"],
      "pendingCapabilities": [],
      "surfaces": {
        "daemonRoutes": [],
        "cliCommands": [],
        "mcpTools": [],
        "dashboardPanels": [],
        "sdkClients": [],
        "connectorCapabilities": [],
        "promptContributions": []
      }
    }
  ]
}
```

### GET /api/plugins/:id

Return one plugin registry record. Returns `404` if the plugin is not
registered.

### GET /api/plugins/:id/diagnostics

Return the registry record, manifest metadata, active surfaces, planned
surfaces, prompt contributions, prompt inclusion/exclusion diagnostics, and
validation errors for a plugin.

### GET /api/plugins/prompt-contributions

List active prompt contributions from enabled plugins with the required
prompt capability grant.

**Response**

```json
{
  "contributions": [
    {
      "id": "signet.secrets.credential-guidance",
      "pluginId": "signet.secrets",
      "target": "user-prompt-submit",
      "mode": "context",
      "priority": 420,
      "maxTokens": 80,
      "content": "When the user provides credentials..."
    }
  ],
  "activeCount": 1
}
```

### GET /api/plugins/audit

List durable plugin audit events from
`$SIGNET_WORKSPACE/.daemon/plugins/audit-v1.ndjson`. Events are newest
first, capped to 500 rows, and sensitive fields are redacted before they
are written and again when read.

**Query parameters**

- `pluginId` - optional plugin id filter, for example `signet.secrets`
- `event` - optional exact event name filter
- `since` / `until` - optional ISO timestamp bounds
- `limit` - optional row limit, default `100`, max `500`

**Response**

```json
{
  "events": [
    {
      "id": "m36n9q5a-x4w2k8p1",
      "timestamp": "2026-04-16T12:00:00.000Z",
      "event": "plugin.enabled",
      "pluginId": "signet.secrets",
      "result": "ok",
      "source": "plugin-host",
      "data": {
        "state": "active",
        "enabled": true
      }
    }
  ],
  "count": 1
}
```

### PATCH /api/plugins/:id

Enable or disable a registered plugin.

**Request body**

```json
{ "enabled": false }
```

Disabling `signet.secrets` removes its active prompt and advertised
surface metadata. It does not delete stored secrets.

Plugin lifecycle changes emit structured daemon diagnostics including
`plugin.discovered`, `plugin.enabled`, `plugin.disabled`,
`plugin.blocked`, `plugin.degraded`, `plugin.health_failed`,
`plugin.capability_denied`, `prompt.contribution_added`, and
`prompt.contribution_removed`. The same events are appended to the durable
plugin audit log for diagnostics and support.


## Secrets

Secrets are owned by the bundled `signet.secrets` core plugin. Local
secrets are stored encrypted on disk at `$SIGNET_WORKSPACE/.secrets/`.
Values are never returned in ordinary API responses, only names are
exposed. Bare names such as `OPENAI_API_KEY` are compatibility aliases
for local provider references such as `local://OPENAI_API_KEY`.
Secrets routes require the matching granted `signet.secrets` capability. If
the plugin is disabled, blocked, or missing a route capability, the route
returns a structured plugin-capability error without deleting stored data.
Secret operations emit structured daemon diagnostics for listing,
storage, deletion, command injection, and command completion. These
diagnostics never include raw secret values.

### POST /api/secrets/:name

Store or overwrite a secret value.

**Request body**

```json
{ "value": "sk-abc123..." }
```

`value` must be a non-empty string.

**Response**

```json
{ "success": true, "name": "OPENAI_API_KEY" }
```

### GET /api/secrets

List stored secret names. Values are never included.

**Response**

```json
{ "secrets": ["OPENAI_API_KEY", "GITHUB_TOKEN"] }
```

### DELETE /api/secrets/:name

Delete a stored secret.

**Response**

```json
{ "success": true, "name": "OPENAI_API_KEY" }
```

Returns `404` if the secret does not exist.

### POST /api/secrets/exec

Queue a shell command with multiple secrets injected into the subprocess
environment. Callers pass a map of env var names to secret references —
never actual values. References can be Signet secret names or direct
Bitwarden refs (`bw://name/NAME`, `bw://item/ITEM_ID/password`) and 1Password refs (`op://vault/item/field`). The daemon resolves and injects
all values before spawning.

**Request body**

```json
{
  "command": "curl -H 'Authorization: Bearer $OPENAI_API_KEY' https://api.openai.com/v1/models",
  "secrets": {
    "OPENAI_API_KEY": "OPENAI_API_KEY",
    "GITHUB_TOKEN": "GITHUB_TOKEN"
  }
}
```

Both `command` and `secrets` are required. The `secrets` map must contain at
least one entry. `timeoutMs` is optional and defaults to 5 minutes; values are
clamped between 1 second and 30 minutes. Secret exec is always queued and the
route always returns immediately with HTTP `202`; callers poll the job endpoint
for the redacted result.

Timed-out commands are terminated by the daemon and finish with code `124` and
`timedOut: true` in the polled job result.
The secret exec queue is bounded; saturated queues return `429`. Output is
redacted before truncation, and timeout cleanup targets the subprocess process
group where the platform supports it.

**Queued response (`202`)**

```json
{ "id": "uuid", "status": "queued", "createdAt": "...", "timeoutMs": 300000 }
```

### GET /api/secrets/exec/:jobId

Return the in-memory status for a queued secret exec job. Completed jobs
include a redacted `result` object with stdout, stderr, exit code, timeout,
and truncation metadata.

### POST /api/secrets/:name/exec

Legacy single-secret variant. Execute a shell command with a single secret
injected into the subprocess environment. Prefer `/api/secrets/exec` for
new integrations.

**Request body**

```json
{
  "command": "curl -H 'Authorization: Bearer $OPENAI_API_KEY' https://api.openai.com/v1/models",
  "secrets": {
    "OPENAI_API_KEY": "OPENAI_API_KEY"
  }
}
```

`command` is required. `secrets` is optional — if omitted, the named secret
from the URL path is injected under its own name. Like `/api/secrets/exec`,
this legacy endpoint is queued and returns immediately with HTTP `202`.
Callers poll `GET /api/secrets/exec/:jobId` for the redacted result.

**Queued response (`202`)**

```json
{ "id": "uuid", "status": "queued", "createdAt": "...", "timeoutMs": 300000 }
```

### GET /api/secrets/bitwarden/status

Return Bitwarden provider status. Bitwarden is opt-in; when it is not connected, existing local Signet secrets remain the active store.

### POST /api/secrets/bitwarden/connect

Validate and store a Bitwarden CLI session token from `bw unlock --raw`. Body: `{ "session": "...", "activate": true, "folderId": "optional-folder-id" }`. If `activate` is true, future Signet secret writes use Bitwarden as the backing store while internal provider metadata remains local. CLI users should pipe the token with `bw unlock --raw | signet secret bitwarden connect --session-stdin` rather than passing it as an argument.

### DELETE /api/secrets/bitwarden/connect

Disconnect Bitwarden, remove the stored session/folder metadata, and switch the active provider back to `local`. Existing local Signet secrets are not deleted.

### POST /api/secrets/bitwarden/provider

Switch active provider with `{ "provider": "local" }` or `{ "provider": "bitwarden" }`. Switching to Bitwarden requires a connected session.

### GET /api/secrets/bitwarden/folders

List Bitwarden folders visible to the connected CLI session.

### POST /api/secrets/bitwarden/migrate

Copy existing local Signet secrets into Bitwarden. Defaults to dry-run: `{ "dryRun": true }`. Pass `{ "dryRun": false, "overwrite": true }` to write. Pass `deleteLocal: true` only when local copies should be removed after successful per-secret migration.

### GET /api/secrets/1password/status

Return 1Password integration status, including whether a service account
token is configured and (when available) accessible vaults.

### POST /api/secrets/1password/connect

Validate and store a 1Password service account token.

**Request body**

```json
{ "token": "ops_..." }
```

### DELETE /api/secrets/1password/connect

Disconnect 1Password integration by removing the stored service account
token secret.

### GET /api/secrets/1password/vaults

List accessible vaults for the connected service account.

### POST /api/secrets/1password/import

Import password-like fields from 1Password vault items into Signet
secrets.

**Request body**

```json
{
  "vaults": ["Engineering"],
  "prefix": "OP",
  "overwrite": false
}
```
