# Scheduled Tasks

Schedule recurring agent prompts that the Signet daemon executes
automatically via Claude Code or OpenCode CLI.

## Overview

Scheduled tasks let you automate recurring agent workflows — PR
reviews, code linting, status summaries, dependency checks, etc.
The daemon evaluates cron expressions and spawns CLI processes on
schedule.

## Creating Tasks

### Via Dashboard

1. Open the Signet dashboard (http://localhost:3850)
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

## Cron Expressions

Standard 5-field cron syntax: `minute hour day-of-month month day-of-week`

### Presets

| Preset | Expression |
|--------|-----------|
| Every 15 min | `*/15 * * * *` |
| Hourly | `0 * * * *` |
| Daily 9am | `0 9 * * *` |
| Weekly Mon 9am | `0 9 * * 1` |

Custom expressions are validated before saving.

## Execution Model

- The daemon polls every 15 seconds for due tasks
- Maximum 3 concurrent task processes
- Each run gets a unique ID and captures stdout/stderr
- Output is capped at 1MB per stream
- Default timeout: 10 minutes per task
- Tasks that are already running are skipped (no double-execution)
- On daemon restart, any in-progress runs are marked as failed

### Process Commands

- **Claude Code**: `claude --dangerously-skip-permissions -p "<prompt>"`
- **OpenCode**: `opencode -m "<prompt>"`

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
