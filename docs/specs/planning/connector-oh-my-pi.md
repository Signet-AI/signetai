---
title: "Connector: Oh My Pi"
id: connector-oh-my-pi
status: planning
informed_by: []
section: "Connectors"
depends_on:
  - "signet-runtime"
success_criteria:
  - "Oh My Pi install writes a managed runtime extension into the agent extensions directory without requiring Oh My Pi-only dependencies for other Signet users"
  - "The extension forwards session-start, user-prompt-submit, pre-compaction, compaction-complete, and session-end lifecycle calls to the daemon with runtimePath=plugin"
  - "Hidden session-context and recall injections persist as hidden session messages so memory-backed answers remain attributable on follow-up turns without polluting transcript reconstruction"
  - "Daemon/network failures remain fail-open so Oh My Pi prompt flow and shutdown continue even when Signet is unavailable"
scope_boundary: "Covers the managed Oh My Pi runtime extension and CLI connector install path; does not add AGENTS.md sync or /remember and /recall tool wiring inside Oh My Pi"
draft_quality: "implementation-aligned planning stub; expand if the integration surface grows"
---

# Connector: Oh My Pi

Spec metadata:
- ID: `connector-oh-my-pi`
- Status: `planning`
- Hard depends on: `signet-runtime`
- Registry: `docs/specs/INDEX.md`

Related docs:
- `packages/connector-oh-my-pi/src/index.ts`
- `packages/oh-my-pi-extension/src/index.ts`
- `docs/specs/approved/signet-runtime.md`

---

## 1) Problem

Signet supports Claude Code, OpenCode, OpenClaw, and Codex, but Oh My Pi needs a
native runtime extension rather than a hook-config patch. Without a dedicated
connector, Signet cannot install or maintain the Oh My Pi lifecycle bridge that
forwards daemon hook calls from inside the runtime.

## 2) Goals

1. Ship `@signet/connector-oh-my-pi` as a managed install path for Oh My Pi.
2. Install a Signet-managed extension file into the Oh My Pi extensions directory.
3. Forward the daemon lifecycle surface needed for continuity and compaction.
4. Keep the extension fail-open when the daemon is slow or unavailable.
5. Avoid imposing Oh My Pi-specific runtime dependencies on users who never install this harness.

## 3) Proposed capability set

### A) Managed extension install

The connector writes `signet-oh-my-pi.js` into the Oh My Pi extensions
directory. If `PI_CODING_AGENT_DIR` is set, use that agent directory;
otherwise use `~/.omp/agent/extensions/`.

### B) Lifecycle forwarding

The runtime extension forwards these daemon hooks through the plugin runtime:

| Oh My Pi event | Signet hook | Daemon endpoint |
|---|---|---|
| `session_start` | session-start | `POST /api/hooks/session-start` |
| `input` / `before_agent_start` | user-prompt-submit | `POST /api/hooks/user-prompt-submit` |
| `session.compacting` | pre-compaction | `POST /api/hooks/pre-compaction` |
| `session_compact` | compaction-complete | `POST /api/hooks/compaction-complete` |
| `session_shutdown`, `session_switch`, `session_branch` | session-end | `POST /api/hooks/session-end` |

### C) Hidden context injection

The extension injects hidden Signet messages for session context and prompt
recall through `before_agent_start`, sets `attribution: "agent"` so Oh My Pi
does not bill them as user-originated Copilot requests, and keeps them out of
transcript reconstruction while preserving follow-up attribution.

## 4) Non-goals

- No `AGENTS.md` identity sync into Oh My Pi.
- No `/remember` or `/recall` tool wiring inside the Oh My Pi runtime.
- No new daemon endpoints; reuse the existing hook API.

## 5) Validation and tests

- Connector install/uninstall test for the managed extension file.
- Extension tests for transcript filtering and timeout handling.
- Build/typecheck for both `@signet/connector-oh-my-pi` and `@signet/oh-my-pi-extension`.

## 6) Open decisions

1. Whether Oh My Pi should later expose Signet MCP tools directly.
2. Whether identity-file sync belongs in this connector or a future runtime capability.
