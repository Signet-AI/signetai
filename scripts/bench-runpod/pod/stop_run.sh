#!/usr/bin/env bash
pids() { pgrep -f "bench-memory.ts|src/index.ts run -j|platform/daemon/src/daemon.ts|db-owner-worker.ts"; }
for p in $(pgrep -f "bench-memory.ts|src/index.ts run -j"); do kill $p; done
sleep 3
for p in $(pgrep -f "platform/daemon/src/daemon.ts"); do kill $p; done
for i in $(seq 1 60); do sleep 1; [ -z "$(pids)" ] && break; done
left=$(pids)
[ -n "$left" ] && { echo "force-killing $left"; kill -9 $left; sleep 2; }
for f in /workspace/runs/*.active; do
  [ -e "$f" ] || continue
  r=$(basename "$f" .active)
  grep -q signet-dreaming /workspace/runs/$r.meta 2>/dev/null || continue
  echo stopped > /workspace/runs/$r.exit; rm -f "$f"
done
echo "remaining signet processes: $(pids | wc -l)"
