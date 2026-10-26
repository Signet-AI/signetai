#!/usr/bin/env bash
set -u
source /workspace/kit/pod/env.sh
run=$1; shift
conc=$DREAM_CONC; sel=(); resume=0; hours=""
case " $* " in *" --resume "*) qids_keep=1 ;; *) qids_keep=0; rm -f /workspace/runs/$run.qids ;; esac
while [ $# -gt 0 ]; do
  case $1 in
    --full) sel=(); shift ;;
    --sample) sel=(-s "$2" --sample-type consecutive); shift 2 ;;
    --limit) sel=(-l "$2"); shift 2 ;;
    --shard)
      i=${2%/*}; n=${2#*/}
      [[ "$i" =~ ^[0-9]+$ && "$n" =~ ^[0-9]+$ ]] && [ "$i" -ge 1 ] && [ "$i" -le "$n" ] || { echo "bad shard $2 (want I/N with 1 <= I <= N)"; exit 2; }
      [ $qids_keep = 1 ] || awk -v i="$i" -v n="$n" 'NF && (NR-1) % n == i-1' /workspace/kit/state/qids_all.txt > /workspace/runs/$run.qids
      sel=(--question-ids-file /workspace/runs/$run.qids); shift 2 ;;
    --ids) [ $qids_keep = 1 ] || cp "$2" /workspace/runs/$run.qids || exit 2; sel=(--question-ids-file /workspace/runs/$run.qids); shift 2 ;;
    --max-hours) hours=$2; shift 2 ;;
    --resume) resume=1; shift ;;
    --dream-conc) conc=$2; shift 2 ;;
    *) echo "unknown arg $1"; exit 2 ;;
  esac
