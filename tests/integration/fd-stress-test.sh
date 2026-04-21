#!/usr/bin/env bash
set -euo pipefail
BASE="http://127.0.0.1:3850"
HDRS='-H "Content-Type: application/json" -H "x-signet-harness: opencode" -H "x-signet-runtime-path: plugin"'

pstats() {
  sort -n | awk '{a[NR]=$1; sum+=$1} END {
    if(NR==0){print "  NO DATA"; exit}
    printf "  n=%-4d min=%.4fs  p50=%.4fs  p90=%.4fs  p95=%.4fs  p99=%.4fs  max=%.4fs  avg=%.4fs\n",
      NR, a[1], a[int(NR*0.5)+1], a[int(NR*0.9)+1], a[int(NR*0.95)+1], a[int(NR*0.99)+1], a[NR], sum/NR
  }'
}

echo "=== BASELINE FDs ==="
curl -s $BASE/health | python3 -c "import json,sys; d=json.load(sys.stdin); r=d['resources']; print(f'  total={r[\"total\"]} memoryMd={r[\"memoryMd\"]} sockets={r[\"sockets\"]} db={r[\"db\"]} RSS={r[\"rss\"]}MB heap={r[\"heapUsed\"]}MB uptime={d[\"uptime\"]:.0f}s')"
echo ""

# 1) Health
echo "=== /health (100 seq) ==="
for i in $(seq 1 100); do
  curl -s $BASE/health -o /dev/null -w "%{time_total}\n"
done | pstats

# 2) Memory search
echo "=== /memory/search (100 seq) ==="
queries=("session summary" "pipeline extraction" "knowledge graph" "memory artifact" "daemon config" "file watcher" "chokidar ignore" "sqlite fts5" "identity soul" "agent yaml")
for i in $(seq 1 100); do
  q="${queries[$((i % 10))]}"
  curl -s -X POST $BASE/memory/search -H 'Content-Type: application/json' -d "{\"query\":\"$q\",\"limit\":5}" -o /dev/null -w "%{time_total}\n"
done | pstats

# 3) Config
echo "=== /api/config (100 seq) ==="
for i in $(seq 1 100); do
  curl -s $BASE/api/config -o /dev/null -w "%{time_total}\n"
done | pstats

# 4) Session-start hook
echo "=== /api/hooks/session-start (20 seq) ==="
for i in $(seq 1 20); do
  curl -s -X POST $BASE/api/hooks/session-start \
    -H 'Content-Type: application/json' -H 'x-signet-harness: opencode' \
    -H "x-signet-session-key: stress-a-$i" -H 'x-signet-runtime-path: plugin' \
    -d "{\"sessionKey\":\"stress-a-$i\",\"agentId\":\"default\",\"project\":\"/tmp/stress\",\"harness\":\"opencode\"}" \
    -o /dev/null -w "%{time_total}\n"
done | pstats

# 5) Checkpoint extract
echo "=== /api/hooks/session-checkpoint-extract (30 seq) ==="
for i in $(seq 1 30); do
  sid="stress-a-$((i % 20 + 1))"
  curl -s -X POST $BASE/api/hooks/session-checkpoint-extract \
    -H 'Content-Type: application/json' -H 'x-signet-harness: opencode' \
    -H "x-signet-session-key: $sid" -H 'x-signet-runtime-path: plugin' \
    -d "{\"sessionKey\":\"$sid\",\"agentId\":\"default\",\"harness\":\"opencode\",\"messages\":[{\"role\":\"user\",\"content\":\"stress test extraction message $i with enough content to trigger pipeline processing and entity extraction\"},{\"role\":\"assistant\",\"content\":\"This is a synthetic response for stress testing the extraction pipeline under load with the FD fix applied.\"}]}" \
    -o /dev/null -w "%{time_total}\n"
done | pstats

# 6) Synthesis request
echo "=== /api/hooks/synthesis (20 seq) ==="
for i in $(seq 1 20); do
  curl -s -X POST $BASE/api/hooks/synthesis \
    -H 'Content-Type: application/json' -H 'x-signet-harness: opencode' \
    -H 'x-signet-session-key: stress-synth-1' \
    -d '{"agentId":"default","sessionKey":"stress-synth-1"}' \
    -o /dev/null -w "%{time_total}\n"
done | pstats

# 7) Synthesis status
echo "=== /api/synthesis/status (50 seq) ==="
for i in $(seq 1 50); do
  curl -s $BASE/api/synthesis/status -o /dev/null -w "%{time_total}\n"
done | pstats

# 8) Synthesis trigger
echo "=== /api/synthesis/trigger (5 seq) ==="
for i in $(seq 1 5); do
  curl -s -X POST $BASE/api/synthesis/trigger \
    -H 'Content-Type: application/json' \
    -o /dev/null -w "%{time_total}\n"
