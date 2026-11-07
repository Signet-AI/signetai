#!/usr/bin/env bash
set -u
source /workspace/kit/pod/env.sh
[ -f /workspace/.ready/ALL ] || { echo "bootstrap not finished: $(ls /workspace/.ready 2>/dev/null)"; exit 1; }
cd /workspace
date +%s > /workspace/kit/state/last_activity
pgrep -f "[k]it/pod/watchdog.sh" >/dev/null || setsid bash /workspace/kit/pod/watchdog.sh >> /workspace/logs/watchdog.log 2>&1 < /dev/null &
for p in $(pgrep -f "[v]llm serve|[u]sage_proxy.py|[k]it/pod/telemetry.py"); do kill $p 2>/dev/null; done
for i in $(seq 1 60); do pgrep -f "vllm serve|EngineCore" >/dev/null || break; sleep 2; done
tag=$(date -u +%Y%m%dT%H%M%S)
setsid bash -c '
  . "$VENV/bin/activate"
  export VLLM_LOGGING_LEVEL=INFO
  export TRITON_PTXAS_PATH=$VENV/lib/python3.12/site-packages/triton/backends/nvidia/bin/ptxas
  exec vllm serve "$MODEL_DIR" \
    --served-model-name "$SERVED_NAME" --host 127.0.0.1 --port $PORT_VLLM \
    --max-model-len "$MAX_LEN" --kv-cache-dtype "$KV_DTYPE" --gpu-memory-utilization "$GPU_MEM_UTIL" \
    --language-model-only --enable-prefix-caching --enable-prompt-tokens-details \
    --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_coder \
    --max-num-seqs 256 --max-num-batched-tokens 16384 \
    --speculative-config "{\"method\":\"mtp\",\"num_speculative_tokens\":$MTP_TOKENS}"
' > /workspace/logs/vllm_$tag.log 2>&1 < /dev/null &
ln -sf /workspace/logs/vllm_$tag.log /workspace/logs/vllm_current.log
echo "vLLM starting (log /workspace/logs/vllm_$tag.log)"
for i in $(seq 1 240); do curl -sf localhost:$PORT_VLLM/v1/models >/dev/null && break; sleep 5; done
curl -sf localhost:$PORT_VLLM/v1/models >/dev/null || { echo "VLLM_FAILED"; tail -40 /workspace/logs/vllm_$tag.log; exit 1; }
grep -a "GPU KV cache size\|Maximum concurrency" /workspace/logs/vllm_$tag.log | tail -2

P="$VENV/bin/python /workspace/kit/pod/usage_proxy.py --upstream http://127.0.0.1:$PORT_VLLM --log-dir /workspace/usage"
start_proxy() { setsid $P "$@" > /workspace/logs/proxy_$2.log 2>&1 < /dev/null & }
start_proxy --tag signet-dream --port $PORT_SIGNET_DREAM
start_proxy --tag signet-qa --port $PORT_SIGNET_QA
start_proxy --tag supermemory-extract --port $PORT_SM_EXTRACT --think-budget "$DREAM_THINK" --force-model "$SERVED_NAME"
start_proxy --tag supermemory-qa --port $PORT_SM_QA
sleep 3
for p in $PORT_SIGNET_DREAM $PORT_SIGNET_QA $PORT_SM_EXTRACT $PORT_SM_QA; do
  curl -sf localhost:$p/_proxy_stats >/dev/null || { echo "PROXY_FAILED port $p"; exit 1; }
done
setsid python3 /workspace/kit/pod/telemetry.py /workspace/telemetry/telemetry.jsonl 10 /workspace/daemon_url > /workspace/logs/telemetry.log 2>&1 < /dev/null &
date +%s > /workspace/kit/state/last_activity
echo "SERVING: vLLM :$PORT_VLLM, proxies :$PORT_SIGNET_DREAM signet-dream :$PORT_SIGNET_QA signet-qa :$PORT_SM_EXTRACT supermemory-extract :$PORT_SM_QA supermemory-qa"
"$VENV/bin/python" /workspace/kit/pod/smoke.py
