---
title: "OpenClaw"
description: "Connect Signet to OpenClaw."
---

## OpenClaw

OpenClaw is the flagship harness for the lossless working-memory model.
The plugin path gives the closest match to the full LCM runtime, while the
legacy hook path remains compatibility-only. `signet sync` auto-migrates
legacy-only Signet installs to the plugin path, and `signet doctor` warns
when a config is still stuck on legacy-only mode.

### Files managed by Signet

| Location | Description |
|----------|-------------|
| `$SIGNET_WORKSPACE/AGENTS.md` | Source of truth (OpenClaw reads workspace directly) |
| `$SIGNET_WORKSPACE/hooks/agent-memory/` | Hook handler directory |
| `~/.openclaw/openclaw.json` | Workspace configuration |

### Workspace configuration

Signet sets OpenClaw-family configs to your active Signet workspace.
Change it with:

```bash
signet workspace set ~/.openclaw/workspace
```

Common compatible workspace targets include:

- `~/.openclaw/workspace`
- `~/.clawdbot/workspace`
- `~/clawd`
- `~/.moltbot/workspace`

OpenClaw config value:

```json
{
  "agents": {
    "defaults": {
      "workspace": "$SIGNET_WORKSPACE"
    }
  }
}
```

OpenClaw checks these config locations (in order):
- `~/.openclaw/openclaw.json`
- `~/.clawdbot/clawdbot.json`
- `~/.moltbot/moltbot.json`

### @signetai/adapter-openclaw

The adapter package provides a full lifecycle integration:

```javascript
import createPlugin from '@signetai/adapter-openclaw';

const signet = createPlugin({
  enabled: true,
  daemonUrl: 'http://localhost:3850'  // default
});
```

**Session start** — inject memories into system prompt:
```javascript
const result = await signet.onSessionStart({
  harness: 'openclaw',
  sessionKey: session.id
});
// result.inject → prepend to system prompt
```

**Pre-compaction** — get summary guidelines:
```javascript
const guide = await signet.onPreCompaction({
  harness: 'openclaw',
  messageCount: messages.length
});
// guide.summaryPrompt → use as compaction instruction
```

**Compaction complete** — save the generated summary:
```javascript
await signet.onCompactionComplete({
  harness: 'openclaw',
  summary: generatedSummary,
  sessionKey: session.id
});
```

When OpenClaw only exposes compaction metadata to the plugin hook, the
runtime may read the latest compaction summary back from `sessionFile`
before calling the daemon so the temporal DAG still receives the real
artifact.

**Manual memory operations:**
```javascript
await signet.remember('nicholai prefers bun', { who: 'openclaw' });
const results = await signet.recall('coding preferences');
```

### MEMORY.md synthesis

The daemon synthesis worker is the primary runtime path for keeping
`MEMORY.md` current. OpenClaw may still drive synthesis on a schedule by:

1. Calls `GET /api/hooks/synthesis/config` to check if synthesis should run
2. Calls `POST /api/hooks/synthesis` to get the synthesis prompt
3. Runs the prompt through the configured model
4. Posts the result to `POST /api/hooks/synthesis/complete`

Both paths write through the same merge-safe head record, so the rendered
`MEMORY.md` stays shared across harnesses instead of becoming
OpenClaw-specific.

### Hooks directory

During setup, Signet creates `$SIGNET_WORKSPACE/hooks/agent-memory/` with:

- `HOOK.md` — hook documentation
- `handler.js` — event handler (for older hook-based integration)
- `package.json` — package metadata

### Package Distinction: adapter vs connector

Signet provides two separate packages for OpenClaw integration:

#### @signetai/connector-openclaw

**Purpose:** Setup and installation

This is a setup-time package that:

- Patches OpenClaw config files (openclaw.json, clawdbot.json, moltbot.json)
- Sets `agents.defaults.workspace` to your active Signet workspace
- Enables the `signet-memory` internal hook entry
- Installs hook handler files under `$SIGNET_WORKSPACE/hooks/agent-memory/`

Installed during `signet setup` when OpenClaw is selected.

#### @signetai/adapter-openclaw

**Purpose:** Runtime plugin

This is a runtime plugin that OpenClaw loads to:

- Call the Signet daemon API for /remember, /recall operations
- Handle lifecycle hooks (session start, compaction, etc.)
- Inject memories into the system prompt

Has a peer dependency on `openclaw` — only usable within the OpenClaw process.
