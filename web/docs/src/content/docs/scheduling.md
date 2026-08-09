---
title: "Scheduled Tasks"
description: "Schedule recurring agent prompts via cron-based daemon tasks."
---

Schedule recurring agent prompts that the Signet [Daemon](/daemon/) executes
automatically via Claude Code or OpenCode [CLI](/cli/).

## Overview

Scheduled tasks let you automate recurring agent workflows — PR
reviews, code linting, status summaries, dependency checks, etc.
The daemon evaluates cron expressions and spawns CLI processes on
schedule.

Source code: `platform/daemon/src/scheduler/`

## Creating Tasks

### Via Dashboard

1. Open the Signet [Dashboard](/dashboard/) (http://localhost:3850)
2. Navigate to the **Tasks** tab
3. Click **+ New Task**
4. Fill in the form:
   - **Name**: descriptive label (e.g. "Review open PRs")
   - **Prompt**: what the agent should do
   - **Harness**: Claude Code or OpenCode
   - **Schedule**: pick a preset or enter a custom cron expression
   - **Working Directory**: optional project path for context
5. Click **Create Task**

### Via API

```bash
curl -X POST http://localhost:3850/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily PR review",
    "prompt": "Review all open pull requests and summarize findings",
    "cronExpression": "0 9 * * *",
    "harness": "claude-code",
    "workingDirectory": "/home/user/my-project"
  }'
```

Required fields: `name`, `prompt`, `cronExpression`, `harness`.

Optional fields: `workingDirectory`.

Supported harness values: `claude-code`, `opencode`.

## Cron Expressions

Standard 5-field cron syntax: `minute hour day-of-month month day-of-week`

### Presets

The dashboard offers these built-in presets (defined in
`platform/daemon/src/scheduler/cron.ts`):

| Preset | Expression |
|--------|-----------|
| Every 15 min | `*/15 * * * *` |
| Hourly | `0 * * * *` |
| Daily 9am | `0 9 * * *` |
| Weekly Mon 9am | `0 9 * * 1` |

Custom expressions are validated before saving using `cron-parser`.
The `validateCron()` function returns `true` for valid expressions
and `false` otherwise — invalid expressions are rejected at creation
time.

## Execution Model

- The daemon polls every 15 seconds for due tasks
- Maximum 3 concurrent task processes
- Each run gets a unique UUID and captures stdout/stderr
- Output is capped at 1 MB per stream (1,048,576 characters)
- Default timeout: 10 minutes per task
- Tasks that are already running are skipped (no double-execution)
- On daemon restart, any in-progress runs are marked as failed

### Process Commands

The `spawnTask()` function in `platform/daemon/src/scheduler/spawn.ts`
builds the CLI command based on the harness:

- **Claude Code**: `claude --dangerously-skip-permissions -p "<prompt>"`
- **OpenCode**: `opencode run --format json "<prompt>"`

Before spawning, the function checks that the CLI binary exists on
PATH via `Bun.which()`. If the binary isn't found, the run fails
immediately with a `"CLI binary not found on PATH"` error.

### Environment Isolation

Spawned processes inherit the daemon's environment with two modifications:

- `CLAUDECODE` is stripped to avoid nested-session detection
- `SIGNET_NO_HOOKS` is set to `"1"` to prevent hook loops (Signet harness
  integrations treat the spawned agent as a sterile background process)

### Timeout Behavior

When a task exceeds its timeout:

1. `SIGTERM` is sent to the process
2. After 5 additional seconds, `SIGKILL` is sent if still alive
3. The run is recorded with `timedOut: true` and an error message

### Startup Recovery

When the daemon starts, the scheduler marks all `pending` and `running`
task runs as `failed` with error `"daemon_restart"`. This prevents
orphaned runs from blocking future executions.

## Task Streaming

The daemon provides real-time output streaming for running tasks via
Server-Sent Events (SSE).

### Endpoint

```
GET /api/tasks/:id/stream
```

Returns an SSE stream with the following event types:

### Event Types

**`connected`** — Sent immediately on connection.

```json
{
  "type": "connected",
  "taskId": "abc-123",
  "timestamp": "2026-03-01T10:00:00.000Z"
}
```

**`run-started`** — A new run has begun. Also sent as a replay if a
run is already in progress when the client connects.

```json
{
  "type": "run-started",
  "taskId": "abc-123",
  "runId": "def-456",
  "startedAt": "2026-03-01T10:00:01.000Z",
  "timestamp": "2026-03-01T10:00:01.000Z"
}
```

**`run-output`** — A chunk of stdout or stderr from the running process.

```json
{
  "type": "run-output",
  "taskId": "abc-123",
  "runId": "def-456",
  "stream": "stdout",
  "chunk": "Analyzing pull requests...\n",
  "timestamp": "2026-03-01T10:00:05.000Z"
}
```

**`run-completed`** — The run has finished.

```json
{
  "type": "run-completed",
  "taskId": "abc-123",
  "runId": "def-456",
  "status": "completed",
  "completedAt": "2026-03-01T10:05:00.000Z",
  "exitCode": 0,
  "error": null,
  "timestamp": "2026-03-01T10:05:00.000Z"
}
```

### Replay on Connect

When a client connects while a task is already running, the stream
replays the current run state: a `run-started` event followed by
buffered stdout/stderr chunks (up to 200,000 characters per stream).
This lets late-joining clients catch up without missing output.

### Buffer Management

The in-memory buffer retains the most recent 200,000 characters per
stream (stdout and stderr independently). When the buffer exceeds this
limit, the oldest chunks are trimmed from the front. The buffer is
cleared when a run completes.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/tasks` | GET | List all tasks with last run status |
| `/api/tasks` | POST | Create a new task |
| `/api/tasks/:id` | GET | Get task details + recent runs |
| `/api/tasks/:id` | PATCH | Update task fields (name, prompt, cron, enabled, etc.) |
| `/api/tasks/:id` | DELETE | Delete a task and its run history |
| `/api/tasks/:id/run` | POST | Trigger immediate execution |
| `/api/tasks/:id/runs` | GET | Paginated run history (`?limit=&offset=`) |
| `/api/tasks/:id/stream` | GET | SSE stream of real-time task output |

## Managing Tasks

### Enable/Disable

Toggle the switch on any task card in the dashboard, or via API:

```bash
curl -X PATCH http://localhost:3850/api/tasks/<id> \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### Manual Run

Trigger a task immediately without waiting for the next scheduled
time. Click "Run Now" in the task detail panel or:

```bash
curl -X POST http://localhost:3850/api/tasks/<id>/run
```

### Viewing Run History

Click any task card in the dashboard to see its run history with
stdout/stderr output. Or via API:

```bash
curl http://localhost:3850/api/tasks/<id>/runs?limit=20&offset=0
```

## Error Handling and Retry

Tasks do **not** automatically retry on failure. Each run is a
one-shot execution. If a run fails:

1. The run status is set to `"failed"`
2. The `error` field captures the reason (timeout, non-zero exit, spawn error)
3. The task's `next_run_at` is still advanced to the next cron tick
4. The task remains enabled and will execute again at the next scheduled time

A run is considered failed when:
- The process exits with a non-zero exit code
- The `error` field on the `SpawnResult` is non-null (binary not found, spawn error)
- The process times out

Successful runs have `status: "completed"` and `exitCode: 0`.

## Security

Claude Code runs with `--dangerously-skip-permissions`, meaning
tasks execute without user approval gates. The dashboard displays
a warning when creating Claude Code tasks.

Only schedule tasks you trust. The daemon runs them with the same
permissions as the daemon process itself.

## Troubleshooting

**Task not running?**
- Check that the daemon is running (`signet status`)
- Verify the CLI binary is on PATH (`which claude` or `which opencode`)
- Check the task is enabled in the dashboard

**Task failing?**
- Open the task detail to view stdout/stderr from the last run
- Check for timeout issues (default 10 minutes)
- Verify the working directory exists and is accessible

**Daemon restart clears running tasks?**
- This is expected — in-progress runs are marked as failed on restart
- The task will be picked up again at the next scheduled time
