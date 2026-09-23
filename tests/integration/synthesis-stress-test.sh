#!/usr/bin/env bash
# synthesis-stress-test.sh
# Stress test: prove synthesis worker thread does NOT block the event loop.
#
# Protocol:
#   1. Start daemon on port 3851 with a known-good temp workspace
#   2. Fire 5 concurrent POST /api/hooks/synthesis requests (background)
#   3. While synthesis runs, fire 10 sequential /health requests with timing
#   4. Report: health p50/p95/max (must all be < 100ms), synthesis times, FD delta
set -uo pipefail

BASE="http://127.0.0.1:3851"
# Use existing workspace — fresh workspaces fail migration (Bun/SQLite compat issue)
WORKSPACE="/tmp/signet-t5-test-workspace"
WORKTREE="$(cd "$(dirname "$0")/../.." && pwd)"
LOG=$(mktemp /tmp/signet-stress-daemon.XXXXXX.log)
SCRATCH=$(mktemp -d /tmp/signet-stress.XXXXXX)
DAEMON_PID=""

cleanup() {
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    sleep 0.5
    kill -9 "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$SCRATCH" "$LOG"
}
trap cleanup EXIT

# Kill anything already on 3851
existing=$(lsof -ti tcp:3851 2>/dev/null || true)
if [[ -n "$existing" ]]; then
  echo "Killing existing process on port 3851 (PID=$existing)"
  kill "$existing" 2>/dev/null || true
  sleep 1
fi

echo "==================================================================="
echo "SYNTHESIS WORKER THREAD STRESS TEST"
echo "Branch: ostico/fd-diagnostic"
echo "Date:   $(date -u +%Y-%m-%dT%H:%M:%S+00:00)"
echo "Port:   3851"
echo "Workspace: $WORKSPACE"
echo "Worktree:  $WORKTREE"
echo "==================================================================="
echo ""

# -- 1. Start daemon -------------------------------------------------------
SIGNET_PATH="$WORKSPACE" SIGNET_PORT=3851 SIGNET_BIND=127.0.0.1 \
  bun run "$WORKTREE/platform/daemon/src/daemon.ts" >"$LOG" 2>&1 &
DAEMON_PID=$!
echo "Daemon started (PID=$DAEMON_PID), waiting for healthy..."