done
if [ $resume = 1 ] && [ ${#sel[@]} -gt 0 ]; then echo "a resumed run keeps the questions it started with; drop the selection"; exit 2; fi
if [ ${#sel[@]} -gt 0 ] && [ "${sel[0]}" = --question-ids-file ] && [ ! -s /workspace/runs/$run.qids ]; then echo "empty question id list; refusing (an empty filter could run all 500)"; exit 2; fi
curl -sf localhost:$PORT_SIGNET_DREAM/v1/models >/dev/null || { echo "inference stack not serving; run serve first"; exit 1; }
pgrep -f "runs/$run.cmd.sh" >/dev/null && { echo "run $run already active"; exit 1; }
phase=(--concurrency-ingest 32 --concurrency-indexing 32 --concurrency-search 128 --concurrency-answer 256 --concurrency-evaluate 256)
if [ $resume = 1 ]; then
  if [ ! -d $WS_ROOT/$run-ws ] && [ -f /workspace/evidence/${run}_ws.tgz ]; then
    echo "restoring $run workspace from /workspace/evidence/${run}_ws.tgz"; tar xzf /workspace/evidence/${run}_ws.tgz -C $WS_ROOT
  fi
  [ -d $WS_ROOT/$run-ws ] || { echo "no workspace for $run"; exit 1; }
  args=(--resume run -r "$run" "${phase[@]}")
else
  [ -e $WS_ROOT/$run-ws ] || [ -e /workspace/runs/$run.meta ] || [ -e /workspace/evidence/$run.tgz ] && { echo "run $run exists; use --resume or a new run id"; exit 1; }
  rm -rf "$SIGNET_DIR/memorybench/data/runs/$run"
  args=(run "${sel[@]}" "${phase[@]}")
fi
rm -f /workspace/runs/$run.exit /workspace/runs/$run.collected /workspace/runs/$run.pulled
nq=$( [ -f /workspace/runs/$run.qids ] && wc -l < /workspace/runs/$run.qids || { [ ${#sel[@]} -eq 0 ] && [ $resume = 0 ] && echo 500 || echo "?"; })
[ $resume = 1 ] && redir=">>" || redir=">"
eval "cat $redir /workspace/runs/$run.meta" <<EOF
{"run":"$run","system":"signet-dreaming","start":$(date +%s),"resume":$resume,"dream_conc":$conc,"selection":"${sel[*]}","questions_in_ids_file":"$nq","commit":"$(git -C $SIGNET_DIR rev-parse --short HEAD)","ref":"$SIGNET_REF","gpu":"$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)","cost_per_hr":$COST_PER_HR,"pod":"${RUNPOD_POD_ID:-}"}
EOF
date +%s > /workspace/kit/state/last_activity
if [ -n "$hours" ]; then echo $(( $(date +%s) + $(python3 -c "print(int(float('$hours')*3600))") )) > /workspace/kit/state/deadline.$run; echo "deadline: ${hours}h"
else rm -f /workspace/kit/state/deadline.$run; fi
cat > /workspace/runs/$run.cmd.sh <<EOF
touch /workspace/runs/$run.active
source /workspace/kit/pod/env.sh
cd $SIGNET_DIR
export SIGNET_BENCH_DREAMING_MODEL=$SERVED_NAME
export SIGNET_BENCH_DREAMING_ENDPOINT=http://127.0.0.1:$PORT_SIGNET_DREAM/v1
export SIGNET_BENCH_DREAMING_PROVIDER_FAMILY=openai-compatible
export SIGNET_BENCH_DREAMING_CONCURRENCY=$conc
export SIGNET_BENCH_DREAMING_TIMEOUT_MS=$DREAM_TIMEOUT_MS
export SIGNET_BENCH_DREAMING_MAX_OUTPUT_TOKENS=16384
export SIGNET_BENCH_DREAMING_THINKING='{"format":"chat-template","budgetTokens":$DREAM_THINK,"budgetField":"thinking_token_budget","chatTemplateKwargs":{"enable_thinking":{"\$var":"thinking.enabled"},"preserve_thinking":false}}'
export SIGNET_BENCH_ANSWERING_MODEL=local:$SERVED_NAME
export SIGNET_BENCH_JUDGE=local:$SERVED_NAME
export LOCAL_LLM_BASE_URL=http://127.0.0.1:$PORT_SIGNET_QA/v1
export MEMORYBENCH_LOCAL_REASONING_EFFORT=low
export MEMORYBENCH_LOCAL_MAX_TOKENS=16000
export MEMORYBENCH_LOCAL_THINKING_BUDGET=$QA_THINK
export MEMORYBENCH_SESSION_CONCURRENCY=4
export SIGNET_BENCH_SKIP_BUILD=1
export SIGNET_BENCH_RUN_ID=$run
export SIGNET_BENCH_KEEP_WORKSPACE=1
export SIGNET_BENCH_DREAMING_WAIT_SECS=604800
export SIGNET_BENCH_CAPTURE_WAIT_SECS=28800
export SIGNET_BENCH_REQUEST_TIMEOUT_MS=300000
bun scripts/bench-memory.ts --workspace $WS_ROOT/$run-ws $(printf '%q ' "${args[@]}")
rc=\$?
echo "{\\"event\\":\\"exit\\",\\"t\\":\$(date +%s),\\"rc\\":\\"\$rc\\"}" >> /workspace/runs/$run.meta
echo \$rc > /workspace/runs/$run.exit
rm -f /workspace/runs/$run.active /workspace/kit/state/deadline.$run
EOF
setsid bash /workspace/runs/$run.cmd.sh >> /workspace/runs/$run.log 2>&1 < /dev/null &
for i in $(seq 1 60); do
  sleep 3
  u=$(grep -a -o "http://127.0.0.1:[0-9]*" /workspace/runs/$run.log | grep -v ":$PORT_SIGNET_DREAM\|:$PORT_SIGNET_QA\|:$PORT_VLLM" | tail -1)
  [ -n "$u" ] && { echo "$u" > /workspace/runs/$run.url; echo "$u" > /workspace/daemon_url; break; }
  [ -f /workspace/runs/$run.exit ] && break
done
echo "launched $run (dream conc $conc, $nq ids) daemon=$(cat /workspace/runs/$run.url 2>/dev/null)"
grep -a "Z\] " /workspace/runs/$run.log | tail -4 | cut -c1-200
