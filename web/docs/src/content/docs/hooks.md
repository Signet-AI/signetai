---
title: "Hooks"
description: "Session lifecycle hooks for harness integration."
---

Signet's hook system lets [Harnesses](/harnesses/) integrate with session lifecycle events — injecting [Memory](/memory/) at session start, capturing summaries at compaction, and triggering MEMORY.md synthesis.

---

## Overview

Hooks are HTTP endpoints exposed by the Signet [Daemon](/daemon/). Harnesses call them at specific lifecycle points:

| Hook | When | Purpose |
|------|------|---------|
| `session-start` | New session begins | Inject memories, identity, and the Memory Check Loop into context |
| `user-prompt-submit` | Before each user turn | Inject compact current-view context only when the prompt mentions a known entity or active entity alias |
| `notifications` | Any declared compatible harness hook | Inject unread cross-agent messages without running recall or transcript side effects |
| `session-end` | Session finishes | Persist transcript lineage and queue session summary |
| `pre-compaction` | Before context compaction | Get summary guidelines |
| `compaction-complete` | After compaction | Save a first-class compaction artifact into the temporal DAG |
| `synthesis` | Scheduled or manual | Get prompt to regenerate MEMORY.md |
| `synthesis/complete` | After synthesis | Save the merge-safe temporal head |

---

## Cache-stable prompt context

The session-start response separates prompt context into two fields:

- `stableSystemPrompt` is the deterministic Signet instruction prefix. It
  excludes clocks, peer presence, session summaries, and recalled memory rows,
  so a compatible harness can cache it.
- `dynamicContext` is state-dependent session/turn context. Adapters deliver
  it through a provider-bound, hidden, or native hook channel rather than
  appending it to the canonical user message.
- `inject` remains a compatibility aggregate for older connectors. New
  integrations should prefer the split fields. The aggregate is returned in
  the versioned `<signet-memory-context>` envelope with `contextHash` and
  `contextVersion` so legacy clients can verify the exact bytes they received.

