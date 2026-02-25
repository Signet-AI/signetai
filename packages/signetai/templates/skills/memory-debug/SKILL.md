---
name: memory-debug
description: Diagnose and fix Signet memory issues (daemon health, embeddings, search quality, and data integrity).
user_invocable: true
arg_hint: "[symptom or query]"
builtin: true
---

# /memory-debug

Debug the Signet memory system when recall quality is poor, memories are missing, or remember/recall commands fail.

Use this skill when the user asks things like:
- "memory is broken"
- "recall isn't finding anything"
- "remember didn't save"
- "why are results low quality?"

## syntax

```bash
/memory-debug
/memory-debug recall is empty
/memory-debug embeddings failing
```

## workflow

Run these checks in order and stop when you find the root cause.

### 1) verify daemon + config

```bash
signet status
curl -s http://localhost:3850/health
```

If daemon is down or unresponsive, restart it:

```bash
# preferred: CLI commands
signet start          # start if not running
signet restart        # stop + start (graceful)

# if CLI restart doesn't work, kill and restart manually
signet stop
pkill -f "signet.*daemon"   # force kill if stop hangs
signet start

# if installed as a system service (launchd on macOS, systemd on Linux)
# macOS:
launchctl kickstart -k gui/$(id -u)/com.signet.daemon
# Linux:
systemctl --user restart signet-daemon
```

After restart, confirm daemon is healthy:

```bash
signet status
curl -s http://localhost:3850/health
```

Then verify key files exist:
- `~/.agents/agent.yaml`
- `~/.agents/memory/memories.db`

### 2) verify write path (`remember`)

```bash
signet remember "memory-debug smoke test" -t debug,smoke -w claude-code
```

Expected: success response with `embedded: true` or a clear fallback message.

If save fails, capture exact CLI error and recommend the fix (daemon restart, permissions, missing config, etc.).

### 3) verify read path (`recall`)

```bash
signet recall "memory-debug smoke test" -l 5 --json
```

If no results:
- retry with simpler keyword query
- check `search.min_score` and `search.alpha` in `~/.agents/agent.yaml`
- confirm the memory was actually written in step 2

### 4) check embedding health

If memories save but semantic recall is weak:

```bash
signet recall "memory-debug smoke test" --json
```

Inspect whether scores are keyword-heavy and whether embedding appears unavailable.

Then verify embedding provider configuration in `~/.agents/agent.yaml`:
- `embedding.provider`
- `embedding.model`
- `embedding.dimensions`

Common fixes:
- provider offline (Ollama/OpenAI unreachable)
- wrong model name
- dimensions mismatch after model change

### 5) advanced diagnostics

Check daemon logs for hook and memory errors:

```bash
signet logs -c hooks
signet logs -c memory
```

Use direct API checks for deeper issues:

```bash
curl -s "http://localhost:3850/api/memory/search?q=debug&limit=5"
curl -s http://localhost:3850/api/status
```

## response format

When reporting back, include:
1. what failed
2. exact command + error
3. likely root cause
4. concrete fix steps
5. verification command to confirm fix

Prefer minimal, reproducible checks over broad speculation.
