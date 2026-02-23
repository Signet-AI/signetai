---
title: "Hooks"
description: "Session lifecycle hooks for harness integration."
order: 8
section: "Core Concepts"
---

# Hooks System

Signet's hook system lets harnesses integrate with session lifecycle events — injecting memory at session start, capturing summaries at compaction, and triggering MEMORY.md synthesis.

---

## Overview

Hooks are HTTP endpoints exposed by the Signet daemon. Harnesses call them at specific lifecycle points:

| Hook | When | Purpose |
|------|------|---------|
| `session-start` | New session begins | Inject memories and identity into context |
| `pre-compaction` | Before context compaction | Get summary guidelines |
| `compaction-complete` | After compaction | Save session summary as a memory |
| `synthesis` | Scheduled or manual | Get prompt to regenerate MEMORY.md |
| `synthesis/complete` | After synthesis | Save new MEMORY.md |

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

In `agent.yaml`:

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

Called after compaction with the generated summary. Saves the summary as a `session_summary` type memory.

### Request

```json
{
  "harness": "openclaw",
  "summary": "Session summary text...",
  "sessionKey": "optional-session-id"
}
```

### Response

```json
{
  "success": true,
  "memoryId": 123
}
```

---

## MEMORY.md Synthesis

Synthesis regenerates the `MEMORY.md` file by asking an AI model to write a coherent summary of all stored memories. This is typically done on a schedule (daily or weekly) by the configured harness.

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

The `@signet/adapter-openclaw` package provides a ready-made plugin:

```javascript
import createPlugin from '@signet/adapter-openclaw';

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

OpenCode uses a fetch-based plugin (`memory.mjs`) that calls the daemon API directly at session lifecycle events:

```javascript
// ~/.config/opencode/memory.mjs
async function onSessionStart(sessionKey) {
  const res = await fetch('http://localhost:3850/api/hooks/session-start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: 'opencode', sessionKey })
  });
  return res.json();
}

async function onUserPromptSubmit(context) {
  const res = await fetch('http://localhost:3850/api/hooks/user-prompt-submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: 'opencode', context })
  });
  return res.json();
}

async function onSessionEnd(sessionKey) {
  const res = await fetch('http://localhost:3850/api/hooks/session-end', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: 'opencode', sessionKey })
  });
  return res.json();
}
```

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
