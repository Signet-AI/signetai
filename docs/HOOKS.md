---
title: "Hooks"
description: "Session lifecycle hooks for harness integration."
order: 8
section: "Core Concepts"
---

# Hooks System

Signet's hook system lets [[harnesses]] integrate with session lifecycle events — injecting [[memory]] at session start, capturing summaries at compaction, and triggering MEMORY.md synthesis.

---

## Overview

Hooks are HTTP endpoints exposed by the Signet [[daemon]]. Harnesses call them at specific lifecycle points:

| Hook | When | Purpose |
|------|------|---------|
| `session-start` | New session begins | Inject memories and identity into context |
| `user-prompt-submit` | Before each user turn | Prefer structured recall, then temporal fallback, then transcript fallback when needed |
| `session-end` | Session finishes | Persist transcript lineage and queue session summary |
| `pre-compaction` | Before context compaction | Get summary guidelines |
| `compaction-complete` | After compaction | Save a first-class compaction artifact into the temporal DAG |
| `synthesis` | Scheduled or manual | Get prompt to regenerate MEMORY.md |
| `synthesis/complete` | After synthesis | Save the merge-safe temporal head |

---

## Per-Session Bypass

Bypass silences all Signet hooks for a single session without stopping the
daemon. This is useful when you want to work without automatic memory
extraction but still have access to MCP tools like `memory_search` and
`memory_store`.

### Activation paths

1. **Environment variable** — Set `SIGNET_BYPASS=1` before starting a session.
   The CLI hook process exits immediately with code 0; the daemon is never
   contacted.

2. **Daemon API / MCP tool / Dashboard** — The session is tracked normally,
   but the bypass flag is flipped. All hook endpoints return empty no-op
   responses with `bypassed: true` in the response body.

### Behavior when bypassed

When bypass is active for a session, all seven hook endpoints return empty
no-op responses with `bypassed: true`:

- `session-start` — no memories or identity injected
- `user-prompt-submit` — no per-prompt context loaded
- `session-end` — no memory extraction (but the session claim is still
  released so future sessions are not blocked)
- `pre-compaction` — no summary guidelines
- `compaction-complete` — summary is discarded
- `remember` — memory is not saved
- `recall` — no search results returned

The `synthesis` and `synthesis/complete` hooks are **not** affected by bypass.
They are scheduler-driven and have no session context.

The `SIGNET_BYPASS=1` environment variable causes the CLI hook process to
exit immediately — the daemon is never contacted, so no session is created
and no network request is made.

---

## Session Start Hook

**`POST /api/hooks/session-start`**

Called when a new agent session begins. Returns memories and context formatted for injection into the system prompt.

### Request

```json
{
  "harness": "openclaw",
  "agentId": "optional-agent-id",
  "context": "optional context string",
  "sessionKey": "optional-session-identifier"
}
```

`harness` is required. Everything else is optional.

### Response

```json
{
  "identity": {
    "name": "Mr. Claude",
    "description": "Personal AI assistant"
  },
  "memories": [
    {
      "id": 42,
      "content": "nicholai prefers bun over npm",
      "type": "preference",
      "importance": 0.8,
      "created_at": "2025-02-15T10:00:00Z"
    }
  ],
  "recentContext": "<!-- MEMORY.md contents -->",
  "inject": "You are Mr. Claude...\n\n## Relevant Memories\n- ..."
}
```

The `inject` field is ready-to-use text for prepending to the system prompt. It includes identity, memories, and recent context formatted as markdown.

### Configuration

In `agent.yaml` (see [[configuration]]):

```yaml
hooks:
  sessionStart:
    recallLimit: 10          # How many memories to include
    includeIdentity: true    # Prepend "You are <name>..."
    includeRecentContext: true # Include MEMORY.md content
    recencyBias: 0.7         # 0=importance-only, 1=recency-only
```

Memory scoring uses: `score = importance × (1 - recencyBias) + recency × recencyBias`

where recency is `1 / (1 + age_in_days)`.

---

## Pre-Compaction Hook

**`POST /api/hooks/pre-compaction`**

Called before the harness compresses/summarizes the conversation context. Returns a prompt and guidelines for generating a durable session summary.

### Request

```json
{
  "harness": "openclaw",
  "sessionContext": "optional current session summary",
  "messageCount": 150,
  "sessionKey": "optional-session-id"
}
```

### Response

```json
{
  "summaryPrompt": "Pre-compaction memory flush. Store durable memories now.\n\nSummarize...",
  "guidelines": "Summarize this session focusing on:\n- Key decisions made\n..."
}
```

The harness should use `summaryPrompt` as the instruction to the model for generating a session summary.

### Configuration

```yaml
hooks:
  preCompaction:
    includeRecentMemories: true  # Include recent memories in prompt
    memoryLimit: 5               # How many recent memories
    summaryGuidelines: |         # Custom summary instructions
      Focus on:
      - Decisions made
      - Code patterns discovered
      - User preferences
```

---

## Compaction Complete Hook

**`POST /api/hooks/compaction-complete`**

Called after compaction with the generated summary. Saves the summary as a
`session_summary` memory row and as a first-class temporal DAG artifact used
by `MEMORY.md`.

Temporal lineage remains agent-scoped. Same `sessionKey` values from
different agents do not share transcript or summary storage.

### Request

```json
{
  "harness": "openclaw",
  "summary": "Session summary text...",
  "sessionKey": "optional-session-id",
  "project": "/workspace/repo"
}
```

