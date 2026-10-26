#!/usr/bin/env bash
set -u
source /workspace/kit/pod/env.sh
run=$1
exec 8> /workspace/runs/$run.collect.lock
flock -w 1800 8 || { echo "another collect of $run is still running"; exit 1; }
[ -f /workspace/runs/$run.exit ] && kind=final || kind=partial
E=/workspace/evidence/$run; rm -rf "$E"; mkdir -p "$E"
fail=0
cp /workspace/runs/$run.{log,meta,exit,url,qids,cmd.sh} "$E/" 2>/dev/null
R=$SIGNET_DIR/memorybench/data/runs/$run
[ -d "$R" ] && { mkdir -p "$E/memorybench"; cp "$R"/*.json "$E/memorybench/" 2>/dev/null; [ -d "$R/results" ] && tar czf "$E/memorybench/results.tgz" -C "$R" results; }
DB=$WS_ROOT/$run-ws/agents/data/signet.db
if [ -f "$DB" ]; then
  python3 - "$DB" "$E/db_snapshot.db" <<'P'
import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=60)
dst = sqlite3.connect(sys.argv[2])
have = {r[0] for r in src.execute("select name from sqlite_master where type='table'")}
for t in ["dreaming_passes", "memories", "dreaming_evidence_consumption", "dreaming_history_nodes", "transcript_capture_jobs"]:
    if t not in have:
        continue
    cols = [r[1] for r in src.execute(f"pragma table_info({t})")]
    dst.execute(f"create table {t} ({','.join(cols)})")
    dst.executemany(f"insert into {t} values ({','.join('?' * len(cols))})", src.execute(f"select * from {t}"))
    print(t, dst.execute(f"select count(*) from {t}").fetchone()[0])
dst.commit()
P
  [ $? -eq 0 ] || { echo "DB snapshot failed"; fail=1; }
  find $WS_ROOT/$run-ws -path "*logs*" -name "*.log" -newer /workspace/runs/$run.meta 2>/dev/null | head -20 | while read f; do tail -c 2000000 "$f" > "$E/daemon_$(basename "$f")"; done
fi
SMD=/workspace/sm/$run
[ -d "$SMD" ] && cp /workspace/logs/supermemory_$run*.log /workspace/runs/$run.timeline "$E/" 2>/dev/null
cp -r /workspace/usage "$E/usage"
cp /workspace/telemetry/telemetry.jsonl "$E/" 2>/dev/null
for f in /workspace/logs/vllm_*.log; do [ -e "$f" ] && { head -300 "$f"; echo "..."; tail -300 "$f"; } > "$E/$(basename "$f")"; done
{ nvidia-smi; git -C $SIGNET_DIR log --oneline -1; cat /workspace/kit/state/config.env 2>/dev/null; } > "$E/environment.txt" 2>&1
python3 /workspace/kit/pod/tokens.py "$run" > "$E/tokens.txt" 2>&1
python3 /workspace/kit/pod/tokens.py "$run" --json > "$E/tokens.json" 2>/dev/null
T=/workspace/evidence/$run.tgz
tar czf "$T.tmp" -C /workspace/evidence "$run" && gzip -t "$T.tmp" || { echo "tar failed"; rm -f "$T.tmp"; exit 1; }
sha256sum "$T.tmp" | cut -d' ' -f1 > "$T.sha256.tmp" && mv "$T.tmp" "$T" && mv "$T.sha256.tmp" "$T.sha256" || exit 1
[ $fail = 0 ] || kind=partial
echo $kind > /workspace/evidence/$run.kind
[ $fail = 0 ] || { echo "collect incomplete (see above); not marking collected"; exit 1; }
[ $kind = final ] && [ -f /workspace/runs/$run.exit ] && [ ! -f /workspace/runs/$run.active ] && touch /workspace/runs/$run.collected
ls -la /workspace/evidence/$run.tgz
cat "$E/tokens.txt"
