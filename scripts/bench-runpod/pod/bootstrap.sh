#!/usr/bin/env bash
set -u
source /workspace/kit/pod/env.sh
mkdir -p /workspace/{logs,models,hf,runs,evidence,usage,telemetry,.ready} /workspace/kit/state
exec >> /workspace/logs/bootstrap.log 2>&1
echo "=== bootstrap $(date -u +%FT%TZ) ref=$SIGNET_REF model=$MODEL_REPO"
date +%s > /workspace/kit/state/last_activity
pgrep -f "[k]it/pod/watchdog.sh" >/dev/null || setsid bash /workspace/kit/pod/watchdog.sh >> /workspace/logs/watchdog.log 2>&1 < /dev/null &
( while true; do date +%s > /workspace/kit/state/last_activity; sleep 300; done ) & KEEPALIVE=$!
trap 'kill $KEEPALIVE 2>/dev/null' EXIT
done_() { touch "/workspace/.ready/$1"; echo "READY $1 $(date -u +%T)"; }
is_done() { [ -f "/workspace/.ready/$1" ]; }

pip install -q uv "huggingface_hub[hf_transfer]" || true

step_model() {
  is_done model && return 0
  HF_HOME=/workspace/hf HF_HUB_ENABLE_HF_TRANSFER=1 hf download "$MODEL_REPO" --local-dir "$MODEL_DIR" > /workspace/logs/bootstrap_model.log 2>&1 \
    && done_ model || echo "FAILED model (see bootstrap_model.log)"
}

step_vllm() {
  is_done vllm && return 0
  (
    set -e
    [ -x "$VENV/bin/python" ] || uv venv --python 3.12 "$VENV"
    . "$VENV/bin/activate"
    grep -v '^triton==' /workspace/kit/pod/freeze.txt > /tmp/freeze-notriton.txt
    uv pip install -r /tmp/freeze-notriton.txt --extra-index-url https://download.pytorch.org/whl/cu129 --index-strategy unsafe-best-match
    uv pip install --no-deps triton==3.6.0
    uv pip uninstall torchcodec || true
    python -c "import vllm,torch,triton,aiohttp;print('vllm',vllm.__version__,'torch',torch.__version__,'triton',triton.__version__,torch.cuda.get_device_name(0))"
  ) > /workspace/logs/bootstrap_vllm.log 2>&1 && done_ vllm || echo "FAILED vllm (see bootstrap_vllm.log)"
}

step_signet() {
  is_done signet && return 0
  (
    set -e
    command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git)
    command -v sqlite3 >/dev/null || (apt-get update -qq && apt-get install -y -qq sqlite3) || true
    [ -x "$BUN_INSTALL/bin/bun" ] || curl -fsSL https://bun.sh/install | BUN_INSTALL=$BUN_INSTALL bash -s "bun-v1.4.2"
    [ -x "$CARGO_HOME/bin/cargo" ] || curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
    [ -d "$SIGNET_DIR/.git" ] || git clone --filter=blob:none https://github.com/Signet-AI/signetai.git "$SIGNET_DIR"
    cd "$SIGNET_DIR"
    git fetch -q origin "$SIGNET_REF" 2>/dev/null || git fetch -q origin
    git checkout -q -B bench FETCH_HEAD 2>/dev/null || git checkout -q -B bench "$SIGNET_REF"
    git log --oneline -1
    bun install
    (cd memorybench && bun install)
    bun run build
  ) > /workspace/logs/bootstrap_signet.log 2>&1 && done_ signet || echo "FAILED signet (see bootstrap_signet.log)"
}

step_dataset() {
  is_done dataset && return 0
  local d="$SIGNET_DIR/memorybench/data/benchmarks/longmemeval/datasets"
  mkdir -p "$d"
  [ -s "$d/longmemeval_s_cleaned.json" ] || curl -fsSL -o "$d/longmemeval_s_cleaned.json" \
    https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
  python3 - "$d/longmemeval_s_cleaned.json" <<'P' && done_ dataset || echo "FAILED dataset"
import json, sys
qs = json.load(open(sys.argv[1]))
assert len(qs) == 500, len(qs)
open("/workspace/kit/state/qids_all.txt", "w").write("\n".join(q["question_id"] for q in qs) + "\n")
print("dataset ok:", len(qs), "questions,", sum(len(q["haystack_session_ids"]) for q in qs), "sessions")
P
}

step_model & A=$!
step_vllm & B=$!
step_signet && step_dataset
wait $A $B
if is_done model && is_done vllm && is_done signet && is_done dataset; then done_ ALL; else echo "BOOTSTRAP INCOMPLETE: $(ls /workspace/.ready)"; fi
