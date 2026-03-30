---
title: "MCP CLI Bridge and Usage Analytics"
id: mcp-cli-bridge-and-usage-analytics
status: approved
informed_by: []
section: "CLI + Dashboard"
depends_on:
  - "signet-runtime"
success_criteria:
  - "Installed MCP servers are invokable through Signet CLI with dashboard usage tracking"
scope_boundary: "CLI bridge and analytics only. Does not implement MCP server discovery, installation, or marketplace integration (see git-marketplace-monorepo). Does not modify MCP protocol transport."
draft_quality: "Phase 1 implemented — CLI bridge, invocation tracking, analytics API, and dashboard panel shipped"
---

# MCP CLI Bridge and Usage Analytics

*Expose installed MCP servers as CLI subcommands and track invocation
analytics in the dashboard.*

---

## Problem Statement

Signet manages MCP servers for agents (marketplace routes, policy/scope
controls, enable/disable lifecycle). But using those servers requires
the agent harness to invoke them. There is no way for a human operator
to call an MCP tool from the terminal, inspect available tools, or see
which tools agents actually use and how often.

This creates two gaps: (1) operators cannot test or debug MCP servers
without running a full agent session, and (2) there is no visibility
into which MCP capabilities agents rely on, making capacity planning
and deprecation decisions blind.

---

## Goals

1. Expose every installed MCP server's tools as `signet mcp <server> <tool>` CLI subcommands.
2. Record every MCP tool invocation (CLI and agent) with timestamp, agent_id, latency, and outcome.
3. Surface usage analytics in the dashboard: per-server, per-tool, and per-agent breakdowns.
4. Support `signet mcp list` and `signet mcp <server> --help` for discoverability.
5. Feed invocation frequency into the predictive scorer as a behavioral signal.

---

## Proposed Capability Set

### A. CLI Bridge (`signet mcp`)

New CLI command group under `packages/cli/src/commands/`:

- `signet mcp list` — queries `GET /api/marketplace/servers` to show
  installed servers with enabled/disabled status.
- `signet mcp <server> list-tools` — calls the server's MCP endpoint
  to enumerate available tools via the `tools/list` method.
- `signet mcp <server> <tool> [--param key=value...]` — invokes a
  tool via `POST /api/marketplace/servers/:name/call` (or directly
  via MCP transport). Params are passed as key=value pairs, JSON
  auto-parsed for non-string values.
- `signet mcp <server> --help` — shows server metadata and tool
  schemas from the MCP `tools/list` response.

The bridge does not maintain its own MCP client connection. It calls
the daemon API which already manages server lifecycle and transport
(`packages/daemon/src/routes/marketplace.ts`).

### B. Invocation Tracking Table

New migration adding `mcp_invocations` to `memories.db`:

```sql
CREATE TABLE mcp_invocations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    server     TEXT NOT NULL,
    tool       TEXT NOT NULL,
    agent_id   TEXT NOT NULL DEFAULT 'default',
    source     TEXT NOT NULL CHECK(source IN ('cli', 'agent', 'mcp')),
    latency_ms INTEGER NOT NULL,
    success    INTEGER NOT NULL DEFAULT 1,
    error_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mcp_inv_server ON mcp_invocations(server, created_at);
CREATE INDEX idx_mcp_inv_agent  ON mcp_invocations(agent_id, created_at);
```

The daemon records a row on every tool call — both CLI-originated
(via the bridge API) and agent-originated (via MCP transport hooks
in `packages/daemon/src/mcp/tools.ts`).

### C. Analytics API

New daemon endpoints:

- `GET /api/mcp/analytics` — aggregated stats: total calls, top
  servers, top tools, failure rate, p50/p95 latency. Accepts
  `?agent_id=`, `?server=`, `?since=` query params.
- `GET /api/mcp/analytics/:server` — per-server breakdown by tool.

### D. Dashboard Usage Panel

New dashboard component in the MCP/Marketplace section showing:

- Invocation timeline (sparkline per server, last 7 days).
- Top tools by call count with success/failure ratio.
- Per-agent usage breakdown when multi-agent is active.
- Latency distribution (p50/p95 bars).

### E. Scorer Feature Export

Invocation frequency (calls per day, recency of last call) exported
as scorer features alongside existing behavioral signals. The
`mcp_invocations` table is queryable by the predictor feature
pipeline the same way `session_memories` is today.

---

## Non-Goals

- MCP server installation or marketplace browsing (see `git-marketplace-monorepo`).
- Modifying MCP protocol transport or adding new transport types.
- Real-time streaming of MCP tool output in the CLI (v1 is request/response).
- Policy enforcement (already handled by `mcp_server_policy_set`).

---

## Integration Contracts

- **Signet Runtime**: runtime records invocations via the same tracking
  table. The `source` column distinguishes `'agent'` from `'cli'`.
- **Predictive Scorer**: invocation frequency becomes a scorer feature
  (cross-cutting invariant 4). High-frequency tools score higher for
  related entity contexts.
- **Multi-Agent**: `agent_id` column on `mcp_invocations` scoped per
  cross-cutting invariant 1. Analytics API filters by agent.
- **Git Marketplace**: marketplace install/uninstall events are not
  tracked here — only tool invocations.

---

## Rollout Phases

### Phase 1: CLI Bridge + Tracking (safe defaults)

Ship `signet mcp list`, `signet mcp <server> <tool>`, and the
`mcp_invocations` migration. Agent-side tracking off by default
(CLI tracking always on). Dashboard panel not yet built.

### Phase 2: Agent Tracking + Dashboard

Enable agent-side invocation recording in the MCP transport hooks.
Ship the dashboard analytics panel. Export scorer features.

### Phase 3: Advanced Analytics

Add latency alerting thresholds, tool deprecation warnings (no
invocations in 30 days), and per-session tool usage summaries in
the session timeline.

---

## Validation and Tests

- CLI integration test: install a mock MCP server, call a tool via
  `signet mcp`, verify invocation row in `mcp_invocations`.
- Analytics API test: seed invocation rows, verify aggregation math
  (counts, latency percentiles, per-agent filtering).
- Agent tracking test: simulate an agent MCP tool call, verify the
  `source='agent'` row is recorded with correct `agent_id`.
- Scorer feature test: verify invocation frequency appears in the
  feature vector for entities associated with the MCP server.

---

## Success Metrics

- Any installed MCP server's tools are callable from `signet mcp`
  with <500ms overhead vs direct MCP call.
- Dashboard shows per-tool invocation counts and latency within 1
  minute of the call occurring.
- Zero invocation rows with missing `agent_id` (scoping invariant).

---

## Open Decisions

1. **CLI output format** — should `signet mcp <server> <tool>` output
   raw JSON or formatted text by default? Leaning toward JSON with
   `--pretty` flag for human-readable output.
2. **Batch invocation** — should the CLI support piping multiple tool
   calls? Defer to Phase 3 unless demand is clear.
3. **Retention policy** — how long to keep `mcp_invocations` rows?
   30 days rolling window vs unbounded with manual cleanup.