Canonical transcript surfaces remove internal `<signet-memory>` and
`<memory-context>` blocks (including `<signet-memory-context>` envelopes).
Where a harness exposes a stream boundary, the
adapter also scrubs split delimiters from visible provider output. The full
contract and measured evaluation are documented in [Cache-Stable Memory
Injection](https://github.com/Signet-AI/signetai/blob/main/docs/specs/approved/cache-stable-memory-injection.md).

## Cross-Agent Notifications

Cross-agent messages are stored in SQLite and survive daemon restarts. A message remains unread for its recipient until the recipient explicitly acknowledges it or the seven-day retention window expires. Acknowledgements are agent-scoped, so acknowledging a broadcast does not dismiss it for other agents.

`session-start` and `user-prompt-submit` responses may include an optional `notifications` block. Its bounded `items` array carries stable message IDs, sender metadata, truncated hook-safe content, `unreadCount`, and `hasMore`. The same response's top-level `inject` includes a delimited peer-message section. Peer content is untrusted coordination data, not system or developer instruction.

Connectors can also call the lightweight endpoint without triggering recall or transcript capture:

**`POST /api/hooks/notifications`**

```json
{
  "harness": "opencode",
  "hook": "experimental.chat.system.transform",
  "agentId": "reviewer",
  "sessionKey": "session-identifier",
  "project": "/workspace/project"
}
```

If no messages are unread, the endpoint returns `{ "inject": "" }`. Unsupported harness hooks return `400` instead of silently polling at an undeclared lifecycle point.

| Harness | Compatible delivery hooks |
|---------|---------------------------|
| Claude Code | `SessionStart`, `UserPromptSubmit`, `PreToolUse` |
| Codex | `SessionStart`, `UserPromptSubmit`, `PreToolUse` |
| OpenCode | `chat.message`, `tool.execute.before`, `experimental.chat.system.transform`, `experimental.chat.messages.transform` |
| OpenClaw | `message_received`, `before_tool_call`, `before_prompt_build`, `before_agent_start` |
| pi | `context` |
| Oh My Pi | `before_agent_start` |
| Hermes Agent | `on_turn_start`, `prefetch`, `sync_turn`, `on_delegation` |
| Gemini CLI | `poll` fallback through `agent_message_inbox` |

After processing a message, call the `agent_message_ack` MCP tool or `POST /api/cross-agent/messages/:messageId/ack` with the recipient agent scope. Until that succeeds, later compatible hooks may deliver the message again.

Run `bun scripts/evals/cross-agent-notification-latency.ts` to exercise 25 create, hook-delivery, and acknowledgement cycles. The eval fails when local p95 queue-to-hook projection exceeds 250 ms.

---

## Session-end Boundary Reasons

**`POST /api/hooks/session-end`** accepts an optional `reason` field. Harnesses
must send an explicit lifecycle reason when the request represents a real
session boundary:

| Reason | Boundary |
|--------|----------|
| `clear` | The caller discards the current session context |
| `session.deleted` | OpenCode deleted the session |
| `session_branch` | Oh My Pi forked the current session |
| `session_fork` | pi forked the current session |
| `session_shutdown` | pi shut down the current session |
| `session_switch` | pi switched to another session |
| `stale-session-sweep` | The daemon finalized an abandoned live-retained session after the stale-session TTL |

These reasons emit one anonymous `session.end` telemetry event per session
lifetime. Repeated end requests for the same session are deduplicated.

Requests without a recognized boundary reason, including ordinary
`session.idle` calls, emit `session.turn` telemetry instead. They still persist
the transcript and queue normal session-end processing.

The daemon's stale-session sweeper processes at most 10 abandoned sessions per
15-minute timer tick. It is single-flight, yields between finalizations, pauses
when system pressure is elevated, and defers when downstream capture or summary
work has reached its backlog threshold. Reproduce the 50-session liveness eval
in an isolated temporary database with:

```sh
bun scripts/load-test-stale-session-sweep.ts
```

```json
{
  "harness": "opencode",
  "sessionKey": "session-identifier",
  "reason": "session.deleted"
}
```

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
  "harnessAgentId": "optional-harness-native-subagent-id",
  "parentSessionKey": "optional-parent-session-key",
  "context": "optional context string",
  "sessionKey": "optional-session-identifier"
}
```

`harness` is required. Everything else is optional. `agentId` is the Signet
persistence scope. Harness-native sub-agent identifiers should be sent as
`harnessAgentId`; they are used only for parent-session inference.

When a daemon restart is detected during an already-running session, a harness
may send `claimOnly: true` with the same `sessionKey` and a `plugin` or `legacy`
runtime path in `x-signet-runtime-path` or `runtimePath`. Signet renews the
runtime claim and returns `{ "sessionKnown": true }` without generating
memories, identity, or an `inject` block. This mode rejects requests without a
runtime path. Do not use it for a new session: it deliberately preserves the
existing conversation's stable system prompt rather than constructing startup
context.

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
  "stableSystemPrompt": "[signet active]\n\n# Memory Check Loop\n...",
  "dynamicContext": "[memory active | /remember | /recall]\n\n## Relevant Memories\n- ...",
  "inject": "<signet-memory-context>\n[signet active]\n...\n[memory active | /remember | /recall]\n...\n</signet-memory-context>\n",
  "contextHash": "sha256-of-the-exact-inject-bytes",
  "contextVersion": 1
}
```

`stableSystemPrompt` is the cacheable instruction prefix. `dynamicContext` is
state-dependent context for the provider-bound or hidden harness channel. The
`inject` field remains the versioned, ready-to-use aggregate for legacy clients
and includes both fields in order; `contextHash` covers the exact serialized
`inject` bytes.

The Memory Check Loop tells agents when prior context may matter, how to run
1-3 targeted recalls, what pitfalls to avoid, and how to verify they are
grounded before acting. It is intentionally behavioral prompt shaping, not a
new hook schema or recall algorithm.

### Configuration

In `agent.yaml` (see [Configuration](/configuration/)):

```yaml
capabilities:
  identity:
    mode: managed            # managed | passthrough | off

hooks:
  sessionStart:
    recallLimit: 10            # How many memories to include
    includeIdentity: true      # Only applies when identity.mode is managed
    includeRecentContext: true # Include MEMORY.md content
    recencyBias: 0.7           # 0=importance-only, 1=recency-only

  contextProfiles:
    coding:
      sessionStart:
        recallLimit: 5
        maxInjectTokens: 5000
      identity:
        files:
          - path: context-profiles/coding/AGENTS.md
            maxChars: 2200
    rich:
      sessionStart:
        recallLimit: 50
        maxInjectTokens: 20000
  harnessProfiles:
    pi: coding
    hermes-agent: rich
```

