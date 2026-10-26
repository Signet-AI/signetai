[ -f /workspace/kit/state/config.env ] && . /workspace/kit/state/config.env
export SIGNET_REF=${SIGNET_REF:-main}
export MODEL_REPO=${MODEL_REPO:-RedHatAI/Qwen3.8-27B-INT4}
export MODEL_DIR=${MODEL_DIR:-/workspace/models/$(basename "$MODEL_REPO")}
export SERVED_NAME=${SERVED_NAME:-qwen3.8-27b}
export MAX_LEN=${MAX_LEN:-262144}
export KV_DTYPE=${KV_DTYPE:-fp8}
export MTP_TOKENS=${MTP_TOKENS:-3}
export GPU_MEM_UTIL=${GPU_MEM_UTIL:-0.92}
export DREAM_CONC=${DREAM_CONC:-12}
export DREAM_THINK=${DREAM_THINK:-2000}
export DREAM_MAX_OUT=${DREAM_MAX_OUT:-16384}
export QA_THINK=${QA_THINK:-4000}
export DREAM_TIMEOUT_MS=${DREAM_TIMEOUT_MS:-1800000}
export GRACE_MIN=${GRACE_MIN:-30}
export IDLE_MAX_MIN=${IDLE_MAX_MIN:-90}
export COST_PER_HR=${COST_PER_HR:-0}
export SM_VERSION=${SM_VERSION:-0.0.9}
export VENV=/workspace/vllm-venv
export SIGNET_DIR=/workspace/signetai
export BUN_INSTALL=/workspace/.bun
export CARGO_HOME=/workspace/.cargo
export RUSTUP_HOME=/workspace/.rustup
export HF_HOME=/workspace/hf
export PATH=$BUN_INSTALL/bin:$CARGO_HOME/bin:/root/.supermemory/bin:$PATH
export PORT_VLLM=8000 PORT_SIGNET_DREAM=8091 PORT_SIGNET_QA=8092 PORT_SM_EXTRACT=8093 PORT_SM_QA=8094
case "$(stat -f -c %T /workspace 2>/dev/null)" in
  nfs*|fuse*|smb*|cifs*|ceph*|9p) export WS_ROOT=/root/runs WS_NETWORK=1 ;;
  *) export WS_ROOT=/workspace/runs WS_NETWORK=0 ;;
esac
mkdir -p "$WS_ROOT" 2>/dev/null
