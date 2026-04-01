# Forge harness parity roadmap

This tracks what can be reasonably ported from the reconstructed reference harness mirror at:

- `https://git.nicholai.work/Nicholai/claude-code`

Important: that repository is a reconstructed, read-only mirror and not a complete upstream build graph.
We use it for architecture patterns, not verbatim source import.

## Current Forge coverage

- Tool loop + streaming events: **present**
- Permissions/approval flow: **present**
- MCP integration: **present**
- Skills integration: **present**
- Session/history + compaction: **present**
- TUI harness with overlays/pickers: **present**

## Immediate parity upgrades

1. **Structured non-interactive output styles**
   - Status: **implemented**
   - `forge --prompt ... --output-style jsonl`
   - Emits JSONL events (`text_delta`, `tool_use_*`, `tool_result`, `usage`, `done`)

2. **Hook pipeline hardening**
   - Status: **implemented**
   - Added explicit lifecycle hooks:
     - `/api/hooks/pre-turn`
     - `/api/hooks/pre-tool`
     - `/api/hooks/post-tool`
     - `/api/hooks/post-turn`
   - Enforced timeout + failure isolation (`FORGE_HOOK_TIMEOUT_MS`, default 1200ms)
   - Hook failures/timeouts are logged and never block tool/turn execution

3. **Task abstraction layer**
   - Status: **implemented (phase 1 + TUI surfacing)**
   - Added first-class task contracts in `forge-core`:
     - `TaskKind`, `TaskPhase`, `TaskEventEnvelope` (`forge.tasks.v1`)
   - Agent loop now emits structured telemetry for:
     - turn started/succeeded/failed
     - tool started/succeeded/failed
   - Exposed through `AgentEvent::TaskTelemetry`
   - TUI now stores a task ring buffer and exposes `/tasks` to inspect recent telemetry

4. **Policy surface parity**
   - Status: **implemented (shared typed policy contract + telemetry)**
   - TUI command `/policy` opens a dedicated diagnostics panel
     (`workspace_only`, `allowed_paths`, `allowed_commands`, `approval_mode`, active agent, cwd)
   - Header chrome surfaces policy state inline (lock mode + path/command constraints + approval mode)
   - Tool approval dialog surfaces policy-aware hints (workspace lock, approval mode, command/path allowlist checks)
   - Added stronger path normalization in hints (ancestor canonicalization fallback) + explicit blocked reason mapping:
     - `shell_operators_disallowed`
     - `empty_command`
     - `command_not_allowlisted`
     - `outside_workspace`
     - `outside_allowed_paths`
   - Shared policy contract now lives in `forge-core` (`PolicyBlockReason` + shared classify/normalize helpers), consumed by both runtime policy enforcement and TUI approval hints
   - Task telemetry now emits structured policy-denied metadata for failed tool tasks:
     - `policy_denied: true`
     - `policy_reason: <reason_code>`
     - `event: "policy_denied"`
   - TUI surfaces policy-denied counters:
     - status telemetry chip (`deny <count>`)
     - `/tasks` summary aggregation (`policy_denied_total`, `policy_denied_by_reason`)
   - `/tasks` now supports trend windowing (`10/30/100`) and external export hooks:
     - `--export <file>` (pretty JSON)
     - `--export <file> --jsonl` (summary/event JSONL for dashboards)
   - CLI supports `--dry-run` in non-interactive mode to print a resolved execution plan
     (provider/model/policy) without executing the prompt

5. **Output/print SDK parity**
   - Status: **implemented (jsonl + json)**
   - Non-interactive mode supports `--output-style text|jsonl|json`
   - Includes stable schema/version fields:
     - stream events: `forge.events.v1`
     - aggregate payload: `forge.output.v1`

## Next execution order

1. Land JSONL output (done)
2. Add hook lifecycle registry (done)
3. Add task contracts + telemetry envelope (done)
4. Add end-to-end dashboard visualizations (charts/cards) for telemetry trends (next)

## Recent additions

- Daemon task telemetry surface for Forge harness events:
  - `POST /api/hooks/task-telemetry` (ingest)
  - `GET /api/forge/tasks/:sessionKey` (snapshot)
  - `GET /api/forge/tasks/:sessionKey/stream` (SSE stream)
- Forge agent now forwards `TaskTelemetry` envelopes to daemon via optional hook
  (`FORGE_TASK_TELEMETRY_TIMEOUT_MS`, default 150ms).
- Forge TUI now consumes daemon-backed task telemetry stream and uses it as
  the primary `/tasks` + policy-denied counter source (local ring fallback if daemon stream is unavailable).
- Daemon Forge task telemetry now persists to SQLite (`forge_task_telemetry`) and supports query filters:
  - `kind`, `phase`, `name`, `since`, `policyDeniedOnly`
- Daemon telemetry now includes monotonic per-session sequencing/cursors:
  - `sequence` (session-local)
  - `cursor` (SQLite row id)
  - query supports `afterCursor` for incremental consumers.
- Retention/pruning policy added for persisted telemetry (time + per-session + global caps):
  - `SIGNET_FORGE_TASK_TELEMETRY_RETENTION_DAYS`
  - `SIGNET_FORGE_TASK_TELEMETRY_MAX_ROWS`
  - `SIGNET_FORGE_TASK_TELEMETRY_MAX_ROWS_PER_SESSION`
- Added daemon tests for task telemetry persistence/filtering (`forge-task-telemetry.test.ts`)
- Dashboard Tasks tab now exposes Forge telemetry filter controls and query integration.