Context profiles override hook budgets and startup identity/context files
per harness. Use them to keep coding harnesses lean while preserving richer
cold-start identity in operator or character-forward harnesses. For a compact
coding prompt, run `signet context compile --profile coding --max-chars 2200`;
that ACPX/inference-backed compiler reads the canonical identity files and
writes `context-profiles/coding/AGENTS.md`. Session-start hooks only read the
compiled artifact, so model synthesis is never performed in the hot hook path.

Memory scoring uses: `score = importance × (1 - recencyBias) + recency × recencyBias`

where recency is `1 / (1 + age_in_days)`.

---

## User Prompt Submit Hook

**`POST /api/hooks/user-prompt-submit`**

Called before each user turn is handed to the model. Prompt-submit does not run
generic memory recall and does not inject fallback guidance when it cannot find
a confident match.

The hook listens for known ontology entities and active entity aliases. When a
prompt names one, the entity match scopes the search, then Signet scores that
entity's current attributes against the remaining prompt. The highest-scoring
attributes choose which aspects to inject into a compact
`## Relevant Entity Context` block. `hooks.userPromptSubmit.minScore` gates
attribute-driven aspect selection; `maxInjectChars` caps the block.

When the prompt is low-signal, mentions no known entity or alias, is ambiguous,
or no attribute clears the confidence gate, the hook returns an empty `inject`
string. Literal aspect names alone do not select context. This keeps the active
agent loop trustable: absence of injected context means Signet chose not to
inject, not that the broader source substrate has no relevant evidence.

Explicit recall remains available through `/api/memory/recall`, `signet_recall`,
`memory_search`, and related MCP/CLI surfaces. Raw transcript search is
deliberately not injected through this hook; use `session_search` when a caller
needs transcript evidence.

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
        "timeout": 7000
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

Prompt-submit timeout note: `SIGNET_PROMPT_SUBMIT_TIMEOUT` defaults to
`5000` (daemon wait budget). Claude Code hook config adds a `+2000ms`
grace buffer when written to `settings.json`, so the installed
`UserPromptSubmit` timeout default is `7000`.

Upgrade note: Claude Code hook timeouts are persisted in
`~/.claude/settings.json` during connector install/update. Existing
installs keep old timeout values until you rerun `signet connect
claude-code` (or `signet setup`) to refresh hook config.

The CLI calls the daemon's hook endpoints and outputs context that Claude Code injects into the session.

---

## OpenCode Integration

OpenCode uses a bundled plugin installed by `@signetai/connector-opencode`
at `~/.config/opencode/plugins/signet.mjs`. The plugin calls the daemon
API at session lifecycle events (session-start, user-prompt-submit,
session-end) and exposes `/remember` and `/recall` as native tools.

Install is handled automatically by `signet setup` or `signet connect opencode`.

Set `SIGNET_ENABLED=false` or `SIGNET_NO_HOOKS=1` to prevent the plugin from
registering hooks for a sterile background process.

> **Legacy:** Earlier installations placed a fetch-based `memory.mjs` at
> `~/.config/opencode/memory.mjs`. This path is deprecated. Running
> `signet connect opencode` migrates the installation to the current
> bundled plugin at `~/.config/opencode/plugins/signet.mjs`.

---

## pi Integration

pi uses a bundled extension installed by `@signetai/connector-pi` at
`~/.pi/agent/extensions/signet-pi.js` (or `$PI_CODING_AGENT_DIR/extensions/signet-pi.js`).
The extension calls the daemon API at session lifecycle events (session-start,
user-prompt-submit, session-end, compaction) and exposes `/recall`, `/remember`,
and `/signet-status` commands plus `signet_recall`, `signet_source_search`,
`signet_session_search`, and `signet_remember` LLM-callable tools.

Install is handled automatically by `signet setup` or `signet connector install pi`.
For a remote daemon, pass the daemon URL and API key during install:

```bash
signet api-key create --name "work laptop pi" --connector pi --agent-id pi-work-laptop
signet connector install pi \
  --url https://signet-home.tailnet:3850 \
  --api-key sig_sk_... \
  --agent-id pi-work-laptop
```

Configuration is optional via `~/.pi/agent/extensions/signet.json`. Set
`SIGNET_ENABLED=false` to disable for a single session.

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