# Poll /health every 500ms, max 30s
MAX_WAIT_ITERS=60
started=0
for i in $(seq 1 $MAX_WAIT_ITERS); do
  sleep 0.5
  h_status=$(curl -s --max-time 1 "$BASE/health" 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status','unknown'))" \
    2>/dev/null || echo "not_ready")
  if [[ "$h_status" == "healthy" ]]; then
    started=1
    echo "Daemon healthy after ~$((i / 2))s"
    break
  fi
done

if [[ "$started" -eq 0 ]]; then
  echo "FAIL: Daemon did not become healthy within 30s"
  echo "--- Daemon log (last 30 lines) ---"
  tail -30 "$LOG"
  exit 1
fi
echo ""

# -- 2. FD baseline --------------------------------------------------------
echo "=== FD BASELINE ==="
baseline_json=$(curl -s --max-time 2 "$BASE/health" 2>/dev/null || echo "{}")
baseline=$(echo "$baseline_json" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); r=d.get('resources',{}); print(r.get('total','N/A'))" \
  2>/dev/null || echo "N/A")
echo "FDs before stress: $baseline"
echo ""

# -- 3. Fire 5 concurrent synthesis requests in background -----------------
echo "=== FIRING 5 CONCURRENT SYNTHESIS REQUESTS ==="
mkdir -p "$SCRATCH/synth"

declare -a SYNTH_PIDS=()
for i in 1 2 3 4 5; do
  {
    t_start=$(date +%s%N)
    resp=$(curl -s --max-time 15 -X POST "$BASE/api/hooks/synthesis" \
      -H 'Content-Type: application/json' \
      -H 'x-signet-harness: opencode' \
      -H "x-signet-session-key: stress-synth-$i" \
      -d "{\"agentId\":\"default\",\"sessionKey\":\"stress-synth-$i\"}" \
      2>/dev/null || echo "{}")
    t_end=$(date +%s%N)
    elapsed_ms=$(( (t_end - t_start) / 1000000 ))
    has_prompt=$(echo "$resp" | python3 -c \
      "import json,sys; d=json.load(sys.stdin); print('yes' if d.get('prompt') else 'no')" \
      2>/dev/null || echo "error")
    echo "${elapsed_ms} ${has_prompt}" > "$SCRATCH/synth/synth-$i.txt"
  } &
  SYNTH_PIDS+=($!)
done

# Brief pause to ensure synthesis has started processing before health loop
sleep 0.3
echo "Synthesis requests in-flight, now measuring health latency..."
echo ""

# -- 4. Fire 10 sequential health requests while synthesis runs ------------
echo "=== HEALTH ENDPOINT TIMING (during concurrent synthesis) ==="
mkdir -p "$SCRATCH/health"

for i in $(seq 1 10); do
  t_start=$(date +%s%N)
  h_json=$(curl -s --max-time 2 "$BASE/health" 2>/dev/null || echo "{}")
  t_end=$(date +%s%N)
  elapsed_ms=$(( (t_end - t_start) / 1000000 ))
  h_status=$(echo "$h_json" | python3 -c \
    "import json,sys; d=json.load(sys.stdin); print(d.get('status','unknown'))" \
    2>/dev/null || echo "error")
  echo "$elapsed_ms $h_status" >> "$SCRATCH/health/times.txt"
done

# Wait only for the 5 synthesis jobs (not the daemon background process)
wait "${SYNTH_PIDS[@]}"

echo ""

# -- 5. Collect and report synthesis results --------------------------------
echo "=== SYNTHESIS RESULTS ==="
synth_ok=0
declare -a synth_times=()

for i in 1 2 3 4 5; do
  f="$SCRATCH/synth/synth-$i.txt"
  if [[ -f "$f" ]]; then
    read -r ms has_prompt < "$f"
    synth_times+=("$ms")
    if [[ "$has_prompt" == "yes" ]]; then
      synth_ok=$((synth_ok + 1))
      echo "  synth-$i: ${ms}ms  [OK - has prompt]"
    else
      echo "  synth-$i: ${ms}ms  [WARN - no prompt field]"
    fi
  else
    echo "  synth-$i: MISSING result file"
  fi
done

# Synth stats
if [[ ${#synth_times[@]} -gt 0 ]]; then
  sorted_synth=($(printf '%s\n' "${synth_times[@]}" | sort -n))
  n=${#sorted_synth[@]}
  s_p50=${sorted_synth[$((n / 2))]}
  s_p95=${sorted_synth[$((( n * 95 + 99) / 100 - 1))]}
  s_max=${sorted_synth[$((n - 1))]}
  echo ""
  echo "Synthesis: n=$n  p50=${s_p50}ms  p95=${s_p95}ms  max=${s_max}ms"
fi
echo ""

# -- 6. Report health timing results ----------------------------------------
echo "=== HEALTH ENDPOINT RESULTS ==="
declare -a health_times=()
healthy_count=0
total_count=0

if [[ -f "$SCRATCH/health/times.txt" ]]; then
  while IFS= read -r line; do
    ms=$(echo "$line" | awk '{print $1}')
    st=$(echo "$line" | awk '{print $2}')
    health_times+=("$ms")
    total_count=$((total_count + 1))
    if [[ "$st" == "healthy" ]]; then
      healthy_count=$((healthy_count + 1))
    fi
    echo "  health: ${ms}ms  [${st}]"
  done < "$SCRATCH/health/times.txt"
fi

# Health stats
if [[ ${#health_times[@]} -gt 0 ]]; then
  sorted_health=($(printf '%s\n' "${health_times[@]}" | sort -n))
  n=${#sorted_health[@]}
  h_p50=${sorted_health[$((n / 2))]}
  h_p95=${sorted_health[$((( n * 95 + 99) / 100 - 1))]}
  h_max=${sorted_health[$((n - 1))]}
  echo ""
  echo "Health:   n=$n  p50=${h_p50}ms  p95=${h_p95}ms  max=${h_max}ms"
  echo "Healthy:  $healthy_count/$total_count responded with status=healthy"
fi
echo ""

# -- 7. FD count after stress -----------------------------------------------
echo "=== FD AFTER STRESS ==="
final_json=$(curl -s --max-time 2 "$BASE/health" 2>/dev/null || echo "{}")
final_fds=$(echo "$final_json" | python3 -c \
  "import json,sys; d=json.load(sys.stdin); r=d.get('resources',{}); print(r.get('total','N/A'))" \
  2>/dev/null || echo "N/A")
echo "FDs after stress: $final_fds"
if [[ "$baseline" != "N/A" && "$final_fds" != "N/A" ]]; then
  delta=$((final_fds - baseline))
  echo "FD delta: $delta (baseline=$baseline final=$final_fds)"
fi
echo ""

# -- 8. Verdict -------------------------------------------------------------
echo "==================================================================="
echo "VERDICT"
echo "==================================================================="
pass=1

# Health < 100ms check
if [[ ${#sorted_health[@]} -gt 0 ]]; then
  if [[ "$h_max" -lt 100 ]]; then
    echo "  health_under_100ms:   PASS (max=${h_max}ms < 100ms threshold)"
  else
    echo "  health_under_100ms:   FAIL (max=${h_max}ms >= 100ms threshold)"
    pass=0
  fi
else
  echo "  health_under_100ms:   FAIL (no health timing data collected)"
  pass=0
fi

# Synthesis completion check
if [[ "$synth_ok" -ge 1 ]]; then
  echo "  synthesis_completed:  PASS ($synth_ok/5 returned prompt field)"
else
  echo "  synthesis_completed:  FAIL (0/5 returned prompt field)"
  pass=0
fi

# FD stability check
if [[ "$baseline" != "N/A" && "$final_fds" != "N/A" ]]; then
  delta=$((final_fds - baseline))
  if [[ "$delta" -le 100 ]]; then
    echo "  fd_stable:            PASS (delta=$delta <= 100 FD threshold)"
  else
    echo "  fd_stable:            WARN (delta=$delta > 100 — investigate)"
  fi
else
  echo "  fd_stable:            SKIP (could not read FD counts)"
fi

echo ""
if [[ "$pass" -eq 1 ]]; then
  echo "RESULT: PASS"
  echo "(Event loop not blocked — synthesis offloaded to dedicated worker thread)"
else
  echo "RESULT: FAIL"
  echo "See output above for details."
  exit 1
fi
