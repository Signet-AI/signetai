---
title: "Develop a harness integration"
description: "Add and validate a new Signet harness integration."
---

## Adding a New Harness

To integrate Signet with a harness not listed here:

1. **Identity sync** — simply watch for `$SIGNET_WORKSPACE/AGENTS.md` changes and copy the content to wherever your harness reads agent instructions.

2. **Memory access** — call the daemon's HTTP API:
   - `POST /api/memory/remember` to save memories
   - `POST /api/memory/recall` to search memories

3. **Lifecycle hooks** — call the hooks API at session events:
   - `POST /api/hooks/session-start` at session start
   - `POST /api/hooks/pre-compaction` before compaction
   - `POST /api/hooks/compaction-complete` after compaction

4. **Check daemon health** — always verify `GET /health` returns 200 before making other calls.

See [API.md](/api/) for full endpoint documentation and [HOOKS.md](/hooks/) for hook integration details.

---

## Working-Memory Fidelity Matrix

All harnesses target the same model:

- one agent
- many sessions / branches
- one shared root `MEMORY.md` head, with optional agent-local `MEMORY.md`
  overrides for named agents
- structured retrieval first
- transcripts as fallback / deep history
- compaction artifacts feeding the same temporal DAG

Where they differ is lifecycle fidelity:

| Harness | session-start | prompt-submit | pre-compaction | post-compaction | session-end | Notes |
|---------|---------------|---------------|----------------|-----------------|-------------|-------|
| OpenCode plugin | yes | yes | yes | yes | yes | Reference full-fidelity path |
| OpenClaw plugin | yes | yes | yes | yes | yes | Flagship path; post-compaction may read summary back from `sessionFile` when the hook only exposes metadata |
| Oh My Pi extension (v1) | yes | yes | yes | yes | yes | Lifecycle events only; no Signet memory tools or AGENTS.md sync yet |
| Hermes Agent plugin | yes | yes | yes | yes | yes | Full fidelity via `MemoryProvider` ABC; includes checkpoint-extract and delegation hooks |
| pi extension | yes | yes | yes | yes | yes | Full lifecycle and Signet tools (`/recall`, `/remember`, `signet_recall`, `signet_source_search`, `signet_session_search`, `signet_remember`); no AGENTS.md sync yet |
| Claude Code | yes | yes | yes | no | yes | Good continuity, degraded after-compaction fidelity |
| Codex | yes | yes | no | no | yes | Solid baseline, degraded compaction fidelity |
| OpenClaw legacy hooks | manual `/context` | no | no | no | no | Compatibility-only, not full parity |

The docs should be read literally. If a hook surface is absent here, that
mode is degraded rather than silently assumed.

---

## Harness Status

Check which harnesses are configured:

```bash
signet status
```

Or via API:

```bash
curl http://localhost:3850/api/harnesses
```

Or in the dashboard under the **Harnesses** section.
