#!/usr/bin/env bash
source /workspace/kit/pod/env.sh
S=/workspace/kit/state
STALL_MIN=${STALL_MIN:-120}; ARCHIVE_MIN=${ARCHIVE_MIN:-60}
exec 9> $S/watchdog.lock
flock -n 9 || { echo "watchdog already running"; exit 0; }
log() { echo "$(date -u +%FT%TZ) $*"; }
mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }
date +%s > $S/last_activity

archive_all() {
  [ "$WS_NETWORK" = 1 ] || return 0
  local ok=0 w
  for w in $WS_ROOT/*-ws; do
    [ -d "$w" ] || continue
    timeout 3600 bash /workspace/kit/pod/archive_ws.sh "$(basename "$w" -ws)" 9>&- || ok=1
  done
  [ $ok = 0 ] && date +%s > $S/last_archive
  return $ok
}

stop_one() {
  local r=$1 why=$2 pid pg
  log "stopping run $r ($why; resumable with --resume)"
  for pid in $(pgrep -f "runs/$r.cmd.sh"); do pg=$(ps -o pgid= -p "$pid" | tr -d ' '); [ -n "$pg" ] && kill -TERM -- "-$pg" 2>/dev/null; done
  for _ in $(seq 1 30); do pgrep -f "runs/$r.cmd.sh" >/dev/null || break; sleep 2; done
  for pid in $(pgrep -f "runs/$r.cmd.sh"); do pg=$(ps -o pgid= -p "$pid" | tr -d ' '); [ -n "$pg" ] && kill -KILL -- "-$pg" 2>/dev/null; done
  if grep -q signet-dreaming /workspace/runs/$r.meta; then
    others=0
    for a in /workspace/runs/*.active; do
      [ -e "$a" ] || continue; o=$(basename "$a" .active)
      [ "$o" != "$r" ] && grep -q signet-dreaming /workspace/runs/$o.meta && pgrep -f "runs/$o.cmd.sh" >/dev/null && others=1
    done
    [ $others = 0 ] && bash /workspace/kit/pod/stop_run.sh 9>&- > /dev/null 2>&1
  fi
  echo "{\"event\":\"exit\",\"t\":$(date +%s),\"rc\":\"$why\"}" >> /workspace/runs/$r.meta
  echo "$why" > /workspace/runs/$r.exit
  rm -f /workspace/runs/$r.active $S/deadline.$r
  date +%s > $S/last_activity
}

stop_pod() {
  echo "$(date -u +%FT%TZ) $1" > $S/autostop_reason
  if [ -f $S/no_autostop ]; then return; fi
  log "stopping pod: $1"
  if ! archive_all; then
    unfinished=0
    for w in $WS_ROOT/*-ws; do
      [ -d "$w" ] || continue; r=$(basename "$w" -ws)
      [ "$(cat /workspace/runs/$r.exit 2>/dev/null)" = 0 ] || unfinished=$((unfinished + 1))
    done
    skips=$(cat $S/stop_skips 2>/dev/null || echo 0)
    if [ "$unfinished" -gt 0 ] && [ "$skips" -lt 3 ]; then
      echo $((skips + 1)) > $S/stop_skips
      log "STOP SKIPPED ($((skips + 1))/3): a workspace archive failed and $unfinished unfinished run(s) still have their workspace only on the container disk, which a stop erases. Fix it, then: lme stop <name>"
      date -u +%FT%TZ > $S/stop_failed
      sleep 600
      return
    fi
    [ "$unfinished" -gt 0 ] && log "workspace archive still failing after 3 tries; stopping anyway to end the spend (unfinished runs will need a fresh start)"
  fi
  rm -f $S/stop_skips
  if runpodctl pod stop "$RUNPOD_POD_ID" 2>&1 || runpodctl stop pod "$RUNPOD_POD_ID" 2>&1; then rm -f $S/stop_failed; else
    log "STOP FAILED: runpodctl could not stop this pod; it keeps billing. Stop it with: lme stop <name>"
    date -u +%FT%TZ > $S/stop_failed
  fi
  sleep 600
}

liveness() {
  tail -n 1 /workspace/telemetry/telemetry.jsonl 2>/dev/null | python3 -c '
import json, sys, time, urllib.request
gen, busy = -1, 0
try:
    r = json.loads(sys.stdin.read())
    v = r.get("vllm", {})
    if time.time() - r["t"] > 120 or "error" in v:
        busy = 1
    else:
        gen = int(v.get("vllm:generation_tokens_total", 0))
        busy = int(v.get("vllm:num_requests_running", 0) > 0)
except Exception:
    busy = 1
for port in (8091, 8092, 8093, 8094):
    try:
        if json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/_proxy_stats", timeout=3)).get("inflight", 0) > 0:
            busy = 1
    except Exception:
        pass
print(gen, busy)
' 2>/dev/null || echo "-1 1"
}

last_gen=-1; gen_changed=$(date +%s)
log "watchdog up pod=${RUNPOD_POD_ID:-?} grace=${GRACE_MIN}m hold=${HOLD_AFTER_PULL_MIN}m idle_max=${IDLE_MAX_MIN}m stall=${STALL_MIN}m ws_network=$WS_NETWORK"
while true; do
  now=$(date +%s)
  active=0; signet_runs=""; pending=0; last_exit=0; newest_write=0
  for m in /workspace/runs/*.meta; do
    [ -e "$m" ] || continue
    r=$(basename "$m" .meta)
    if [ -f /workspace/runs/$r.active ]; then
      if pgrep -f "runs/$r.cmd.sh" >/dev/null; then
        active=$((active + 1))
        if grep -q signet-dreaming "$m"; then
          signet_runs="$signet_runs $r"
          for f in /workspace/runs/$r.log $WS_ROOT/$r-ws/agents/data/signet.db $WS_ROOT/$r-ws/agents/data/signet.db-wal; do
            t=$(mtime "$f"); [ "$t" -gt "$newest_write" ] && newest_write=$t
          done
        fi
        if [ -f $S/deadline.$r ] && [ $now -ge "$(cat $S/deadline.$r)" ]; then stop_one "$r" deadline; fi
        continue
      fi
      lost_at=$(tail -n 1 /workspace/telemetry/telemetry.jsonl 2>/dev/null | python3 -c "import json,sys;print(int(json.load(sys.stdin)['t']))" 2>/dev/null || echo $now)
      log "run $r marked active but its process is gone (pod restart?); marking lost at $lost_at"
      echo "{\"event\":\"exit\",\"t\":$lost_at,\"rc\":\"lost\"}" >> "$m"
      echo lost > /workspace/runs/$r.exit; touch -d "@$lost_at" /workspace/runs/$r.exit; rm -f /workspace/runs/$r.active $S/deadline.$r
    fi
    [ -f /workspace/runs/$r.exit ] || continue
    t=$(mtime /workspace/runs/$r.exit); [ $t -gt $last_exit ] && last_exit=$t
    if [ ! -f /workspace/runs/$r.collected ]; then
      log "run $r exited ($(cat /workspace/runs/$r.exit)); collecting"
      timeout 1800 bash /workspace/kit/pod/collect.sh "$r" > /workspace/logs/collect_$r.log 2>&1 9>&- && log "collected $r" || log "collect $r incomplete (see logs/collect_$r.log)"
    fi
    [ -f /workspace/runs/$r.pulled ] || pending=$((pending + 1))
  done

  read -r g busy <<< "$(liveness)"
  if [ $active -eq 0 ] || [ "$busy" = 1 ] || [ "$g" != "$last_gen" ]; then last_gen=$g; gen_changed=$now; fi

  if [ $active -gt 0 ]; then
    if [ -n "$signet_runs" ] && [ $((now - newest_write)) -ge $((STALL_MIN * 60)) ] && [ $((now - gen_changed)) -ge $((STALL_MIN * 60)) ]; then
      log "STALL: no generation, no in-flight model calls, and no run-log or database writes for ${STALL_MIN}m"
      for r in $signet_runs; do stop_one "$r" stalled; done
      continue
    fi
    if [ $((now - $(cat $S/last_archive 2>/dev/null || echo 0))) -ge $((ARCHIVE_MIN * 60)) ] && ! pgrep -f "[k]it/pod/archive_ws.sh" >/dev/null; then
      ( archive_all > /workspace/logs/archive.log 2>&1 ) 9>&- &
    fi
  else
    ref=$(cat $S/last_activity 2>/dev/null || echo $now); [ $last_exit -gt $ref ] && ref=$last_exit
    idle=$(( (now - ref) / 60 ))
    if [ $pending -gt 0 ]; then limit=$GRACE_MIN; why="runs finished; $pending not pulled (evidence is in /workspace/evidence)"
    elif [ $last_exit -gt 0 ]; then limit=${HOLD_AFTER_PULL_MIN:-10}; why="all runs finished and pulled"
    else limit=$IDLE_MAX_MIN; why="no run started"; fi
    [ $idle -ge $limit ] && stop_pod "$why; idle ${idle}m (limit ${limit}m)"
  fi
  echo "{\"t\":$now,\"active\":$active,\"unpulled\":$pending,\"last_exit\":$last_exit,\"stop_failed\":$([ -f $S/stop_failed ] && echo true || echo false)}" > $S/watchdog.json
  sleep 60
done