If compaction arrives before transcript persistence, `project` is the required
fallback lineage key. When both exist, transcript lineage wins and the request
project is only used as a fallback.

### Response

```json
{
  "success": true,
  "memoryId": 123
}
```

---

## MEMORY.md Synthesis

Synthesis regenerates the `MEMORY.md` file by asking an AI model to write a
coherent summary of scored memory and temporal state.

The daemon synthesis worker is the primary runtime path. Harness-scheduled
calls are still supported, but they now write through the same DB-backed,
lease-protected head record. A busy head lease is a deferred write, not a
terminal failure.

### Step 1: Request synthesis

**`POST /api/hooks/synthesis`**

```json
{
  "trigger": "scheduled"
}
```

Response:

```json
{
  "harness": "openclaw",
  "model": "sonnet",
  "prompt": "You are regenerating MEMORY.md...\n\n## Memories to Synthesize\n...",
  "memories": [...]
}
```

### Step 2: Run the model

The harness runs the prompt through the specified model.

### Step 3: Save the result

**`POST /api/hooks/synthesis/complete`**

```json
{
  "content": "# Memory\n\n## Active Projects\n..."
}
```

The daemon:
1. Backs up the existing MEMORY.md to `memory/MEMORY.backup-<timestamp>.md`
2. Writes the new content with a generation timestamp header
3. Returns `{ "success": true }`

### Configuration

```yaml
memory:
  synthesis:
    harness: openclaw   # which harness runs synthesis
    model: sonnet       # model identifier
    schedule: daily     # daily | weekly | on-demand
    max_tokens: 4000
```

### Get synthesis config

**`GET /api/hooks/synthesis/config`**

Returns the current synthesis configuration. Harnesses can poll this to know when to trigger synthesis.

---

## OpenClaw Integration

The `@signetai/adapter-openclaw` package provides a ready-made plugin:

```javascript
import createPlugin from '@signetai/adapter-openclaw';

const signet = createPlugin({
  enabled: true,
  daemonUrl: 'http://localhost:3850'
});

// In your OpenClaw configuration:
export default {
  plugins: [signet],
};
```

The plugin automatically calls the appropriate hook endpoints at the right lifecycle moments:

```javascript
// Session start — inject memories
const context = await signet.onSessionStart({
  harness: 'openclaw',
  sessionKey: session.id
});
// context.inject → prepend to system prompt

// Pre-compaction — get summary instructions
const guide = await signet.onPreCompaction({
  harness: 'openclaw',
  messageCount: messages.length
});
// Use guide.summaryPrompt as the compaction instruction

// Compaction complete — save summary
await signet.onCompactionComplete({
  harness: 'openclaw',
  summary: generatedSummary
});

// Manual memory operations
await signet.remember('nicholai prefers bun', { who: 'openclaw' });
const results = await signet.recall('coding preferences');
```

In the current OpenClaw plugin runtime, post-compaction persistence may read
the latest compaction summary back from `sessionFile` when the hook payload
only exposes metadata. That keeps compaction artifacts in the same temporal
body as ordinary session-end summaries instead of discarding them.

---

## Claude Code Integration

Claude Code uses file-based hooks in `~/.claude/settings.json`. The hooks call the Signet CLI, which routes requests through the daemon HTTP API:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "signet hook session-start -H claude-code --project \"$(pwd)\"",
        "timeout": 3000
      }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "signet hook user-prompt-submit -H claude-code --project \"$(pwd)\"",
        "timeout": 2000
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "signet hook session-end -H claude-code",
        "timeout": 15000
      }]
    }]
  }
}
```

The CLI calls the daemon's hook endpoints and outputs context that Claude Code injects into the session.

---

## OpenCode Integration

OpenCode uses a bundled plugin installed by `@signet/connector-opencode`
at `~/.config/opencode/plugins/signet.mjs`. The plugin calls the daemon
API at session lifecycle events (session-start, user-prompt-submit,
session-end) and exposes `/remember` and `/recall` as native tools.

Install is handled automatically by `signet setup` or `signet connect opencode`.

> **Legacy:** Earlier installations placed a fetch-based `memory.mjs` at
> `~/.config/opencode/memory.mjs`. This path is deprecated. Running
> `signet connect opencode` migrates the installation to the current
> bundled plugin at `~/.config/opencode/plugins/signet.mjs`.

---

## Implementing a Custom Hook Client

If you're building a new harness integration, call the hooks directly:

```bash
# Session start
curl -X POST http://localhost:3850/api/hooks/session-start \
  -H 'Content-Type: application/json' \
  -d '{"harness": "my-tool"}'

# Pre-compaction
curl -X POST http://localhost:3850/api/hooks/pre-compaction \
  -H 'Content-Type: application/json' \
  -d '{"harness": "my-tool", "messageCount": 200}'

# Save compaction summary
curl -X POST http://localhost:3850/api/hooks/compaction-complete \
  -H 'Content-Type: application/json' \
  -d '{"harness": "my-tool", "summary": "..."}'
```

The daemon returns JSON at each step. Check `/health` first to verify the daemon is running.

---

## Logs API (Bonus)

The daemon also exposes a real-time log stream via Server-Sent Events:

```
GET /api/logs/stream
```

Useful for harnesses that want to monitor Signet activity without polling:

```javascript
const evtSource = new EventSource('http://localhost:3850/api/logs/stream');
evtSource.onmessage = (e) => {
  const entry = JSON.parse(e.data);
  console.log(entry.level, entry.message);
};
```

Or fetch recent logs:

```bash
curl "http://localhost:3850/api/logs?limit=50&level=warn"
```
