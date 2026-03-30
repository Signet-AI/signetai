---
title: "Skill Usage Analytics"
id: skill-usage-analytics
status: approved
informed_by:
  - "mcp-cli-bridge-and-usage-analytics"
section: "CLI + Dashboard"
depends_on: []
success_criteria:
  - "Skill invocations are tracked with source, latency, and outcome"
  - "Dashboard displays constellation-style usage panel for installed skills"
scope_boundary: "Skill invocation tracking and analytics only. Does not modify skill execution, installation, or marketplace."
draft_quality: "Phase 1 implemented — scheduled task tracking, analytics API, CLI command, dashboard panel"
---

# Skill Usage Analytics

*Track skill invocations and surface usage analytics in the dashboard.*

## Problem Statement

Skills are installed and discoverable but usage is invisible. The
`skill_meta` table has `use_count` and `last_used_at` columns (since
migration 018) that are never written to. Operators cannot see which
skills agents rely on, how often they run, or whether they succeed.

## Implemented (Phase 1)

### Migration 053: skill_invocations table
- Tracks: skill_name, agent_id, source, task_id, latency_ms, success, error_text
- Sources tracked in Phase 1: scheduled-task, api
- Additional sources (slash-command, cli) deferred to Phase 2

### Scheduler instrumentation
- `worker.ts` records invocations when scheduled tasks with `skill_name` complete
- Updates `skill_meta.use_count` and `last_used_at` (previously unused columns)

### Analytics API
- `GET /api/skills/analytics` — aggregated stats with agent scoping
- `GET /api/skills/analytics/:skill` — per-skill breakdown with 7-day timeline

### CLI command
- `signet skill analytics [--skill <name>] [--since <iso>] [--json]`

### Dashboard panel
- Constellation-style SkillUsagePanel matching MCP analytics design
- Side-by-side panes: total runs + node graph, stats + usage bars

## Phase 2 (not implemented)
- Harness-side slash command tracking (requires connector cooperation)
- Per-agent skill usage breakdown
- Skill importance decay based on invocation frequency