done | pstats

# 9) Recall hook
echo "=== /api/hooks/recall (30 seq) ==="
for i in $(seq 1 30); do
  sid="stress-a-$((i % 20 + 1))"
  curl -s -X POST $BASE/api/hooks/recall \
    -H 'Content-Type: application/json' -H 'x-signet-harness: opencode' \
    -H "x-signet-session-key: $sid" -H 'x-signet-runtime-path: plugin' \
    -d "{\"sessionKey\":\"$sid\",\"agentId\":\"default\",\"harness\":\"opencode\",\"query\":\"stress test recall query number $i\"}" \
    -o /dev/null -w "%{time_total}\n"
done | pstats

echo ""
echo "=== POST-PIPELINE FDs ==="
curl -s $BASE/health | python3 -c "import json,sys; d=json.load(sys.stdin); r=d['resources']; print(f'  total={r[\"total\"]} memoryMd={r[\"memoryMd\"]} sockets={r[\"sockets\"]} db={r[\"db\"]} RSS={r[\"rss\"]}MB heap={r[\"heapUsed\"]}MB uptime={d[\"uptime\"]:.0f}s')"

echo ""
echo "=== MIXED RANDOM LOAD (100 requests, random endpoint) ==="
tmpfile=$(mktemp)
for i in $(seq 1 100); do
  r=$((RANDOM % 7))
  case $r in
    0) curl -s $BASE/health -o /dev/null -w "health %{time_total}\n" >> "$tmpfile" & ;;
    1) curl -s -X POST $BASE/memory/search -H 'Content-Type: application/json' -d '{"query":"random stress","limit":3}' -o /dev/null -w "search %{time_total}\n" >> "$tmpfile" & ;;
    2) curl -s $BASE/api/config -o /dev/null -w "config %{time_total}\n" >> "$tmpfile" & ;;
    3) curl -s -X POST $BASE/api/hooks/session-checkpoint-extract \
         -H 'Content-Type: application/json' -H 'x-signet-harness: opencode' \
         -H "x-signet-session-key: stress-a-$((i%20+1))" -H 'x-signet-runtime-path: plugin' \
         -d "{\"sessionKey\":\"stress-a-$((i%20+1))\",\"agentId\":\"default\",\"harness\":\"opencode\",\"messages\":[{\"role\":\"user\",\"content\":\"mixed load extraction $i\"}]}" \
         -o /dev/null -w "extract %{time_total}\n" >> "$tmpfile" & ;;
    4) curl -s -X POST $BASE/api/hooks/synthesis \
         -H 'Content-Type: application/json' -H 'x-signet-session-key: stress-synth-1' \
         -d '{"agentId":"default","sessionKey":"stress-synth-1"}' \
         -o /dev/null -w "synthesis %{time_total}\n" >> "$tmpfile" & ;;
    5) curl -s $BASE/api/synthesis/status -o /dev/null -w "synth-status %{time_total}\n" >> "$tmpfile" & ;;
    6) curl -s -X POST $BASE/api/hooks/recall \
         -H 'Content-Type: application/json' -H 'x-signet-harness: opencode' \
         -H "x-signet-session-key: stress-a-$((i%20+1))" -H 'x-signet-runtime-path: plugin' \
         -d "{\"sessionKey\":\"stress-a-$((i%20+1))\",\"agentId\":\"default\",\"harness\":\"opencode\",\"query\":\"mixed recall $i\"}" \
         -o /dev/null -w "recall %{time_total}\n" >> "$tmpfile" & ;;
  esac
done
wait

# Per-endpoint breakdown from mixed
for ep in health search config extract synthesis synth-status recall; do
  cnt=$(grep "^$ep " "$tmpfile" | wc -l)
  if [ "$cnt" -gt 0 ]; then
    echo "  [$ep] (n=$cnt):"
    grep "^$ep " "$tmpfile" | awk '{print $2}' | sort -n | awk '{a[NR]=$1; sum+=$1} END {
      printf "    min=%.4fs  p50=%.4fs  p95=%.4fs  max=%.4fs  avg=%.4fs\n",
        a[1], a[int(NR*0.5)+1], a[int(NR*0.95)+1], a[NR], sum/NR
    }'
  fi
done
rm "$tmpfile"

echo ""
echo "=== FINAL FDs ==="
curl -s $BASE/health | python3 -c "import json,sys; d=json.load(sys.stdin); r=d['resources']; print(f'  total={r[\"total\"]} memoryMd={r[\"memoryMd\"]} sockets={r[\"sockets\"]} db={r[\"db\"]} RSS={r[\"rss\"]}MB heap={r[\"heapUsed\"]}MB uptime={d[\"uptime\"]:.0f}s')"
