#!/usr/bin/env bash
set -u
source /workspace/kit/pod/env.sh
run=$1; shift
sel=()
case ${1:-} in
  --sample) sel=(-s "$2" --sample-type consecutive) ;;
  --shard) i=${2%/*}; n=${2#*/}; [[ "$i" =~ ^[0-9]+$ && "$n" =~ ^[0-9]+$ ]] && [ "$i" -ge 1 ] && [ "$i" -le "$n" ] || { echo "bad shard $2"; exit 2; }; awk -v i="$i" -v n="$n" 'NF && (NR-1) % n == i-1' /workspace/kit/state/qids_all.txt > /workspace/runs/$run.qids; sel=(--question-ids-file /workspace/runs/$run.qids) ;;
  --ids) cp "$2" /workspace/runs/$run.qids; sel=(--question-ids-file /workspace/runs/$run.qids) ;;
  *) echo "selection required: --sample K | --shard I/N | --ids FILE"; exit 2 ;;
esac
sample=0; [ "${sel[0]}" = -s ] && sample=${sel[1]}
docs=$(python3 - "$SIGNET_DIR/memorybench/data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json" "/workspace/runs/$run.qids" "$sample" <<'P'
import collections, json, os, sys
qs = json.load(open(sys.argv[1])); k = int(sys.argv[3])
if k:  # memorybench --sample K --sample-type consecutive: first K questions of each type
    seen, pick = collections.Counter(), []
    for q in qs:
        if seen[q["question_type"]] < k:
            seen[q["question_type"]] += 1; pick.append(q)
else:
    ids = set(open(sys.argv[2]).read().split()) if os.path.exists(sys.argv[2]) else set()
    pick = [q for q in qs if q["question_id"] in ids]
print(sum(len(q["haystack_session_ids"]) for q in pick) if pick else "")
P
)
[[ "$docs" =~ ^[0-9]+$ ]] || { echo "could not size the selection (docs='$docs'); refusing"; exit 2; }
[ "$docs" -gt 9500 ] && { echo "selection needs $docs documents; Supermemory Lite caps at 10,000"; exit 2; }
echo "selection: $docs documents"
curl -sf localhost:$PORT_SM_EXTRACT/_proxy_stats >/dev/null || { echo "proxies not running; run serve first"; exit 1; }
[ -x /root/.supermemory/bin/supermemory-server ] || { curl -fsSL https://supermemory.ai/install -o /tmp/sm_install.sh && bash /tmp/sm_install.sh "$SM_VERSION" < /dev/null; }
[ -e /workspace/runs/$run.meta ] && { echo "run $run exists; pick a new run id"; exit 1; }
rm -f /workspace/runs/$run.exit /workspace/runs/$run.collected /workspace/runs/$run.pulled
date +%s > /workspace/kit/state/last_activity
echo "{\"run\":\"$run\",\"system\":\"supermemory\",\"documents\":$docs,\"start\":$(date +%s),\"selection\":\"${sel[*]}\",\"sm_version\":\"$SM_VERSION\",\"cost_per_hr\":$COST_PER_HR,\"pod\":\"${RUNPOD_POD_ID:-}\"}" >> /workspace/runs/$run.meta
cat > /workspace/runs/$run.cmd.sh <<EOF
touch /workspace/runs/$run.active
source /workspace/kit/pod/env.sh
T=/workspace/runs/$run.timeline
stamp() { echo "\$(date -u +%FT%TZ) \$*" >> \$T; }
calls() { curl -sf localhost:$PORT_SM_EXTRACT/_proxy_stats | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['paths'].get('/v1/chat/completions',0), d.get('inflight',0))" 2>/dev/null || echo "err err"; }
pkill -f supermemory-server; for i in \$(seq 1 30); do ss -ltn | grep -q ":6767 " || break; sleep 1; done
mkdir -p /workspace/sm/$run
SUPERMEMORY_DATA_DIR=/workspace/sm/$run OPENAI_BASE_URL=http://127.0.0.1:$PORT_SM_EXTRACT/v1 OPENAI_API_KEY=local OPENAI_MODEL=$SERVED_NAME \\
  SUPERMEMORY_INGEST_CONCURRENCY=8 SUPERMEMORY_EMBEDDING_RAM_LIMIT=32gb SUPERMEMORY_LOCAL_EMBEDDING_POOL_SIZE=8 SUPERMEMORY_LOCAL_EMBEDDING_WASM_THREADS=4 \\
  SUPERMEMORY_DISABLE_TELEMETRY=1 SUPERMEMORY_NO_UPDATE_CHECK=1 SUPERMEMORY_NO_OPEN=1 \\
  setsid /root/.supermemory/bin/supermemory-server > /workspace/logs/supermemory_${run}_server.log 2>&1 < /dev/null &
for i in \$(seq 1 60); do curl -sf localhost:6767/v3/health >/dev/null && break; sleep 3; done
stamp "server up"
cd $SIGNET_DIR/memorybench
export SUPERMEMORY_API_KEY=\$(cat /workspace/sm/$run/api-key) SUPERMEMORY_BASE_URL=http://127.0.0.1:6767 LOCAL_LLM_BASE_URL=http://127.0.0.1:$PORT_SM_QA/v1
export MEMORYBENCH_LOCAL_REASONING_EFFORT=low MEMORYBENCH_LOCAL_MAX_TOKENS=16000 MEMORYBENCH_LOCAL_THINKING_BUDGET=$QA_THINK
read c0 _ <<< "\$(calls)"; stamp "ingest start (extract calls so far \$c0)"
bun src/index.ts ingest -p supermemory -b longmemeval -r $run $(printf '%q ' "${sel[@]}") --concurrency-ingest 8 --concurrency-indexing 8 >> /workspace/runs/$run.log 2>&1
stamp "ingest+indexing exit=\$? (documents report done)"
prev=-1; quiet=0
while [ \$quiet -lt 5 ]; do
  sleep 60; read n inflight <<< "\$(calls)"
  if [ "\$n" != err ] && [ "\$n" = "\$prev" ] && [ "\$inflight" = 0 ]; then quiet=\$((quiet+1)); else quiet=0; fi; prev=\$n
  stamp "extraction: calls=\$n inflight=\$inflight quiet_min=\$quiet"
done
stamp "extraction settled: calls=\$((prev-c0)) since ingest start"
bun src/index.ts run -r $run -m local:$SERVED_NAME -j local:$SERVED_NAME --concurrency-search 16 --concurrency-answer 16 --concurrency-evaluate 16 >> /workspace/runs/$run.log 2>&1
rc=\$?
stamp "search/answer/evaluate exit=\$rc"
pkill -f supermemory-server
echo "{\\"event\\":\\"exit\\",\\"t\\":\$(date +%s),\\"rc\\":\\"\$rc\\"}" >> /workspace/runs/$run.meta
echo \$rc > /workspace/runs/$run.exit
rm -f /workspace/runs/$run.active
EOF
setsid bash /workspace/runs/$run.cmd.sh >> /workspace/runs/$run.log 2>&1 < /dev/null &
sleep 20
echo "launched supermemory run $run"; cat /workspace/runs/$run.timeline 2>/dev/null
